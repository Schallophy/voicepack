//! 语音包 = 根目录下的一个文件夹；一条语音 = 文件夹里的一个音频文件，文件名就是语音名。
//! 没有 manifest，没有自定义 schema：能在资源管理器里看到、能直接拷走的东西才算用户的资产。
//!
//! 根目录本身记在 `settings.json`（属于磁盘布局，归 Rust 管），会话状态里的素材/热键不在这儿。
//! 所有路径都必须落在根目录以内，写文件的命令是 raw body，因为语音可能有好几 MB。

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

/// 首次运行时建的默认根目录：`文档\语音包`。
const ROOT_NAME: &str = "语音包";
/// 能当语音读进来的扩展名；写出去一律 WAV。
const VOICE_SUFFIXES: &[&str] = &["wav", "flac", "ogg", "oga", "mp3", "m4a"];

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    pack_root: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRow {
    pub name: String,
    pub voices: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRow {
    /// 语音名 = 文件名去掉扩展名。
    pub name: String,
    pub file: String,
    pub path: String,
    pub size: u64,
    /// 只有 WAV 能在不解码的情况下报出这些；其它格式交给前端解码后回填。
    pub duration_ms: Option<u64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("拿不到应用数据目录：{err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("建不了数据目录：{err}"))?;
    Ok(dir)
}

fn load_settings(app: &AppHandle) -> Result<Settings, String> {
    let path = config_dir(app)?.join("settings.json");
    if !path.is_file() {
        return Ok(Settings::default());
    }
    let text = fs::read_to_string(path).map_err(|err| format!("读设置失败：{err}"))?;
    serde_json::from_str(&text).or_else(|_| Ok(Settings::default()))
}

fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = config_dir(app)?.join("settings.json");
    let text = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text).map_err(|err| format!("写设置失败：{err}"))?;
    fs::rename(&tmp, path).map_err(|err| format!("写设置失败：{err}"))
}

fn documents_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .and_then(|home| {
            let docs = home.join("Documents");
            let alt = home.join("文档");
            if docs.is_dir() {
                Some(docs)
            } else if alt.is_dir() {
                Some(alt)
            } else {
                Some(docs)
            }
        })
        .ok_or_else(|| "找不到文档目录".to_string())
}

/// 根目录一定存在；没配置过就用 `文档\语音包` 并建出来。
fn ensure_root(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = load_settings(app)?;
    let root = if settings.pack_root.trim().is_empty() {
        documents_dir()?.join(ROOT_NAME)
    } else {
        PathBuf::from(settings.pack_root.trim())
    };
    if !root.is_dir() {
        fs::create_dir_all(&root).map_err(|err| format!("建不了语音包目录：{err}：{}", root.display()))?;
    }
    Ok(root)
}

/// 拒绝绝对路径、盘符、`..`，只允许根目录以内的相对片段。
fn join_checked(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(relative);
    if candidate.is_absolute() {
        return Err("只能使用语音包根目录内的相对路径".to_string());
    }
    let mut out = root.to_path_buf();
    for part in candidate.components() {
        match part {
            Component::Normal(name) => out.push(name),
            Component::CurDir => {}
            _ => return Err("路径不合法".to_string()),
        }
    }
    if out == root {
        return Err("没有指定语音包".to_string());
    }
    Ok(out)
}

fn has_voice_suffix(name: &str) -> bool {
    let lower = name.to_lowercase();
    VOICE_SUFFIXES.iter().any(|ext| lower.ends_with(&format!(".{ext}")))
}

/// Windows 不允许的字符全部换成 `·`，顺带去掉结尾的点和空格（会被静默吞掉，留下对不上的名字）。
fn sanitize_file_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '·',
            other => other,
        })
        .collect();
    // 与前端 sanitizeName 同一套规则：两头都裁，结尾的点会被 Windows 静默吞掉。
    out = out.trim().to_string();
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    if out.trim().is_empty() {
        out = "语音".to_string();
    }
    out.chars().take(80).collect()
}

/// 只读 WAV 的头，不解码：够语音板报出时长和采样率。
fn wav_info(path: &Path) -> (Option<u64>, Option<u32>, Option<u16>) {
    match fs::read(path) {
        Ok(bytes) => wav_info_of(&bytes),
        Err(_) => (None, None, None),
    }
}

