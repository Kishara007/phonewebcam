use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, StreamConfig};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Routes mono/stereo f32 PCM audio from WebView2 directly to Windows WASAPI (`CABLE Input`)
/// on a dedicated background audio thread so `cpal::Stream` remains thread-safe.
pub struct AudioBridge {
    ring: Arc<Mutex<VecDeque<f32>>>,
    running: Arc<AtomicBool>,
    cable_detected: Arc<AtomicBool>,
    device_name: Arc<Mutex<Option<String>>>,
    device_sample_rate: Arc<AtomicU32>,
}

impl AudioBridge {
    pub fn new() -> Self {
        let ring = Arc::new(Mutex::new(VecDeque::<f32>::with_capacity(9600)));
        let running = Arc::new(AtomicBool::new(true));
        let cable_detected = Arc::new(AtomicBool::new(false));
        let device_name = Arc::new(Mutex::new(None));
        let device_sample_rate = Arc::new(AtomicU32::new(48_000));

        let ring_bg = Arc::clone(&ring);
        let running_bg = Arc::clone(&running);
        let detected_bg = Arc::clone(&cable_detected);
        let name_bg = Arc::clone(&device_name);
        let rate_bg = Arc::clone(&device_sample_rate);

        thread::spawn(move || {
            run_wasapi_loop(ring_bg, running_bg, detected_bg, name_bg, rate_bg);
        });

        Self {
            ring,
            running,
            cable_detected,
            device_name,
            device_sample_rate,
        }
    }

    pub fn is_cable_detected(&self) -> bool {
        self.cable_detected.load(Ordering::Relaxed)
    }

    pub fn device_name(&self) -> Option<String> {
        self.device_name.lock().ok().and_then(|g| g.clone())
    }

    /// Pushes little-endian f32 mono PCM bytes into the bounded WASAPI output jitter buffer.
    pub fn push_f32_pcm(&self, raw_le_bytes: &[u8], src_sample_rate: u32) {
        if !self.is_cable_detected() || raw_le_bytes.len() < 4 {
            return;
        }

        let dst_rate = self.device_sample_rate.load(Ordering::Relaxed).max(8_000);
        let src_rate = src_sample_rate.max(8_000);
        let sample_count = raw_le_bytes.len() / 4;

        let mut samples = Vec::with_capacity(sample_count);
        for chunk in raw_le_bytes.chunks_exact(4) {
            let val = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            samples.push(if val.is_finite() { val.clamp(-1.0, 1.0) } else { 0.0 });
        }

        let Ok(mut guard) = self.ring.lock() else {
            return;
        };

        // Keep max ~100 ms buffered to preserve real-time lip sync.
        let max_buffered = (dst_rate as usize) / 10;

        if src_rate == dst_rate {
            for s in samples {
                guard.push_back(s);
            }
        } else {
            // Lightweight linear resampler (e.g., 44.1 kHz <-> 48 kHz).
            let ratio = src_rate as f64 / dst_rate as f64;
            let out_len = ((samples.len() as f64) / ratio).round() as usize;
            for i in 0..out_len {
                let pos = i as f64 * ratio;
                let idx = (pos as usize).min(samples.len().saturating_sub(1));
                let next = (idx + 1).min(samples.len().saturating_sub(1));
                let frac = (pos - idx as f64) as f32;
                let sample = samples[idx] + (samples[next] - samples[idx]) * frac;
                guard.push_back(sample);
            }
        }

        while guard.len() > max_buffered {
            guard.pop_front();
        }
    }

    pub fn clear(&self) {
        if let Ok(mut guard) = self.ring.lock() {
            guard.clear();
        }
    }
}

impl Drop for AudioBridge {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

fn find_vbcable_device(host: &cpal::Host) -> Option<(cpal::Device, String)> {
    let devices = host.output_devices().ok()?;
    for device in devices {
        if let Ok(name) = device.name() {
            let lower = name.to_lowercase();
            if lower.contains("cable input") || lower.contains("vb-audio virtual cable") {
                return Some((device, name));
            }
        }
    }
    None
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    ring: Arc<Mutex<VecDeque<f32>>>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: Sample + SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    device.build_output_stream(
        config,
        move |data: &mut [T], _| {
            let mut guard = ring.lock().ok();
            for frame in data.chunks_mut(channels) {
                let sample_f32 = guard
                    .as_mut()
                    .and_then(|q| q.pop_front())
                    .unwrap_or(0.0);
                let converted = T::from_sample(sample_f32);
                for ch in frame.iter_mut() {
                    *ch = converted;
                }
            }
        },
        |_err| {},
        None,
    )
}

fn run_wasapi_loop(
    ring: Arc<Mutex<VecDeque<f32>>>,
    running: Arc<AtomicBool>,
    cable_detected: Arc<AtomicBool>,
    device_name: Arc<Mutex<Option<String>>>,
    device_sample_rate: Arc<AtomicU32>,
) {
    let host = cpal::default_host();

    while running.load(Ordering::Relaxed) {
        let Some((device, name)) = find_vbcable_device(&host) else {
            cable_detected.store(false, Ordering::Relaxed);
            if let Ok(mut g) = device_name.lock() {
                *g = None;
            }
            thread::sleep(Duration::from_secs(3));
            continue;
        };

        let Ok(supported) = device.default_output_config() else {
            thread::sleep(Duration::from_secs(3));
            continue;
        };

        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.into();
        device_sample_rate.store(config.sample_rate.0, Ordering::Relaxed);

        let stream_res = match sample_format {
            SampleFormat::F32 => build_stream::<f32>(&device, &config, Arc::clone(&ring)),
            SampleFormat::I16 => build_stream::<i16>(&device, &config, Arc::clone(&ring)),
            SampleFormat::U16 => build_stream::<u16>(&device, &config, Arc::clone(&ring)),
            _ => {
                thread::sleep(Duration::from_secs(3));
                continue;
            }
        };

        let Ok(stream) = stream_res else {
            thread::sleep(Duration::from_secs(3));
            continue;
        };

        if stream.play().is_err() {
            thread::sleep(Duration::from_secs(3));
            continue;
        }

        cable_detected.store(true, Ordering::Relaxed);
        if let Ok(mut g) = device_name.lock() {
            *g = Some(name);
        }

        // Keep WASAPI stream alive until app shutdown.
        while running.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(500));
        }

        drop(stream);
    }
}
