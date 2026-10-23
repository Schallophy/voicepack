import { clamp } from './util.js';
import { normalizeSegments } from './edits.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.sinkId = '';
    this.sinkSupported = false;
  }

  context() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('当前环境不支持 Web Audio');
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.sinkSupported = typeof this.ctx.setSinkId === 'function';
    }
    return this.ctx;
  }

  async ensure() {
    const ctx = this.context();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* 用户手势后会自动恢复 */ }
    }
    return ctx;
  }

  async decode(data) {
    const ctx = this.context();
    const bytes = data instanceof ArrayBuffer ? data.slice(0) : data;
    return await ctx.decodeAudioData(bytes);
  }

  async setSink(id) {
    const ctx = this.context();
    if (!this.sinkSupported) throw new Error('当前环境不支持选择输出设备');
    await ctx.setSinkId(id || '');
    this.sinkId = id || '';
  }

  renderSegments(source, segments) {
    const clean = normalizeSegments(segments, source.length);
    if (!clean.length) throw new Error('编辑后的音频为空');
    const total = clean.reduce((sum, s) => sum + (s.end - s.start), 0);
    if (total <= 0) throw new Error('编辑后的音频为空');

    const sampleRate = source.sampleRate;
    const out = this.context().createBuffer(source.numberOfChannels, total, sampleRate);
    const boundaries = [];
    let cursor = 0;

    for (let i = 0; i < clean.length; i++) {
      const seg = clean[i];
      const len = seg.end - seg.start;
      for (let c = 0; c < source.numberOfChannels; c++) {
        const src = source.getChannelData(c);
        const dst = out.getChannelData(c);
        dst.set(src.subarray(seg.start, seg.end), cursor);
      }
      cursor += len;
      if (i < clean.length - 1) boundaries.push(cursor);
    }

    const applyIn = (data, at, frames) => {
      const n = Math.max(1, frames);
      for (let i = 0; i < n; i++) data[at + i] *= (i + 1) / n;
    };
    const applyOut = (data, at, frames) => {
      const n = Math.max(1, frames);
      for (let i = 0; i < n; i++) data[at - n + i] *= (n - 1 - i) / Math.max(1, n - 1);
    };

    const edgeFrames = Math.max(1, Math.min(Math.round(sampleRate * 0.001), Math.floor(total / 2)));
    for (let c = 0; c < out.numberOfChannels; c++) {
      const data = out.getChannelData(c);
      applyIn(data, 0, edgeFrames);
      applyOut(data, total, edgeFrames);
      for (const b of boundaries) {
        const n = Math.max(1, Math.min(Math.round(sampleRate * 0.003), Math.floor(b / 2), Math.floor((total - b) / 2)));
        applyOut(data, b, n);
        applyIn(data, b, n);
      }
    }

    return out;
  }
}

export function peakOf(buffer) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

export function gainForDb(db) {
  return clamp(Math.pow(10, (Number(db) || 0) / 20), 0, 4);
}
