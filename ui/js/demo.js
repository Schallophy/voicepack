function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeBuffer(buffer, target = 0.5, edgeSeconds = 0.003) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  let peak = 0;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  const gain = peak > 1e-8 ? target / peak : 0;
  const edge = Math.max(1, Math.round(buffer.sampleRate * edgeSeconds));
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) data[i] *= gain;
    const n = Math.min(edge, Math.floor(data.length / 2));
    for (let i = 0; i < n; i++) {
      data[i] *= i / n;
      data[data.length - 1 - i] *= i / n;
    }
  }
}

export function makeDemoSpeech(ctx, sampleRate = 48000) {
  const duration = 2.8;
  const length = Math.round(duration * sampleRate);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const random = mulberry32(20261023);
  const syllables = [
    { start: 0.10, len: 0.28, f0: 168, amp: 0.8 },
    { start: 0.46, len: 0.20, f0: 202, amp: 0.62 },
    { start: 0.76, len: 0.34, f0: 142, amp: 0.92 },
    { start: 1.20, len: 0.24, f0: 190, amp: 0.68 },
    { start: 1.55, len: 0.42, f0: 128, amp: 0.95 },
    { start: 2.08, len: 0.20, f0: 214, amp: 0.56 },
    { start: 2.36, len: 0.28, f0: 158, amp: 0.72 },
  ];

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let sample = 0;
    for (const sy of syllables) {
      const u = t - sy.start;
      if (u < 0 || u > sy.len) continue;
      const p = u / sy.len;
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, p))), 0.55);
      const glide = 1 - 0.035 * p;
      const f0 = sy.f0 * glide * (1 + 0.012 * Math.sin(2 * Math.PI * 4.6 * u));
      const phase = 2 * Math.PI * sy.f0 * (u - (0.035 * u * u) / (2 * sy.len)) + 0.45 * Math.sin(2 * Math.PI * 4.6 * u);
      let tone = 0;
      for (let h = 1; h <= 10; h++) {
        const f = f0 * h;
        const weight = 1 / Math.pow(h, 1.15);
        const formant =
          0.55 +
          0.7 * Math.exp(-Math.pow((f - 740) / 420, 2)) +
          0.35 * Math.exp(-Math.pow((f - 1320) / 520, 2));
        tone += weight * formant * Math.sin(phase * h);
      }
      const noise = u < 0.04 ? (random() * 2 - 1) * Math.exp(-u / 0.015) * 0.22 : 0;
      sample += env * (tone * 0.24 + noise) * sy.amp;
    }
    data[i] = sample;
  }

  normalizeBuffer(buffer, 0.54, 0.004);
  return buffer;
}

export function makeDemoChime(ctx, sampleRate = 48000) {
  const duration = 1.6;
  const length = Math.round(duration * sampleRate);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const notes = [
    { t: 0.02, f: 880.0 },
    { t: 0.31, f: 1174.66 },
    { t: 0.63, f: 1567.98 },
  ];
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let sample = 0;
    for (const n of notes) {
      const u = t - n.t;
      if (u < 0) continue;
      const attack = Math.min(1, u / 0.006);
      const decay = Math.exp(-u / 0.42);
      sample += attack * decay * (
        Math.sin(2 * Math.PI * n.f * u) * 0.6 +
        Math.sin(2 * Math.PI * n.f * 2.01 * u) * 0.22 +
        Math.sin(2 * Math.PI * n.f * 3.02 * u) * 0.08
      );
    }
    data[i] = sample;
  }
  normalizeBuffer(buffer, 0.38, 0.004);
  return buffer;
}

export function makeDemoGame(ctx, sampleRate = 48000) {
  const duration = 3.6;
  const length = Math.round(duration * sampleRate);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const random = mulberry32(77);
  const notes = [
    { t: 0.0, f: 392.0, len: 0.55 },
    { t: 0.18, f: 523.25, len: 0.55 },
    { t: 0.36, f: 659.25, len: 0.55 },
    { t: 0.90, f: 783.99, len: 0.7 },
    { t: 1.20, f: 1046.5, len: 1.1 },
  ];
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let sample = 0;
    for (const n of notes) {
      const u = t - n.t;
      if (u < 0 || u > n.len + 0.8) continue;
      const attack = Math.min(1, u / 0.012);
      const decay = Math.exp(-u / 0.45);
      sample += attack * decay * (
        Math.sin(2 * Math.PI * n.f * u) * 0.5 +
        Math.sin(2 * Math.PI * n.f * 2 * u) * 0.2 +
        Math.sin(2 * Math.PI * n.f * 3 * u) * 0.08
      );
    }
    if (t < 0.5) {
      sample += (random() * 2 - 1) * Math.exp(-t / 0.18) * 0.09;
    }
    data[i] = sample;
  }
  normalizeBuffer(buffer, 0.48, 0.004);
  return buffer;
}

export function makeDemoMusic(ctx, sampleRate = 48000) {
  const duration = 4.0;
  const length = Math.round(duration * sampleRate);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const sequence = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63, 293.66, 392.0];
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const step = Math.floor(t / 0.5) % sequence.length;
    const u = t % 0.5;
    const f = sequence[step];
    const env = Math.min(1, u / 0.02) * Math.exp(-u / 0.55);
    data[i] = env * (
      Math.sin(2 * Math.PI * f * t) * 0.48 +
      Math.sin(2 * Math.PI * f * 2 * t) * 0.14
    );
  }
  normalizeBuffer(buffer, 0.36, 0.004);
  return buffer;
}

export const DEMO_APPS = [
  { id: 'game', name: '示例游戏', sub: '示例 · 游戏内语音', color: '#b7791f', initial: '游', bufferKey: 'game' },
  { id: 'player', name: '示例播放器', sub: '示例 · 音乐播放', color: '#3f7d58', initial: '播', bufferKey: 'music' },
  { id: 'browser', name: '浏览器标签页', sub: '示例 · 网页音频', color: '#4b6b8a', initial: '页', bufferKey: 'speech' },
];

export function makeDemoBuffers(ctx) {
  const speech = makeDemoSpeech(ctx);
  const chime = makeDemoChime(ctx);
  const game = makeDemoGame(ctx);
  const music = makeDemoMusic(ctx);
  return { speech, chime, game, music };
}
