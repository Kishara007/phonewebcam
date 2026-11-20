import React, { useEffect, useRef, useState } from 'react';
import { MicIcon, MicOffIcon } from './Icons';

interface AudioMeterProps {
  stream: MediaStream | null;
  muted?: boolean;
  label: string;
  mutedLabel?: string;
  compact?: boolean;
}

const BAR_COUNT = 7;
const BAR_WEIGHTS = [0.55, 0.8, 0.95, 1.0, 0.9, 0.75, 0.5];

export const AudioMeter: React.FC<AudioMeterProps> = ({
  stream,
  muted = false,
  label,
  mutedLabel,
  compact = false,
}) => {
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0.14));
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!stream || muted) {
      setLevels(Array(BAR_COUNT).fill(0.12));
      return;
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      setLevels(Array(BAR_COUNT).fill(0.12));
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    let audioCtx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let cancelled = false;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const resumeAudio = () => {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    };

    try {
      audioCtx = new AudioCtx();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;

      const audioOnlyStream = new MediaStream(audioTracks);
      source = audioCtx.createMediaStreamSource(audioOnlyStream);
      source.connect(analyser);

      resumeAudio();
      window.addEventListener('pointerdown', resumeAudio, { once: true });
      window.addEventListener('keydown', resumeAudio, { once: true });

      const freqData = new Uint8Array(analyser.frequencyBinCount);
      const timeData = new Uint8Array(analyser.fftSize);
      let lastUpdate = 0;

      const tick = (now: number) => {
        if (cancelled || !analyser) return;

        const minInterval = prefersReducedMotion ? 160 : 45;
        if (now - lastUpdate >= minInterval) {
          lastUpdate = now;
          analyser.getByteFrequencyData(freqData);
          analyser.getByteTimeDomainData(timeData);

          // Calculate RMS from time domain for ultra-responsive voice pickup
          let sumSquares = 0;
          for (let i = 0; i < timeData.length; i++) {
            const normalized = (timeData[i] - 128) / 128;
            sumSquares += normalized * normalized;
          }
          const rms = Math.sqrt(sumSquares / timeData.length);
          const boostedRms = Math.min(1, rms * 3.8);

          const nextLevels = BAR_WEIGHTS.map((weight, idx) => {
            const binIndex = Math.min(freqData.length - 1, 2 + idx * 4);
            const freqVal = freqData[binIndex] / 255;
            const combined = Math.max(boostedRms * weight, freqVal * 0.9);
            return Math.max(0.14, Math.min(1, combined));
          });

          setLevels(nextLevels);
        }

        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Gracefully fall back to idle meter if Web Audio API is unavailable
    }

    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', resumeAudio);
      window.removeEventListener('keydown', resumeAudio);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      try {
        source?.disconnect();
        analyser?.disconnect();
        if (audioCtx && audioCtx.state !== 'closed') {
          audioCtx.close().catch(() => {});
        }
      } catch {
        // Ignore teardown errors
      }
    };
  }, [stream, muted]);

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full backdrop-blur-md border ${
        compact
          ? 'px-2.5 py-1 bg-black/55 border-white/15 text-white'
          : 'px-3.5 py-1.5 bg-black/65 border-white/15 text-white'
      }`}
      role="status"
      aria-label={muted ? mutedLabel || label : label}
    >
      {muted ? (
        <MicOffIcon className="w-4 h-4 text-rose-400 shrink-0" />
      ) : (
        <MicIcon className="w-4 h-4 text-[#71C9CE] shrink-0" />
      )}

      {muted ? (
        <span className="text-xs font-semibold text-rose-200 whitespace-nowrap">
          {mutedLabel || label}
        </span>
      ) : (
        <div
          className="flex items-end gap-[3px] h-4"
          aria-hidden="true"
        >
          {levels.map((level, idx) => (
            <span
              key={idx}
              className="audio-meter-bar w-[3px] h-full rounded-full bg-[#71C9CE]"
              style={{
                transform: `scaleY(${level.toFixed(2)})`,
                opacity: 0.45 + level * 0.55,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};
