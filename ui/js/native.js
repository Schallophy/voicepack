// Capability layer between the UI and the native (Rust) backend.
// Inside the Tauri shell every audible path goes through these commands;
// in a plain browser `isNative` is false and the Web Audio fallback runs.

const tauri = typeof window !== 'undefined' ? window.__TAURI__ : null;

export const isNative = !!(tauri?.core?.invoke);

export function invoke(cmd, payload = null, options) {
  if (!isNative) return Promise.reject(new Error('原生后端不可用'));
  return tauri.core.invoke(cmd, payload, options);
}

export function listen(event, handler) {
  if (!isNative) return Promise.reject(new Error('原生后端不可用'));
  return tauri.event.listen(event, handler);
}

/// Interleave two channel planes into one 48 kHz stereo f32 buffer.
/// Native playback accepts only 48 kHz — anything else goes through an
/// OfflineAudioContext first so the browser's resampler owns that difference.
export async function toNativePcm(buffer, startSec = 0, endSec = buffer.duration) {
  const RATE = 48_000;
  let rendered = buffer;
  let offset = startSec;
  const duration = Math.max(0, endSec - startSec);
  if (buffer.sampleRate !== RATE || buffer.numberOfChannels !== 2) {
    const length = Math.max(1, Math.ceil(duration * RATE));
    const off = new OfflineAudioContext(2, length, RATE);
    const src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start(0, startSec, duration);
    rendered = await off.startRendering();
    offset = 0;
  }
  const start = Math.max(0, Math.min(rendered.length, Math.floor(offset * rendered.sampleRate)));
  const end = Math.max(start, Math.min(rendered.length, Math.ceil((offset + duration) * rendered.sampleRate)));
  const left = rendered.getChannelData(0);
  const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
  const frames = end - start;
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    out[i * 2] = left[start + i];
    out[i * 2 + 1] = right[start + i];
  }
  return out;
}
