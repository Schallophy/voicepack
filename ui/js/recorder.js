import { peakDb } from './util.js';
import { invoke, listen } from './native.js';

export const MAX_RECORD_SECONDS = 600;

function chooseMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const type of candidates) {
    if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export class Recorder {
  constructor(engine) {
    this.engine = engine;
    this.mode = null;
    this.running = false;
    this.stopping = false;
    this.discarded = false;
    this.stream = null;
    this.audioStream = null;
    this.media = null;
    this.analyser = null;
    this.sourceNode = null;
    this.silentGain = null;
    this.chunks = [];
    this.timeData = null;
    this.startedAt = 0;
    this.raf = 0;
    this.lastLevelAt = 0;
    this.lastTickAt = 0;
    this.limitFired = false;
    this.demoBuffer = null;
    this.demoName = '';
    this.onLevel = null;
    this.onTick = null;
    this.onLimit = null;
    this.onStreamEnded = null;
  }

  resetState() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.running = false;
    this.stopping = false;
    this.discarded = false;
    this.mode = null;
    this.startedAt = 0;
    this.chunks = [];
    this.limitFired = false;
    this.demoBuffer = null;
    this.demoName = '';
    this.nativeName = '';
    this.unlisten = null;
  }

  async start({ mode, native = false, deviceId, pid, demoBuffer, demoName, nativeName, onLevel, onTick, onLimit, onStreamEnded }) {
    this.resetState();
    this.mode = native ? 'native' : mode;
    this.nativeName = nativeName || '';
    this.demoBuffer = demoBuffer || null;
    this.demoName = demoName || '';
    this.onLevel = onLevel;
    this.onTick = onTick;
    this.onLimit = onLimit;
    this.onStreamEnded = onStreamEnded;
    this.startedAt = performance.now();
    this.running = true;
    this.lastLevelAt = 0;
    this.lastTickAt = 0;

    if (this.mode === 'native') {
      await invoke('start_capture', { mode, device: deviceId || null, pid: pid ?? null });
      this.unlisten = await listen('vp:capture-level', (event) => {
        if (!this.running || this.discarded) return;
        const { elapsedMs, min, max } = event.payload;
        const peak = Math.max(Math.abs(min), Math.abs(max));
        this.onLevel?.({ peak, min, max, rms: peak, db: peakDb(peak), elapsed: elapsedMs / 1000 });
      });
      this.raf = requestAnimationFrame(this.nativeTick);
      return;
    }

    if (mode === 'demo') {
      if (!demoBuffer) throw new Error('没有可用的示例音源');
      this.raf = requestAnimationFrame(this.demoTick);
      return;
    }

    let stream;
    try {
      if (mode === 'mic') {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持麦克风采集');
        const audioConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        };
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      } else {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前环境不支持共享系统音频');
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      }
    } catch (err) {
      this.running = false;
      throw err;
    }

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      this.running = false;
      throw new Error(mode === 'mic' ? '没有可用的麦克风轨道' : '共享内容里没有音频轨道，请选择带声音的标签页或窗口');
    }

    this.stream = stream;
    this.audioStream = new MediaStream(audioTracks);
    const ctx = await this.engine.ensure();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.timeData = new Float32Array(this.analyser.fftSize);
    this.sourceNode = ctx.createMediaStreamSource(stream);
    this.silentGain = ctx.createGain();
    this.silentGain.gain.value = 0;
    this.sourceNode.connect(this.analyser);
    this.analyser.connect(this.silentGain);
    this.silentGain.connect(ctx.destination);

    audioTracks[0].addEventListener('ended', () => {
      if (this.running && !this.stopping && !this.discarded) this.onStreamEnded?.();
    });

    const mime = chooseMime();
    try {
      this.media = new MediaRecorder(this.audioStream, mime ? { mimeType: mime } : undefined);
    } catch (err) {
      this.teardown();
      throw new Error('无法启动录音');
    }
    this.media.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    this.media.onerror = () => {};
    this.media.start(250);
    this.raf = requestAnimationFrame(this.mediaTick);
  }

  mediaTick = () => {
    if (!this.running) return;
    const now = performance.now();
    const elapsed = (now - this.startedAt) / 1000;
    if (now - this.lastLevelAt >= 30) {
      this.lastLevelAt = now;
      this.analyser.getFloatTimeDomainData(this.timeData);
      let peak = 0;
      let min = 1;
      let max = -1;
      let sumSq = 0;
      const data = this.timeData;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;
        if (v < min) min = v;
        if (v > max) max = v;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / data.length);
      this.onLevel?.({ peak, min, max, rms, db: peakDb(peak), elapsed });
    }
    if (now - this.lastTickAt >= 100) {
      this.lastTickAt = now;
      this.onTick?.({ elapsed });
    }
    if (!this.limitFired && elapsed >= MAX_RECORD_SECONDS) {
      this.limitFired = true;
      this.onLimit?.();
    }
    this.raf = requestAnimationFrame(this.mediaTick);
  };

  nativeTick = () => {
    if (!this.running) return;
    const elapsed = (performance.now() - this.startedAt) / 1000;
    if (performance.now() - this.lastTickAt >= 100) {
      this.lastTickAt = performance.now();
      this.onTick?.({ elapsed });
    }
    if (!this.limitFired && elapsed >= MAX_RECORD_SECONDS) {
      this.limitFired = true;
      this.onLimit?.();
    }
    this.raf = requestAnimationFrame(this.nativeTick);
  };

  demoTick = () => {
    if (!this.running || !this.demoBuffer) return;
    const now = performance.now();
    const elapsed = (now - this.startedAt) / 1000;
    if (now - this.lastLevelAt >= 30) {
      this.lastLevelAt = now;
      const buffer = this.demoBuffer;
      const sr = buffer.sampleRate;
      const start = Math.min(buffer.length - 1, Math.floor(elapsed * sr));
      const window = Math.min(Math.floor(sr * 0.03), buffer.length - start);
      let peak = 0;
      let min = 1;
      let max = -1;
      if (elapsed <= buffer.duration && window > 0) {
        const data = buffer.getChannelData(0);
        for (let i = start; i < start + window; i++) {
          const v = data[i];
          const a = Math.abs(v);
          if (a > peak) peak = a;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      } else {
        min = 0;
        max = 0;
        peak = 0;
      }
      this.onLevel?.({ peak, min, max, rms: peak, db: peakDb(peak), elapsed });
    }
    if (now - this.lastTickAt >= 100) {
      this.lastTickAt = now;
      this.onTick?.({ elapsed });
    }
    if (!this.limitFired && elapsed >= MAX_RECORD_SECONDS) {
      this.limitFired = true;
      this.onLimit?.();
    }
    this.raf = requestAnimationFrame(this.demoTick);
  };

  async stop() {
    if (!this.running || this.stopping) return null;
    this.stopping = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;

    if (this.mode === 'native') {
      try {
        const bytes = await invoke('stop_capture');
        const meta = await invoke('capture_meta');
        if (!bytes || !meta || !meta.frames) throw new Error('录音没有产生数据');
        const elapsed = (performance.now() - this.startedAt) / 1000;
        const buffer = nativeBytesToBuffer(bytes, meta, this.engine);
        this.unlisten?.();
        this.unlisten = null;
        this.running = false;
        this.stopping = false;
        return { kind: 'native', buffer, elapsed, name: this.nativeName || '录音' };
      } catch (err) {
        this.unlisten?.();
        this.unlisten = null;
        this.teardown();
        this.running = false;
        this.stopping = false;
        throw err;
      }
    }

    const elapsed = (performance.now() - this.startedAt) / 1000;

    if (this.mode === 'demo') {
      const buffer = this.demoBuffer;
      this.running = false;
      this.stopping = false;
      return { kind: 'demo', buffer, elapsed, name: this.demoName };
    }

    const media = this.media;
    if (!media) {
      this.teardown();
      this.running = false;
      this.stopping = false;
      throw new Error('录音没有产生数据');
    }

    if (media.state !== 'inactive') {
      const stopped = new Promise((resolve) => {
        media.onstop = resolve;
      });
      try {
        media.stop();
      } catch {
        /* 已经停止 */
      }
      await stopped;
    } else {
      // 系统共享被手动结束时 MediaRecorder 可能已经自行停止，给最后一个 dataavailable 一点时间。
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    const chunks = this.chunks.slice();
    const mime = media.mimeType || 'audio/webm';
    this.teardown();
    this.running = false;
    this.stopping = false;
    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) throw new Error('录音没有产生数据');
    const bytes = await blob.arrayBuffer();
    const buffer = await this.engine.decode(bytes);
    return { kind: 'media', buffer, elapsed, name: this.mode === 'mic' ? '麦克风' : '系统共享' };
  }

  discard() {
    this.discarded = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.mode === 'native') {
      invoke('cancel_capture').catch(() => { /* 会话已不存在 */ });
      this.unlisten?.();
      this.unlisten = null;
    }
    if (this.media && this.media.state !== 'inactive') {
      try { this.media.stop(); } catch { /* 忽略 */ }
    }
    this.teardown();
    this.running = false;
    this.stopping = false;
  }

  teardown() {
    try { this.sourceNode?.disconnect(); } catch { /* 忽略 */ }
    try { this.analyser?.disconnect(); } catch { /* 忽略 */ }
    try { this.silentGain?.disconnect(); } catch { /* 忽略 */ }
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.audioStream = null;
    this.media = null;
    this.sourceNode = null;
    this.analyser = null;
    this.silentGain = null;
    this.timeData = null;
  }
}

/// Raw little-endian interleaved f32 from the native capture becomes a normal AudioBuffer.
function nativeBytesToBuffer(bytes, meta, engine) {
  const samples = new Float32Array(bytes);
  const channels = Math.max(1, meta.channels);
  const frames = Math.floor(meta.frames / channels);
  if (!frames) throw new Error('录音没有产生数据');
  const ctx = engine.context();
  const out = ctx.createBuffer(channels, frames, meta.sampleRate);
  const planes = [];
  for (let c = 0; c < channels; c++) planes.push(out.getChannelData(c));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) planes[c][i] = samples[i * channels + c];
  }
  return out;
}
