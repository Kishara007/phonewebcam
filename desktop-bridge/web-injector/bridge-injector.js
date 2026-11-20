/**
 * PhoneWebcam Desktop Bridge — WebView2 Initialization Script
 *
 * Injected strictly into https://phonewebcam.pages.dev inside the lightweight Tauri v2
 * Windows Desktop Bridge. Leaves PhoneWebcam's WebRTC engine 100% untouched:
 *   - Observes the live PC Receiver <video> element and its incoming WebRTC MediaStream
 *   - Renders onto a fixed 1280x720 HD canvas (multiples of 4, preserving aspect ratio,
 *     rotation, and mirror) and streams RGBA via Tauri v2 raw binary IPC -> Softcam DirectShow
 *   - Streams raw f32 PCM audio via Tauri v2 binary IPC -> Rust -> Windows WASAPI (VB-Cable)
 */
(function () {
  if (typeof window === 'undefined') return;
  const host = window.location.hostname || '';
  if (host !== 'phonewebcam.pages.dev' && !host.endsWith('.phonewebcam.pages.dev')) {
    return;
  }

  const OUT_WIDTH = 1280;
  const OUT_HEIGHT = 720;
  const TARGET_FPS = 30;
  const MIN_FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

  let activeVideo = null;
  let activeStreamId = null;
  let videoInFlight = false;
  let lastFrameTs = 0;
  let rafId = null;
  let vfcHandle = null;
  let lastVideoError = '';

  let audioCtx = null;
  let audioSource = null;
  let audioProcessor = null;
  let silentGain = null;
  let audioInFlight = false;

  const canvas = document.createElement('canvas');
  canvas.width = OUT_WIDTH;
  canvas.height = OUT_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });

  function getInvoke() {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke;
    }
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke;
    }
    return null;
  }

  function parseTransform(video) {
    const tf = (video && video.style && video.style.transform) || '';
    const rotMatch = tf.match(/rotate\((-?\d+)deg\)/i);
    const rawDeg = rotMatch ? parseInt(rotMatch[1], 10) : 0;
    const rotation = ((rawDeg % 360) + 360) % 360;
    const mirror = /scaleX\(-1\)/i.test(tf);
    return { rotation, mirror };
  }

  function teardownAudioCapture() {
    try {
      if (audioProcessor) {
        audioProcessor.onaudioprocess = null;
        audioProcessor.disconnect();
      }
    } catch (_) {}
    try {
      if (audioSource) audioSource.disconnect();
    } catch (_) {}
    try {
      if (silentGain) silentGain.disconnect();
    } catch (_) {}
    try {
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
    } catch (_) {}
    audioProcessor = null;
    audioSource = null;
    silentGain = null;
    audioCtx = null;
  }

  function startAudioCapture(stream) {
    teardownAudioCapture();
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks || audioTracks.length === 0) return;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
      audioCtx = new AudioCtx({ sampleRate: 48000 });
    } catch (_) {
      audioCtx = new AudioCtx();
    }

    try {
      const audioOnly = new MediaStream(audioTracks);
      audioSource = audioCtx.createMediaStreamSource(audioOnly);
      audioProcessor = audioCtx.createScriptProcessor(2048, 1, 1);
      silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;

      audioProcessor.onaudioprocess = (evt) => {
        if (audioInFlight) return;
        const invoke = getInvoke();
        if (!invoke || !audioCtx) return;

        const input = evt.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        const bytes = new Uint8Array(copy.buffer);

        audioInFlight = true;
        invoke('push_audio_chunk', bytes, {
          headers: {
            'x-sample-rate': String(audioCtx.sampleRate || 48000),
            'x-channels': '1',
          },
        })
          .catch(() => {})
          .finally(() => {
            audioInFlight = false;
          });
      };

      audioSource.connect(audioProcessor);
      audioProcessor.connect(silentGain);
      silentGain.connect(audioCtx.destination);
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    } catch (_) {
      teardownAudioCapture();
    }
  }

  function stopVideoLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (
      activeVideo &&
      vfcHandle !== null &&
      typeof activeVideo.cancelVideoFrameCallback === 'function'
    ) {
      try {
        activeVideo.cancelVideoFrameCallback(vfcHandle);
      } catch (_) {}
      vfcHandle = null;
    }
  }

  function captureAndSendFrame(now) {
    if (!activeVideo || !ctx) return;
    if (!activeVideo.srcObject || activeVideo.readyState < 2 || activeVideo.videoWidth === 0) {
      return;
    }

    if (videoInFlight || now - lastFrameTs < MIN_FRAME_INTERVAL_MS) {
      return;
    }

    const invoke = getInvoke();
    if (!invoke) return;

    const srcW = activeVideo.videoWidth;
    const srcH = activeVideo.videoHeight;
    const { rotation, mirror } = parseTransform(activeVideo);
    const swapped = rotation === 90 || rotation === 270;

    // Fit incoming frame cleanly inside fixed 1280x720 canvas with zero distortion
    const visW = swapped ? srcH : srcW;
    const visH = swapped ? srcW : srcH;
    const scale = Math.min(OUT_WIDTH / visW, OUT_HEIGHT / visH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#060E12';
    ctx.fillRect(0, 0, OUT_WIDTH, OUT_HEIGHT);
    ctx.translate(OUT_WIDTH / 2, OUT_HEIGHT / 2);
    if (mirror) ctx.scale(-1, 1);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(activeVideo, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    const imageData = ctx.getImageData(0, 0, OUT_WIDTH, OUT_HEIGHT);
    const rawBytes = new Uint8Array(
      imageData.data.buffer,
      imageData.data.byteOffset,
      imageData.data.byteLength
    );

    lastFrameTs = now;
    videoInFlight = true;
    invoke('push_video_frame', rawBytes, {
      headers: {
        'x-width': String(OUT_WIDTH),
        'x-height': String(OUT_HEIGHT),
      },
    })
      .then(() => {
        lastVideoError = '';
      })
      .catch((err) => {
        lastVideoError = String(err || 'IPC error');
      })
      .finally(() => {
        videoInFlight = false;
      });
  }

  function scheduleNextFrame() {
    if (!activeVideo) return;
    if (typeof activeVideo.requestVideoFrameCallback === 'function') {
      vfcHandle = activeVideo.requestVideoFrameCallback((now) => {
        vfcHandle = null;
        captureAndSendFrame(now);
        scheduleNextFrame();
      });
    } else {
      rafId = requestAnimationFrame((now) => {
        rafId = null;
        captureAndSendFrame(now);
        scheduleNextFrame();
      });
    }
  }

  function detachStream() {
    stopVideoLoop();
    teardownAudioCapture();
    activeVideo = null;
    activeStreamId = null;
    const invoke = getInvoke();
    if (invoke) {
      invoke('stop_virtual_devices').catch(() => {});
    }
  }

  function scanForLiveVideo() {
    const videos = document.querySelectorAll('video');
    let candidate = null;

    for (const v of videos) {
      if (v.srcObject instanceof MediaStream && v.videoWidth > 0 && v.videoHeight > 0) {
        candidate = v;
        break;
      }
    }

    if (!candidate) {
      if (activeVideo) detachStream();
      return;
    }

    const stream = candidate.srcObject;
    if (activeVideo === candidate && activeStreamId === stream.id) {
      return;
    }

    stopVideoLoop();
    activeVideo = candidate;
    activeStreamId = stream.id;
    startAudioCapture(stream);
    scheduleNextFrame();
  }

  function mountStatusPill() {
    if (document.getElementById('pwc-bridge-pill')) return;
    const pill = document.createElement('div');
    pill.id = 'pwc-bridge-pill';
    pill.setAttribute('role', 'status');
    pill.style.cssText = [
      'position:fixed',
      'right:14px',
      'bottom:14px',
      'z-index:99999',
      'display:inline-flex',
      'align-items:center',
      'gap:8px',
      'padding:7px 12px',
      'border-radius:999px',
      'background:rgba(11,22,26,0.92)',
      'color:#E3FDFD',
      'border:1px solid rgba(113,201,206,0.45)',
      'font:600 12px/1.2 system-ui,-apple-system,Segoe UI,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,0.28)',
      'backdrop-filter:blur(8px)',
    ].join(';');

    const dot = document.createElement('span');
    dot.style.cssText =
      'width:8px;height:8px;border-radius:50%;background:#71C9CE;display:inline-block;flex-shrink:0;';

    const text = document.createElement('span');
    text.textContent = 'Bridge Active · Initializing…';

    const vbBtn = document.createElement('button');
    vbBtn.type = 'button';
    vbBtn.textContent = 'Setup VB-Cable';
    vbBtn.style.cssText = [
      'display:none',
      'margin-left:4px',
      'padding:3px 8px',
      'border-radius:999px',
      'border:none',
      'cursor:pointer',
      'background:#71C9CE',
      'color:#0F172A',
      'font:700 11px/1.2 system-ui,sans-serif',
    ].join(';');
    vbBtn.addEventListener('click', () => {
      const invoke = getInvoke();
      if (invoke) invoke('open_vbcable_setup').catch(() => {});
    });

    pill.appendChild(dot);
    pill.appendChild(text);
    pill.appendChild(vbBtn);
    document.body.appendChild(pill);

    const pollStatus = () => {
      const invoke = getInvoke();
      if (!invoke) {
        text.textContent = 'Bridge IPC Unavailable';
        dot.style.background = '#F43F5E';
        return;
      }
      invoke('get_bridge_status')
        .then((st) => {
          const camLabel = st.camera_streaming
            ? st.client_connected
              ? `Virtual Cam Live (${st.width}×${st.height} · In Use)`
              : `Virtual Cam Live (${st.width}×${st.height})`
            : st.camera_driver_ready
              ? `Virtual Cam Ready (${st.width}×${st.height})`
              : 'Virtual Cam Driver Missing';
          const micLabel = st.audio_cable_detected ? 'Mic: VB-Cable' : 'Mic: No VB-Cable';
          text.textContent = lastVideoError
            ? `${camLabel} · ${lastVideoError}`
            : `${camLabel} · ${micLabel}`;
          dot.style.background = st.camera_streaming
            ? '#34D399'
            : st.camera_driver_ready
              ? '#71C9CE'
              : '#F59E0B';
          vbBtn.style.display = st.audio_cable_detected ? 'none' : 'inline-block';
        })
        .catch((err) => {
          text.textContent = `Bridge Error: ${String(err || 'ACL denied').slice(0, 60)}`;
          dot.style.background = '#F43F5E';
        });
    };

    pollStatus();
    setInterval(pollStatus, 1500);
  }

  window.addEventListener('DOMContentLoaded', () => {
    mountStatusPill();
    setInterval(scanForLiveVideo, 700);
  });

  window.addEventListener('beforeunload', () => {
    detachStream();
  });
})();
