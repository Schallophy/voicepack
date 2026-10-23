mod audio;

use audio::AudioCore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
