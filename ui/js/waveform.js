import { clamp, dbToGain, fmtDuration, fmtTick } from './util.js';

const RULER_H = 24;
const MIN_SPP = 8;
const TICK_CANDIDATES = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export class WaveformEditor {
  constructor({ wrap, waveCanvas, overlayCanvas, hscroll, hthumb, onSelection, onSeek, onViewChange }) {
    this.wrap = wrap;
    this.waveCanvas = waveCanvas;
    this.overlayCanvas = overlayCanvas;
    this.hscroll = hscroll;
    this.hthumb = hthumb;
    this.onSelection = onSelection || (() => {});
    this.onSeek = onSeek || (() => {});
    this.onViewChange = onViewChange || (() => {});

    this.clip = null;
    this.view = { start: 0, spp: 1, autoFit: true };
    this.position = 0;
    this.playing = false;
    this.hover = null;
    this.drag = null;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this._staticRaf = 0;
    this._overlayRaf = 0;
    this._scrollVisible = false;
    this._scrollDrag = null;

    this._bind();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(wrap);
    this.resize();
  }

  /* ---------- data ---------- */

  duration() {
    return this.clip ? this.clip.length / this.clip.sampleRate : 0;
  }

  setClip(clip) {
    this.clip = clip;
    this.position = 0;
    this.hover = null;
    this.drag = null;
    this.fit();
  }

  clear() {
    this.clip = null;
    this.position = 0;
    this.hover = null;
    this.drag = null;
    this._clearCanvases();
    this.updateScrollbar();
    this.onViewChange(this);
  }

  refresh() {
    this.updateScrollbar();
    this.scheduleRedraw();
    this.onViewChange(this);
  }

  setPosition(sec) {
    if (!this.clip) return;
    const dur = this.duration();
    this.position = clamp(sec, 0, dur);
    if (this.playing && this._isZoomed()) {
      const sr = this.clip.sampleRate;
      const x = this._sampleToX(this.position * sr);
      if (x < 0 || x > this.width * 0.94) {
        const maxStart = Math.max(0, this.clip.length - this.view.spp * this.width);
        this.view.start = clamp(this.position * sr - this.width * 0.15 * this.view.spp, 0, maxStart);
        this.view.autoFit = false;
        this.scheduleRedraw();
      }
    }
    this.scheduleOverlay();
  }

  setPlaying(playing) {
    this.playing = !!playing;
    this.scheduleOverlay();
  }

  fit() {
    if (!this.clip) {
      this._clearCanvases();
      this.updateScrollbar();
      this.onViewChange(this);
      return;
    }
    const fitSpp = Math.max(1e-6, this.clip.length / Math.max(1, this.width));
    this.view.spp = fitSpp;
    this.view.start = 0;
    this.view.autoFit = true;
    this.updateScrollbar();
    this.scheduleRedraw();
    this.onViewChange(this);
  }

  zoomBy(factor, anchorX = this.width / 2) {
    if (!this.clip) return;
    const fitSpp = Math.max(1e-6, this.clip.length / Math.max(1, this.width));
    const minSpp = Math.min(MIN_SPP, fitSpp);
    const nextSpp = clamp(this.view.spp / factor, minSpp, fitSpp);
    if (Math.abs(nextSpp - this.view.spp) < 1e-9) return;
    const anchorSample = this.view.start + anchorX * this.view.spp;
    this.view.spp = nextSpp;
    this.view.start = anchorSample - anchorX * nextSpp;
    this.view.autoFit = Math.abs(nextSpp - fitSpp) < 1e-6;
    this._clampView();
    this.updateScrollbar();
    this.scheduleRedraw();
    this.onViewChange(this);
  }

  canZoomIn() {
    if (!this.clip) return false;
    const fitSpp = Math.max(1e-6, this.clip.length / Math.max(1, this.width));
    return this.view.spp > Math.min(MIN_SPP, fitSpp) + 1e-9;
  }

  canZoomOut() {
    if (!this.clip) return false;
    const fitSpp = Math.max(1e-6, this.clip.length / Math.max(1, this.width));
    return this.view.spp < fitSpp - 1e-9;
  }

  /* ---------- layout ---------- */

  resize() {
    const width = Math.max(1, this.wrap.clientWidth);
    const height = Math.max(1, this.wrap.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    for (const canvas of [this.waveCanvas, this.overlayCanvas]) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    if (this.clip) {
      if (this.view.autoFit) {
        this.view.spp = Math.max(1e-6, this.clip.length / width);
        this.view.start = 0;
      } else {
        this._clampView();
      }
      this.updateScrollbar();
      this.scheduleRedraw();
    } else {
      this._clearCanvases();
    }
  }

  _isZoomed() {
    if (!this.clip) return false;
    const fitSpp = Math.max(1e-6, this.clip.length / Math.max(1, this.width));
    return this.view.spp < fitSpp - 1e-9;
  }

  _clampView() {
    if (!this.clip) return;
    const fitSpp = Math.max(1e-6, this.clip.length / Math.max(1, this.width));
    if (this.view.spp >= fitSpp - 1e-9) {
      this.view.spp = fitSpp;
      this.view.start = 0;
      this.view.autoFit = true;
      return;
    }
    const viewSamples = this.view.spp * this.width;
    const maxStart = Math.max(0, this.clip.length - viewSamples);
    this.view.start = clamp(this.view.start, 0, maxStart);
    this.view.autoFit = false;
  }

  _sampleToX(sample) {
    return (sample - this.view.start) / this.view.spp;
  }

  _xToSample(x) {
    return clamp(this.view.start + x * this.view.spp, 0, this.clip?.length || 0);
  }

  _waveTop() {
    return RULER_H + 6;
  }

  _waveBottom() {
    return this.height - (this._scrollVisible ? 14 : 8);
  }

  _palette() {
    const style = getComputedStyle(document.documentElement);
    const get = (name) => style.getPropertyValue(name).trim();
    return {
      panel: get('--panel'),
      panelSoft: get('--panel-soft'),
      ink: get('--ink'),
      muted: get('--muted'),
      faint: get('--faint'),
      line: get('--line'),
      lineStrong: get('--line-strong'),
      accent: get('--accent'),
      accentSoft: get('--accent-soft'),
      track: get('--track'),
      mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
    };
  }

  _clearCanvases() {
    const wctx = this.waveCanvas.getContext('2d');
    const octx = this.overlayCanvas.getContext('2d');
    wctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    octx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    wctx.clearRect(0, 0, this.width, this.height);
    octx.clearRect(0, 0, this.width, this.height);
  }

  /* ---------- drawing ---------- */

  scheduleRedraw() {
    if (this._staticRaf) return;
    this._staticRaf = requestAnimationFrame(() => {
      this._staticRaf = 0;
      this._drawStatic();
      this._drawOverlayNow();
      this.updateScrollbar();
    });
  }

  scheduleOverlay() {
    if (this._overlayRaf) return;
    this._overlayRaf = requestAnimationFrame(() => {
      this._overlayRaf = 0;
      this._drawOverlayNow();
    });
  }

  _drawStatic() {
    const ctx = this.waveCanvas.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.clip) return;

    const c = this._palette();
    const top = this._waveTop();
    const bottom = this._waveBottom();
    const mid = (top + bottom) / 2;
    const half = Math.max(1, (bottom - top) / 2 - 2);
    const sr = this.clip.sampleRate;

    ctx.fillStyle = c.panelSoft;
    ctx.fillRect(0, 0, this.width, RULER_H);
    ctx.strokeStyle = c.line;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(this.width, RULER_H + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const interval = this._tickInterval(sr);
    const first = Math.ceil((this.view.start / sr) / interval) * interval;
    const endSec = (this.view.start + this.view.spp * this.width) / sr;
    ctx.font = `10px ${c.mono}`;
    ctx.textBaseline = 'middle';

    for (let t = first; t <= endSec + interval * 0.01; t += interval) {
      const x = (t * sr - this.view.start) / this.view.spp;
      if (x < -1 || x > this.width + 1) continue;
      ctx.strokeStyle = c.line;
      ctx.globalAlpha = 0.42;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H);
      ctx.lineTo(x + 0.5, bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.lineStrong;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 4);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
      if (x >= 0 && x < this.width - 30) {
        ctx.fillStyle = c.muted;
        ctx.fillText(fmtTick(t, interval), x + 4, 11);
      }
    }

    ctx.strokeStyle = c.lineStrong;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(this.width, mid + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const peaks = this.clip.peaks;
    if (!peaks || !peaks.count) {
      ctx.strokeStyle = c.lineStrong;
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(this.width, mid + 0.5);
      ctx.stroke();
      return;
    }

    const gain = dbToGain(this.clip.gainDb);
    const fadeIn = Math.max(0, this.clip.fadeInMs) / 1000;
    const fadeOut = Math.max(0, this.clip.fadeOutMs) / 1000;
    const duration = this.clip.length / sr;
    const bucket = peaks.bucket;
    const path = new Path2D();

    for (let x = 0; x < this.width; x++) {
      const s0 = this.view.start + x * this.view.spp;
      const s1 = s0 + this.view.spp;
      if (s1 <= 0 || s0 >= this.clip.length) continue;
      const b0 = Math.max(0, Math.floor(s0 / bucket));
      const b1 = Math.min(peaks.count - 1, Math.max(b0, Math.floor((s1 - 1e-9) / bucket)));
      let lo = 0;
      let hi = 0;
      for (let b = b0; b <= b1; b++) {
        if (peaks.min[b] < lo) lo = peaks.min[b];
        if (peaks.max[b] > hi) hi = peaks.max[b];
      }
      const t0 = s0 / sr;
      let env = gain;
      if (fadeIn > 0 && t0 < fadeIn) env *= clamp(t0 / fadeIn, 0, 1);
      if (fadeOut > 0 && duration - t0 < fadeOut) env *= clamp((duration - t0) / fadeOut, 0, 1);
      const y1 = clamp(mid - hi * env * half, top, bottom);
      const y2 = clamp(mid - lo * env * half, top, bottom);
      path.rect(x, y1, 1, Math.max(1, y2 - y1));
    }

    ctx.fillStyle = c.ink;
    ctx.globalAlpha = 0.7;
    ctx.fill(path);
    ctx.globalAlpha = 1;
  }

  _tickInterval(sr) {
    const secPerPx = this.view.spp / sr;
    for (const candidate of TICK_CANDIDATES) {
      if (candidate / secPerPx >= 68) return candidate;
    }
    return TICK_CANDIDATES[TICK_CANDIDATES.length - 1];
  }

  _drawOverlayNow() {
    const ctx = this.overlayCanvas.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.clip) return;

    const c = this._palette();
    const sr = this.clip.sampleRate;
    const top = this._waveTop();
    const bottom = this._waveBottom();
    const sel = this.clip.selection;

    if (sel && sel.end > sel.start) {
      const x1 = clamp(this._sampleToX(sel.start), 0, this.width);
      const x2 = clamp(this._sampleToX(sel.end), 0, this.width);
      if (x2 > x1) {
        ctx.fillStyle = c.accent;
        ctx.globalAlpha = 0.11;
        ctx.fillRect(x1, RULER_H, x2 - x1, this.height - RULER_H);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1 + 0.5, RULER_H);
        ctx.lineTo(x1 + 0.5, bottom);
        ctx.moveTo(x2 - 0.5, RULER_H);
        ctx.lineTo(x2 - 0.5, bottom);
        ctx.stroke();
        ctx.fillStyle = c.accent;
        ctx.fillRect(x1 - 0.5, top, 2, 14);
        ctx.fillRect(x2 - 1.5, top, 2, 14);
        ctx.fillRect(x1 - 0.5, bottom - 14, 2, 14);
        ctx.fillRect(x2 - 1.5, bottom - 14, 2, 14);

        const label = fmtDuration((sel.end - sel.start) / sr, 3);
        if (x2 - x1 > 66) {
          ctx.font = `10px ${c.mono}`;
          const tw = ctx.measureText(label).width;
          const cx = (x1 + x2) / 2;
          const boxW = tw + 12;
          const boxX = clamp(cx - boxW / 2, 4, this.width - boxW - 4);
          ctx.globalAlpha = 0.92;
          ctx.fillStyle = c.panel;
          roundRect(ctx, boxX, RULER_H + 6, boxW, 16, 4);
          ctx.fill();
          ctx.strokeStyle = c.accent;
          ctx.globalAlpha = 0.5;
          roundRect(ctx, boxX, RULER_H + 6, boxW, 16, 4);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = c.accent;
          ctx.textBaseline = 'middle';
          ctx.fillText(label, boxX + 6, RULER_H + 14.5);
        }
      }
    }

    const px = this._sampleToX(this.position * sr);
    if (px >= -1 && px <= this.width + 1) {
      ctx.strokeStyle = c.ink;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(px + 0.5, RULER_H - 1);
      ctx.lineTo(px + 0.5, bottom);
      ctx.stroke();
      ctx.fillStyle = c.ink;
      ctx.beginPath();
      ctx.moveTo(px, RULER_H - 7);
      ctx.lineTo(px - 4, RULER_H - 13);
      ctx.lineTo(px + 4, RULER_H - 13);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    if (this.hover != null && !this.drag) {
      const hx = this._sampleToX(this.hover);
      if (hx >= 0 && hx <= this.width) {
        ctx.strokeStyle = c.lineStrong;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(hx + 0.5, RULER_H);
        ctx.lineTo(hx + 0.5, bottom);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const label = fmtDuration(this.hover / sr, 3);
        ctx.font = `10px ${c.mono}`;
        const tw = ctx.measureText(label).width;
        const boxW = tw + 12;
        const boxX = clamp(hx + 5, 4, this.width - boxW - 4);
        ctx.fillStyle = c.panel;
        roundRect(ctx, boxX, 4, boxW, 16, 4);
        ctx.fill();
        ctx.strokeStyle = c.line;
        roundRect(ctx, boxX, 4, boxW, 16, 4);
        ctx.stroke();
        ctx.fillStyle = c.muted;
        ctx.textBaseline = 'middle';
        ctx.fillText(label, boxX + 6, 12.5);
      }
    }
  }

  /* ---------- scrollbar ---------- */

  updateScrollbar() {
    const zoomed = this._isZoomed();
    this._scrollVisible = zoomed;
    if (!zoomed) {
      this.hscroll.classList.add('hidden');
      return;
    }
    this.hscroll.classList.remove('hidden');
    const track = Math.max(1, this.hscroll.clientWidth);
    const view = Math.max(1, this.view.spp * this.width);
    const total = this.clip.length;
    const thumbW = clamp((view / total) * track, 18, track);
    const maxStart = Math.max(0, total - view);
    const ratio = maxStart > 0 ? this.view.start / maxStart : 0;
    const left = ratio * (track - thumbW);
    this.hthumb.style.width = `${thumbW}px`;
    this.hthumb.style.transform = `translateX(${left}px)`;
  }

  _scrollToRatio(ratio) {
    if (!this._isZoomed()) return;
    const view = this.view.spp * this.width;
    const maxStart = Math.max(0, this.clip.length - view);
    this.view.start = clamp(ratio * maxStart, 0, maxStart);
    this.view.autoFit = false;
    this.scheduleRedraw();
  }

  /* ---------- interactions ---------- */

  _bind() {
    this.wrap.addEventListener('pointerdown', (e) => {
      if (!this.clip || e.button !== 0) return;
      if (e.target.closest('.hscroll')) return;
      const rect = this.wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < 0 || x > this.width) return;
      const sample = this._xToSample(x);
      const sel = this.clip.selection;
      const edge = this._selectionEdge(x, sel);
      this.wrap.setPointerCapture?.(e.pointerId);
      if (edge) {
        this.drag = { mode: edge, fixed: edge === 'start' ? sel.end : sel.start, lastX: x };
      } else {
        this.drag = { mode: 'new', anchor: sample, startX: x, moved: false };
      }
      this.scheduleOverlay();
    });

    this.wrap.addEventListener('pointermove', (e) => {
      if (!this.clip) return;
      const rect = this.wrap.getBoundingClientRect();
      const x = clamp(e.clientX - rect.left, 0, this.width);
      const sample = this._xToSample(x);
      this.hover = sample;

      if (this.drag) {
        if (this.drag.mode === 'new') {
          if (!this.drag.moved && Math.abs(x - this.drag.startX) > 3) this.drag.moved = true;
          if (this.drag.moved) {
            const a = Math.min(this.drag.anchor, sample);
            const b = Math.max(this.drag.anchor, sample);
            this._setSelection(a, b, true);
          }
        } else {
          const fixed = this.drag.fixed;
          const a = Math.min(fixed, sample);
          const b = Math.max(fixed, sample);
          this._setSelection(a, b, true);
        }
      } else {
        const edge = this._selectionEdge(x, this.clip.selection);
        this.wrap.style.cursor = edge ? 'ew-resize' : 'crosshair';
      }
      this.scheduleOverlay();
    });

    const endDrag = (e) => {
      if (!this.clip) return;
      if (this.drag) {
        const rect = this.wrap.getBoundingClientRect();
        const x = clamp(e.clientX - rect.left, 0, this.width);
        if (this.drag.mode === 'new' && !this.drag.moved) {
          this.clip.selection = null;
          this.onSelection(null);
          this.onSeek(this._xToSample(x));
        } else {
          this.onSelection(this.clip.selection);
        }
        this.drag = null;
        this.wrap.style.cursor = 'crosshair';
        this.scheduleOverlay();
      }
    };
    this.wrap.addEventListener('pointerup', endDrag);
    this.wrap.addEventListener('pointercancel', endDrag);

    this.wrap.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.hover = null;
        this.scheduleOverlay();
      }
    });

    this.wrap.addEventListener('dblclick', (e) => {
      if (!this.clip) return;
      e.preventDefault();
      this._setSelection(0, this.clip.length, true);
      this.onSelection(this.clip.selection);
    });

    this.wrap.addEventListener('wheel', (e) => {
      if (!this.clip) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = this.wrap.getBoundingClientRect();
        const x = clamp(e.clientX - rect.left, 0, this.width);
        this.zoomBy(e.deltaY > 0 ? 1 / 1.18 : 1.18, x);
      } else if (this._isZoomed()) {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.view.start += delta * this.view.spp;
        this._clampView();
        this.scheduleRedraw();
      }
    }, { passive: false });

    this.hthumb.addEventListener('pointerdown', (e) => {
      if (!this.clip) return;
      e.preventDefault();
      e.stopPropagation();
      const track = this.hscroll.clientWidth;
      const thumb = this.hthumb.offsetWidth;
      const maxLeft = Math.max(1, track - thumb);
      const startX = e.clientX;
      const startRatio = this.view.start / Math.max(1, this.clip.length - this.view.spp * this.width);
      this._scrollDrag = { startX, startRatio, maxLeft };
      this.hthumb.setPointerCapture?.(e.pointerId);
    });
    this.hthumb.addEventListener('pointermove', (e) => {
      if (!this._scrollDrag) return;
      const dx = e.clientX - this._scrollDrag.startX;
      const ratio = clamp(this._scrollDrag.startRatio + dx / this._scrollDrag.maxLeft, 0, 1);
      this._scrollToRatio(ratio);
    });
    const endScroll = () => { this._scrollDrag = null; };
    this.hthumb.addEventListener('pointerup', endScroll);
    this.hthumb.addEventListener('pointercancel', endScroll);

    this.hscroll.addEventListener('pointerdown', (e) => {
      if (e.target === this.hthumb || !this._isZoomed()) return;
      const rect = this.hscroll.getBoundingClientRect();
      const track = rect.width;
      const thumb = this.hthumb.offsetWidth;
      const x = clamp(e.clientX - rect.left, 0, track);
      this._scrollToRatio(clamp((x - thumb / 2) / Math.max(1, track - thumb), 0, 1));
    });
  }

  _setSelection(a, b, notify) {
    if (!this.clip) return;
    const start = clamp(Math.round(a), 0, this.clip.length);
    const end = clamp(Math.round(b), 0, this.clip.length);
    if (end <= start) return;
    this.clip.selection = { start, end };
    if (notify) this.onSelection(this.clip.selection);
    this.scheduleOverlay();
  }

  _selectionEdge(x, sel) {
    if (!sel || sel.end <= sel.start) return null;
    const x1 = this._sampleToX(sel.start);
    const x2 = this._sampleToX(sel.end);
    const nearStart = Math.abs(x - x1) <= 6;
    const nearEnd = Math.abs(x - x2) <= 6;
    if (nearStart && nearEnd) return x < (x1 + x2) / 2 ? 'start' : 'end';
    if (nearStart) return 'start';
    if (nearEnd) return 'end';
    return null;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
