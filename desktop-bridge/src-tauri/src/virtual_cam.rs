use libloading::Library;
use std::ffi::{c_float, c_int, c_void};
use std::path::PathBuf;

pub const VIRTUAL_CAM_WIDTH: u32 = 1280;
pub const VIRTUAL_CAM_HEIGHT: u32 = 720;

type ScCreateCameraFn =
    unsafe extern "C" fn(width: c_int, height: c_int, framerate: c_float) -> *mut c_void;
type ScDeleteCameraFn = unsafe extern "C" fn(camera: *mut c_void);
type ScSendFrameFn = unsafe extern "C" fn(camera: *mut c_void, image_bits: *const u8);
type ScIsConnectedFn = unsafe extern "C" fn(camera: *mut c_void) -> bool;

struct LoadedSoftcam {
    // Keep the loaded DLL handle alive for as long as the function pointers are used.
    _lib: Library,
    create_camera: ScCreateCameraFn,
    delete_camera: ScDeleteCameraFn,
    send_frame: ScSendFrameFn,
    is_connected: Option<ScIsConnectedFn>,
}

/// Manages a user-mode DirectShow virtual camera via `softcam.dll` (shared memory).
///
/// Opens a fixed 1280x720 (multiples of 4, universal Chrome/Meet/Zoom HD format) camera
/// immediately at startup with `framerate = 0.0` (non-blocking real-time delivery) so
/// Google Meet, Zoom, Teams, and Discord can connect immediately without "Camera unavailable".
pub struct SoftcamDriver {
    api: Option<LoadedSoftcam>,
    camera_handle: *mut c_void,
    width: u32,
    height: u32,
    bgr_buffer: Vec<u8>,
    frames_sent: u64,
    receiving_live_video: bool,
}

// SAFETY: Access is serialized behind `std::sync::Mutex` in `BridgeState`.
unsafe impl Send for SoftcamDriver {}

impl SoftcamDriver {
    pub fn new() -> Self {
        let mut driver = Self {
            api: Self::try_load_library(),
            camera_handle: std::ptr::null_mut(),
            width: 0,
            height: 0,
            bgr_buffer: Vec::new(),
            frames_sent: 0,
            receiving_live_video: false,
        };

        // Pre-initialize a fixed 1280x720 DirectShow camera immediately on app launch
        // so Chrome/Google Meet sees a valid active MediaType even before phone pairing.
        let _ = driver.ensure_camera();
        driver.send_standby_frame();
        driver
    }

