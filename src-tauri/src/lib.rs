mod audio;
mod store;

use audio::AudioCore;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // 会话存储只有一个写者：第二个实例起不来时把已有窗口叫到前面，否则两边会互相覆盖 state.json。
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .manage(AudioCore::default())
        .invoke_handler(tauri::generate_handler![
            audio::list_input_devices,
            audio::list_output_devices,
            audio::list_app_sources,
            audio::start_capture,
            audio::stop_capture,
            audio::cancel_capture,
            audio::capture_meta,
            audio::play_pcm,
            audio::playback_pause,
            audio::playback_resume,
            audio::playback_seek,
            audio::playback_stop,
            audio::playback_state,
            audio::playback_set_gain,
            audio::set_output_device,
            store::write_state,
            store::read_state,
            store::put_blob,
            store::read_blob,
            store::session_stats,
            store::clear_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
