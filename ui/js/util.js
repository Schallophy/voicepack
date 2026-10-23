export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function fmtDuration(sec, digits = 3) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const totalMs = Math.round(sec * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const core = `${m}:${String(s).padStart(2, '0')}`;
  const tail = digits > 0 ? `.${String(ms).padStart(3, '0').slice(0, digits)}` : '';
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${tail}` : core + tail;
}

export function fmtShort(sec) {
  return fmtDuration(sec, 1);
}

export function fmtClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDb(db) {
  const v = Number(db) || 0;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtRate(rate) {
  return `${Math.round(rate / 100) / 10} kHz`;
}

export function channelLabel(n) {
  if (n === 1) return '单声道';
  if (n === 2) return '立体声';
  return `${n} 声道`;
}

export function fmtTick(sec, interval) {
  if (interval < 1) {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  }
  if (interval < 60) {
    const total = Math.round(sec);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const m = Math.round(sec / 60);
  return `${m}:00`;
}

export function sanitizeFilename(name, fallback = '未命名') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned || fallback;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function deepCopySegments(segments) {
  return segments.map((s) => ({ start: s.start, end: s.end }));
}

export function dbToGain(db) {
  return Math.pow(10, clamp(db, -60, 24) / 20);
}

export function gainToDb(gain) {
  return 20 * Math.log10(Math.max(gain, 1e-9));
}

export function peakDb(peak) {
  return 20 * Math.log10(Math.max(peak, 1e-9));
}

export function hotkeyFromEvent(e) {
  const key = e.key;
  if (!key || key === 'Unidentified' || key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  let base = '';
  if (/^F\d{1,2}$/.test(key)) base = key;
  else if (/^[a-zA-Z0-9]$/.test(key)) base = key.toUpperCase();
  else if (key === ' ' || key === 'Spacebar') base = 'Space';
  else if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') base = key;
  else if (key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown' || key === 'Insert') base = key;
  else return null;

  if (!/^F\d/.test(base) && !mods.some((m) => m === 'Ctrl' || m === 'Alt' || m === 'Meta')) return null;
  return [...mods, base].join('+');
}

export function matchHotkey(e, hotkey) {
  if (!hotkey) return false;
  const pressed = hotkeyFromEvent(e);
  return pressed === hotkey;
}

export function estimateWavBytes(durationSec, sampleRate, channels, bits) {
  return 44 + Math.max(0, Math.floor(durationSec * sampleRate)) * channels * (bits / 8);
}
