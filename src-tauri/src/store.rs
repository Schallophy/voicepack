//! The session is on disk the moment it exists. Metadata is one small JSON file; every asset and
//! voice keeps its own immutable float32 blob, so saving a change never rewrites audio.
//! This is the working store, not a distribution format — 「导出语音包」 still writes a zip by itself.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::Request;
use tauri::{AppHandle, Manager};

const SESSION_DIR: &str = "session";
const STATE_FILE: &str = "state.json";
const BLOB_DIR: &str = "audio";
const BLOB_SUFFIX: &str = ".f32";

/// Blob names come from the webview, so only the alphabet `crypto.randomUUID` produces is allowed.
fn blob_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        return Err(format!("非法的音频编号：{id}"));
    }
    Ok(root.join(BLOB_DIR).join(format!("{id}{BLOB_SUFFIX}")))
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    // 用 Local 而不是 Roaming：一次录音就是几 MB，漫游配置文件会被域同步拖着走。
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("拿不到应用数据目录：{err}"))?
        .join(SESSION_DIR);
    fs::create_dir_all(dir.join(BLOB_DIR)).map_err(|err| format!("建不了数据目录：{err}"))?;
    Ok(dir)
}

/// Write a sibling then rename, so a crash mid-save cannot leave a half-read file behind.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|err| format!("写入失败：{err}"))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(format!("保存失败：{err}"))
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub blobs: usize,
    pub bytes: u64,
    pub dir: String,
    pub restored: bool,
}

#[tauri::command]
pub fn write_state(app: AppHandle, raw: String, keep: Vec<String>) -> Result<(), String> {
    let base = root(&app)?;
    write_atomic(&base.join(STATE_FILE), raw.as_bytes())?;
    // Entities can come back through undo, so the live set is the only truth about what is still used.
    let kept: std::collections::HashSet<String> = keep.into_iter().collect();
    for entry in fs::read_dir(base.join(BLOB_DIR)).map_err(|err| format!("读音频目录失败：{err}"))? {
        let path = entry.map_err(|err| format!("读音频目录失败：{err}"))?.path();
        let stem = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        if path.extension().and_then(|ext| ext.to_str()) == Some("f32") && !kept.contains(&stem) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn read_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = root(&app)?.join(STATE_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|err| format!("读取失败：{err}"))?;
    String::from_utf8(bytes).map(|raw| Some(raw)).map_err(|err| {
        let _ = fs::remove_file(&path);
        format!("会话文件已损坏，本次从空库开始：{err}")
    })
}

/// Raw-body command, like `play_pcm`: the id rides on a header and the body is the float32 bytes.
#[tauri::command]
pub fn put_blob(app: AppHandle, request: Request) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let path = blob_path(&root(&app)?, &id)?;
    if path.is_file() {
        return Ok(()); // blobs are immutable; the first write is the only one that matters
    }
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => write_atomic(&path, bytes),
        _ => Err("音频载荷格式不正确".to_string()),
    }
}

#[tauri::command]
pub fn read_blob(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let path = blob_path(&root(&app)?, &id)?;
    let bytes = fs::read(&path).map_err(|err| format!("音频 {id} 读不出来：{err}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn session_stats(app: AppHandle) -> Result<SessionStats, String> {
    let base = root(&app)?;
    let mut blobs = 0usize;
    let mut bytes = 0u64;
    for entry in fs::read_dir(base.join(BLOB_DIR)).map_err(|err| format!("读音频目录失败：{err}"))? {
        let path = entry.map_err(|err| format!("读音频目录失败：{err}"))?.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("f32") {
            blobs += 1;
            bytes += fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(SessionStats {
        blobs,
        bytes,
        dir: base.display().to_string(),
        restored: base.join(STATE_FILE).is_file(),
    })
}

/// 「清空当前会话」— wipes the store, not the running session, which the front end resets itself.
#[tauri::command]
pub fn clear_session(app: AppHandle) -> Result<(), String> {
    let base = root(&app)?;
    let _ = fs::remove_file(base.join(STATE_FILE));
    for entry in fs::read_dir(base.join(BLOB_DIR)).map_err(|err| format!("读音频目录失败：{err}"))? {
        let path = entry.map_err(|err| format!("读音频目录失败：{err}"))?.path();
        let _ = fs::remove_file(path);
    }
    Ok(())
}
