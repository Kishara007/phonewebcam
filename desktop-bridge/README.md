# PhoneWebcam Desktop Bridge (Windows 10/11 — < 7 MB)

A lightweight **Tauri v2 (Rust + system WebView2)** Windows companion app that turns [PhoneWebcam](https://phonewebcam.pages.dev/) into a native Windows **Virtual Camera** and **Virtual Microphone** for **Google Meet, Zoom, Microsoft Teams, and Discord** — no OBS Studio required.

## Architecture

1. **System WebView2 Shell (`src-tauri/src/lib.rs`):** Loads `https://phonewebcam.pages.dev/?mode=pc` directly (zero Electron/Chromium bloat, always up to date with the live web app).
2. **Zero-Invasion WebView2 Injector (`web-injector/bridge-injector.js`):** Strictly scoped to `phonewebcam.pages.dev`. Captures incoming WebRTC `<video>` frames (preserving active rotation/mirror) and Web Audio PCM chunks, sending raw binary buffers over Tauri v2 `InvokeBody::Raw` IPC.
3. **DirectShow Virtual Camera (`src-tauri/src/virtual_cam.rs`):** Dynamically loads `softcam.dll` (from [tshino/softcam](https://github.com/tshino/softcam)), converts RGBA → BGR24 in zero-allocation Rust, and pushes frames into DirectShow shared memory.
4. **Windows WASAPI Audio Router (`src-tauri/src/audio_bridge.rs`):** Streams low-latency resampled PCM audio directly to VB-Cable (`CABLE Input`) via `cpal` WASAPI.
5. **1-Click Installer (`installer/hooks.nsh` & `installer/PhoneWebcam-Setup.iss`):** Registers `softcam.dll` (`regsvr32 /s`) during install, unregisters cleanly on uninstall (`regsvr32 /u /s`), and offers a 1-click VB-Cable setup assistant if `CABLE Input` is not yet installed.

## Local Windows Build

Prerequisites: Rust (`x86_64-pc-windows-msvc`), Visual Studio 2022 C++ Build Tools, and `cargo install tauri-cli --version "^2"`.

```powershell
# 1. Build x64 Release softcam.dll from https://github.com/tshino/softcam
#    and copy it to desktop-bridge/src-tauri/resources/softcam.dll

# 2. Build the < 7 MB NSIS 1-Click Installer
cd desktop-bridge/src-tauri
cargo tauri build --bundles nsis
```

## Automated Releases (GitHub Actions)

Tagging any release (`git tag v1.0.0 && git push origin v1.0.0`) automatically triggers [`.github/workflows/build-desktop-bridge.yml`](../.github/workflows/build-desktop-bridge.yml) on `windows-latest`, builds `softcam.dll` + `PhoneWebcam-Setup.exe` (< 10 MB), and publishes it to GitHub Releases at:

`https://github.com/Kishara007/phonewebcam/releases/latest/download/PhoneWebcam-Setup.exe`
