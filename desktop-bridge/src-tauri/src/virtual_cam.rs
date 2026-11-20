use libloading::Library;
use std::ffi::{c_float, c_int, c_void};
use std::path::PathBuf;

type ScCreateCameraFn = unsafe extern "C" fn(width: c_int, height: c_int, framerate: c_float) -> *mut c_void;
type ScDeleteCameraFn = unsafe extern "C" fn(camera: *mut c_void);
type ScSendFrameFn = unsafe extern "C" fn(camera: *mut c_void, image_bits: *const u8);

struct LoadedSoftcam {
    // Keep the loaded DLL handle alive for as long as the function pointers are used.
    _lib: Library,
    create_camera: ScCreateCameraFn,
    delete_camera: ScDeleteCameraFn,
    send_frame: ScSendFrameFn,
}

/// Manages a user-mode DirectShow virtual camera via `softcam.dll` (shared memory).
///
/// Wrapped inside a `Mutex<SoftcamDriver>` so only one thread ever touches the raw
/// `scCamera` handle at a time.
pub struct SoftcamDriver {
    api: Option<LoadedSoftcam>,
    camera_handle: *mut c_void,
    width: u32,
    height: u32,
    fps: f32,
    bgr_buffer: Vec<u8>,
    frames_sent: u64,
}

// SAFETY: Access is serialized behind `std::sync::Mutex` in `BridgeState`.
unsafe impl Send for SoftcamDriver {}

impl SoftcamDriver {
    pub fn new() -> Self {
        let api = Self::try_load_library();
        Self {
            api,
            camera_handle: std::ptr::null_mut(),
            width: 0,
            height: 0,
            fps: 30.0,
            bgr_buffer: Vec::new(),
            frames_sent: 0,
        }
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
                let create_camera = lib.get::<ScCreateCameraFn>(b"scCreateCamera\0").ok().map(|s| *s);
                let delete_camera = lib.get::<ScDeleteCameraFn>(b"scDeleteCamera\0").ok().map(|s| *s);
                let send_frame = lib.get::<ScSendFrameFn>(b"scSendFrame\0").ok().map(|s| *s);
                (create_camera, delete_camera, send_frame)
            };

            if let (Some(create_camera), Some(delete_camera), Some(send_frame)) = symbols {
                return Some(LoadedSoftcam {
                    _lib: lib,
                    create_camera,
                    delete_camera,
                    send_frame,
                });
            }
        }
        None
    }

    pub fn is_driver_ready(&self) -> bool {
        self.api.is_some()
    }

    pub fn is_streaming(&self) -> bool {
        !self.camera_handle.is_null()
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn frames_sent(&self) -> u64 {
        self.frames_sent
    }

    fn ensure_camera(&mut self, width: u32, height: u32, fps: f32) -> Result<(), String> {
        if self.api.is_none() {
            self.api = Self::try_load_library();
        }
        let Some(api) = self.api.as_ref() else {
            return Err("softcam.dll not found — run PhoneWebcam-Setup.exe to register the DirectShow driver.".into());
        };

        if !self.camera_handle.is_null() && self.width == width && self.height == height {
            return Ok(());
        }

        if !self.camera_handle.is_null() {
            unsafe { (api.delete_camera)(self.camera_handle) };
            self.camera_handle = std::ptr::null_mut();
        }

        let handle = unsafe { (api.create_camera)(width as c_int, height as c_int, fps as c_float) };
        if handle.is_null() {
            return Err("scCreateCamera returned null".into());
        }

        self.camera_handle = handle;
        self.width = width;
        self.height = height;
        self.fps = fps;
        self.bgr_buffer.resize((width as usize) * (height as usize) * 3, 0);
        Ok(())
    }

    /// Converts an RGBA32 frame from WebView2 Canvas into BGR24 and pushes it to DirectShow.
    pub fn push_rgba_frame(&mut self, rgba: &[u8], width: u32, height: u32, fps: f32) -> Result<(), String> {
        let expected_rgba = (width as usize)
            .checked_mul(height as usize)
            .and_then(|px| px.checked_mul(4))
            .ok_or_else(|| "Invalid frame dimensions".to_string())?;

        if rgba.len() != expected_rgba || width == 0 || height == 0 {
            return Err("RGBA frame size mismatch".into());
        }

        self.ensure_camera(width, height, fps)?;

        // Tight zero-allocation RGBA -> BGR24 conversion for DirectShow Softcam.
        let mut out_idx = 0usize;
        for px in rgba.chunks_exact(4) {
            self.bgr_buffer[out_idx] = px[2];     // B
            self.bgr_buffer[out_idx + 1] = px[1]; // G
            self.bgr_buffer[out_idx + 2] = px[0]; // R
            out_idx += 3;
        }

        if let Some(api) = self.api.as_ref() {
            if !self.camera_handle.is_null() {
                unsafe { (api.send_frame)(self.camera_handle, self.bgr_buffer.as_ptr()) };
                self.frames_sent = self.frames_sent.saturating_add(1);
            }
        }

        Ok(())
    }

    pub fn stop(&mut self) {
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
        self.stop();
    }
}
