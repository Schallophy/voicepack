import { icon } from './icons.js';
import { clamp, fmtDb } from './util.js';

let modalSeq = 0;

export function showToast(message, { type = 'info', action = null, duration = 3600 } = {}) {
  const root = document.getElementById('toastRoot');
  if (!root) return () => {};
  while (root.children.length >= 3) root.firstElementChild.remove();

  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' is-error' : ''}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const dot = document.createElement('span');
  dot.className = 'toast-dot';
  toast.appendChild(dot);

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  toast.appendChild(text);

  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    toast.remove();
  };

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick?.();
      close();
    });
    toast.appendChild(btn);
  }

  root.appendChild(toast);
  timer = setTimeout(close, duration);
  return close;
}

export function openModal({
  title,
  body,
  actions = [],
  wide = false,
  dismissible = true,
  onMount,
} = {}) {
  const root = document.getElementById('modalRoot');
  const previousFocus = document.activeElement;
  const id = `modal_${++modalSeq}`;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const panel = document.createElement('div');
  panel.className = `modal${wide ? ' wide' : ''}`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', `${id}_title`);

  const heading = document.createElement('h2');
  heading.id = `${id}_title`;
  heading.textContent = title || '';
  panel.appendChild(heading);

  const content = document.createElement('div');
  content.className = 'modal-content';
  if (title) content.classList.add('has-heading');
  if (body instanceof Node) content.appendChild(body);
  panel.appendChild(content);

  const footer = document.createElement('div');
  footer.className = 'modal-actions';
  panel.appendChild(footer);

  const close = () => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (previousFocus && typeof previousFocus.focus === 'function') {
      try { previousFocus.focus(); } catch { /* 忽略 */ }
    }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (dismissible) close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = Array.from(panel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'))
      .filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn${action.kind === 'primary' ? ' primary' : action.kind === 'danger' ? ' danger' : ''}`;
    btn.textContent = action.label;
    if (action.kind === 'danger') {
      btn.style.color = 'var(--err)';
      btn.style.borderColor = 'var(--err-line)';
    }
    btn.disabled = !!action.disabled;
    btn.addEventListener('click', async () => {
      const result = action.onClick ? await action.onClick(close) : undefined;
      if (result !== false) close();
    });
    footer.appendChild(btn);
  }

  backdrop.appendChild(panel);
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop && dismissible) close();
  });
  document.addEventListener('keydown', onKey, true);
  root.appendChild(backdrop);
  onMount?.(panel, close);

  requestAnimationFrame(() => {
    const target = panel.querySelector('input, select, textarea, button:not(:disabled)');
    target?.focus();
  });

  return { close, panel, backdrop };
}

export function confirmDialog({ title, message, confirmLabel = '确定', cancelLabel = '取消', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const body = document.createElement('p');
    body.textContent = message || '';
    const modal = openModal({
      title,
      body,
      actions: [
        { label: cancelLabel, onClick: () => { done(false); } },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { done(true); } },
      ],
    });
    const observer = new MutationObserver(() => {
      if (!modal.backdrop.isConnected) {
        observer.disconnect();
        done(false);
      }
    });
    observer.observe(document.getElementById('modalRoot'), { childList: true });
    setTimeout(() => {
      const btns = Array.from(modal.panel.querySelectorAll('button'));
      const cancel = btns.find((b) => b.textContent === cancelLabel);
      if (cancel) cancel.focus();
    }, 0);
  });
}

export function promptDialog({
  title,
  label = '',
  value = '',
  placeholder = '',
  confirmLabel = '确定',
  validate,
  hint = '',
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const body = document.createElement('div');
    const labelEl = document.createElement('label');
    labelEl.className = 'field-label';
    labelEl.textContent = label;
    if (label) body.appendChild(labelEl);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.maxLength = 60;
    body.appendChild(input);
    const error = document.createElement('div');
    error.className = 'error-text hidden';
    body.appendChild(error);
    const hintEl = document.createElement('div');
    hintEl.className = 'hint';
    hintEl.textContent = hint;
    if (hint) body.appendChild(hintEl);

    const submit = () => {
      const v = input.value.trim();
      const err = validate ? validate(v) : (!v ? '名称不能为空' : '');
      if (err) {
        error.textContent = err;
        error.classList.remove('hidden');
        input.focus();
        return;
      }
      done(v);
      modal.close();
    };

    const modal = openModal({
      title,
      body,
      actions: [
        { label: '取消', onClick: () => done(null) },
        { label: confirmLabel, kind: 'primary', onClick: () => { submit(); return false; } },
      ],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    const observer = new MutationObserver(() => {
      if (!modal.backdrop.isConnected) {
        observer.disconnect();
        done(null);
      }
    });
    observer.observe(document.getElementById('modalRoot'), { childList: true });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

export function openMenu(anchor, items) {
  const existing = document.querySelector('.menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu-item${item.danger ? ' danger' : ''}`;
    btn.setAttribute('role', 'menuitem');
    btn.disabled = !!item.disabled;
    if (item.icon) {
      const wrap = document.createElement('span');
      wrap.className = 'ic';
      wrap.innerHTML = icon(item.icon);
      btn.appendChild(wrap);
    }
    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.shortcut) {
      const sc = document.createElement('span');
      sc.className = 'shortcut';
      sc.textContent = item.shortcut;
      btn.appendChild(sc);
    }
    btn.addEventListener('click', () => {
      close();
      item.onClick?.();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.left;
  if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
  left = Math.max(8, left);
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    anchor.setAttribute('aria-expanded', 'false');
  };
  const outside = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  anchor.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => menu.querySelector('.menu-item:not(:disabled)')?.focus());
  return { close, menu };
}

