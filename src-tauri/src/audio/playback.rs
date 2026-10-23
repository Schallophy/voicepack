//! Playback through a real render endpoint. The frontend hands over 48 kHz stereo float
//! (it resamples via OfflineAudioContext, so the browser's resampler owns that difference)
//! and this side owns the device clock, gain, fades, loop, seek and pause.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use micdeck_lib::platform::{Endpoint, Sink, StreamOptions};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::AudioCore;

/// Progress events at ~30 Hz are what the playhead and readouts animate from.
const PROGRESS_EVENT_MS: Duration = Duration::from_millis(30);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub position_ms: u64,
    pub finished: bool,
}

/// Shared between the device fill thread and the command thread. The fill thread is the
/// only writer of `cursor` while playing; commands pause/seek/stop through the flags.
pub struct PlayShared {
    samples: Vec<f32>,
    channels: usize,
    frames_total: usize,
    cursor: AtomicU64, // frame index
    paused: AtomicBool,
    stopped: AtomicBool,
    finished: AtomicBool,
    looping: AtomicBool,
    gain_db: AtomicU32,      // f32 bits, live target
    gain_current: AtomicU32, // f32 bits, what the last block ended on
    fade_in: usize,          // frames
    fade_out: usize,
    reported: Mutex<Instant>,
}

impl PlayShared {
    fn envelope(&self, frame: usize, base: f32) -> f32 {
        let mut g = base;
        if self.fade_in > 0 && frame < self.fade_in {
            g *= frame as f32 / self.fade_in as f32;
        }
        if self.fade_out > 0 && frame + self.fade_out > self.frames_total {
            let left = self.frames_total - frame;
            g *= left as f32 / self.fade_out as f32;
        }
        g
    }
}

pub struct Player {
    pub sink: Sink,
    pub shared: Arc<PlayShared>,
}

fn endpoint_by_id(id: &str) -> Result<Endpoint, String> {
    if id.is_empty() {
        return micdeck_lib::platform::win_default(micdeck_lib::platform::Direction::Render);
    }
    micdeck_lib::platform::list_endpoints(micdeck_lib::platform::Direction::Render)?
        .into_iter()
        .find(|ep| ep.id == id)
        .ok_or_else(|| "没有找到这个输出设备".to_string())
}

fn start_sink(endpoint: &Endpoint, shared: Arc<PlayShared>, app: AppHandle) -> Result<Sink, String> {
    let fill = Box::new(move |block: &mut [f32]| fill_block(block, &shared, &app));
    Sink::start(endpoint, StreamOptions::default(), fill)
}

fn fill_block(block: &mut [f32], shared: &Arc<PlayShared>, app: &AppHandle) {
    const DEVICE_CH: usize = 2;
    let frames = block.len() / DEVICE_CH;
    // gain_db stores decibels; the envelope multiplies linear amplitude.
    let base = 10f32.powf(f32::from_bits(shared.gain_db.load(Ordering::Relaxed)) / 20.0);
    let current0 = f32::from_bits(shared.gain_current.load(Ordering::Relaxed));

    if shared.stopped.load(Ordering::Relaxed) {
        block.fill(0.0);
        return;
    }
    if shared.paused.load(Ordering::Relaxed) {
        block.fill(0.0);
        report_progress(shared, app, false);
        return;
    }

    let channels = shared.channels.max(1);
    let mut cursor = shared.cursor.load(Ordering::Relaxed) as usize;
    let mut current = current0;
    let mut finished = false;
    for f in 0..frames {
        if cursor >= shared.frames_total {
            if shared.looping.load(Ordering::Relaxed) {
                cursor = 0;
            } else {
                finished = true;
            }
        }
        if finished {
            block[f * DEVICE_CH..(f + 1) * DEVICE_CH].fill(0.0);
            continue;
        }
        // Linear approach to the live gain across this block: a slider jump must not click.
        let target = current + (base - current) * ((f + 1) as f32 / frames as f32);
        let g = shared.envelope(cursor, target);
        for c in 0..DEVICE_CH {
            let src = if c < channels {
                shared.samples[cursor * channels + c]
            } else {
                shared.samples[cursor * channels + channels - 1]
            };
            block[f * DEVICE_CH + c] = src * g;
        }
        cursor += 1;
        current = target;
    }
    shared.gain_current.store(current.to_bits(), Ordering::Relaxed);
    shared.cursor.store(cursor as u64, Ordering::Relaxed);

    if finished {
        if !shared.finished.swap(true, Ordering::Relaxed) {
            let _ = app.emit("vp:playback-progress", ProgressEvent {
                position_ms: shared.frames_total as u64 * 1000 / 48_000,
                finished: true,
            });
        }
        report_progress(shared, app, true);
    } else {
        report_progress(shared, app, false);
    }
}

