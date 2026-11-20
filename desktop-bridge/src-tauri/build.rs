fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "push_video_frame",
            "push_audio_chunk",
            "stop_virtual_devices",
            "get_bridge_status",
            "open_vbcable_setup",
        ]),
    );

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