    fn candidate_dll_paths() -> Vec<PathBuf> {
        let mut paths = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                paths.push(dir.join("resources").join("softcam.dll"));
                paths.push(dir.join("softcam.dll"));
            }
        }
        paths.push(PathBuf::from("softcam.dll"));
        paths
    }

    fn try_load_library() -> Option<LoadedSoftcam> {
        for candidate in Self::candidate_dll_paths() {
            let loaded = unsafe { Library::new(&candidate) };
            let Ok(lib) = loaded else {
                continue;
            };

            let symbols = unsafe {
                let create_camera = lib
                    .get::<ScCreateCameraFn>(b"scCreateCamera\0")
                    .ok()
                    .map(|s| *s);
                let delete_camera = lib
                    .get::<ScDeleteCameraFn>(b"scDeleteCamera\0")
                    .ok()
                    .map(|s| *s);
                let send_frame = lib
                    .get::<ScSendFrameFn>(b"scSendFrame\0")
                    .ok()
                    .map(|s| *s);
                let is_connected = lib
                    .get::<ScIsConnectedFn>(b"scIsConnected\0")
                    .ok()
                    .map(|s| *s);
                (create_camera, delete_camera, send_frame, is_connected)
            };

            if let (Some(create_camera), Some(delete_camera), Some(send_frame), is_connected) =
                symbols
            {
                return Some(LoadedSoftcam {
                    _lib: lib,
                    create_camera,
                    delete_camera,
                    send_frame,
                    is_connected,
                });
            }
        }
        None
    }

    pub fn is_driver_ready(&self) -> bool {
        self.api.is_some() && !self.camera_handle.is_null()
    }

    pub fn is_streaming(&self) -> bool {
        !self.camera_handle.is_null() && self.receiving_live_video
    }

    pub fn is_client_connected(&self) -> bool {
        if let (Some(api), false) = (self.api.as_ref(), self.camera_handle.is_null()) {
            if let Some(check_fn) = api.is_connected {
                return unsafe { check_fn(self.camera_handle) };
            }
        }
        false
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn frames_sent(&self) -> u64 {
        self.frames_sent
    }

    fn ensure_camera(&mut self) -> Result<(), String> {
        if self.api.is_none() {
            self.api = Self::try_load_library();
        }
        let Some(api) = self.api.as_ref() else {
            return Err(
                "softcam.dll not found — run PhoneWebcam-Setup.exe to register the DirectShow driver."
                    .into(),
            );
        };

        if !self.camera_handle.is_null() {
            return Ok(());
        }

        // Passing framerate = 0.0 tells softcam to deliver real-time frames immediately
        // without sleeping inside scSendFrame (per softcam.h docs).
        let handle = unsafe {
            (api.create_camera)(
                VIRTUAL_CAM_WIDTH as c_int,
                VIRTUAL_CAM_HEIGHT as c_int,
                0.0 as c_float,
            )
        };
        if handle.is_null() {
            return Err(
                "scCreateCamera returned null (another PhoneWebcam Bridge instance may already be running)."
                    .into(),
            );
        }

        self.camera_handle = handle;
        self.width = VIRTUAL_CAM_WIDTH;
        self.height = VIRTUAL_CAM_HEIGHT;
        self.bgr_buffer
            .resize((VIRTUAL_CAM_WIDTH as usize) * (VIRTUAL_CAM_HEIGHT as usize) * 3, 0);
        Ok(())
    }

    /// Sends a clean dark standby frame (#0B161A) while keeping the DirectShow camera active
    /// so Google Meet / Zoom / Teams never disconnect or show "Camera unavailable".
    pub fn send_standby_frame(&mut self) {
        self.receiving_live_video = false;
        if self.camera_handle.is_null() {
            return;
        }
        for px in self.bgr_buffer.chunks_exact_mut(3) {
            px[0] = 0x1A; // B
            px[1] = 0x16; // G
            px[2] = 0x0B; // R
        }
        if let Some(api) = self.api.as_ref() {
            unsafe { (api.send_frame)(self.camera_handle, self.bgr_buffer.as_ptr()) };
        }
    }

    /// Converts an RGBA32 1280x720 frame from WebView2 Canvas into top-down BGR24
    /// (softcam's FrameBuffer::transferToDIB handles bottom-up DIB flipping internally).
    pub fn push_rgba_frame(&mut self, rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
        if width != VIRTUAL_CAM_WIDTH || height != VIRTUAL_CAM_HEIGHT {
            return Err(format!(
                "Expected {}x{} frame, got {}x{}",
                VIRTUAL_CAM_WIDTH, VIRTUAL_CAM_HEIGHT, width, height
            ));
        }

        let expected_rgba = (VIRTUAL_CAM_WIDTH as usize) * (VIRTUAL_CAM_HEIGHT as usize) * 4;
        if rgba.len() != expected_rgba {
            return Err(format!(
                "RGBA byte length mismatch: expected {}, got {}",
                expected_rgba,
                rgba.len()
            ));
        }

        self.ensure_camera()?;

        let mut out_idx = 0usize;
        for px in rgba.chunks_exact(4) {
            self.bgr_buffer[out_idx] = px[2]; // B
            self.bgr_buffer[out_idx + 1] = px[1]; // G
            self.bgr_buffer[out_idx + 2] = px[0]; // R
            out_idx += 3;
        }

        if let Some(api) = self.api.as_ref() {
            if !self.camera_handle.is_null() {
                unsafe { (api.send_frame)(self.camera_handle, self.bgr_buffer.as_ptr()) };
                self.frames_sent = self.frames_sent.saturating_add(1);
                self.receiving_live_video = true;
            }
        }

        Ok(())
    }

    pub fn shutdown(&mut self) {
        self.receiving_live_video = false;
        if let Some(api) = self.api.as_ref() {
            if !self.camera_handle.is_null() {
                unsafe { (api.delete_camera)(self.camera_handle) };
                self.camera_handle = std::ptr::null_mut();
            }
        }
        self.width = 0;
        self.height = 0;
    }
}

impl Drop for SoftcamDriver {
    fn drop(&mut self) {
        self.shutdown();
    }
}