fn report_progress(shared: &Arc<PlayShared>, app: &AppHandle, force: bool) {
    let mut last = shared.reported.lock().unwrap();
    if !force && last.elapsed() < PROGRESS_EVENT_MS {
        return;
    }
    *last = Instant::now();
    let position_ms = shared.cursor.load(Ordering::Relaxed) * 1000 / 48_000;
    let _ = app.emit("vp:playback-progress", ProgressEvent { position_ms, finished: false });
}

fn stop_player(core: &AudioCore) {
    if let Some(mut player) = core.player.lock().unwrap().take() {
        player.shared.stopped.store(true, Ordering::Relaxed);
        player.sink.stop();
    }
}

/// PCM arrives in the request body as little-endian f32; the playback parameters travel
/// in headers because `invoke(cmd, body, { headers })` keeps one round trip.
#[tauri::command]
pub fn play_pcm(
    app: AppHandle,
    core: State<'_, AudioCore>,
    request: tauri::ipc::Request,
) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("音频载荷格式不正确".to_string()),
    };
    if bytes.len() < 4 {
        return Err("音频为空".to_string());
    }
    let h = |name: &str| -> String {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    let num = |name: &str, default: f64| -> f64 { h(name).parse::<f64>().unwrap_or(default) };

    let channels = (h("x-channels").parse::<usize>().unwrap_or(2)).clamp(1, 2);
    let sample_rate = h("x-sample-rate").parse::<usize>().unwrap_or(48_000);
    if sample_rate != 48_000 {
        return Err("只接受 48 kHz 的播放数据".to_string());
    }
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    if samples.is_empty() {
        return Err("音频为空".to_string());
    }
    let frames_total = samples.len() / channels;
    let gain_db = num("x-gain-db", 0.0).clamp(-24.0, 24.0) as f32;
    let fade_in = (num("x-fade-in-ms", 0.0) * 48.0) as usize;
    let fade_out = (num("x-fade-out-ms", 0.0) * 48.0) as usize;
    let looping = h("x-loop") == "1";
    let start_ms = num("x-start-ms", 0.0).max(0.0);

    let shared = Arc::new(PlayShared {
        samples,
        channels,
        frames_total,
        cursor: AtomicU64::new(((start_ms / 1000.0) * 48_000.0) as u64),
        paused: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
        finished: AtomicBool::new(false),
        looping: AtomicBool::new(looping),
        gain_db: AtomicU32::new(gain_db.to_bits()),
        gain_current: AtomicU32::new(0.0_f32.to_bits()),
        fade_in: fade_in.min(frames_total / 2),
        fade_out: fade_out.min(frames_total / 2),
        reported: Mutex::new(Instant::now()),
    });

    let device = h("x-device");
    let endpoint = endpoint_by_id(&device)?;
    let sink = start_sink(&endpoint, shared.clone(), app.clone())?;

    stop_player(&core);
    *core.player.lock().unwrap() = Some(Player { sink, shared });
    *core.output_device.lock().unwrap() = if device.is_empty() { None } else { Some(device) };
    Ok(())
}

