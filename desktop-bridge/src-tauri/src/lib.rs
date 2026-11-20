mod audio_bridge;
mod virtual_cam;

use audio_bridge::AudioBridge;
use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request};
use tauri::{State, WebviewUrl, WebviewWindowBuilder};
use virtual_cam::SoftcamDriver;

const PHONEWEBCAM_URL: &str = "https://phonewebcam.pages.dev/?mode=pc";
const BRIDGE_INJECTOR_JS: &str = include_str!("../../web-injector/bridge-injector.js");

pub struct BridgeState {
    camera: Mutex<SoftcamDriver>,
    audio: AudioBridge,
}

#[derive(Serialize)]
struct BridgeStatus {
    camera_driver_ready: bool,
    camera_streaming: bool,
    client_connected: bool,
    width: u32,
    height: u32,
    frames_sent: u64,
    audio_cable_detected: bool,
    audio_device_name: Option<String>,
}

fn parse_header_u32(req: &Request<'_>, name: &str, default: u32) -> u32 {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(default)
}

#[tauri::command]
fn push_video_frame(request: Request<'_>, state: State<'_, BridgeState>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw RGBA frame bytes".into());
    };

    let width = parse_header_u32(&request, "x-width", virtual_cam::VIRTUAL_CAM_WIDTH);
    let height = parse_header_u32(&request, "x-height", virtual_cam::VIRTUAL_CAM_HEIGHT);

    let mut cam = state
        .camera
        .lock()
        .map_err(|_| "Virtual camera lock poisoned".to_string())?;
    cam.push_rgba_frame(bytes, width, height)
}

#[tauri::command]
fn push_audio_chunk(request: Request<'_>, state: State<'_, BridgeState>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw PCM f32 audio bytes".into());
    };

    let sample_rate = parse_header_u32(&request, "x-sample-rate", 48_000);
    state.audio.push_f32_pcm(bytes, sample_rate);
    Ok(())
}

#[tauri::command]
fn stop_virtual_devices(state: State<'_, BridgeState>) -> Result<(), String> {
    if let Ok(mut cam) = state.camera.lock() {
        // Keep the DirectShow camera alive on a dark standby frame so Meet/Zoom never drops it.
        cam.send_standby_frame();
    }
    state.audio.clear();
    Ok(())
}

#[tauri::command]
fn get_bridge_status(state: State<'_, BridgeState>) -> BridgeStatus {
    let (camera_driver_ready, camera_streaming, client_connected, width, height, frames_sent) =
        if let Ok(cam) = state.camera.lock() {
            let (w, h) = cam.dimensions();
            (
                cam.is_driver_ready(),
                cam.is_streaming(),
                cam.is_client_connected(),
                w,
                h,
                cam.frames_sent(),
            )
        } else {
            (false, false, false, 0, 0, 0)
        };

    BridgeStatus {
        camera_driver_ready,
        camera_streaming,
        client_connected,
        width,
        height,
        frames_sent,
        audio_cable_detected: state.audio.is_cable_detected(),
        audio_device_name: state.audio.device_name(),
    }
}

#[tauri::command]
fn open_vbcable_setup() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "https://vb-audio.com/Cable/"])
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bridge_state = BridgeState {
        camera: Mutex::new(SoftcamDriver::new()),
        audio: AudioBridge::new(),
    };

    tauri::Builder::default()
        .manage(bridge_state)
        .invoke_handler(tauri::generate_handler![
            push_video_frame,
            push_audio_chunk,
            stop_virtual_devices,
            get_bridge_status,
            open_vbcable_setup,
        ])
        .setup(|app| {
            let url = WebviewUrl::External(
                PHONEWEBCAM_URL
                    .parse()
                    .expect("valid PhoneWebcam production URL"),
            );

            WebviewWindowBuilder::new(app, "main", url)
                .title("PhoneWebcam — Virtual Camera & Mic Bridge")
                .inner_size(1120.0, 780.0)
                .min_inner_size(760.0, 580.0)
                .center()
                .initialization_script(BRIDGE_INJECTOR_JS)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running PhoneWebcam Bridge");
}
