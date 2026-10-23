// 会话实时落盘。元数据是一小块 JSON，素材和语音各自一个不可变的 float32 音频块：
// 改名、裁剪只重写 JSON，音频只在诞生那一刻写一次。「导出/导入语音包」是分发格式，走另一条路。

import { isNative, invoke } from './native.js';
import { normalizeSegments } from './edits.js';

const SCHEMA = 1;
const TICK_MS = 400;

function planarBytes(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const out = new Float32Array(channels * frames);
  for (let c = 0; c < channels; c++) out.set(buffer.getChannelData(c), c * frames);
  return out;
}

export class SessionStore {
  constructor(app) {
    this.app = app;
    this.enabled = isNative;
    this.written = new Set();
    this.last = '';
    this.busy = false;
    this.again = false;
    this.warned = false;
    this.timer = 0;
  }

  rows() {
    const app = this.app;
    const audio = new Map();
    const assets = app.assets.map((asset) => {
      audio.set(asset.id, asset.buffer);
      return {
        id: asset.id,
        name: asset.name,
        createdAt: asset.createdAt,
        sampleRate: asset.buffer.sampleRate,
        channels: asset.buffer.numberOfChannels,
        frames: asset.buffer.length,
        segments: asset.segments,
        gainDb: asset.gainDb,
        fadeInMs: asset.fadeInMs,
        fadeOutMs: asset.fadeOutMs,
      };
    });
    const voices = [];
    for (const [packId, list] of app.voicesByPack) {
      for (const voice of list) {
        audio.set(voice.id, voice.renderBuffer);
        voices.push({
          id: voice.id,
          name: voice.name,
          createdAt: voice.createdAt,
          packId,
          sampleRate: voice.sampleRate,
          channels: voice.channels,
          frames: voice.renderBuffer.length,
          gainDb: voice.gainDb,
          fadeInMs: voice.fadeInMs,
          fadeOutMs: voice.fadeOutMs,
          hotkey: voice.hotkey,
        });
      }
    }
    return { assets, voices, audio };
  }

  state() {
    const app = this.app;
    const { assets, voices } = this.rows();
    return {
      schemaVersion: SCHEMA,
      packs: app.packs.map((pack) => ({ id: pack.id, name: pack.name, createdAt: pack.createdAt })),
      packId: app.packId,
      sourceMode: app.sourceMode,
      micDeviceId: app.micDeviceId,
      outputId: app.outputId,
      boardLayout: app.boardLayout,
      assets,
      voices,
    };
  }

  /// 把当前会话写下去：先补音频块，再写引用它们的 JSON，顺序反了就会留下指向空文件的记录。
  async flush() {
    if (!this.enabled) return false;
    if (this.busy) {
      this.again = true;
      return false;
    }
    this.busy = true;
    let wrote = false;
    try {
      do {
        this.again = false;
        const { assets, voices, audio } = this.rows();
        const raw = JSON.stringify(this.state());
        const live = new Set();
        for (const item of [...assets, ...voices]) {
          live.add(item.id);
          if (this.written.has(item.id)) continue;
          const bytes = planarBytes(audio.get(item.id));
          await invoke('put_blob', bytes.buffer, { headers: { 'x-id': item.id } });
          this.written.add(item.id);
          wrote = true;
        }
        for (const id of this.written) if (!live.has(id)) this.written.delete(id);
        if (raw !== this.last || wrote) {
          await invoke('write_state', { raw, keep: [...live] });
          this.last = raw;
        }
      } while (this.again);
      this.warned = false;
      return wrote;
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      this.flush().catch((err) => this.report(err));
    }, TICK_MS);
    addEventListener('pagehide', () => { this.flush().catch(() => {}); });
  }

  report(err) {
    if (this.warned) return;
    this.warned = true;
    import('./ui.js').then(({ showToast }) => {
      showToast(`自动保存失败：${err?.message || err}`, { type: 'error', duration: 6000 });
    });
  }

  async restore() {
    if (!this.enabled) return null;
    const raw = await invoke('read_state').catch(() => null);
    if (!raw) return null;
    let state = null;
    try {
      state = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!state || state.schemaVersion !== SCHEMA || !Array.isArray(state.assets)) return null;
    const app = this.app;
    const ctx = app.engine.context();
    const decode = async (row) => {
      const bytes = await invoke('read_blob', { id: row.id });
      const samples = new Float32Array(bytes);
      const frames = Math.max(1, Math.trunc(row.frames) || 1);
      const channels = Math.min(2, Math.max(1, Math.trunc(row.channels) || 1));
      if (samples.length < frames * channels) throw new Error('音频块不完整');
      const buffer = ctx.createBuffer(channels, frames, row.sampleRate || 48000);
      for (let c = 0; c < channels; c++) {
        buffer.getChannelData(c).set(samples.subarray(c * frames, (c + 1) * frames));
      }
      return buffer;
    };

    app.packs = (state.packs || []).map((pack) => ({
      id: pack.id, name: pack.name, createdAt: pack.createdAt,
    }));
    if (!app.packs.length) {
      const pack = { id: crypto.randomUUID(), name: '默认语音包', createdAt: Date.now() };
      app.packs.push(pack);
    }
    app.packId = app.packs.some((p) => p.id === state.packId) ? state.packId : app.packs[0].id;
    app.voicesByPack = new Map(app.packs.map((pack) => [pack.id, []]));

    let dropped = 0;
    for (const row of state.voices || []) {
      try {
        const voice = app.buildVoice({
          id: row.id,
          name: row.name,
          buffer: await decode(row),
          gainDb: row.gainDb,
          fadeInMs: row.fadeInMs,
          fadeOutMs: row.fadeOutMs,
          hotkey: row.hotkey || '',
          createdAt: row.createdAt,
          packId: app.packs.some((p) => p.id === row.packId) ? row.packId : app.packId,
        });
        app.voicesByPack.get(voice.packId).push(voice);
      } catch {
        dropped += 1;
      }
    }
    for (const row of state.assets || []) {
      try {
        app.assets.push(app.buildAsset({
          id: row.id,
          name: row.name,
          buffer: await decode(row),
          segments: normalizeSegments(row.segments || [], row.frames),
          createdAt: row.createdAt,
        }));
        const asset = app.assets[app.assets.length - 1];
        asset.gainDb = Number.isFinite(row.gainDb) ? row.gainDb : 0;
        asset.fadeInMs = row.fadeInMs || 0;
        asset.fadeOutMs = row.fadeOutMs || 0;
      } catch {
        dropped += 1;
      }
    }
    // 「应用」模式存不下来：pid 跨重启没有意义，进程也可能已经不在了，回到麦克风比留一个录不出声的模式诚实。
    app.sourceMode = state.sourceMode === 'system' ? 'system' : 'mic';
    app.micDeviceId = state.micDeviceId || '';
    app.outputId = state.outputId || '';
    app.boardLayout = state.boardLayout === 'list' ? 'list' : 'grid';

    this.written = new Set([
      ...app.assets.map((asset) => asset.id),
      ...[...app.voicesByPack.values()].flat().map((voice) => voice.id),
    ]);
    this.last = JSON.stringify(this.state());
    return {
      assets: app.assets.length,
      voices: [...app.voicesByPack.values()].reduce((sum, list) => sum + list.length, 0),
      dropped,
    };
  }

  async clear() {
    if (!this.enabled) return;
    await invoke('clear_session');
    this.written = new Set();
    this.last = '';
  }
}
