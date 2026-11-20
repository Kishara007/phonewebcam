/**
 * PhoneWebcam Desktop Bridge — WebView2 Initialization Script
 *
 * Injected strictly into https://phonewebcam.pages.dev inside the lightweight Tauri v2
 * Windows Desktop Bridge. Leaves PhoneWebcam's WebRTC engine 100% untouched:
 *   - Observes the live PC Receiver <video> element and its incoming WebRTC MediaStream
 *   - Streams raw RGBA frames via Tauri v2 binary IPC -> Rust -> Softcam DirectShow Virtual Cam
 *   - Streams raw f32 PCM audio via Tauri v2 binary IPC -> Rust -> Windows WASAPI (VB-Cable)
 */
(function () {
  if (typeof window === 'undefined') return;
  const host = window.location.hostname || '';
  if (host !== 'phonewebcam.pages.dev' && !host.endsWith('.phonewebcam.pages.dev')) {
    return;
  }

  const MAX_WIDTH = 1280;
  const MAX_HEIGHT = 720;
  const TARGET_FPS = 30;
  const MIN_FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

  let activeVideo = null;
  let activeStreamId = null;
  let videoInFlight = false;
  let lastFrameTs = 0;
  let rafId = null;
  let vfcHandle = null;

  let audioCtx = null;
  let audioSource = null;
  let audioProcessor = null;
  let silentGain = null;
  let audioInFlight = false;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });

  function getInvoke() {
    return window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke
      ? window.__TAURI__.core.invoke
      : null;
  }

  function parseTransform(video) {
    const tf = (video && video.style && video.style.transform) || '';
    const rotMatch = tf.match(/rotate\((-?\d+)deg\)/i);
    const rawDeg = rotMatch ? parseInt(rotMatch[1], 10) : 0;
    const rotation = ((rawDeg % 360) + 360) % 360;
    const mirror = /scaleX\(-1\)/i.test(tf);
    return { rotation, mirror };
  }

  function computeEvenDimensions(srcW, srcH, rotation) {
    const swapped = rotation === 90 || rotation === 270;
    let w = swapped ? srcH : srcW;
    let h = swapped ? srcW : srcH;

    const scale = Math.min(1, MAX_WIDTH / w, MAX_HEIGHT / h);
    w = Math.max(16, Math.floor((w * scale) / 2) * 2);
    h = Math.max(16, Math.floor((h * scale) / 2) * 2);
    return { w, h };
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
        // Clone sample buffer before handing across async IPC boundary
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
    if (activeVideo && vfcHandle !== null && typeof activeVideo.cancelVideoFrameCallback === 'function') {
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

    const { rotation, mirror } = parseTransform(activeVideo);
    const { w, h } = computeEvenDimensions(activeVideo.videoWidth, activeVideo.videoHeight, rotation);

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    if (mirror) ctx.scale(-1, 1);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);

    const swapped = rotation === 90 || rotation === 270;
    const drawW = swapped ? h : w;
    const drawH = swapped ? w : h;
    ctx.drawImage(activeVideo, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    const imageData = ctx.getImageData(0, 0, w, h);
    const rawBytes = new Uint8Array(
      imageData.data.buffer,
      imageData.data.byteOffset,
      imageData.data.byteLength
    );

    lastFrameTs = now;
    videoInFlight = true;
    invoke('push_video_frame', rawBytes, {
      headers: {
        'x-width': String(w),
        'x-height': String(h),
        'x-fps': String(TARGET_FPS),
      },
    })
      .catch(() => {})
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
        // Prefer remote WebRTC stream (PC Receiver) over local camera preview
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

    setInterval(() => {
      const invoke = getInvoke();
      if (!invoke) return;
      invoke('get_bridge_status')
        .then((st) => {
          const camLabel = st.camera_streaming
            ? `Virtual Cam Live (${st.width}×${st.height})`
            : st.camera_driver_ready
              ? 'Virtual Cam Ready'
              : 'Virtual Cam Driver Missing';
          const micLabel = st.audio_cable_detected ? 'Mic: VB-Cable' : 'Mic: No VB-Cable';
          text.textContent = `${camLabel} · ${micLabel}`;
          dot.style.background = st.camera_streaming
            ? '#34D399'
            : st.camera_driver_ready
              ? '#71C9CE'
              : '#F59E0B';
          vbBtn.style.display = st.audio_cable_detected ? 'none' : 'inline-block';
        })
        .catch(() => {});
    }, 1500);
  }

  window.addEventListener('DOMContentLoaded', () => {
    mountStatusPill();
    setInterval(scanForLiveVideo, 700);
  });

  window.addEventListener('beforeunload', () => {
    detachStream();
  });
})();