/// 文件头是别人写的（资源管理器里丢进来的 mp3、半截的 wav），所以每一步都按字节数判边界。
fn wav_info_of(bytes: &[u8]) -> (Option<u64>, Option<u32>, Option<u16>) {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return (None, None, None);
    }
    let mut channels = None;
    let mut rate = None;
    let mut block_align = 0u32;
    let mut cursor = 12usize;
    while cursor + 8 <= bytes.len() {
        let id = &bytes[cursor..cursor + 4];
        let size = u32::from_le_bytes([bytes[cursor + 4], bytes[cursor + 5], bytes[cursor + 6], bytes[cursor + 7]]) as usize;
        let body = cursor + 8;
        if body + size > bytes.len() {
            break;
        }
        match id {
            b"fmt " => {
                if size >= 16 {
                    channels = Some(u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]));
                    rate = Some(u32::from_le_bytes([bytes[body + 4], bytes[body + 5], bytes[body + 6], bytes[body + 7]]));
                    // block_align 只有 2 字节：多读一位就把 bitsPerSample 也算进对齐块大小，帧数直接成 0。
                    block_align = u16::from_le_bytes([bytes[body + 12], bytes[body + 13]]) as u32;
                }
            }
            b"data" => {
                if rate.unwrap_or(0) == 0 || block_align == 0 {
                    break;
                }
                let frames = (size as u64) / (block_align as u64);
                let ms = frames * 1000 / (rate.unwrap_or(48000) as u64);
                return (if ms > 0 { Some(ms) } else { None }, rate, channels);
            }
            _ => {}
        }
        // chunk 按 2 字节对齐。
        cursor = body + size + (size % 2);
    }
    (None, rate, channels)
}

#[tauri::command]
pub fn pack_root_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let root = ensure_root(&app)?;
    Ok(serde_json::json!({
        "root": root.display().to_string(),
        "default": documents_dir()?.join(ROOT_NAME).display().to_string(),
    }))
}

#[tauri::command]
pub fn set_pack_root(app: AppHandle, path: String) -> Result<String, String> {
    let target = PathBuf::from(path.trim());
    if !target.is_absolute() {
        return Err("请填写完整路径，比如 D:\\语音包".to_string());
    }
    fs::create_dir_all(&target).map_err(|err| format!("建不了这个目录：{err}"))?;
    save_settings(
        &app,
        &Settings {
            pack_root: target.display().to_string(),
        },
    )?;
    Ok(target.display().to_string())
}

#[tauri::command]
pub fn list_packs(app: AppHandle) -> Result<Vec<PackRow>, String> {
    let root = ensure_root(&app)?;
    let mut rows = Vec::new();
    for entry in fs::read_dir(&root).map_err(|err| format!("读不了语音包目录：{err}"))? {
        let path = entry.map_err(|err| format!("读不了语音包目录：{err}"))?.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        let voices = list_voices_at(&path).len();
        rows.push(PackRow { name, voices });
    }
    rows.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(rows)
}

fn list_voices_at(dir: &Path) -> Vec<VoiceRow> {
    let mut rows = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else { return rows };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        if !has_voice_suffix(&file) {
            continue;
        }
        let name = file.rsplit_once('.').map(|(stem, _)| stem.to_string()).unwrap_or(file.clone());
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let (duration_ms, sample_rate, channels) = if file.to_lowercase().ends_with(".wav") {
            wav_info(&path)
        } else {
            (None, None, None)
        };
        rows.push(VoiceRow {
            name,
            file,
            path: path.display().to_string(),
            size,
            duration_ms,
            sample_rate,
            channels,
        });
    }
    rows.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    rows
}

#[tauri::command]
pub fn list_pack_voices(app: AppHandle, pack: String) -> Result<Vec<VoiceRow>, String> {
    let dir = join_checked(&ensure_root(&app)?, &sanitize_file_name(&pack))?;
    if !dir.is_dir() {
        return Err(format!("语音包「{pack}」不在了"));
    }
    Ok(list_voices_at(&dir))
}

