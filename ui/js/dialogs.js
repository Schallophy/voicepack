import { icon } from './icons.js';
import { openModal, openMenu, showToast } from './ui.js';
import {
  fmtDuration, fmtBytes, fmtRate, channelLabel, estimateWavBytes,
  sanitizeFilename, downloadBlob, hotkeyFromEvent,
} from './util.js';
import { audioBufferToWav } from './wav.js';
import { DEMO_APPS } from './demo.js';
import { isNative, invoke } from './native.js';

const APP_COLORS = ['#b7791f', '#3f7d58', '#4b6b8a', '#8a5a83', '#a54a3f', '#5b6f45', '#4f6d9e'];

function appColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return APP_COLORS[hash % APP_COLORS.length];
}

export async function openAppPicker(app) {
  const body = document.createElement('div');

  const searchWrap = document.createElement('div');
  searchWrap.className = 'app-picker-search';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索应用';
  search.autocomplete = 'off';
  searchWrap.appendChild(search);
  body.appendChild(searchWrap);

  const list = document.createElement('div');
  list.className = 'app-picker-list';
  body.appendChild(list);

  const defs = isNative
    ? await invoke('list_app_sources').catch(() => [])
    : DEMO_APPS;
  const normalized = defs.map((def, index) => ({
    id: def.id,
    name: def.name,
    sub: def.sub || '',
    pid: def.pid ?? null,
    bufferKey: def.bufferKey ?? null,
    icon: def.icon || '',
    color: def.color || appColor(def.name || '应'),
    initial: def.initial || (def.name || '应').slice(0, 1).toUpperCase(),
    index,
  }));

  const rows = [];
  const currentId = app.appSource?.id || null;

  for (const def of normalized) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `app-row${currentId === def.id ? ' is-selected' : ''}`;
    row.dataset.name = def.name;

    const mark = document.createElement('span');
    mark.className = 'app-icon';
    if (def.icon) {
      mark.style.backgroundImage = `url("${def.icon}")`;
    } else {
      mark.style.background = def.color;
      mark.textContent = def.initial;
    }

    const info = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'app-name';
    name.textContent = def.name;
    const sub = document.createElement('span');
    sub.className = 'app-sub';
    sub.textContent = def.sub;
    info.append(name, document.createElement('br'), sub);

    const meter = document.createElement('span');
    meter.className = 'app-meter';
    const fill = document.createElement('i');
    meter.appendChild(fill);

    const check = document.createElement('span');
    check.className = 'app-check';
    if (currentId === def.id) check.innerHTML = icon('check');

    row.append(mark, info, meter, check);
    row.addEventListener('click', () => {
      app.setAppSource(def);
      close();
    });
    list.appendChild(row);
    rows.push({ def, row, fill, index: def.index });
  }

  if (!normalized.length) {
    const empty = document.createElement('p');
    empty.className = 'picker-note';
    empty.textContent = '没有找到可以采集的应用窗口';
    list.appendChild(empty);
  }

  const modal = openModal({
    title: '选择应用音频',
    body,
    wide: true,
    actions: [{ label: '取消' }],
  });
  const close = modal.close;

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const item of rows) {
      item.row.classList.toggle('hidden', !!q && !item.def.name.toLowerCase().includes(q));
    }
  });

  let last = 0;
  let raf = 0;
  if (!isNative) app.ensureDemoBuffers();
  const tick = (now) => {
    if (!modal.panel.isConnected) return;
    if (now - last > 66) {
      last = now;
      for (const item of rows) {
        if (item.row.classList.contains('hidden')) continue;
        const buffer = app.demo?.[item.def.bufferKey];
        if (!buffer) continue;
        const sr = buffer.sampleRate;
        const seconds = (now / 1000 + item.index * 0.73) % buffer.duration;
        const start = Math.floor(seconds * sr);
        const end = Math.min(buffer.length, start + Math.floor(sr * 0.025));
        let peak = 0;
        if (end > start) {
          const data = buffer.getChannelData(0);
          for (let i = start; i < end; i++) {
            const v = Math.abs(data[i]);
            if (v > peak) peak = v;
          }
        }
        item.fill.style.width = `${Math.min(100, (peak / 0.55) * 100)}%`;
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  modal.backdrop.addEventListener('pointerdown', () => cancelAnimationFrame(raf), { once: true });
  modal.panel.closest('.modal-backdrop')?.addEventListener('click', (event) => {
    if (event.target.classList.contains('modal-backdrop')) cancelAnimationFrame(raf);
  });
}

export function openExportClipDialog(app, entity) {
  const body = document.createElement('div');
  body.className = 'export-form';

  const formatRow = document.createElement('div');
  formatRow.className = 'form-row';
  const formatLabel = document.createElement('span');
  formatLabel.textContent = '格式';
  const format = document.createElement('select');
  format.innerHTML = '<option value="24">WAV · 24-bit</option><option value="16">WAV · 16-bit</option><option value="32">WAV · 32-bit 浮点</option>';
  formatRow.append(formatLabel, format);
  body.appendChild(formatRow);

  const monoRow = document.createElement('label');
  monoRow.className = 'check-row';
  const mono = document.createElement('input');
  mono.type = 'checkbox';
  monoRow.append(mono, document.createTextNode('混合为单声道'));
  body.appendChild(monoRow);

  const summary = document.createElement('div');
  summary.className = 'summary';
  body.appendChild(summary);

  const updateSummary = () => {
    const bits = Number(format.value);
    const channels = mono.checked ? 1 : entity.renderBuffer.numberOfChannels;
    const size = estimateWavBytes(entity.duration, entity.renderBuffer.sampleRate, channels, bits);
    summary.textContent = `${fmtDuration(entity.duration, 3)} · ${fmtRate(entity.renderBuffer.sampleRate)} · ${channelLabel(channels)} · 约 ${fmtBytes(size)}`;
  };
  format.addEventListener('change', updateSummary);
  mono.addEventListener('change', updateSummary);
  updateSummary();

  const modal = openModal({
    title: '导出音频',
    body,
    actions: [
      { label: '取消' },
      {
        label: '下载 WAV',
        kind: 'primary',
        onClick: () => {
          const bits = Number(format.value);
          const blob = audioBufferToWav(entity.renderBuffer, {
            bitDepth: bits,
            mono: mono.checked,
            gainDb: entity.gainDb,
            fadeInMs: entity.fadeInMs,
            fadeOutMs: entity.fadeOutMs,
          });
          downloadBlob(blob, `${sanitizeFilename(entity.name)}.wav`);
          showToast(`已下载「${sanitizeFilename(entity.name)}.wav」`);
        },
      },
    ],
  });
  format.focus();
  return modal;
}

export function openAbout() {
  const body = document.createElement('div');

  const summary = document.createElement('div');
  summary.className = 'summary';
  summary.textContent = '素材、语音和语音包都只保存在当前会话的内存里：不自动写盘、不上传；只有你明确导出时才会生成文件。';
  body.appendChild(summary);

  const model = document.createElement('p');
  model.textContent = '素材是原始录音或导入音频；编辑素材不会改母带。把整段或选区保存为语音后，这条语音就成为独立个体，和素材再无关联，之后删素材也不影响它；语音包只负责把语音分组。';
  body.appendChild(model);

  return openModal({
    title: '关于',
    body,
    actions: [{ label: '知道了', kind: 'primary' }],
  });
}

export function openPackMenu(app, anchor) {
  const hasVoices = app.currentVoices().length > 0;
  const packs = app.packs.map((pack) => ({
    label: pack.name,
    icon: pack.id === app.packId ? 'check' : 'folder',
    shortcut: `${(app.voicesByPack.get(pack.id) || []).length} 条`,
    onClick: () => app.switchPack(pack.id),
  }));
  return openMenu(anchor, [
    ...packs,
    { separator: true },
    { label: '新建语音包', icon: 'plus', onClick: () => app.newPack() },
    { label: '重命名当前语音包', icon: 'rename', onClick: () => app.renameCurrentPack() },
    { separator: true },
    { label: '导入语音包…', icon: 'upload', onClick: () => app.pickPackFile() },
    { label: '导出当前语音包…', icon: 'download', disabled: !hasVoices || app.isBusy(), onClick: () => app.exportPack() },
    { separator: true },
    { label: '删除当前语音包', icon: 'trash', danger: true, disabled: app.packs.length <= 1 || app.isBusy(), onClick: () => app.deleteCurrentPack() },
  ]);
}

export function openAssetMenu(app, asset, anchor) {
  return openMenu(anchor, [
    { label: '重命名素材', icon: 'rename', onClick: () => { app.selectAsset(asset.id); app.focusTitle(); } },
    { label: '保存整段为语音', icon: 'plus', disabled: app.isBusy(), onClick: () => app.saveVoiceFromAsset({ assetId: asset.id }) },
    { label: '导出素材音频…', icon: 'download', disabled: app.isBusy(), onClick: () => openExportClipDialog(app, asset) },
    { separator: true },
    { label: '删除素材', icon: 'trash', danger: true, disabled: app.isBusy(), onClick: () => app.deleteAsset(asset) },
  ]);
}

export function openVoiceMenu(app, voice, anchor) {
  return openMenu(anchor, [
    { label: '重命名…', icon: 'rename', onClick: () => app.renameVoice(voice) },
    { label: '设置热键…', icon: 'keyboard', shortcut: voice.hotkey || '未设置', onClick: () => openVoiceHotkeyDialog(app, voice) },
    { label: '导出音频…', icon: 'download', disabled: app.isBusy(), onClick: () => openExportClipDialog(app, voice) },
    { separator: true },
    { label: '删除语音', icon: 'trash', danger: true, disabled: app.isBusy(), onClick: () => app.deleteVoice(voice) },
  ]);
}

export function openVoiceHotkeyDialog(app, voice) {
  const body = document.createElement('div');
  const note = document.createElement('p');
  note.textContent = '按下 F1–F12 或带 Ctrl/Alt 的组合即可绑定；Delete 清除，Esc 取消。';
  const cap = document.createElement('div');
  cap.className = 'hotkey-capture';
  cap.textContent = voice.hotkey || '等待按键…';
  body.append(note, cap);

  const modal = openModal({
    title: '设置热键',
    body,
    actions: [{ label: '取消' }],
  });
  modal.panel.tabIndex = -1;
  modal.panel.focus();

  modal.panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Backspace' || event.key === 'Delete') {
      app.setVoiceHotkey(voice, '');
      modal.close();
      showToast('已清除热键');
      return;
    }
    const combo = hotkeyFromEvent(event);
    if (!combo) {
      if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        showToast('请使用 F1–F12 或带 Ctrl/Alt 的组合', { type: 'error' });
      }
      return;
    }
    const error = app.checkVoiceHotkey(voice, combo);
    if (error) {
      showToast(error, { type: 'error' });
      return;
    }
    app.setVoiceHotkey(voice, combo);
    modal.close();
    showToast(`已设置 ${combo}`);
  });
  return modal;
}
