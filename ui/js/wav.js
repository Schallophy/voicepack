import { clamp, dbToGain } from './util.js';

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function audioBufferToWav(buffer, opts = {}) {
  const bitDepth = opts.bitDepth === 16 || opts.bitDepth === 32 ? opts.bitDepth : 24;
  const mono = !!opts.mono;
  const gainDb = Number(opts.gainDb) || 0;
  const fadeInMs = Math.max(0, Number(opts.fadeInMs) || 0);
  const fadeOutMs = Math.max(0, Number(opts.fadeOutMs) || 0);

  const srcChannels = buffer.numberOfChannels;
  const outChannels = mono ? 1 : srcChannels;
  const frames = buffer.length;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = bitDepth / 8;
  const dataBytes = frames * outChannels * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const isFloat = bitDepth === 32;
  const format = isFloat ? 3 : 1;

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, outChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * outChannels * bytesPerSample, true);
  view.setUint16(32, outChannels * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  const gain = dbToGain(gainDb);
  const fadeIn = Math.round((fadeInMs / 1000) * sampleRate);
  const fadeOut = Math.round((fadeOutMs / 1000) * sampleRate);
  const channels = [];
  for (let c = 0; c < srcChannels; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    let env = gain;
    if (fadeIn > 0 && i < fadeIn) env *= i / fadeIn;
    if (fadeOut > 0 && i >= frames - fadeOut) env *= (frames - 1 - i) / fadeOut;
    env = Math.max(0, env);

    let channelsToWrite;
    if (mono) {
      let sum = 0;
      for (const data of channels) sum += data[i];
      channelsToWrite = [sum / srcChannels];
    } else {
      channelsToWrite = channels.map((data) => data[i]);
    }

    for (const raw of channelsToWrite) {
      let sample = raw * env;
      if (!Number.isFinite(sample)) sample = 0;

      if (isFloat) {
        view.setFloat32(offset, sample, true);
        offset += 4;
      } else if (bitDepth === 16) {
        sample = clamp(sample, -1, 1);
        const dither = (Math.random() - Math.random()) / 32768;
        const v = clamp(Math.round(sample * 32767 + dither), -32768, 32767);
        view.setInt16(offset, v, true);
        offset += 2;
      } else {
        sample = clamp(sample, -1, 1);
        const v = Math.max(-8388608, Math.min(8388607, Math.round(sample * 8388607)));
        bytes[offset] = v & 0xff;
        bytes[offset + 1] = (v >> 8) & 0xff;
        bytes[offset + 2] = (v >> 16) & 0xff;
        offset += 3;
      }
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
