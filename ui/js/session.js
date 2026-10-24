// 会话实时落盘。这里只存两类东西：素材（原始录音 + 剪辑，还没变成文件的）和热键/偏好。
// 语音不在这里——语音是语音包文件夹里的一个音频文件，存它的是目录本身。
// 素材的音频是一条不可变的平面 f32 块，改名和裁剪只重写 JSON，音频只在诞生那一刻写一次。

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

  state() {
    const app = this.app;
    return {
      schemaVersion: SCHEMA,
      packName: app.packName,
      sourceMode: app.sourceMode,
      micDeviceId: app.micDeviceId,
      outputId: app.outputId,
      boardLayout: app.boardLayout,
      hotkeys: app.hotkeys,
      assets: app.assets.map((asset) => {
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
      }),
    };
  }

  buffers() {
    const audio = new Map();
    for (const asset of this.app.assets) audio.set(asset.id, asset.buffer);
    return audio;
  }

  /// 先补音频块，再写引用它们的 JSON：顺序反了就会留下指向空文件的记录。
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
        const state = this.state();
        const raw = JSON.stringify(state);
        const audio = this.buffers();
        const live = new Set();
        for (const row of state.assets) {
          live.add(row.id);
          if (this.written.has(row.id)) continue;
          const bytes = planarBytes(audio.get(row.id));
          await invoke('put_blob', bytes.buffer, { headers: { 'x-id': row.id } });
          this.written.add(row.id);
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
    let dropped = 0;
    for (const row of state.assets) {
      try {
        const bytes = await invoke('read_blob', { id: row.id });
        const samples = new Float32Array(bytes);
        const frames = Math.max(1, Math.trunc(row.frames) || 1);
        const channels = Math.min(2, Math.max(1, Math.trunc(row.channels) || 1));
        if (samples.length < frames * channels) throw new Error('音频块不完整');
        const buffer = ctx.createBuffer(channels, frames, row.sampleRate || 48000);
        for (let c = 0; c < channels; c++) {
          buffer.getChannelData(c).set(samples.subarray(c * frames, (c + 1) * frames));
        }
        const asset = app.buildAsset({
          id: row.id,
          name: row.name,
          buffer,
          segments: normalizeSegments(row.segments || [], frames),
          createdAt: row.createdAt,
        });
        asset.gainDb = Number.isFinite(row.gainDb) ? row.gainDb : 0;
        asset.fadeInMs = row.fadeInMs || 0;
        asset.fadeOutMs = row.fadeOutMs || 0;
        app.assets.push(asset);
      } catch {
        dropped += 1;
      }
    }
    app.hotkeys = state.hotkeys && typeof state.hotkeys === 'object' ? { ...state.hotkeys } : {};
    app.packName = typeof state.packName === 'string' ? state.packName : '';
    // 「应用」采集模式不跨重启恢复：pid 换个开机就没有意义了。
    app.sourceMode = state.sourceMode === 'system' ? 'system' : 'mic';
    app.micDeviceId = state.micDeviceId || '';
    app.outputId = state.outputId || '';
    app.boardLayout = state.boardLayout === 'list' ? 'list' : 'grid';

    this.written = new Set(app.assets.map((asset) => asset.id));
    this.last = JSON.stringify(this.state());
    return { assets: app.assets.length, dropped };
  }

  async clear() {
    if (!this.enabled) return;
    await invoke('clear_session');
    this.written = new Set();
    this.last = '';
  }
}
