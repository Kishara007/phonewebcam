import React, { useEffect, useRef, useState } from 'react';
import type Peer from 'peerjs';
import type { DataConnection, MediaConnection } from 'peerjs';
import {
  getObsRelayPeerId,
  getReceiverPeerId,
  sanitizeRoomCode,
} from '@/lib/roomCode';
import { PEER_OPTIONS, type PeerControlMessage } from '@/lib/webrtc';
import { translate, type LanguageCode } from '@/i18n';
import { VolumeOnIcon } from './Icons';

interface ObsCleanViewProps {
  rawCode: string;
  lang: LanguageCode;
}

/**
 * Full-viewport 100vw x 100vh zero-chrome black canvas for OBS Browser Source (?view=CODE).
 *
 * Dual-mode automatic attachment:
 * 1. Tries claiming `pwc-v1-recv-CODE` directly (when PC preview tab is closed).
 * 2. If `unavailable-id` (PC preview tab is already open!), connects as a relay observer
 *    to `pwc-v1-recv-CODE` and receives the live MediaStream automatically with zero user steps!
 */
export const ObsCleanView: React.FC<ObsCleanViewProps> = ({ rawCode, lang }) => {
  const code = sanitizeRoomCode(rawCode);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const callRef = useRef<MediaConnection | null>(null);
  const relayConnRef = useRef<DataConnection | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  const [hasStream, setHasStream] = useState(false);
  const [needsAudioGesture, setNeedsAudioGesture] = useState(false);

  const attachStream = (stream: MediaStream) => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    if (videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
    }

    // OBS Browser Source routes unmuted audio via reroute_audio=true
    videoEl.muted = false;
    videoEl
      .play()
      .then(() => {
        setHasStream(true);
        setNeedsAudioGesture(false);
      })
      .catch(() => {
        // Fallback when previewed inside a regular browser tab blocking unmuted autoplay
        videoEl.muted = true;
        videoEl
          .play()
          .then(() => {
            setHasStream(true);
            setNeedsAudioGesture(true);
          })
          .catch(() => {});
      });
  };

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.add('obs-clean-view');
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.documentElement.classList.remove('obs-clean-view');
      }
    };
  }, []);

  useEffect(() => {
    if (!code || code.length !== 4) return;

    let cancelled = false;

    const cleanup = () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      try {
        callRef.current?.close();
      } catch {
        // ignore
      }
      callRef.current = null;
      try {
        relayConnRef.current?.close();
      } catch {
        // ignore
      }
      relayConnRef.current = null;
      try {
        peerRef.current?.destroy();
      } catch {
        // ignore
      }
      peerRef.current = null;
    };

    const scheduleReconnect = (delayMs = 2000) => {
      if (cancelled) return;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
      retryTimerRef.current = window.setTimeout(() => {
        if (!cancelled) {
          startDirectReceiver();
        }
      }, delayMs);
    };

    const wireIncomingCall = (call: MediaConnection) => {
      if (callRef.current && callRef.current !== call) {
        try {
          callRef.current.close();
        } catch {
          // ignore
        }
      }
      callRef.current = call;
      call.answer();

      call.on('stream', (remoteStream) => {
        if (!cancelled) {
          attachStream(remoteStream);
        }
      });

      call.on('close', () => {
        if (!cancelled) {
          setHasStream(false);
          if (videoRef.current) {
            videoRef.current.srcObject = null;
          }
        }
      });

      call.on('error', () => {
        if (!cancelled) {
          setHasStream(false);
        }
      });
    };

    const startRelayObserver = async () => {
      if (cancelled) return;
      cleanup();
      const { default: PeerClass } = await import('peerjs');
      if (cancelled) return;

      const relayPeer = new PeerClass(getObsRelayPeerId(code), PEER_OPTIONS);
      peerRef.current = relayPeer;

      relayPeer.on('open', () => {
        if (cancelled) return;
        const conn = relayPeer.connect(getReceiverPeerId(code), { reliable: true });
        relayConnRef.current = conn;

        conn.on('open', () => {
          const msg: PeerControlMessage = { type: 'request-relay' };
          conn.send(msg);
        });

        conn.on('close', () => {
          // Primary PC tab closed — reclaim primary receiver ID so phone can reconnect directly
          if (!cancelled) {
            setHasStream(false);
            scheduleReconnect(1500);
          }
        });

        conn.on('error', () => {
          if (!cancelled) {
            scheduleReconnect(2500);
          }
        });
      });

      relayPeer.on('call', wireIncomingCall);

      relayPeer.on('error', () => {
        if (!cancelled) {
          scheduleReconnect(3000);
        }
      });
    };

    const startDirectReceiver = async () => {
      if (cancelled) return;
      cleanup();
      const { default: PeerClass } = await import('peerjs');
      if (cancelled) return;

      const peer = new PeerClass(getReceiverPeerId(code), PEER_OPTIONS);
      peerRef.current = peer;

      peer.on('call', wireIncomingCall);

      peer.on('disconnected', () => {
        if (!cancelled && !peer.destroyed) {
          try {
            peer.reconnect();
          } catch {
            scheduleReconnect(2500);
          }
        }
      });

      peer.on('error', (err: { type?: string }) => {
        if (cancelled) return;
        if (err?.type === 'unavailable-id') {
          // PC preview tab currently owns the primary receiver ID; attach as relay observer
          startRelayObserver();
        } else {
          scheduleReconnect(3000);
        }
      });
    };

    startDirectReceiver();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [code]);

  const handleEnableAudio = () => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    videoEl.muted = false;
    videoEl
      .play()
      .then(() => setNeedsAudioGesture(false))
      .catch(() => {});
  };

  return (
    <div className="fixed inset-0 w-screen h-screen bg-black overflow-hidden select-none">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="block w-screen h-screen object-cover bg-black"
      />

      {!hasStream && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="inline-flex items-center gap-3 px-5 py-3 rounded-full bg-white/5 border border-white/10 text-white/75 text-base font-medium">
            <span className="w-2.5 h-2.5 rounded-full bg-[#71C9CE] animate-pulse" />
            <span>
              {translate(lang, 'obs.waitingLabel')}{' '}
              <strong className="font-mono text-[#71C9CE] tracking-widest">
                {code || '----'}
              </strong>
            </span>
          </div>
        </div>
      )}

      {hasStream && needsAudioGesture && (
        <button
          type="button"
          onClick={handleEnableAudio}
          className="absolute bottom-5 right-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-[#71C9CE] text-[#0F172A] font-semibold text-sm shadow-lg hover:bg-[#A6E3E9] transition"
        >
          <VolumeOnIcon className="w-5 h-5" />
          <span>{translate(lang, 'obs.clickUnmute')}</span>
        </button>
      )}
    </div>
  );
};
