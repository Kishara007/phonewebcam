import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type Peer from 'peerjs';
import type { DataConnection, MediaConnection } from 'peerjs';
import {
  DEFAULT_LANG,
  LANG_CHANGE_EVENT,
  getStoredLang,
  translate,
  type LanguageCode,
  type TranslationKey,
} from '@/i18n';
import {
  ROOM_CODE_LENGTH,
  detectMobileDevice,
  generateRoomCode,
  getObsCleanViewUrl,
  getPhonePairUrl,
  getReceiverPeerId,
  getSenderPeerId,
  isValidRoomCode,
  sanitizeRoomCode,
} from '@/lib/roomCode';
import { downloadObsSceneCollection } from '@/lib/obsConfig';
import {
  PEER_OPTIONS,
  RTC_CONFIG,
  acquireCameraStream,
  attachStreamToVideo,
  buildMediaConstraints,
  getRelayFallbackPeerOptions,
  getSkippedTurnProviders,
  isTurnQuotaUnavailable,
  mapMediaErrorToKey,
  mapPeerErrorToKey,
  measurePeerTelemetry,
  monitorTurnQuotaErrors,
  patchPeerJsIceQueue,
  preferSafeVideoCodecs,
  skipTurnProvider,
  type ActiveTurnProvider,
  type CallMetadata,
  type CameraFacing,
  type ConnectionStatus,
  type PeerControlMessage,
  type VideoQuality,
} from '@/lib/webrtc';
import { AudioMeter } from './AudioMeter';
import { ObsCleanView } from './ObsCleanView';
import {
  AlertIcon,
  CameraIcon,
  CheckIcon,
  CopyIcon,
  DisconnectIcon,
  DownloadIcon,
  ExitFullscreenIcon,
  FlashIcon,
  FullscreenIcon,
  LinkIcon,
  MicIcon,
  MicOffIcon,
  MirrorIcon,
  MonitorIcon,
  RefreshIcon,
  SmartphoneIcon,
  SunAwakeIcon,
  SwitchCameraIcon,
  VolumeOffIcon,
  VolumeOnIcon,
} from './Icons';

type ToolMode = 'pc' | 'phone';

interface TrackCapabilitiesWithTorch extends MediaTrackCapabilities {
  torch?: boolean;
}

