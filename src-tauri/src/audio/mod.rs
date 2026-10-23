pub mod capture;
pub mod playback;

pub use capture::*;
pub use playback::*;

use std::sync::Mutex;

use capture::CaptureSession;
use playback::Player;

/// Everything audible goes through here: one capture session and one playback at a time,
/// plus the output device the user picked. The device id is `None` for "system default".
#[derive(Default)]
pub struct AudioCore {
    pub capture: Mutex<Option<CaptureSession>>,
    pub last_capture: Mutex<Option<capture::CaptureMeta>>,
    pub player: Mutex<Option<Player>>,
    pub output_device: Mutex<Option<String>>,
}
