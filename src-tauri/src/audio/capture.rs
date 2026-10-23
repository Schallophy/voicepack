//! Capture from a microphone, one application's render stream, or a whole render endpoint.
//! The stream is micdeck's canonical 48 kHz stereo float; frames accumulate in memory and
//! leave as raw little-endian f32 when the user stops — nothing touches disk by itself.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use micdeck_lib::platform::{Capture, Endpoint, OnFrames, Source, StreamOptions};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::AudioCore;

/// Voice-pack takes are seconds long, not podcasts. 15 minutes is generous and still
/// bounds memory to ~230 MB of float samples.
const MAX_SECONDS: u64 = 900;
/// The live meter and live waveform read this; faster than eyes need, slower than packets come.
const LEVEL_EVENT_MS: Duration = Duration::from_millis(30);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelEvent {
    pub elapsed_ms: u64,
    pub min: f32,
    pub max: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMeta {
    pub sample_rate: u32,
    pub channels: u32,
    pub frames: u64,
    pub duration_ms: u64,
}

pub struct CaptureSession {
    capture: Capture,
    buffer: Arc<Mutex<Vec<f32>>>,
    frames: Arc<AtomicUsize>,
    overflow: Arc<AtomicBool>,
    started: Instant,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub sub: String,
    pub pid: Option<u32>,
}

fn endpoint_rows(dir: micdeck_lib::platform::Direction) -> Vec<Endpoint> {
    micdeck_lib::platform::list_endpoints(dir).unwrap_or_default()
}

#[tauri::command]
pub fn list_input_devices() -> Vec<SourceInfo> {
    endpoint_rows(micdeck_lib::platform::Direction::Capture)
        .into_iter()
        .map(|ep| SourceInfo {
            id: ep.id,
            name: ep.name,
            sub: if ep.is_default { "默认输入".into() } else { String::new() },
            pid: None,
        })
        .collect()
}

#[tauri::command]
pub fn list_output_devices() -> Vec<SourceInfo> {
    endpoint_rows(micdeck_lib::platform::Direction::Render)
        .into_iter()
        .map(|ep| SourceInfo {
            id: ep.id,
            name: ep.name,
            sub: if ep.is_default { "默认输出".into() } else { String::new() },
            pid: None,
        })
        .collect()
}

/// One pickable window per process, filtered the way Alt+Tab filters — the same list
/// MicDeck mixes, so a game that hides from one hides from both.
#[tauri::command]
pub fn list_app_sources() -> Vec<SourceInfo> {
    micdeck_lib::platform::list_window_candidates()
        .into_iter()
        .map(|row| SourceInfo {
            id: format!("pid:{}", row.pid),
            name: row.name,
            sub: row.title,
            pid: Some(row.pid),
        })
        .collect()
}

fn resolve_source(mode: &str, device: Option<String>, pid: Option<u32>) -> Result<Source, String> {
    match mode {
        "mic" => {
            let id = device.unwrap_or_default();
            let endpoint = if id.is_empty() {
                micdeck_lib::platform::win_default(micdeck_lib::platform::Direction::Capture)?
            } else {
                endpoint_rows(micdeck_lib::platform::Direction::Capture)
                    .into_iter()
                    .find(|ep| ep.id == id)
                    .ok_or_else(|| "没有找到这个输入设备".to_string())?
            };
            Ok(Source::Microphone(endpoint))
        }
        "app" => {
            let pid = pid.ok_or_else(|| "缺少目标进程".to_string())?;
            // WASAPI 对不存在的进程照常打开回环、只给静音，这里必须自己拦。
            if !micdeck_lib::platform::process_alive(pid) {
                return Err("目标进程已经不在了".to_string());
            }
            Ok(Source::Process { pid, include_tree: true })
        }
        "system" => {
            let id = device.unwrap_or_default();
            let endpoint = if id.is_empty() {
                micdeck_lib::platform::win_default(micdeck_lib::platform::Direction::Render)?
            } else {
                endpoint_rows(micdeck_lib::platform::Direction::Render)
                    .into_iter()
                    .find(|ep| ep.id == id)
                    .ok_or_else(|| "没有找到这个输出设备".to_string())?
            };
            Ok(Source::RenderLoopback(endpoint))
        }
        other => Err(format!("未知的采集来源：{other}")),
    }
}

struct LevelAcc {
    min: f32,
    max: f32,
    since: Instant,
}

#[tauri::command]
pub fn start_capture(
    app: AppHandle,
    core: State<'_, AudioCore>,
    mode: String,
    device: Option<String>,
    pid: Option<u32>,
) -> Result<(), String> {
    let source = resolve_source(&mode, device, pid)?;
    let mut guard = core.capture.lock().unwrap();
    // 兜底：上一段没停也先丢弃，一次只有一段录音
    *guard = None;

    let buffer = Arc::new(Mutex::new(Vec::new()));
    let frames = Arc::new(AtomicUsize::new(0));
    let overflow = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    let acc = Arc::new(Mutex::new(LevelAcc { min: 0.0, max: 0.0, since: Instant::now() }));

    let (t_buf, t_frames, t_over, t_acc) =
        (buffer.clone(), frames.clone(), overflow.clone(), acc.clone());
    let on: OnFrames = Box::new(move |chunk: &[f32]| {
        {
            let mut buf = t_buf.lock().unwrap();
            buf.extend_from_slice(chunk);
        }
        let total = t_frames.fetch_add(chunk.len(), Ordering::Relaxed) + chunk.len();
        if total as u64 > MAX_SECONDS * 48_000 * 2 {
            t_over.store(true, Ordering::Relaxed);
        }
        let mut acc = t_acc.lock().unwrap();
        acc.min = acc.min.min(chunk.iter().copied().fold(0.0_f32, f32::min));
        acc.max = acc.max.max(chunk.iter().copied().fold(0.0_f32, f32::max));
        if acc.since.elapsed() >= LEVEL_EVENT_MS {
            let _ = app.emit(
                "vp:capture-level",
                LevelEvent {
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    min: std::mem::take(&mut acc.min),
                    max: std::mem::take(&mut acc.max),
                },
            );
            acc.since = Instant::now();
        }
    });

    let capture = Capture::start(source, StreamOptions::default(), on)?;
    *guard = Some(CaptureSession { capture, buffer, frames, overflow, started });
    Ok(())
}

#[tauri::command]
pub fn stop_capture(core: State<'_, AudioCore>) -> Result<tauri::ipc::Response, String> {
    let session = core
        .capture
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "当前没有正在进行的录音".to_string())?;
    let CaptureSession { mut capture, buffer, frames, overflow, started } = session;
    capture.stop();

    let meta = CaptureMeta {
        sample_rate: 48_000,
        channels: 2,
        frames: frames.load(Ordering::Relaxed) as u64,
        duration_ms: started.elapsed().as_millis() as u64,
    };
    if overflow.load(Ordering::Relaxed) {
        return Err("录音太长（超过 15 分钟），已丢弃".to_string());
    }
    if meta.frames == 0 {
        return Err("这段录音没有采到任何音频".to_string());
    }
    let samples = buffer.lock().unwrap().clone();
    *core.last_capture.lock().unwrap() = Some(meta);
    let bytes = samples
        .into_iter()
        .flat_map(|s| s.to_le_bytes())
        .collect::<Vec<u8>>();
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn cancel_capture(core: State<'_, AudioCore>) -> Result<(), String> {
    if let Some(mut session) = core.capture.lock().unwrap().take() {
        session.capture.stop();
    }
    Ok(())
}

#[tauri::command]
pub fn capture_meta(core: State<'_, AudioCore>) -> Option<CaptureMeta> {
    core.last_capture.lock().unwrap().clone()
}


