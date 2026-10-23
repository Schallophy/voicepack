const stroke = (body, viewBox = '0 0 24 24') =>
  `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const solid = (body, viewBox = '0 0 24 24') =>
  `<svg viewBox="${viewBox}" fill="currentColor" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  play: solid('<path d="M8 5.2c0-.8.9-1.3 1.6-.9l9.1 5.8c.7.4.7 1.4 0 1.8l-9.1 5.8c-.7.4-1.6-.1-1.6-.9V5.2z"/>'),
  pause: solid('<rect x="7" y="5" width="3.4" height="14" rx="1"/><rect x="13.6" y="5" width="3.4" height="14" rx="1"/>'),
  stop: solid('<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'),
  loop: stroke('<path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M3.5 11V9.2A3.2 3.2 0 016.7 6H20"/><path d="M7 21.5L3.5 18 7 14.5"/><path d="M20.5 13v1.8a3.2 3.2 0 01-3.2 3.2H4"/>'),
  undo: stroke('<path d="M9.5 14.5L5 10l4.5-4.5"/><path d="M5 10h9.5a5 5 0 010 10H11"/>'),
  redo: stroke('<path d="M14.5 14.5L19 10l-4.5-4.5"/><path d="M19 10h-9.5a5 5 0 000 10H13"/>'),
  zoomIn: stroke('<circle cx="10.8" cy="10.8" r="6.8"/><path d="M20.5 20.5l-4.4-4.4M10.8 8v5.6M8 10.8h5.6"/>'),
  zoomOut: stroke('<circle cx="10.8" cy="10.8" r="6.8"/><path d="M20.5 20.5l-4.4-4.4M8 10.8h5.6"/>'),
  more: solid('<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>'),
  search: stroke('<circle cx="10.8" cy="10.8" r="6.6"/><path d="M20 20l-4.2-4.2"/>'),
  upload: stroke('<path d="M12 16V3.5M7.5 8L12 3.5 16.5 8"/><path d="M4 15.5v3A2.5 2.5 0 006.5 21h11a2.5 2.5 0 002.5-2.5v-3"/>'),
  download: stroke('<path d="M12 3.5V16M7.5 11.5L12 16l4.5-4.5"/><path d="M4 15.5v3A2.5 2.5 0 006.5 21h11a2.5 2.5 0 002.5-2.5v-3"/>'),
  gear: stroke('<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="var(--panel)"/><circle cx="15" cy="12" r="2" fill="var(--panel)"/><circle cx="9" cy="18" r="2" fill="var(--panel)"/>'),
  chevronDown: stroke('<path d="M6 9l6 6 6-6"/>'),
  close: stroke('<path d="M6 6l12 12M18 6L6 18"/>'),
  check: stroke('<path d="M5 12.5l4.2 4.2L19 7"/>'),
  warning: stroke('<path d="M12 3.5L22 20H2L12 3.5z"/><path d="M12 9v5M12 17.2v.1"/>'),
  mic: stroke('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M8.5 21h7"/>'),
  appWindow: stroke('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18M6.5 6.7h.1M9.5 6.7h.1"/>'),
  monitor: stroke('<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M9 20h6M12 16.5V20"/>'),
  folder: stroke('<path d="M3.5 7.5A2.5 2.5 0 016 5h3l2 2h7a2.5 2.5 0 012.5 2.5v8A2.5 2.5 0 0118 20H6a2.5 2.5 0 01-2.5-2.5v-10z"/>'),
  trash: stroke('<path d="M4 7h16M9 7V4.8h6V7M6 7l1 13h10l1-13M10 11v5.5M14 11v5.5"/>'),
  copy: stroke('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>'),
  rename: stroke('<path d="M4 20h4L20 8l-4-4L4 16v4z"/><path d="M14.5 5.5l4 4"/>'),
  exportAudio: stroke('<path d="M12 3.5V15M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>'),
  info: stroke('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.1"/>'),
  scissors: stroke('<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M8.2 7.7L20 18M8.2 16.3L20 6"/>'),
  spark: stroke('<path d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3z"/>'),
  plus: stroke('<path d="M12 5v14M5 12h14"/>'),
  keyboard: stroke('<rect x="2.5" y="6.5" width="19" height="11" rx="2.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 13.6h8"/>'),
  grid: stroke('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
  listView: stroke('<path d="M8.5 6h12M8.5 12h12M8.5 18h12"/><circle cx="4.2" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.2" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.2" cy="18" r="1.1" fill="currentColor" stroke="none"/>'),
};

export function icon(name) {
  return ICONS[name] || '';
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.getAttribute('data-icon');
    if (ICONS[name]) el.innerHTML = ICONS[name];
  });
}

export function setIcon(el, name) {
  if (el && ICONS[name]) el.innerHTML = ICONS[name];
}
