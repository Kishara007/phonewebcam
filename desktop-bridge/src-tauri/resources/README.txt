Place the compiled x64 Release `softcam.dll` (from https://github.com/tshino/softcam)
into this directory before running `cargo tauri build --bundles nsis`.

GitHub Actions (`.github/workflows/build-desktop-bridge.yml`) compiles and copies
`softcam.dll` here automatically on every release build.