#[tauri::command]
pub fn read_voice_file(app: AppHandle, path: String) -> Result<Response, String> {
    let file = join_checked(&ensure_root(&app)?, &path)?;
    let bytes = fs::read(&file).map_err(|err| format!("读不出来：{err}"))?;
    Ok(Response::new(bytes))
}

/// raw body 布局：`[u32 路径字节数][路径 UTF-8][文件内容]`。
/// 用长度前缀而不是请求头，是因为路径里有中文，HTTP 头装不下；而不是把几 MB 音频 base64 一遍。
fn split_request(body: &[u8]) -> Result<(String, &[u8]), String> {
    if body.len() < 4 {
        return Err("写入请求不完整".to_string());
    }
    let len = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if 4 + len > body.len() {
        return Err("写入请求的路径长度不对".to_string());
    }
    let path = String::from_utf8(body[4..4 + len].to_vec()).map_err(|_| "路径不是合法文本".to_string())?;
    Ok((path, &body[4 + len..]))
}

fn write_new(root: &Path, relative: &str, bytes: &[u8]) -> Result<String, String> {
    let file = join_checked(root, relative)?;
    if file.exists() {
        return Err("这个包里已经有同名语音".to_string());
    }
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|err| format!("建不了目录：{err}"))?;
    }
    let tmp = file.with_extension("vpk-tmp");
    fs::write(&tmp, bytes).map_err(|err| format!("写入失败：{err}"))?;
    match fs::rename(&tmp, &file) {
        Ok(()) => Ok(file.display().to_string()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(format!("写入失败：{err}"))
        }
    }
}

#[tauri::command]
pub fn write_voice_file(app: AppHandle, request: Request) -> Result<String, String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        _ => return Err("写入需要原始音频数据".to_string()),
    };
    let (path, bytes) = split_request(body)?;
    write_new(&ensure_root(&app)?, &path, bytes)
}

fn move_between(from: &Path, to: &Path) -> Result<(), String> {
    if !from.is_file() {
        return Err("源文件不在了".to_string());
    }
    if to.exists() {
        return Err("目标位置已经有同名语音".to_string());
    }
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir).map_err(|err| format!("建不了目录：{err}"))?;
    }
    fs::rename(from, to).map_err(|err| format!("移动失败：{err}"))
}

#[tauri::command]
pub fn move_voice_file(app: AppHandle, from: String, to: String) -> Result<String, String> {
    let root = ensure_root(&app)?;
    let source = join_checked(&root, &from)?;
    let target = join_checked(&root, &to)?;
    move_between(&source, &target)?;
    Ok(target.display().to_string())
}

#[tauri::command]
pub fn delete_voice_file(app: AppHandle, path: String) -> Result<(), String> {
    let file = join_checked(&ensure_root(&app)?, &path)?;
    fs::remove_file(&file).map_err(|err| format!("删除失败：{err}"))
}

#[tauri::command]
pub fn create_pack(app: AppHandle, name: String) -> Result<String, String> {
    let dir = join_checked(&ensure_root(&app)?, &sanitize_file_name(&name))?;
    if dir.exists() {
        return Err("已经有同名语音包".to_string());
    }
    fs::create_dir(&dir).map_err(|err| format!("建不了语音包：{err}"))?;
    Ok(dir.display().to_string())
}

#[tauri::command]
pub fn rename_pack(app: AppHandle, from: String, to: String) -> Result<String, String> {
    let root = ensure_root(&app)?;
    let source = join_checked(&root, &sanitize_file_name(&from))?;
    let target = join_checked(&root, &sanitize_file_name(&to))?;
    if !source.is_dir() {
        return Err("语音包不在了".to_string());
    }
    if target.exists() {
        return Err("已经有同名语音包".to_string());
    }
    fs::rename(&source, &target).map_err(|err| format!("重命名失败：{err}"))?;
    Ok(target.display().to_string())
}

/// 删包是真的删文件夹，所以要么空、要么显式 force（界面上先确认过）。
#[tauri::command]
pub fn delete_pack(app: AppHandle, name: String, force: bool) -> Result<(), String> {
    let dir = join_checked(&ensure_root(&app)?, &sanitize_file_name(&name))?;
    if !dir.is_dir() {
        return Err("语音包不在了".to_string());
    }
    let voices = list_voices_at(&dir).len();
    if voices > 0 && !force {
        return Err(format!("这个包里还有 {voices} 条语音"));
    }
    fs::remove_dir_all(&dir).map_err(|err| format!("删除失败：{err}"))
}