export const WebcamTool: React.FC = () => {
  const [lang, setLang] = useState<LanguageCode>(DEFAULT_LANG);
  const [hydrated, setHydrated] = useState(false);

  // Clean OBS View (?view=CODE)
  const [obsViewCode, setObsViewCode] = useState<string | null>(null);

  // Active Mode
  const [mode, setMode] = useState<ToolMode>('pc');

  // === Desktop Receiver State ===
  const [roomCode, setRoomCode] = useState<string>('');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [pcStatus, setPcStatus] = useState<ConnectionStatus>('waiting');
  const [pcErrorKey, setPcErrorKey] = useState<TranslationKey | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [hasVideoFrames, setHasVideoFrames] = useState<boolean>(false);
  const [mirrorVideo, setMirrorVideo] = useState<boolean>(false);
  const [monitorMuted, setMonitorMuted] = useState<boolean>(true); // Default muted to prevent echo
  const [phoneMicMuted, setPhoneMicMuted] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [resolutionLabel, setResolutionLabel] = useState<string>('');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [isRelayed, setIsRelayed] = useState<boolean>(false);
  const [pcRetryingRelay, setPcRetryingRelay] = useState<boolean>(false);
  const [pcCallAttempt, setPcCallAttempt] = useState<number>(0);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [copiedObsUrl, setCopiedObsUrl] = useState<boolean>(false);
  const [obsDownloaded, setObsDownloaded] = useState<boolean>(false);
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>('');
  const [pcSessionNonce, setPcSessionNonce] = useState<number>(0);

  // Desktop Refs
  const pcVideoRef = useRef<HTMLVideoElement | null>(null);
  const pcVideoContainerRef = useRef<HTMLDivElement | null>(null);
  const pcPeerRef = useRef<Peer | null>(null);
  const pcActiveCallRef = useRef<MediaConnection | null>(null);
  const pcDataConnRef = useRef<DataConnection | null>(null);
  const pcRelayWaitTimerRef = useRef<number | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const obsRelayPeersRef = useRef<Set<string>>(new Set());

  // === Phone Sender State ===
  const [codeChars, setCodeChars] = useState<string[]>(['', '', '', '']);
  const [autoFilledFromQr, setAutoFilledFromQr] = useState<boolean>(false);
  const [facingMode, setFacingMode] = useState<CameraFacing>('user');
  const [quality, setQuality] = useState<VideoQuality>('720p');
  const [phoneStatus, setPhoneStatus] = useState<ConnectionStatus>('ready');
  const [phoneErrorKey, setPhoneErrorKey] = useState<TranslationKey | null>(null);
  const [phoneRetryingRelay, setPhoneRetryingRelay] = useState<boolean>(false);
  const [phoneIsRelayed, setPhoneIsRelayed] = useState<boolean>(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isStartingCamera, setIsStartingCamera] = useState<boolean>(false);
  const [isSwitchingCamera, setIsSwitchingCamera] = useState<boolean>(false);
  const [micMuted, setMicMuted] = useState<boolean>(false);
  const [torchSupported, setTorchSupported] = useState<boolean>(false);
  const [torchOn, setTorchOn] = useState<boolean>(false);
  const [wakeLockSupported, setWakeLockSupported] = useState<boolean>(false);
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);

  // Phone Refs
  const codeInputRefs = useRef<Array<HTMLInputElement | null>>([null, null, null, null]);
  const phoneVideoRef = useRef<HTMLVideoElement | null>(null);
  const phonePeerRef = useRef<Peer | null>(null);
  const phoneCallRef = useRef<MediaConnection | null>(null);
  const phoneDataConnRef = useRef<DataConnection | null>(null);
  const phoneConnectTimerRef = useRef<number | null>(null);
  const phoneSessionGenRef = useRef<number>(0);
  const localStreamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const wantWakeLockRef = useRef<boolean>(false);

  const t = useCallback((key: TranslationKey) => translate(lang, key), [lang]);

  // Sync i18n language from localStorage + global navbar switcher
  useEffect(() => {
    setLang(getStoredLang());
    const onLangChange = (evt: Event) => {
      const next = (evt as CustomEvent<LanguageCode>).detail;
      if (next) setLang(next);
    };
    window.addEventListener(LANG_CHANGE_EVENT, onLangChange);
    return () => window.removeEventListener(LANG_CHANGE_EVENT, onLangChange);
  }, []);

  // Initialize URL params, device detection, and Wake Lock support on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');

    if (viewParam) {
      const sanitized = sanitizeRoomCode(viewParam);
      if (sanitized.length === ROOM_CODE_LENGTH) {
        setObsViewCode(sanitized);
        setHydrated(true);
        return;
      }
    }

    const modeParam = params.get('mode')?.toLowerCase();
    const codeParam = sanitizeRoomCode(params.get('code') || '');

    if (modeParam === 'phone' || codeParam.length > 0) {
      setMode('phone');
      if (codeParam.length === ROOM_CODE_LENGTH) {
        setCodeChars(codeParam.split(''));
        setAutoFilledFromQr(true);
      }
    } else if (modeParam === 'pc') {
      setMode('pc');
    } else {
      setMode(detectMobileDevice() ? 'phone' : 'pc');
    }

    setRoomCode(generateRoomCode());
    setWakeLockSupported(
      typeof navigator !== 'undefined' &&
        'wakeLock' in navigator &&
        typeof navigator.wakeLock?.request === 'function'
    );
    setHydrated(true);
  }, []);

  useEffect(() => {
    remoteStreamRef.current = remoteStream;
  }, [remoteStream]);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  // === Wake Lock helpers (Phone Sender) ===
  const releaseWakeLock = useCallback(async () => {
    wantWakeLockRef.current = false;
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
      } catch {
        // Ignore release errors
      }
      wakeLockRef.current = null;
    }
    setWakeLockActive(false);
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (!navigator.wakeLock?.request) return false;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      wakeLockRef.current = sentinel;
      wantWakeLockRef.current = true;
      setWakeLockActive(true);
      sentinel.addEventListener('release', () => {
        setWakeLockActive(false);
      });
      return true;
    } catch {
      setWakeLockActive(false);
      return false;
    }
  }, []);

  useEffect(() => {
    const handleVisibility = () => {
      if (
        document.visibilityState === 'visible' &&
        wantWakeLockRef.current &&
        localStreamRef.current
      ) {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [requestWakeLock]);

  // === Generate crisp client-side QR Code whenever Desktop roomCode changes ===
  useEffect(() => {
    if (!roomCode) return;
    let cancelled = false;
    const url = getPhonePairUrl(roomCode);

    QRCode.toDataURL(url, {
      width: 320,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#0F172A',
        light: '#FFFFFF',
      },
    })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [roomCode]);

  // === Teardown helpers ===
  const teardownPcPeer = useCallback(() => {
    if (pcRelayWaitTimerRef.current !== null) {
      window.clearTimeout(pcRelayWaitTimerRef.current);
      pcRelayWaitTimerRef.current = null;
    }

    try {
      pcActiveCallRef.current?.close();
    } catch {
      // ignore
    }
    pcActiveCallRef.current = null;

    try {
      pcDataConnRef.current?.close();
    } catch {
      // ignore
    }
    pcDataConnRef.current = null;

    try {
      pcPeerRef.current?.destroy();
    } catch {
      // ignore
    }
    pcPeerRef.current = null;
    obsRelayPeersRef.current.clear();

    if (pcVideoRef.current) {
      pcVideoRef.current.srcObject = null;
    }
    setRemoteStream(null);
    setHasVideoFrames(false);
    setResolutionLabel('');
    setLatencyMs(null);
    setIsRelayed(false);
    setPcRetryingRelay(false);
    setPhoneMicMuted(false);
  }, []);

  /**
   * Closes only the active PeerJS call/peer while keeping the live camera stream & Wake Lock
   * untouched — used when seamlessly escalating from Stage 1 (STUN) to Stage 2 (Metered TURN).
   */
  const closePhonePeerOnly = useCallback(() => {
    if (phoneConnectTimerRef.current !== null) {
      window.clearTimeout(phoneConnectTimerRef.current);
      phoneConnectTimerRef.current = null;
    }

    try {
      phoneCallRef.current?.close();
    } catch {
      // ignore
    }
    phoneCallRef.current = null;

    try {
      phoneDataConnRef.current?.close();
    } catch {
      // ignore
    }
    phoneDataConnRef.current = null;

    try {
      phonePeerRef.current?.destroy();
    } catch {
      // ignore
    }
    phonePeerRef.current = null;
  }, []);

  const teardownPhoneSender = useCallback(
    (notifyRemote = true) => {
      phoneSessionGenRef.current += 1;

      if (notifyRemote && phoneDataConnRef.current?.open) {
        try {
          const msg: PeerControlMessage = { type: 'disconnect' };
          phoneDataConnRef.current.send(msg);
        } catch {
          // ignore
        }
      }

      closePhonePeerOnly();

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // ignore
          }
        });
      }
      if (phoneVideoRef.current) {
        phoneVideoRef.current.srcObject = null;
      }

      setLocalStream(null);
      setTorchOn(false);
      setTorchSupported(false);
      setMicMuted(false);
      setIsStartingCamera(false);
      setIsSwitchingCamera(false);
      setPhoneRetryingRelay(false);
      setPhoneIsRelayed(false);
      setPhoneStatus('ready');
      releaseWakeLock();
    },
    [closePhonePeerOnly, releaseWakeLock]
  );

  // === Desktop Receiver PeerJS Lifecycle ===
  useEffect(() => {
    if (!hydrated || obsViewCode || mode !== 'pc' || !roomCode) {
      return;
    }

    let cancelled = false;
    setPcErrorKey(null);
    setPcStatus('waiting');
    teardownPcPeer();

    const initReceiver = async () => {
      try {
        const { default: PeerClass } = await import('peerjs');
        if (cancelled) return;

        // Stage 1 Default: STUN-only (0 bytes of Metered TURN quota used for same-Wi-Fi P2P)
        const peer = new PeerClass(getReceiverPeerId(roomCode), PEER_OPTIONS);
        pcPeerRef.current = peer;

        peer.on('open', () => {
          if (!cancelled) {
            setPcErrorKey(null);
            setPcStatus('waiting');
          }
        });

        peer.on('connection', (conn) => {
          if (cancelled) return;
          patchPeerJsIceQueue(conn);

          conn.on('data', (raw) => {
            if (cancelled || !raw || typeof raw !== 'object') return;
            const msg = raw as PeerControlMessage;

            if (msg.type === 'request-relay') {
              obsRelayPeersRef.current.add(conn.peer);
              if (remoteStreamRef.current && !peer.destroyed) {
                try {
                  const relayCall = peer.call(conn.peer, remoteStreamRef.current, {
                    sdpTransform: preferSafeVideoCodecs,
                  });
                  if (relayCall) patchPeerJsIceQueue(relayCall);
                } catch {
                  // ignore relay errors
                }
              }
              conn.on('close', () => {
                obsRelayPeersRef.current.delete(conn.peer);
              });
              return;
            }

            pcDataConnRef.current = conn;
            if (msg.type === 'mic-state') {
              setPhoneMicMuted(Boolean(msg.muted));
            } else if (msg.type === 'disconnect') {
              if (pcRelayWaitTimerRef.current !== null) {
                window.clearTimeout(pcRelayWaitTimerRef.current);
                pcRelayWaitTimerRef.current = null;
              }
              if (pcActiveCallRef.current) {
                try {
                  pcActiveCallRef.current.close();
                } catch {
                  // ignore
                }
                pcActiveCallRef.current = null;
              }
              setRemoteStream(null);
              setHasVideoFrames(false);
              setResolutionLabel('');
              setLatencyMs(null);
              setIsRelayed(false);
              setPcRetryingRelay(false);
              setPhoneMicMuted(false);
              setPcStatus('waiting');
            }
          });
        });

        peer.on('call', (call) => {
          if (cancelled) return;

          // Patch PeerJS ICE queue synchronously BEFORE any async TURN lookup so zero
          // iOS Safari host/STUN/TURN candidates arriving behind the Offer are dropped.
          patchPeerJsIceQueue(call);

          if (pcRelayWaitTimerRef.current !== null) {
            window.clearTimeout(pcRelayWaitTimerRef.current);
            pcRelayWaitTimerRef.current = null;
          }

          if (pcActiveCallRef.current && pcActiveCallRef.current !== call) {
            try {
              pcActiveCallRef.current.close();
            } catch {
              // ignore
            }
          }

          const callMeta = (call.metadata || {}) as CallMetadata;
          const isRelayCall = Boolean(callMeta.relayFallback);

          pcActiveCallRef.current = call;
          setPcCallAttempt((n) => n + 1);
          setPcErrorKey(null);
          setHasVideoFrames(false);
          setIsRelayed(false);
          setPcRetryingRelay(isRelayCall);
          setPcStatus('connecting');

          void (async () => {
            const peerOptionsBag = peer.options as { config?: RTCConfiguration };
            let activeProvider: ActiveTurnProvider | undefined;

            // Engage TURN ONLY when Phone explicitly escalated to Stage 2 cross-network relay
            if (isRelayCall) {
              const relayResult = await getRelayFallbackPeerOptions({
                extraSkip: callMeta.skippedProviders,
              });
              if (cancelled || pcActiveCallRef.current !== call || peer.destroyed) return;
              if (relayResult?.peerOptions.config) {
                peerOptionsBag.config = relayResult.peerOptions.config;
                activeProvider = relayResult.provider;
              }
            }

            try {
              call.answer(undefined, { sdpTransform: preferSafeVideoCodecs });
            } finally {
              // Always restore STUN-only immediately so OBS loopback and future LAN calls use 0 TURN
              peerOptionsBag.config = RTC_CONFIG;
            }

            let callBecameLive = false;
            let stopQuotaMonitor: (() => void) | null = null;

            // Collect all live tracks across multiple ontrack/stream events (iOS Safari often
            // delivers audio first and video second on the same stream reference).
            const receivedTracks = new Map<string, MediaStreamTrack>();
            const syncStream = (tracks: MediaStreamTrack[]) => {
              let changed = false;
              for (const tr of tracks) {
                if (tr.readyState !== 'ended' && !receivedTracks.has(tr.id)) {
                  receivedTracks.set(tr.id, tr);
                  changed = true;
                }
              }
              if (!changed || cancelled || pcActiveCallRef.current !== call) return;

              const assembled = new MediaStream(Array.from(receivedTracks.values()));
              setRemoteStream(assembled);
              setPcErrorKey(null);

              obsRelayPeersRef.current.forEach((obsPeerId) => {
                if (!peer.destroyed) {
                  try {
                    const relayCall = peer.call(obsPeerId, assembled, {
                      sdpTransform: preferSafeVideoCodecs,
                    });
                    if (relayCall) patchPeerJsIceQueue(relayCall);
                  } catch {
                    // ignore
                  }
                }
              });
            };

            const handleDrop = () => {
              if (cancelled || pcActiveCallRef.current !== call) return;
              stopQuotaMonitor?.();
              stopQuotaMonitor = null;
              if (pcRelayWaitTimerRef.current !== null) {
                window.clearTimeout(pcRelayWaitTimerRef.current);
                pcRelayWaitTimerRef.current = null;
              }
              pcActiveCallRef.current = null;
              setRemoteStream(null);
              setHasVideoFrames(false);
              setResolutionLabel('');
              setLatencyMs(null);
              setIsRelayed(false);
              setPcRetryingRelay(false);
              setPhoneMicMuted(false);
              setPcStatus('waiting');
            };

            // While Phone escalates Stage 1 -> Stage 2 or hops across the 3-provider TURN chain
            // (Metered -> Turnix -> ExpressTURN), hold connecting UI briefly to avoid error flashes.
            const canWaitForPhoneHop = () =>
              !callBecameLive &&
              !isTurnQuotaUnavailable() &&
              (!isRelayCall || getSkippedTurnProviders().length < 3);

            const waitForStage2OrDrop = (fallbackErrorKey: TranslationKey | null) => {
              if (cancelled || pcActiveCallRef.current !== call) return;
              setPcRetryingRelay(true);
              setPcStatus('connecting');
              setPcErrorKey(null);

              if (pcRelayWaitTimerRef.current !== null) {
                window.clearTimeout(pcRelayWaitTimerRef.current);
              }
              pcRelayWaitTimerRef.current = window.setTimeout(() => {
                pcRelayWaitTimerRef.current = null;
                if (cancelled || pcActiveCallRef.current !== call) return;
                handleDrop();
                if (fallbackErrorKey) {
                  setPcErrorKey(fallbackErrorKey);
                }
              }, 6000);
            };

            const rtcPc = call.peerConnection;
            if (rtcPc) {
              if (isRelayCall && activeProvider) {
                stopQuotaMonitor = monitorTurnQuotaErrors(rtcPc, activeProvider);
              }

              rtcPc.addEventListener('track', (evt) => {
                if (cancelled || pcActiveCallRef.current !== call) return;
                const incoming = evt.streams?.[0]
                  ? evt.streams[0].getTracks()
                  : evt.track
                    ? [evt.track]
                    : [];
                syncStream(incoming);
              });
            }

            call.on('stream', (incomingStream) => {
              if (cancelled || pcActiveCallRef.current !== call || !incomingStream) return;
              syncStream(incomingStream.getTracks());
            });

            call.on('close', () => {
              if (cancelled || pcActiveCallRef.current !== call) return;
              if (canWaitForPhoneHop()) {
                waitForStage2OrDrop(isRelayCall ? 'error.relayQuotaFallback' : null);
              } else {
                handleDrop();
              }
            });

            call.on('error', () => {
              if (cancelled || pcActiveCallRef.current !== call) return;
              if (isRelayCall && activeProvider) {
                skipTurnProvider(activeProvider);
              }
              if (canWaitForPhoneHop()) {
                waitForStage2OrDrop(
                  isRelayCall ? 'error.relayQuotaFallback' : 'error.appleVideoStall'
                );
              } else if (isRelayCall) {
                handleDrop();
                setPcErrorKey('error.relayQuotaFallback');
              } else {
                handleDrop();
                setPcErrorKey('error.networkDrop');
              }
            });

            if (rtcPc) {
              const syncIceState = () => {
                if (cancelled || pcActiveCallRef.current !== call) return;
                const ice = rtcPc.iceConnectionState;
                const conn = rtcPc.connectionState;
                if (ice === 'connected' || ice === 'completed' || conn === 'connected') {
                  callBecameLive = true;
                  if (pcRelayWaitTimerRef.current !== null) {
                    window.clearTimeout(pcRelayWaitTimerRef.current);
                    pcRelayWaitTimerRef.current = null;
                  }
                  setPcRetryingRelay(false);
                  setPcStatus('live');
                  setPcErrorKey(null);
                } else if (ice === 'failed' || conn === 'failed') {
                  if (isRelayCall && activeProvider) {
                    skipTurnProvider(activeProvider);
                  }
                  if (canWaitForPhoneHop()) {
                    waitForStage2OrDrop(
                      isRelayCall ? 'error.relayQuotaFallback' : 'error.appleVideoStall'
                    );
                  } else if (isRelayCall) {
                    handleDrop();
                    setPcErrorKey('error.relayQuotaFallback');
                  } else {
                    handleDrop();
                    setPcErrorKey('error.appleVideoStall');
                  }
                } else if (ice === 'closed' || conn === 'closed') {
                  if (canWaitForPhoneHop()) {
                    waitForStage2OrDrop(isRelayCall ? 'error.relayQuotaFallback' : null);
                  } else {
                    handleDrop();
                  }
                } else if (ice === 'disconnected') {
                  setPcStatus('connecting');
                }
              };

              rtcPc.addEventListener('iceconnectionstatechange', syncIceState);
              rtcPc.addEventListener('connectionstatechange', syncIceState);
            }
          })();
        });

        peer.on('disconnected', () => {
          if (!cancelled && !peer.destroyed) {
            try {
              peer.reconnect();
            } catch {
              setPcErrorKey('error.signalingFailed');
            }
          }
        });

        peer.on('error', (err: { type?: string }) => {
          if (cancelled) return;
          if (err?.type === 'unavailable-id') {
            setRoomCode((prev) => generateRoomCode(prev));
            return;
          }
          setPcErrorKey(mapPeerErrorToKey(err));
        });
      } catch (err) {
        if (!cancelled) {
          setPcErrorKey(mapPeerErrorToKey(err));
        }
      }
    };

    initReceiver();

    return () => {
      cancelled = true;
      teardownPcPeer();
    };
  }, [hydrated, obsViewCode, mode, roomCode, pcSessionNonce, teardownPcPeer]);

  // Attach remote stream to Desktop <video>, verify decoded frames, and monitor resolution
  useEffect(() => {
    const videoEl = pcVideoRef.current;
    if (!videoEl || !remoteStream) return;

    const detachVideo = attachStreamToVideo(videoEl, remoteStream, monitorMuted);

    const updateResolution = () => {
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        setHasVideoFrames(true);
        setPcRetryingRelay(false);
        setPcStatus('live');
        setPcErrorKey(null);
        setResolutionLabel(`${videoEl.videoWidth}×${videoEl.videoHeight}`);
      }
    };

    videoEl.addEventListener('loadedmetadata', updateResolution);
    videoEl.addEventListener('loadeddata', updateResolution);
    videoEl.addEventListener('playing', updateResolution);
    videoEl.addEventListener('resize', updateResolution);
    updateResolution();

    // Poll briefly for first decoded video frame (covers Safari/WebKit track unmute delays)
    const frameCheckId = window.setInterval(() => {
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        updateResolution();
        window.clearInterval(frameCheckId);
      } else if (videoEl.paused && videoEl.srcObject) {
        videoEl.play().catch(() => {});
      }
    }, 500);

    return () => {
      window.clearInterval(frameCheckId);
      detachVideo();
      videoEl.removeEventListener('loadedmetadata', updateResolution);
      videoEl.removeEventListener('loadeddata', updateResolution);
      videoEl.removeEventListener('playing', updateResolution);
      videoEl.removeEventListener('resize', updateResolution);
    };
  }, [remoteStream, monitorMuted]);

  // Stall watchdog: if connected/connecting for 14s with 0 decoded frames, surface actionable guidance
  useEffect(() => {
    if ((!remoteStream && pcStatus !== 'connecting') || hasVideoFrames) {
      return;
    }

    const timerId = window.setTimeout(() => {
      const videoEl = pcVideoRef.current;
      if (!videoEl || videoEl.videoWidth === 0) {
        setPcErrorKey(pcRetryingRelay ? 'error.relayQuotaFallback' : 'error.appleVideoStall');
      }
    }, 14000);

    return () => window.clearTimeout(timerId);
  }, [remoteStream, pcStatus, hasVideoFrames, pcCallAttempt, pcRetryingRelay]);

  useEffect(() => {
    if (pcVideoRef.current) {
      pcVideoRef.current.muted = monitorMuted;
    }
  }, [monitorMuted]);

  // Poll WebRTC stats for round-trip latency and P2P vs Relay transport detection
  useEffect(() => {
    const activeConnStatus = mode === 'pc' ? pcStatus : phoneStatus;
    if (activeConnStatus !== 'live' && activeConnStatus !== 'connecting') {
      if (mode === 'pc') {
        setLatencyMs(null);
        setIsRelayed(false);
      } else {
        setPhoneIsRelayed(false);
      }
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const rtcPc =
        mode === 'pc'
          ? pcActiveCallRef.current?.peerConnection
          : phoneCallRef.current?.peerConnection;
      const telemetry = await measurePeerTelemetry(rtcPc);
      if (cancelled) return;
      if (mode === 'pc') {
        if (telemetry.latencyMs !== null) {
          setLatencyMs(telemetry.latencyMs);
        }
        setIsRelayed(telemetry.isRelayed);
      } else {
        setPhoneIsRelayed(telemetry.isRelayed);
      }
    };

    poll();
    const intervalId = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [mode, pcStatus, phoneStatus]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    const videoEl = phoneVideoRef.current;
    if (!videoEl || !localStream) return;
    return attachStreamToVideo(videoEl, localStream, true);
  }, [localStream]);

  useEffect(() => {
    return () => {
      teardownPcPeer();
      teardownPhoneSender(false);
    };
  }, [teardownPcPeer, teardownPhoneSender]);

  const handleSwitchMode = (nextMode: ToolMode) => {
    if (nextMode === mode) return;
    if (mode === 'pc') {
      teardownPcPeer();
    } else {
      teardownPhoneSender(true);
    }
    setPcErrorKey(null);
    setPhoneErrorKey(null);
    setMode(nextMode);
  };

  const announce = useCallback((message: string) => {
    setLiveAnnouncement('');
    window.setTimeout(() => setLiveAnnouncement(message), 15);
  }, []);

  // === Desktop Actions ===
  const handleRefreshCode = () => {
    teardownPcPeer();
    const nextCode = generateRoomCode(roomCode);
    setRoomCode(nextCode);
    announce(`${t('tool.roomCodeLabel')}: ${nextCode}`);
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopiedCode(true);
      announce(t('tool.copied'));
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      const input = document.createElement('input');
      input.value = roomCode;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopiedCode(true);
      announce(t('tool.copied'));
      window.setTimeout(() => setCopiedCode(false), 1800);
    }
  };

  const handleCopyObsUrl = async () => {
    const url = getObsCleanViewUrl(roomCode);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedObsUrl(true);
      announce(t('tool.obsUrlCopied'));
      window.setTimeout(() => setCopiedObsUrl(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleDownloadObsJson = () => {
    downloadObsSceneCollection(roomCode);
    setObsDownloaded(true);
    announce(t('tool.obsDownloaded'));
    window.setTimeout(() => setObsDownloaded(false), 2400);
  };

  const handleToggleFullscreen = async () => {
    const container = pcVideoContainerRef.current;
    if (!container) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await container.requestFullscreen();
      }
    } catch {
      // Ignore
    }
  };

  const handlePcDisconnect = () => {
    if (pcRelayWaitTimerRef.current !== null) {
      window.clearTimeout(pcRelayWaitTimerRef.current);
      pcRelayWaitTimerRef.current = null;
    }
    if (pcActiveCallRef.current) {
      try {
        pcActiveCallRef.current.close();
      } catch {
        // ignore
      }
      pcActiveCallRef.current = null;
    }
    setRemoteStream(null);
    setHasVideoFrames(false);
    setResolutionLabel('');
    setLatencyMs(null);
    setIsRelayed(false);
    setPcRetryingRelay(false);
    setPhoneMicMuted(false);
    setPcStatus('waiting');
  };

  const handlePcReconnect = () => {
    setPcErrorKey(null);
    setPcSessionNonce((n) => n + 1);
  };

  // === Phone Code Input Handlers ===
  const joinedPhoneCode = codeChars.join('');

  const handleCodeInputChange = (index: number, rawValue: string) => {
    const cleaned = sanitizeRoomCode(rawValue);
    setAutoFilledFromQr(false);
    setPhoneErrorKey(null);

    if (cleaned.length > 1) {
      const next = ['', '', '', ''];
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        next[i] = cleaned[i] || '';
      }
      setCodeChars(next);
      const focusIdx = Math.min(cleaned.length, ROOM_CODE_LENGTH - 1);
      codeInputRefs.current[focusIdx]?.focus();
      return;
    }

    const next = [...codeChars];
    next[index] = cleaned;
    setCodeChars(next);

    if (cleaned && index < ROOM_CODE_LENGTH - 1) {
      codeInputRefs.current[index + 1]?.focus();
    }
  };

  const handleCodeKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!codeChars[index] && index > 0) {
        e.preventDefault();
        const next = [...codeChars];
        next[index - 1] = '';
        setCodeChars(next);
        codeInputRefs.current[index - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      codeInputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < ROOM_CODE_LENGTH - 1) {
      e.preventDefault();
      codeInputRefs.current[index + 1]?.focus();
    }
  };

  const handleCodePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = sanitizeRoomCode(e.clipboardData.getData('text'));
    if (!pasted) return;
    e.preventDefault();
    setAutoFilledFromQr(false);
    setPhoneErrorKey(null);
    const next = ['', '', '', ''];
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      next[i] = pasted[i] || '';
    }
    setCodeChars(next);
    const focusIdx = Math.min(pasted.length, ROOM_CODE_LENGTH - 1);
    codeInputRefs.current[focusIdx]?.focus();
  };

  const inspectTorchCapability = (stream: MediaStream) => {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack || typeof videoTrack.getCapabilities !== 'function') {
      setTorchSupported(false);
      setTorchOn(false);
      return;
    }
    try {
      const caps = videoTrack.getCapabilities() as TrackCapabilitiesWithTorch;
      const supported = Boolean(caps.torch);
      setTorchSupported(supported);
      if (!supported) setTorchOn(false);
    } catch {
      setTorchSupported(false);
      setTorchOn(false);
    }
  };

  /**
   * Two-stage WebRTC sender connection with 3-provider TURN fallback hopping:
   *  - Stage 1 (`useRelayFallback = false`): STUN-only direct P2P (uses 0 bytes of TURN quota on same Wi-Fi).
   *  - Stage 2 (`useRelayFallback = true`): Edge-served TURN relay (Metered -> Turnix -> ExpressTURN)
   *    engaged ONLY if Stage 1 fails/stalls. If the active provider returns a quota/auth rejection
   *    (401/403/437/486/508) or fails ICE, automatically skips it and hops mid-session to the next
   *    provider in the chain before entering the 15-minute TURN cooldown.
   */
  const connectPhonePeer = useCallback(
    async (
      targetCode: string,
      stream: MediaStream,
      useRelayFallback: boolean,
      sessionGen: number
    ) => {
      if (phoneSessionGenRef.current !== sessionGen) return;

      closePhonePeerOnly();

      let peerOptions = PEER_OPTIONS;
      let activeProvider: ActiveTurnProvider | undefined;
      if (useRelayFallback) {
        const relayResult = await getRelayFallbackPeerOptions();
        if (phoneSessionGenRef.current !== sessionGen) return;
        if (!relayResult) {
          setIsStartingCamera(false);
          setPhoneRetryingRelay(false);
          setPhoneStatus('disconnected');
          setPhoneErrorKey('error.relayQuotaFallback');
          return;
        }
        peerOptions = relayResult.peerOptions;
        activeProvider = relayResult.provider;
      }

      try {
        const { default: PeerClass } = await import('peerjs');
        if (phoneSessionGenRef.current !== sessionGen) return;

        const peer = new PeerClass(getSenderPeerId(targetCode), peerOptions);
        phonePeerRef.current = peer;

        const receiverId = getReceiverPeerId(targetCode);
        let attemptLive = false;
        let escalated = false;
        let stopQuotaMonitor: (() => void) | null = null;

        const clearConnectTimer = () => {
          if (phoneConnectTimerRef.current !== null) {
            window.clearTimeout(phoneConnectTimerRef.current);
            phoneConnectTimerRef.current = null;
          }
        };

        const isCurrentAttempt = () =>
          phoneSessionGenRef.current === sessionGen && phonePeerRef.current === peer && !escalated;

        const failStage2Gracefully = (errorKey: TranslationKey = 'error.relayQuotaFallback') => {
          if (!isCurrentAttempt()) return;
          clearConnectTimer();
          stopQuotaMonitor?.();
          stopQuotaMonitor = null;
          closePhonePeerOnly();
          setIsStartingCamera(false);
          setPhoneRetryingRelay(false);
          setPhoneStatus('disconnected');
          setPhoneErrorKey(errorKey);
        };

        const hopToNextRelayProvider = () => {
          if (!useRelayFallback || !activeProvider || attemptLive || escalated) return;
          if (phoneSessionGenRef.current !== sessionGen || phonePeerRef.current !== peer) return;
          escalated = true;
          clearConnectTimer();
          stopQuotaMonitor?.();
          stopQuotaMonitor = null;

          // Mark failing/quota-exhausted provider skipped and immediately fetch the next provider
          // via `/api/ice-servers?mode=relay&skip=...` (Metered -> Turnix -> ExpressTURN).
          skipTurnProvider(activeProvider);
          setPhoneRetryingRelay(true);
          setPhoneErrorKey(null);
          setPhoneStatus('connecting');
          void connectPhonePeer(targetCode, stream, true, sessionGen);
        };

        const escalateToRelay = () => {
          if (useRelayFallback || attemptLive || escalated) return;
          if (phoneSessionGenRef.current !== sessionGen || phonePeerRef.current !== peer) return;
          escalated = true;
          clearConnectTimer();
          stopQuotaMonitor?.();
          stopQuotaMonitor = null;

          if (isTurnQuotaUnavailable()) {
            closePhonePeerOnly();
            setIsStartingCamera(false);
            setPhoneRetryingRelay(false);
            setPhoneStatus('disconnected');
            setPhoneErrorKey('error.relayQuotaFallback');
            return;
          }

          setPhoneRetryingRelay(true);
          setPhoneErrorKey(null);
          setPhoneStatus('connecting');
          void connectPhonePeer(targetCode, stream, true, sessionGen);
        };

        peer.on('open', () => {
          if (!isCurrentAttempt()) return;

          // 1. Start the media call FIRST with Apple/Chrome-safe SDP codec order + ICE queue patch
          const metadata: CallMetadata = {
            relayFallback: useRelayFallback,
            relayProvider: activeProvider,
            skippedProviders: useRelayFallback ? getSkippedTurnProviders() : undefined,
          };
          const call = peer.call(receiverId, stream, {
            sdpTransform: preferSafeVideoCodecs,
            metadata,
          });
          phoneCallRef.current = call;

          if (!call) {
            clearConnectTimer();
            setIsStartingCamera(false);
            setPhoneRetryingRelay(false);
            setPhoneErrorKey('error.peerUnavailable');
            setPhoneStatus('disconnected');
            return;
          }

          patchPeerJsIceQueue(call);

          // 2. Open lightweight JSON DataConnection (avoids PeerJS binary serializer crash on iOS Safari)
          const dataConn = peer.connect(receiverId, {
            reliable: true,
            serialization: 'json',
          });
          patchPeerJsIceQueue(dataConn);
          phoneDataConnRef.current = dataConn;

          dataConn.on('open', () => {
            if (!isCurrentAttempt()) return;
            const camMsg: PeerControlMessage = {
              type: 'camera-state',
              facingMode,
              resolution: quality,
            };
            dataConn.send(camMsg);
            const isCurrentlyMuted = !stream.getAudioTracks().some((tr) => tr.enabled);
            if (isCurrentlyMuted) {
              const micMsg: PeerControlMessage = { type: 'mic-state', muted: true };
              dataConn.send(micMsg);
            }
            setIsStartingCamera(false);
          });

          // Stage 1: give direct local Wi-Fi P2P 4.5s before escalating to cross-network TURN relay.
          // Stage 2: give each TURN provider 8s before hopping to the next provider in the chain.
          clearConnectTimer();
          phoneConnectTimerRef.current = window.setTimeout(
            () => {
              phoneConnectTimerRef.current = null;
              if (!isCurrentAttempt() || attemptLive) return;
              if (!useRelayFallback) {
                escalateToRelay();
              } else {
                hopToNextRelayProvider();
              }
            },
            useRelayFallback ? 8000 : 4500
          );

          const rtcPc = call.peerConnection;
          if (rtcPc) {
            if (useRelayFallback && activeProvider) {
              stopQuotaMonitor = monitorTurnQuotaErrors(rtcPc, activeProvider, () => {
                // Quota/auth rejection (401/403/437/486/508) -> immediately hop to next provider
                hopToNextRelayProvider();
              });
            }

            const markConnectedIfReady = () => {
              if (!isCurrentAttempt()) return;
              const ice = rtcPc.iceConnectionState;
              const conn = rtcPc.connectionState;
              if (ice === 'connected' || ice === 'completed' || conn === 'connected') {
                attemptLive = true;
                clearConnectTimer();
                setIsStartingCamera(false);
                setPhoneRetryingRelay(false);
                setPhoneStatus('live');
                setPhoneErrorKey(null);
              } else if (ice === 'failed' || conn === 'failed') {
                if (!useRelayFallback && !attemptLive) {
                  escalateToRelay();
                } else if (useRelayFallback && !attemptLive) {
                  hopToNextRelayProvider();
                } else if (useRelayFallback) {
                  failStage2Gracefully('error.relayQuotaFallback');
                } else {
                  clearConnectTimer();
                  setIsStartingCamera(false);
                  setPhoneStatus('disconnected');
                  setPhoneErrorKey('error.appleVideoStall');
                }
              } else if (ice === 'closed' || conn === 'closed') {
                if (!useRelayFallback && !attemptLive) {
                  escalateToRelay();
                } else if (useRelayFallback && !attemptLive) {
                  hopToNextRelayProvider();
                } else {
                  clearConnectTimer();
                  setPhoneRetryingRelay(false);
                  setPhoneStatus('disconnected');
                }
              }
            };

            rtcPc.addEventListener('iceconnectionstatechange', markConnectedIfReady);
            rtcPc.addEventListener('connectionstatechange', markConnectedIfReady);
          }

          call.on('close', () => {
            if (!isCurrentAttempt()) return;
            if (!useRelayFallback && !attemptLive) {
              escalateToRelay();
              return;
            }
            if (useRelayFallback && !attemptLive) {
              hopToNextRelayProvider();
              return;
            }
            clearConnectTimer();
            stopQuotaMonitor?.();
            stopQuotaMonitor = null;
            setPhoneRetryingRelay(false);
            setPhoneStatus('disconnected');
          });

          call.on('error', (err) => {
            if (!isCurrentAttempt()) return;
            const errType = (err as { type?: string } | undefined)?.type;
            if (!useRelayFallback && !attemptLive && errType !== 'peer-unavailable') {
              escalateToRelay();
              return;
            }
            if (useRelayFallback && !attemptLive && errType !== 'peer-unavailable') {
              hopToNextRelayProvider();
              return;
            }
            if (useRelayFallback) {
              failStage2Gracefully(
                errType === 'peer-unavailable'
                  ? 'error.peerUnavailable'
                  : 'error.relayQuotaFallback'
              );
              return;
            }
            clearConnectTimer();
            setIsStartingCamera(false);
            setPhoneRetryingRelay(false);
            setPhoneStatus('disconnected');
            setPhoneErrorKey(mapPeerErrorToKey(err));
          });
        });

        peer.on('error', (err) => {
          if (!isCurrentAttempt()) return;
          const errType = (err as { type?: string } | undefined)?.type;
          if (!useRelayFallback && !attemptLive && errType === 'webrtc') {
            escalateToRelay();
            return;
          }
          if (useRelayFallback && !attemptLive && errType === 'webrtc') {
            hopToNextRelayProvider();
            return;
          }
          clearConnectTimer();
          stopQuotaMonitor?.();
          stopQuotaMonitor = null;
          setIsStartingCamera(false);
          setPhoneRetryingRelay(false);
          setPhoneStatus('disconnected');
          setPhoneErrorKey(
            useRelayFallback && errType !== 'peer-unavailable'
              ? 'error.relayQuotaFallback'
              : mapPeerErrorToKey(err)
          );
        });
      } catch (err) {
        if (phoneSessionGenRef.current !== sessionGen) return;
        setIsStartingCamera(false);
        setPhoneRetryingRelay(false);
        setPhoneStatus('disconnected');
        setPhoneErrorKey(useRelayFallback ? 'error.relayQuotaFallback' : mapPeerErrorToKey(err));
      }
    },
    [closePhonePeerOnly, facingMode, quality]
  );

  // === Phone Start Camera & Mic (User Gesture for iOS Safari) ===
  const handleStartPhoneStream = async () => {
    const targetCode = sanitizeRoomCode(joinedPhoneCode);
    if (!isValidRoomCode(targetCode)) {
      setPhoneErrorKey('error.invalidCode');
      return;
    }

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setPhoneErrorKey('error.insecureContext');
      return;
    }

    phoneSessionGenRef.current += 1;
    const sessionGen = phoneSessionGenRef.current;

    setPhoneErrorKey(null);
    setPhoneRetryingRelay(false);
    setPhoneIsRelayed(false);
    setIsStartingCamera(true);
    setPhoneStatus('connecting');

    let stream: MediaStream;
    try {
      stream = await acquireCameraStream(facingMode, quality);
    } catch (err) {
      setIsStartingCamera(false);
      setPhoneStatus('ready');
      setPhoneErrorKey(mapMediaErrorToKey(err));
      return;
    }

    if (phoneSessionGenRef.current !== sessionGen) {
      stream.getTracks().forEach((tr) => tr.stop());
      return;
    }

    setLocalStream(stream);
    setMicMuted(false);
    inspectTorchCapability(stream);

    if (wakeLockSupported) {
      requestWakeLock();
    }

    // Allow iOS Safari WebKit one frame to bind the camera stream to the preview <video>
    // so hardware VideoToolbox capture is active before WebRTC encoding starts.
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });

    if (phoneSessionGenRef.current !== sessionGen) return;

    // Always try Stage 1 (STUN-only direct P2P) first to preserve free TURN relay quota
    await connectPhonePeer(targetCode, stream, false, sessionGen);
  };

  const handleSwitchCamera = async () => {
    const currentStream = localStreamRef.current;
    if (!currentStream || isSwitchingCamera) return;

    const nextFacing: CameraFacing = facingMode === 'user' ? 'environment' : 'user';
    setIsSwitchingCamera(true);
    setTorchOn(false);

    const oldVideoTracks = currentStream.getVideoTracks();
    oldVideoTracks.forEach((track) => track.stop());

    try {
      const videoConstraints = buildMediaConstraints(nextFacing, quality).video;
      let replacementStream: MediaStream;
      try {
        replacementStream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });
      } catch {
        replacementStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: nextFacing },
          audio: false,
        });
      }
      const newVideoTrack = replacementStream.getVideoTracks()[0];
      if (!newVideoTrack) throw new Error('No video track');

      const audioTracks = currentStream.getAudioTracks();
      const updatedStream = new MediaStream([newVideoTrack, ...audioTracks]);

      const rtcPc = phoneCallRef.current?.peerConnection;
      if (rtcPc) {
        const videoSender = rtcPc.getSenders().find((s) => s.track?.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(newVideoTrack);
        }
      }

      setFacingMode(nextFacing);
      setLocalStream(updatedStream);
      inspectTorchCapability(updatedStream);

      if (phoneDataConnRef.current?.open) {
        const msg: PeerControlMessage = {
          type: 'camera-state',
          facingMode: nextFacing,
          resolution: quality,
        };
        phoneDataConnRef.current.send(msg);
      }
    } catch (err) {
      setPhoneErrorKey(mapMediaErrorToKey(err));
    } finally {
      setIsSwitchingCamera(false);
    }
  };

  const handleToggleMic = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextMuted = !micMuted;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMicMuted(nextMuted);

    if (phoneDataConnRef.current?.open) {
      const msg: PeerControlMessage = { type: 'mic-state', muted: nextMuted };
      phoneDataConnRef.current.send(msg);
    }
  };

  const handleToggleTorch = async () => {
    const stream = localStreamRef.current;
    if (!stream || !torchSupported) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    const nextTorch = !torchOn;
    try {
      await videoTrack.applyConstraints({
        advanced: [{ torch: nextTorch } as MediaTrackConstraintSet],
      });
      setTorchOn(nextTorch);
    } catch {
      setTorchSupported(false);
      setTorchOn(false);
    }
  };

  const handleToggleWakeLock = async () => {
    if (!wakeLockSupported) return;
    if (wakeLockActive) {
      await releaseWakeLock();
    } else {
      await requestWakeLock();
    }
  };

  const handlePhoneReconnect = () => {
    teardownPhoneSender(false);
    setPhoneErrorKey(null);
    handleStartPhoneStream();
  };

  // Render Clean OBS View immediately when ?view=CODE is active
  if (obsViewCode) {
    return <ObsCleanView rawCode={obsViewCode} lang={lang} />;
  }

  // Minimal live status indicator (screen-reader live region)
  const renderStatusIndicator = (
    status: ConnectionStatus,
    retryingRelay: boolean,
    relayed: boolean
  ) => {
    if (status === 'live') {
      return (
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs sm:text-sm font-bold bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25"
        >
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span>{t(relayed ? 'tool.statusLiveRelay' : 'tool.statusLive')}</span>
        </span>
      );
    }

    if (status === 'connecting') {
      return (
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs sm:text-sm font-bold bg-amber-500/12 text-amber-800 dark:text-amber-200 border border-amber-500/25"
        >
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" aria-hidden="true" />
          <span>{t(retryingRelay ? 'tool.switchingToRelay' : 'tool.statusConnecting')}</span>
        </span>
      );
    }

    if (status === 'disconnected') {
      return (
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs sm:text-sm font-bold bg-rose-500/12 text-rose-700 dark:text-rose-300 border border-rose-500/25"
        >
          <span className="w-2 h-2 rounded-full bg-rose-500" aria-hidden="true" />
          <span>{t('tool.statusDisconnected')}</span>
        </span>
      );
    }

    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-2.5 text-xs sm:text-sm font-semibold text-muted"
      >
        <span className="pulse-ring-wrapper w-2 h-2" aria-hidden="true">
          <span className="w-2 h-2 rounded-full bg-accent block" />
        </span>
        <span>{t(status === 'ready' ? 'tool.statusReady' : 'tool.statusWaiting')}</span>
      </span>
    );
  };

  const activeStatus = mode === 'pc' ? pcStatus : phoneStatus;
  const activeRetryingRelay = mode === 'pc' ? pcRetryingRelay : phoneRetryingRelay;
  const activeIsRelayed = mode === 'pc' ? isRelayed : phoneIsRelayed;

  return (
    <div className="w-full">
      <span className="sr-only" role="status" aria-live="polite">
        {liveAnnouncement}
      </span>

      {/* === Unified Studio Card Header Bar (Compact Mode Switcher + Live Status) === */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-5 border-b border-edge/60">
        <div
          className="grid grid-cols-2 sm:inline-grid p-1 rounded-xl surface-subtle border border-edge/70 w-full sm:w-auto"
          role="tablist"
          aria-label="Operating Mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'pc'}
            onClick={() => handleSwitchMode('pc')}
            className={`inline-flex items-center justify-center gap-1.5 sm:gap-2 min-h-[40px] px-2 sm:px-4 py-1.5 rounded-lg font-bold text-xs sm:text-sm leading-tight text-center transition-all duration-150 min-w-0 ${
              mode === 'pc'
                ? 'bg-accent text-[#0F172A] shadow-sm'
                : 'text-muted hover:text-ink'
            }`}
          >
            <MonitorIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            <span>{t('tool.modePc')}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={mode === 'phone'}
            onClick={() => handleSwitchMode('phone')}
            className={`inline-flex items-center justify-center gap-1.5 sm:gap-2 min-h-[40px] px-2 sm:px-4 py-1.5 rounded-lg font-bold text-xs sm:text-sm leading-tight text-center transition-all duration-150 min-w-0 ${
              mode === 'phone'
                ? 'bg-accent text-[#0F172A] shadow-sm'
                : 'text-muted hover:text-ink'
            }`}
          >
            <SmartphoneIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            <span>{t('tool.modePhone')}</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between sm:justify-end gap-2">
          {renderStatusIndicator(activeStatus, activeRetryingRelay, activeIsRelayed)}

          {mode === 'pc' && pcStatus === 'live' && resolutionLabel && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-mono font-bold surface-subtle border border-edge/70 text-ink">
              {resolutionLabel}
            </span>
          )}
          {mode === 'pc' && pcStatus === 'live' && latencyMs !== null && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-mono font-bold surface-subtle border border-edge/70 text-ink">
              {latencyMs} ms
            </span>
          )}
        </div>
      </div>

      {/* =================================================================== */}
      {/* DESKTOP RECEIVER MODE                                               */}
      {/* =================================================================== */}
      {mode === 'pc' && (
        <div key="mode-pc" className="mode-panel-enter pt-6">
          {/* Error Banner (PC) */}
          {pcErrorKey && (
            <div
              role="alert"
              className="mb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-ink"
            >
              <div className="flex items-start gap-3">
                <AlertIcon className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                <p className="text-sm font-medium leading-snug">{t(pcErrorKey)}</p>
              </div>
              <button
                type="button"
                onClick={handlePcReconnect}
                className="btn-accent inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl font-bold text-sm shrink-0"
              >
                <RefreshIcon className="w-4 h-4" />
                <span>{t('tool.reconnect')}</span>
              </button>
            </div>
          )}

          {/* PAIRING STAGE — Clean 2-column split, zero double-nested boxes */}
          {pcStatus === 'waiting' && !remoteStream && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-7 md:gap-0 items-center md:divide-x md:divide-edge/60">
              {/* Left: Clean QR Code */}
              <div className="md:col-span-5 md:pr-7 flex flex-col items-center justify-center text-center">
                <div className="p-3 rounded-2xl bg-white border border-edge/75 shadow-sm">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={`QR Code ${roomCode}`}
                      width={184}
                      height={184}
                      className="w-44 h-44 sm:w-[184px] sm:h-[184px] rounded-lg block"
                    />
                  ) : (
                    <div className="w-44 h-44 sm:w-[184px] sm:h-[184px] rounded-lg bg-[#F2FCFD] animate-pulse" />
                  )}
                </div>
                <p className="mt-3 text-sm font-semibold text-muted">
                  {t('tool.scanQrTitle')}
                </p>
              </div>

              {/* Right: Pairing Code + Single-Line OBS Controls */}
              <div className="md:col-span-7 md:pl-8 flex flex-col justify-center space-y-5">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">
                      {t('tool.roomCodeLabel')}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleCopyCode}
                        className="btn-secondary inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-bold"
                        aria-label={t('tool.copyCode')}
                        title={t('tool.copyCode')}
                      >
                        {copiedCode ? (
                          <>
                            <CheckIcon className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                            <span>{t('tool.copied')}</span>
                          </>
                        ) : (
                          <>
                            <CopyIcon className="w-3.5 h-3.5" />
                            <span>{t('tool.copyCode')}</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={handleRefreshCode}
                        className="btn-secondary inline-flex items-center justify-center w-8 h-8 rounded-lg"
                        aria-label={t('tool.refreshCode')}
                        title={t('tool.refreshCode')}
                      >
                        <RefreshIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Balanced 4-Tile Monospace Code Grid */}
                  <div
                    className="grid grid-cols-4 gap-2.5 sm:gap-3"
                    aria-label={`${t('tool.roomCodeLabel')}: ${roomCode}`}
                  >
                    {(roomCode || '----').split('').map((ch, i) => (
                      <span
                        key={i}
                        className="h-14 sm:h-16 inline-flex items-center justify-center rounded-xl surface-subtle border border-edge/80 font-mono text-2xl sm:text-3xl font-extrabold text-ink tracking-wider select-all"
                      >
                        {ch}
                      </span>
                    ))}
                  </div>

                  <p className="text-xs sm:text-sm text-muted">
                    {t('tool.scanQrHint')}
                  </p>
                </div>

                {/* Single-Line OBS Action Row (stacks cleanly on narrow tablet right column) */}
                <div className="pt-4 border-t border-edge/55 flex flex-col sm:flex-row md:flex-col lg:flex-row gap-2.5">
                  <button
                    type="button"
                    onClick={handleDownloadObsJson}
                    className="btn-accent flex-1 inline-flex items-center justify-center gap-2 min-h-[46px] px-4 py-2.5 rounded-xl font-bold text-sm whitespace-nowrap"
                  >
                    {obsDownloaded ? (
                      <>
                        <CheckIcon className="w-4 h-4 shrink-0" />
                        <span>{t('tool.obsDownloaded')}</span>
                      </>
                    ) : (
                      <>
                        <DownloadIcon className="w-4 h-4 shrink-0" />
                        <span>{t('tool.downloadObsJson')}</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleCopyObsUrl}
                    className="btn-secondary inline-flex items-center justify-center gap-2 min-h-[46px] px-4 py-2.5 rounded-xl font-bold text-sm whitespace-nowrap shrink-0"
                    aria-label={t('tool.copyObsUrl')}
                    title={getObsCleanViewUrl(roomCode)}
                  >
                    {copiedObsUrl ? (
                      <>
                        <CheckIcon className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        <span>{t('tool.obsUrlCopied')}</span>
                      </>
                    ) : (
                      <>
                        <LinkIcon className="w-4 h-4 shrink-0" />
                        <span>{t('tool.copyObsUrl')}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* LIVE / CONNECTING VIDEO VIEW (Once Phone Starts Pairing) */}
          {(pcStatus === 'live' || pcStatus === 'connecting' || remoteStream !== null) && (
            <div className="space-y-4">
              <div
                ref={pcVideoContainerRef}
                className="relative w-full aspect-video rounded-2xl overflow-hidden bg-[#060E12] border border-edge"
              >
                <video
                  ref={pcVideoRef}
                  autoPlay
                  playsInline
                  muted={monitorMuted}
                  className={`w-full h-full object-contain bg-black transition-transform duration-150 ${
                    mirrorVideo ? 'scale-x-[-1]' : ''
                  }`}
                />

                {!hasVideoFrames && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/45 pointer-events-none">
                    <div className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full bg-black/75 border border-white/15 text-sm font-semibold text-[#E3FDFD]">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#71C9CE] animate-pulse" aria-hidden="true" />
                      <span>
                        {pcRetryingRelay
                          ? t('tool.switchingToRelay')
                          : t('tool.waitingVideoFrames')}
                      </span>
                    </div>
                  </div>
                )}

                <div className="absolute top-3 left-3 right-3 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-black/65 backdrop-blur-md border border-white/15 text-xs font-mono font-bold text-[#E3FDFD]">
                      {roomCode}
                    </span>
                    {monitorMuted && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/65 backdrop-blur-md border border-white/15 text-xs font-medium text-[#A6E3E9]">
                        <VolumeOffIcon className="w-3.5 h-3.5" />
                        <span>{t('tool.monitorMutedBadge')}</span>
                      </span>
                    )}
                  </div>

                  <AudioMeter
                    stream={remoteStream}
                    muted={phoneMicMuted}
                    label={t('tool.audioLevel')}
                    mutedLabel={t('tool.phoneMuted')}
                  />
                </div>
              </div>

              {/* Clean Live Control Toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMirrorVideo((v) => !v)}
                  aria-pressed={mirrorVideo}
                  className={`inline-flex items-center gap-1.5 min-h-[42px] px-3.5 py-2 rounded-xl font-bold text-sm transition ${
                    mirrorVideo ? 'btn-accent' : 'btn-secondary'
                  }`}
                >
                  <MirrorIcon className="w-4 h-4" />
                  <span>{mirrorVideo ? t('tool.unmirrorVideo') : t('tool.mirrorVideo')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setMonitorMuted((m) => !m)}
                  aria-pressed={!monitorMuted}
                  className={`inline-flex items-center gap-1.5 min-h-[42px] px-3.5 py-2 rounded-xl font-bold text-sm transition ${
                    !monitorMuted ? 'btn-accent' : 'btn-secondary'
                  }`}
                >
                  {monitorMuted ? (
                    <>
                      <VolumeOffIcon className="w-4 h-4" />
                      <span>{t('tool.unmuteMonitor')}</span>
                    </>
                  ) : (
                    <>
                      <VolumeOnIcon className="w-4 h-4" />
                      <span>{t('tool.muteMonitor')}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleToggleFullscreen}
                  className="btn-secondary inline-flex items-center gap-1.5 min-h-[42px] px-3.5 py-2 rounded-xl font-bold text-sm"
                >
                  {isFullscreen ? (
                    <>
                      <ExitFullscreenIcon className="w-4 h-4" />
                      <span>{t('tool.exitFullscreen')}</span>
                    </>
                  ) : (
                    <>
                      <FullscreenIcon className="w-4 h-4" />
                      <span>{t('tool.fullscreen')}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleCopyObsUrl}
                  aria-label={t('tool.copyObsUrl')}
                  className="btn-secondary inline-flex items-center gap-1.5 min-h-[42px] px-3.5 py-2 rounded-xl font-bold text-sm"
                >
                  {copiedObsUrl ? (
                    <>
                      <CheckIcon className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      <span>{t('tool.obsUrlCopied')}</span>
                    </>
                  ) : (
                    <>
                      <LinkIcon className="w-4 h-4" />
                      <span>{t('tool.copyObsUrl')}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleDownloadObsJson}
                  className="btn-accent inline-flex items-center gap-1.5 min-h-[42px] px-3.5 py-2 rounded-xl font-bold text-sm"
                >
                  {obsDownloaded ? (
                    <>
                      <CheckIcon className="w-4 h-4" />
                      <span>{t('tool.obsDownloaded')}</span>
                    </>
                  ) : (
                    <>
                      <DownloadIcon className="w-4 h-4" />
                      <span>{t('tool.downloadObsJson')}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handlePcDisconnect}
                  className="sm:ml-auto inline-flex items-center gap-1.5 min-h-[42px] px-3.5 py-2 rounded-xl bg-rose-500/12 hover:bg-rose-500/20 border border-rose-500/30 text-rose-700 dark:text-rose-300 font-bold text-sm transition"
                >
                  <DisconnectIcon className="w-4 h-4" />
                  <span>{t('tool.disconnect')}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* PHONE SENDER MODE                                                   */}
      {/* =================================================================== */}
      {mode === 'phone' && (
        <div key="mode-phone" className="mode-panel-enter pt-6">
          {/* Error Banner (Phone) */}
          {phoneErrorKey && (
            <div
              role="alert"
              className="mb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-ink"
            >
              <div className="flex items-start gap-3">
                <AlertIcon className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                <p className="text-sm font-medium leading-snug">{t(phoneErrorKey)}</p>
              </div>
              <button
                type="button"
                onClick={localStream ? handlePhoneReconnect : handleStartPhoneStream}
                className="btn-accent inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl font-bold text-sm shrink-0"
              >
                <RefreshIcon className="w-4 h-4" />
                <span>{localStream ? t('tool.reconnect') : t('tool.tryAgain')}</span>
              </button>
            </div>
          )}

          {/* PRE-STREAMING SETUP FORM */}
          {!localStream && (
            <div className="max-w-md mx-auto space-y-5">
              <div className="text-center space-y-2">
                <h2 className="text-lg sm:text-xl font-extrabold text-ink">
                  {t('phone.enterCodeTitle')}
                </h2>
                {autoFilledFromQr && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25">
                    <CheckIcon className="w-3.5 h-3.5" />
                    <span>{t('phone.autoFilledBadge')}</span>
                  </span>
                )}
              </div>

              {/* Fluid 4-Slot Code Input Grid (never overflows even at 320px) */}
              <div className="grid grid-cols-4 gap-2.5 sm:gap-3.5 max-w-[304px] mx-auto">
                {codeChars.map((ch, idx) => (
                  <input
                    key={idx}
                    ref={(el) => {
                      codeInputRefs.current[idx] = el;
                    }}
                    type="text"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={4}
                    value={ch}
                    onChange={(e) => handleCodeInputChange(idx, e.target.value)}
                    onKeyDown={(e) => handleCodeKeyDown(idx, e)}
                    onPaste={handleCodePaste}
                    aria-label={`${t('tool.roomCodeLabel')} ${idx + 1}`}
                    placeholder="•"
                    className="w-full h-16 sm:h-[4.5rem] rounded-xl surface-subtle border border-edge focus:border-accent text-center font-mono text-2xl sm:text-3xl font-extrabold uppercase text-ink placeholder:text-muted/35 transition"
                  />
                ))}
              </div>

              {/* Clean Compact Camera & Quality Row */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="flex items-center justify-between gap-1.5 p-1.5 rounded-xl surface-subtle border border-edge/70">
                  <button
                    type="button"
                    onClick={() => setFacingMode('user')}
                    className={`flex-1 py-2 rounded-lg text-xs sm:text-sm font-bold transition ${
                      facingMode === 'user'
                        ? 'bg-accent text-[#0F172A] shadow-sm'
                        : 'text-muted hover:text-ink'
                    }`}
                  >
                    {t('phone.cameraFront')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFacingMode('environment')}
                    className={`flex-1 py-2 rounded-lg text-xs sm:text-sm font-bold transition ${
                      facingMode === 'environment'
                        ? 'bg-accent text-[#0F172A] shadow-sm'
                        : 'text-muted hover:text-ink'
                    }`}
                  >
                    {t('phone.cameraBack')}
                  </button>
                </div>

                <div className="flex items-center justify-between gap-1.5 p-1.5 rounded-xl surface-subtle border border-edge/70">
                  <button
                    type="button"
                    onClick={() => setQuality('720p')}
                    className={`flex-1 py-2 rounded-lg text-xs sm:text-sm font-bold transition ${
                      quality === '720p'
                        ? 'bg-accent text-[#0F172A] shadow-sm'
                        : 'text-muted hover:text-ink'
                    }`}
                  >
                    720p
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuality('1080p')}
                    className={`flex-1 py-2 rounded-lg text-xs sm:text-sm font-bold transition ${
                      quality === '1080p'
                        ? 'bg-accent text-[#0F172A] shadow-sm'
                        : 'text-muted hover:text-ink'
                    }`}
                  >
                    1080p
                  </button>
                </div>
              </div>

              {/* Primary Gesture CTA (iOS Safari compliant) */}
              <button
                type="button"
                onClick={handleStartPhoneStream}
                disabled={isStartingCamera}
                className="btn-accent w-full min-h-[54px] px-6 py-3.5 rounded-xl inline-flex items-center justify-center gap-2.5 text-base sm:text-lg font-extrabold disabled:opacity-60"
              >
                <CameraIcon className="w-5 h-5 shrink-0" />
                <span>
                  {isStartingCamera ? t('phone.starting') : t('phone.startButton')}
                </span>
              </button>
            </div>
          )}

          {/* ACTIVE STREAMING VIEW */}
          {localStream && (
            <div className="space-y-4">
              <div className="relative w-full max-w-xl mx-auto aspect-video rounded-2xl overflow-hidden bg-black border border-edge">
                <video
                  ref={phoneVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full object-cover ${
                    facingMode === 'user' ? 'scale-x-[-1]' : ''
                  }`}
                />
                <div className="absolute top-3 left-3 px-2.5 py-1 rounded-full bg-black/65 backdrop-blur-md text-xs font-mono font-bold text-[#E3FDFD]">
                  {joinedPhoneCode}
                </div>
                <div className="absolute top-3 right-3">
                  <AudioMeter
                    stream={localStream}
                    muted={micMuted}
                    label={t('tool.audioLevel')}
                    mutedLabel={t('phone.muteMic')}
                    compact
                  />
                </div>
                <div className="absolute bottom-3 left-3 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md text-xs font-semibold text-white">
                  {facingMode === 'user' ? t('phone.cameraFront') : t('phone.cameraBack')} •{' '}
                  {quality}
                </div>
              </div>

              {/* Big Touch-Friendly Control Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <button
                  type="button"
                  onClick={handleSwitchCamera}
                  disabled={isSwitchingCamera}
                  aria-label={t('phone.switchCamera')}
                  className="btn-secondary flex flex-col items-center justify-center gap-1.5 min-h-[68px] p-2.5 rounded-xl font-bold text-xs sm:text-sm disabled:opacity-60"
                >
                  <SwitchCameraIcon className="w-5 h-5" />
                  <span>{t('phone.switchCamera')}</span>
                </button>

                <button
                  type="button"
                  onClick={handleToggleMic}
                  aria-pressed={micMuted}
                  aria-label={micMuted ? t('phone.unmuteMic') : t('phone.muteMic')}
                  className={`flex flex-col items-center justify-center gap-1.5 min-h-[68px] p-2.5 rounded-xl border font-bold text-xs sm:text-sm transition ${
                    micMuted
                      ? 'bg-rose-500/12 border-rose-500/35 text-rose-700 dark:text-rose-300'
                      : 'btn-secondary'
                  }`}
                >
                  {micMuted ? (
                    <>
                      <MicOffIcon className="w-5 h-5" />
                      <span>{t('phone.unmuteMic')}</span>
                    </>
                  ) : (
                    <>
                      <MicIcon className="w-5 h-5" />
                      <span>{t('phone.muteMic')}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleToggleTorch}
                  disabled={!torchSupported}
                  aria-pressed={torchOn}
                  className={`flex flex-col items-center justify-center gap-1.5 min-h-[68px] p-2.5 rounded-xl border font-bold text-xs sm:text-sm transition ${
                    !torchSupported
                      ? 'surface-subtle border-edge/40 text-muted/55 cursor-not-allowed'
                      : torchOn
                        ? 'btn-accent border-accent'
                        : 'btn-secondary'
                  }`}
                >
                  <FlashIcon className="w-5 h-5" />
                  <span>
                    {!torchSupported
                      ? t('phone.torchUnsupported')
                      : torchOn
                        ? t('phone.torchOn')
                        : t('phone.torchOff')}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleToggleWakeLock}
                  disabled={!wakeLockSupported}
                  aria-pressed={wakeLockActive}
                  className={`flex flex-col items-center justify-center gap-1.5 min-h-[68px] p-2.5 rounded-xl border font-bold text-xs sm:text-sm transition ${
                    !wakeLockSupported
                      ? 'surface-subtle border-edge/40 text-muted/55 cursor-not-allowed'
                      : wakeLockActive
                        ? 'btn-accent border-accent'
                        : 'btn-secondary'
                  }`}
                >
                  <SunAwakeIcon className="w-5 h-5" />
                  <span>
                    {!wakeLockSupported
                      ? t('phone.wakeLockUnsupported')
                      : wakeLockActive
                        ? t('phone.wakeLockOn')
                        : t('phone.wakeLockOff')}
                  </span>
                </button>
              </div>

              <div className="flex flex-col sm:flex-row gap-2.5">
                {phoneStatus === 'disconnected' && (
                  <button
                    type="button"
                    onClick={handlePhoneReconnect}
                    className="btn-accent flex-1 min-h-[48px] px-5 py-2.5 rounded-xl inline-flex items-center justify-center gap-2 text-sm sm:text-base font-extrabold"
                  >
                    <RefreshIcon className="w-5 h-5" />
                    <span>{t('tool.reconnect')}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => teardownPhoneSender(true)}
                  className="flex-1 min-h-[48px] px-5 py-2.5 rounded-xl inline-flex items-center justify-center gap-2 bg-rose-500/12 hover:bg-rose-500/20 border border-rose-500/30 text-rose-700 dark:text-rose-300 text-sm sm:text-base font-extrabold transition"
                >
                  <DisconnectIcon className="w-5 h-5" />
                  <span>{t('tool.disconnect')}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default WebcamTool;