#[tauri::command]
pub fn playback_pause(core: State<'_, AudioCore>) {
    if let Some(player) = core.player.lock().unwrap().as_ref() {
        player.shared.paused.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn playback_resume(core: State<'_, AudioCore>) {
    if let Some(player) = core.player.lock().unwrap().as_ref() {
        player.shared.paused.store(false, Ordering::Relaxed);
        player.shared.finished.store(false, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn playback_seek(core: State<'_, AudioCore>, position_ms: u64) {
    if let Some(player) = core.player.lock().unwrap().as_ref() {
        player
            .shared
            .cursor
            .store(position_ms.min(player.shared.frames_total as u64) * 48_000 / 1000, Ordering::Relaxed);
        player.shared.finished.store(false, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn playback_stop(core: State<'_, AudioCore>) {
    stop_player(&core);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    pub active: bool,
    pub paused: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
}

#[tauri::command]
pub fn playback_state(core: State<'_, AudioCore>) -> PlaybackState {
    match core.player.lock().unwrap().as_ref() {
        Some(player) => PlaybackState {
            active: !player.shared.stopped.load(Ordering::Relaxed),
            paused: player.shared.paused.load(Ordering::Relaxed),
            position_ms: player.shared.cursor.load(Ordering::Relaxed) * 1000 / 48_000,
            duration_ms: player.shared.frames_total as u64 * 1000 / 48_000,
        },
        None => PlaybackState { active: false, paused: false, position_ms: 0, duration_ms: 0 },
    }
}

/// Switching devices restarts the current playback from where it was: the sink owns one
/// endpoint for its whole life, and a short seam beats a silent wrong device.
#[tauri::command]
pub fn set_output_device(
    app: AppHandle,
    core: State<'_, AudioCore>,
    device_id: Option<String>,
) -> Result<(), String> {
    let guard = core.player.lock().unwrap();
    let current = guard.as_ref();
    *core.output_device.lock().unwrap() = device_id.clone().filter(|s| !s.is_empty());
    if let Some(player) = current {
        let shared = player.shared.clone();
        let looping = shared.looping.load(Ordering::Relaxed);
        let gain = f32::from_bits(shared.gain_db.load(Ordering::Relaxed));
        let fade_in = shared.fade_in * 1000 / 48_000;
        let fade_out = shared.fade_out * 1000 / 48_000;
        let position_ms = shared.cursor.load(Ordering::Relaxed) * 1000 / 48_000;
        drop(guard);
        stop_player(&core);
        let samples = shared.samples.clone();
        let channels = shared.channels;
        replay(
            &app, &core, samples, channels, gain, fade_in, fade_out, looping, position_ms, device_id,
        )?;
    } else {
        drop(guard);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn replay(
    app: &AppHandle,
    core: &AudioCore,
    samples: Vec<f32>,
    channels: usize,
    gain_db: f32,
    fade_in_ms: usize,
    fade_out_ms: usize,
    looping: bool,
    start_ms: u64,
    device: Option<String>,
) -> Result<(), String> {
    let frames_total = samples.len() / channels.max(1);
    let shared = Arc::new(PlayShared {
        samples,
        channels,
        frames_total,
        cursor: AtomicU64::new(start_ms * 48_000 / 1000),
        paused: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
        finished: AtomicBool::new(false),
        looping: AtomicBool::new(looping),
        gain_db: AtomicU32::new(gain_db.to_bits()),
        gain_current: AtomicU32::new(10f32.powf(gain_db / 20.0).to_bits()),
        fade_in: fade_in_ms.min(frames_total / 2) * 48 / 1000,
        fade_out: fade_out_ms.min(frames_total / 2) * 48 / 1000,
        reported: Mutex::new(Instant::now()),
    });
    let endpoint = endpoint_by_id(&device.unwrap_or_default())?;
    let sink = start_sink(&endpoint, shared.clone(), app.clone())?;
    *core.player.lock().unwrap() = Some(Player { sink, shared });
    Ok(())
}

#[tauri::command]
pub fn playback_set_gain(core: State<'_, AudioCore>, gain_db: f64) {
    if let Some(player) = core.player.lock().unwrap().as_ref() {
        let db = gain_db.clamp(-24.0, 24.0) as f32;
        player.shared.gain_db.store(db.to_bits(), Ordering::Relaxed);
    }
}