#[tauri::command]
pub fn reveal_in_explorer(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let root = ensure_root(&app)?;
    let target = match path {
        Some(relative) if !relative.trim().is_empty() => join_checked(&root, &relative)?,
        _ => root,
    };
    // 文件用 `/select,` 才能在资源管理器里被选中；直接给路径会变成"用默认程序打开"。
    let mut command = Command::new("explorer.exe");
    if target.is_file() {
        command.arg(format!("/select,{}", target.display()));
    } else {
        command.arg(&target);
    }
    command
        .spawn()
        .map_err(|err| format!("打不开资源管理器：{err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = id.to_vec();
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
        if body.len() % 2 == 1 {
            out.push(0);
        }
        out
    }

    fn wav(channels: u16, rate: u32, bits: u16, data_len: u32) -> Vec<u8> {
        let block_align = channels * (bits / 8);
        let mut fmt = Vec::new();
        fmt.extend_from_slice(&1u16.to_le_bytes());
        fmt.extend_from_slice(&channels.to_le_bytes());
        fmt.extend_from_slice(&rate.to_le_bytes());
        fmt.extend_from_slice(&(rate * block_align as u32).to_le_bytes());
        fmt.extend_from_slice(&block_align.to_le_bytes());
        fmt.extend_from_slice(&bits.to_le_bytes());
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(&chunk(b"fmt ", &fmt));
        out.extend_from_slice(&chunk(b"data", &vec![0u8; data_len as usize]));
        out
    }

    #[test]
    fn header_gives_the_duration_without_decoding() {
        // 48 kHz / 单声道 / 24 bit，172800 字节 = 57600 帧 = 1200 ms
        assert_eq!(wav_info_of(&wav(1, 48000, 24, 172800)), (Some(1200), Some(48000), Some(1)));
        // 立体声 16 bit：block_align=4，2 字节读错成 4 字节时这里会算出 0
        assert_eq!(wav_info_of(&wav(2, 44100, 16, 352800)), (Some(2000), Some(44100), Some(2)));
    }

    #[test]
    fn odd_headers_report_nothing_instead_of_panicking() {
        assert_eq!(wav_info_of(&[]), (None, None, None));
        assert_eq!(wav_info_of(&b"not a wav at all, really".to_vec()), (None, None, None));
        // 截断：data 声明的长度比文件实际长度还长——报不出时长，但不许崩
        let mut truncated = wav(1, 48000, 24, 172800);
        truncated.truncate(100);
        assert_eq!(wav_info_of(&truncated), (None, Some(48000), Some(1)));
        // 空的 data 块同理
        assert_eq!(wav_info_of(&wav(1, 48000, 24, 0)), (None, Some(48000), Some(1)));
    }

    #[test]
    fn file_names_are_made_safe_but_stay_readable() {
        assert_eq!(sanitize_file_name("带 斜杠/和 冒号:尾"), "带 斜杠·和 冒号·尾");
        assert_eq!(sanitize_file_name("  尾随点号...  "), "尾随点号");
        assert_eq!(sanitize_file_name("***"), "···");
        assert_eq!(sanitize_file_name("..."), "语音");
        assert_eq!(sanitize_file_name("   "), "语音");
        assert_eq!(sanitize_file_name(&"长".repeat(200)).chars().count(), 80);
    }

    #[test]
    fn paths_cannot_escape_the_root() {
        let root = Path::new(r"D:\语音包");
        assert_eq!(
            join_checked(root, "默认语音包/你好.wav").unwrap(),
            PathBuf::from(r"D:\语音包\默认语音包\你好.wav")
        );
        assert!(join_checked(root, "../Windows/system.ini").is_err());
        assert!(join_checked(root, r"C:\Windows\x.wav").is_err());
        assert!(join_checked(root, r"\\server\share\x.wav").is_err());
        assert!(join_checked(root, "").is_err());
    }
}
