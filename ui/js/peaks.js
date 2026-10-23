import { sleep } from './util.js';

export async function buildPeaks(buffer, bucket = 128, onProgress) {
  const length = buffer.length;
  const count = Math.max(1, Math.ceil(length / bucket));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  let peak = 0;
  let index = 0;
  let started = performance.now();

  for (let offset = 0; offset < length; offset += bucket) {
    const end = Math.min(length, offset + bucket);
    let lo = 0;
    let hi = 0;
    for (const data of channels) {
      for (let i = offset; i < end; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[index] = lo;
    max[index] = hi;
    const abs = Math.max(Math.abs(lo), Math.abs(hi));
    if (abs > peak) peak = abs;
    index++;

    if ((index & 511) === 0 && performance.now() - started > 12) {
      onProgress?.(index / count);
      await sleep(0);
      started = performance.now();
    }
  }

  onProgress?.(1);
  return { bucket, count, min, max, peak, length, sampleRate: buffer.sampleRate };
}