export class PeakMeter {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.current = -100;
    this.hold = -100;
    this.holdUntil = 0;
    this.lastAt = performance.now();
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || 132;
    const h = this.canvas.clientHeight || 8;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.cssW = w;
    this.cssH = h;
    this.draw();
  }

  update(db) {
    const now = performance.now();
    const dt = Math.min(0.2, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    const value = clamp(Number(db) || -100, -60, 6);
    if (value >= this.current) this.current = value;
    else this.current = Math.max(value, this.current - 60 * dt);
    if (this.current >= this.hold) {
      this.hold = this.current;
      this.holdUntil = now + 1200;
    } else if (now > this.holdUntil) {
      this.hold = Math.max(this.current, this.hold - 20 * dt);
    }
    this.draw();
  }

  reset() {
    this.current = -100;
    this.hold = -100;
    this.holdUntil = 0;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    if (!w || !h) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(document.documentElement);
    const get = (name) => style.getPropertyValue(name).trim();
    ctx.fillStyle = get('--track');
    rounded(ctx, 0, 0, w, h, h / 2);
    ctx.fill();

    const ratio = clamp((this.current + 60) / 60, 0, 1);
    const color = this.current > -3 ? get('--err') : this.current > -12 ? get('--warn') : get('--ok');
    if (ratio > 0) {
      ctx.fillStyle = color;
      rounded(ctx, 0, 0, Math.max(h, w * ratio), h, h / 2);
      ctx.fill();
    }

    if (this.hold > -60) {
      const hx = clamp(((this.hold + 60) / 60) * w, 1, w - 1);
      ctx.fillStyle = get('--ink');
      ctx.globalAlpha = 0.55;
      ctx.fillRect(hx - 1, 0, 2, h);
      ctx.globalAlpha = 1;
    }

    if (this.current >= -0.1) {
      ctx.fillStyle = get('--err');
      ctx.fillRect(w - 3, 0, 3, h);
    }
  }
}

export class LiveWave {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.points = [];
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.window = 8;
    this.lastT = 0;
  }

  reset() {
    this.points = [];
    this.lastT = 0;
    this.draw();
  }

  push(t, min, max) {
    const last = this.points[this.points.length - 1];
    if (last && t < last.t) this.points = [];
    this.points.push({ t, min, max });
    this.lastT = t;
    while (this.points.length && t - this.points[0].t > this.window + 0.5) this.points.shift();
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const w = c.clientWidth || 1;
    const h = c.clientHeight || 1;
    if (c.width !== Math.round(w * this.dpr) || c.height !== Math.round(h * this.dpr)) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (w < 2 || h < 2) return;
    const style = getComputedStyle(document.documentElement);
    const get = (name) => style.getPropertyValue(name).trim();
    const mid = h / 2;
    const half = h / 2 - 3;
    ctx.strokeStyle = get('--line');
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(w, mid + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const latest = this.lastT;
    ctx.fillStyle = get('--rec');
    ctx.globalAlpha = 0.62;
    for (const p of this.points) {
      const age = latest - p.t;
      if (age > this.window) continue;
      const x = w - (age / this.window) * w;
      const y1 = mid - clamp(p.max, -1, 1) * half;
      const y2 = mid - clamp(p.min, -1, 1) * half;
      ctx.fillRect(x, y1, 2, Math.max(1, y2 - y1));
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = get('--line-strong');
    ctx.beginPath();
    ctx.moveTo(w - 0.5, 0);
    ctx.lineTo(w - 0.5, h);
    ctx.stroke();
  }
}

export function drawMeterLabel(ctx, db) {
  ctx.font = '10px ui-monospace, Consolas, monospace';
  ctx.fillStyle = '#888';
  ctx.fillText(fmtDb(db), 0, 10);
}

function rounded(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
