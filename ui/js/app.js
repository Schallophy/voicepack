import {
  $$, clamp, uid, fmtDuration, fmtShort, fmtRate, channelLabel,
  isTypingTarget, matchHotkey, deepCopySegments, peakDb, downloadBlob,
} from './util.js';
import { hydrateIcons, icon } from './icons.js';
import { AudioEngine, peakOf, gainForDb } from './audio.js';
import { buildPeaks } from './peaks.js';
import { audioBufferToWav } from './wav.js';
import { WaveformEditor } from './waveform.js';
import { Recorder, MAX_RECORD_SECONDS } from './recorder.js';
import { makeDemoBuffers } from './demo.js';
import {
  normalizeSegments, totalLength, keepRenderedRange, removeRenderedRange,
  segmentsEqual, fullSegments, findAudibleBounds,
} from './edits.js';
import {
  showToast, confirmDialog, promptDialog, openMenu, PeakMeter, LiveWave,
} from './ui.js';
import {
  openAppPicker, openExportClipDialog, openAbout, openPackMenu, openAssetMenu, openVoiceMenu,
} from './dialogs.js';
import { isNative, invoke, listen, toNativePcm } from './native.js';
import { packs as packStore, sanitizeName, voiceFile, voiceKey, DEFAULT_PACK } from './packs.js';
import { SessionStore } from './session.js';

const ROW_H = 52;
const MIN_REMAIN_SECONDS = 0.02;
const PEAKS_BUCKET = 32;
const RESERVED_HOTKEYS = new Set([
  'F2', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y', 'Ctrl+S', 'Ctrl+E',
]);

export class App {
  constructor() {
    this.engine = new AudioEngine();
    this.recorder = new Recorder(this.engine);
    this.dom = {};
    this.packs = [];
    this.packName = '';
    this.voices = [];
    this.hotkeys = {};
    this.assets = [];
    this.asset = null;
    this.selectedAssetId = null;
    this.waveAsset = null;
    this.view = 'edit';
    this.assetSearch = '';
    this.voiceSearch = '';
    this.boardLayout = 'grid';
    this.sourceMode = 'mic';
    this.micDeviceId = '';
    this.appSource = null;
    this.outputId = '';
    this.demo = null;
    this.meter = null;
    this.live = null;
    this.waveform = null;
    this.recording = {
      active: false, preparing: false, stopping: false,
      mode: null, sourceName: '', elapsed: 0, session: 0,
    };
    this.transport = {
      playing: false, position: 0, range: null, loop: false,
      handle: null, raf: 0,
    };
    this.voicePlay = null;
    this.voicePlayToken = 0;
    this.history = new Map();
    this.session = new SessionStore(this);
    this._busyExporting = false;
    this._busyImporting = false;
    this._listRaf = 0;
    this._titleBefore = '';
    this._dropDepth = 0;
    this._initialized = false;
  }

  /* =========================================================
   * init
   * ======================================================= */

  async init() {
    hydrateIcons(document);
    this.cacheDom();
    this.meter = new PeakMeter(this.dom.recMeter);
    this.live = new LiveWave(this.dom.liveCanvas);
    this.waveform = new WaveformEditor({
      wrap: this.dom.waveWrap,
      waveCanvas: this.dom.waveCanvas,
      overlayCanvas: this.dom.overlayCanvas,
      hscroll: this.dom.hscroll,
      hthumb: this.dom.hthumb,
      onSelection: (sel) => this.handleSelection(sel),
      onSeek: (sample) => this.handleSeek(sample),
      onViewChange: () => this.updateZoomButtons(),
    });

    // 画布颜色只在绘制时读取 CSS 变量，系统主题切换后必须主动重绘。
    // change 事件可能早于新变量落盘，下一帧再补一次。
    this.themeMql = window.matchMedia('(prefers-color-scheme: dark)');
    this.themeMql.addEventListener('change', () => {
      this.syncCanvasTheme();
      requestAnimationFrame(() => this.syncCanvasTheme());
    });

    const restored = await this.session.restore();
    await this.scanPacks();
    this.wireEvents();
    this.renderTargetPacks();
    this.renderAssetCounts();
    this.renderSourceControls();
    this.renderAssetList();
    this.renderBoardTools();
    this.renderBoard();
    this.updateControls();
    this.updateTimeReadout();
    this.updateOutputUI();
    if (isNative) this.setupNativeEvents();

    // 不用 rAF 等布局：隐藏页里 rAF 可能完全不推进，而选择素材不依赖首帧绘制。
    await new Promise((resolve) => setTimeout(resolve, 0));
    const initial = this.visibleAssets()[0];
    if (initial) this.selectAsset(initial.id, { initial: true, scroll: false });

    await this.refreshDevices();
    this.session.start();
    if (restored?.assets) {
      showToast(`已恢复上次的 ${restored.assets} 段素材`, { duration: 3200 });
    }
    if (restored?.dropped) {
      showToast(`${restored.dropped} 段素材的音频缺失，已跳过`, { type: 'error', duration: 3600 });
    }
    this._initialized = true;
  }

  cacheDom() {
    const ids = [
      'viewSwitch', 'editView', 'boardView',
      'assetCount', 'assetSearchInput', 'assetList', 'assetListInner', 'importBtn',
      'sourceSeg', 'micSelect', 'appPickBtn', 'appMini', 'appPickLabel', 'systemHint',
      'recMeter', 'recTime', 'recordBtn', 'recordLabel', 'assetTitle', 'assetMeta',
      'trimBtn', 'deleteSelBtn', 'undoBtn', 'redoBtn', 'fitBtn', 'zoomOutBtn', 'zoomInBtn', 'moreBtn',
      'waveWrap', 'waveCanvas', 'overlayCanvas', 'waveEmpty', 'waveLoading',
      'recordOverlay', 'recSourceName', 'recOverlayTime', 'discardBtn', 'liveCanvas', 'recHint',
      'hscroll', 'hthumb', 'playBtn', 'stopBtn', 'loopBtn', 'selectionReadout', 'timeReadout',
      'gainInput', 'fadeInInput', 'fadeOutInput', 'targetPackSelect',
      'normalizeBtn', 'silenceBtn', 'resetBtn', 'editWarning', 'exportBtn', 'saveWholeBtn', 'saveSelBtn',
      'boardPackBtn', 'boardPackName', 'boardCount', 'boardSearch', 'layoutToggle',
      'voiceGrid', 'boardEmpty', 'boardEmptyTitle', 'boardEmptyText', 'boardEmptyAction',
      'outputSelect', 'aboutBtn', 'fileInput', 'dropVeil', 'toastRoot', 'modalRoot',
    ];
    for (const id of ids) this.dom[id] = document.getElementById(id);
  }

  syncCanvasTheme() {
    this.meter.resize();
    this.live.draw();
    this.waveform.refresh();
  }

  /* =========================================================
   * packs and voices come from the directory; assets come from the session
   * ======================================================= */

  /// 语音包 = 根目录下的一个文件夹。启动、重新聚焦、手动刷新都走这里，外部改动也能看见。
  async scanPacks() {
    let rows = [];
    try {
      rows = await packStore.listPacks();
    } catch (err) {
      showToast(`读不了语音包目录：${err?.message || err}`, { type: 'error', duration: 6000 });
      return false;
    }
    if (!rows.length) {
      try {
        await packStore.createPack(DEFAULT_PACK);
        rows = [{ name: DEFAULT_PACK, voices: 0 }];
      } catch (err) {
        showToast(`建不了默认语音包：${err?.message || err}`, { type: 'error', duration: 6000 });
      }
    }
    this.packs = rows;
    if (!rows.some((pack) => pack.name === this.packName)) this.packName = rows[0]?.name || '';
    await this.scanVoices();
    return true;
  }

  async scanVoices() {
    if (!this.packName) {
      this.voices = [];
      return;
    }
    try {
      this.voices = await packStore.listVoices(this.packName);
    } catch (err) {
      this.voices = [];
      showToast(err?.message || '读不了这个语音包', { type: 'error', duration: 5000 });
      return;
    }
    for (const voice of this.voices) {
      voice.hotkey = this.hotkeys[voiceKey(voice.pack, voice.name)] || '';
    }
    // 包里的条数是 scanPacks 那一次数出来的，存/删/改名之后得自己补上。
    const row = this.packs.find((pack) => pack.name === this.packName);
    if (row) row.voices = this.voices.length;
    // 正在播的那条可能已经被人在资源管理器里删掉或改名了。
    const playing = this.voicePlay?.voice;
    if (playing) {
      const still = this.voices.find((v) => v.path === playing.path);
      if (still) this.voicePlay.voice = still;
      else this.stopVoicePlayback();
    }
  }

  /// 浏览器回退里的「应用音频」用合成演示音源；桌面版用不到，所以按需构建。
  ensureDemoBuffers() {
    if (!this.demo) this.demo = makeDemoBuffers(this.engine.context());
    return this.demo;
  }

  currentPack() {
    return this.packs.find((pack) => pack.name === this.packName) || null;
  }

  currentVoices() {
    return this.voices;
  }

  findAsset(id) {
    return this.assets.find((a) => a.id === id) || null;
  }

  findVoice(path) {
    return this.voices.find((voice) => voice.path === path) || null;
  }

  visibleAssets() {
    const q = this.assetSearch.trim().toLowerCase();
    return [...this.assets]
      .filter((asset) => !q || asset.name.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  visibleVoices() {
    const q = this.voiceSearch.trim().toLowerCase();
    // 目录本身就是按名字排的：语音板上的顺序 = 文件名顺序，和资源管理器里看到的一致。
    return this.currentVoices().filter((voice) => !q || voice.name.toLowerCase().includes(q));
  }

  isBusy() {
    return this.recording.active || this.recording.preparing || this.recording.stopping
      || this._busyExporting || this._busyImporting;
  }

  buildAsset({ id = uid(), name, buffer, createdAt = Date.now(), segments = null }) {
    if (!buffer || !buffer.length) throw new Error('音频为空');
    const cuts = segments && segments.length ? normalizeSegments(segments, buffer.length) : fullSegments(buffer.length);
    let renderBuffer;
    try {
      renderBuffer = this.engine.renderSegments(buffer, cuts);
    } catch {
      renderBuffer = buffer;
    }
    return {
      id,
      name: String(name || '未命名素材').slice(0, 60),
      createdAt,
      buffer,
      segments: cuts,
      renderBuffer,
      duration: renderBuffer.duration,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      selection: null,
      peaks: null,
      peaksToken: 0,
      version: 0,
      _peaksPromise: null,
    };
  }

  /// 语音就是包文件夹里的一个文件：渲染选好的段落，把增益和淡变烘进采样，编成 24-bit WAV。
  async renderVoiceWav(asset, segments) {
    if (!asset.buffer || !asset.buffer.length) throw new Error('音频为空');
    const clean = normalizeSegments(segments, asset.buffer.length);
    if (!clean.length) throw new Error('这段音频没有可用内容');
    const rendered = this.engine.renderSegments(asset.buffer, clean);
    const blob = audioBufferToWav(rendered, {
      bitDepth: 24,
      gainDb: asset.gainDb,
      fadeInMs: asset.fadeInMs,
      fadeOutMs: asset.fadeOutMs,
    });
    return new Uint8Array(await blob.arrayBuffer());
  }

  uniqueAssetName(base) {
    const names = new Set(this.assets.map((a) => a.name));
    const clean = String(base || '未命名素材').trim().slice(0, 60) || '未命名素材';
    if (!names.has(clean)) return clean;
    let n = 2;
    while (names.has(`${clean} ${n}`)) n++;
    return `${clean} ${n}`.slice(0, 60);
  }

  /// 重名判定按文件名来（Windows 大小写不敏感），所以这里也按大小写不敏感比。
  uniqueVoiceName(base, voices = this.voices) {
    const names = new Set(voices.map((v) => v.name.toLowerCase()));
    const clean = sanitizeName(base || '未命名语音');
    if (!names.has(clean.toLowerCase())) return clean;
    let n = 2;
    while (names.has(`${clean} ${n}`.toLowerCase())) n++;
    return sanitizeName(`${clean} ${n}`);
  }

  uniquePackName(base) {
    const names = new Set(this.packs.map((p) => p.name.toLowerCase()));
    const clean = String(base || '语音包').trim().slice(0, 40) || '语音包';
    if (!names.has(clean.toLowerCase())) return clean;
    let n = 2;
    while (names.has(`${clean} ${n}`.toLowerCase())) n++;
    return `${clean} ${n}`;
  }

  nextRecordingName() {
    let max = 0;
    for (const asset of this.assets) {
      const m = /^录音 (\d+)$/.exec(asset.name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `录音 ${max + 1}`;
  }

  makeWaveAsset(asset) {
    return {
      length: asset.renderBuffer.length,
      sampleRate: asset.buffer.sampleRate,
      peaks: asset.peaks,
      gainDb: asset.gainDb,
      fadeInMs: asset.fadeInMs,
      fadeOutMs: asset.fadeOutMs,
      selection: asset.selection,
    };
  }

  syncWaveFields() {
    if (!this.waveAsset || !this.asset) return;
    this.waveAsset.peaks = this.asset.peaks;
    this.waveAsset.gainDb = this.asset.gainDb;
    this.waveAsset.fadeInMs = this.asset.fadeInMs;
    this.waveAsset.fadeOutMs = this.asset.fadeOutMs;
    this.waveAsset.selection = this.asset.selection;
  }

  /* =========================================================
   * view switching
   * ======================================================= */

  setView(view) {
    const next = view === 'board' ? 'board' : 'edit';
    if (this.view === next) return;
    this.stopAll();
    this.view = next;
    this.applyViewUI();
    if (next === 'board') this.renderBoard();
    this.updateControls();
  }

  applyViewUI() {
    const edit = this.view === 'edit';
    this.dom.editView.classList.toggle('hidden', !edit);
    this.dom.boardView.classList.toggle('hidden', edit);
    for (const btn of $$('.seg-btn', this.dom.viewSwitch)) {
      const on = btn.dataset.view === this.view;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (edit) this.waveform.resize();
  }

  /* =========================================================
   * rendering: library + inspector
   * ======================================================= */

  renderAssetCounts() {
    const total = this.assets.length;
    const shown = this.visibleAssets().length;
    this.dom.assetCount.textContent = this.assetSearch ? `${shown}/${total} 个` : `${total} 个`;
  }

  renderTargetPacks() {
    const select = this.dom.targetPackSelect;
    const options = this.packs.map((pack) => {
      const el = document.createElement('option');
      el.value = pack.name;
      el.textContent = pack.name;
      return el;
    });
    select.replaceChildren(...options);
    if (!this.packs.some((pack) => pack.name === this.packName)) this.packName = this.packs[0]?.name || '';
    select.value = this.packName;
    this.dom.boardPackName.textContent = this.packName || '语音包';
    const total = this.currentVoices().length;
    const shown = this.visibleVoices().length;
    this.dom.boardCount.textContent = this.voiceSearch ? `${shown}/${total} 条` : `${total} 条`;
  }

  renderSourceControls() {
    for (const btn of $$('.seg-btn', this.dom.sourceSeg)) {
      btn.classList.toggle('is-active', btn.dataset.mode === this.sourceMode);
    }
    const busy = this.isBusy();
    this.dom.micSelect.classList.toggle('hidden', this.sourceMode !== 'mic');
    this.dom.appPickBtn.classList.toggle('hidden', this.sourceMode !== 'app');
    this.dom.systemHint.classList.toggle('hidden', this.sourceMode !== 'system');
    if (this.sourceMode === 'system') {
      this.dom.systemHint.textContent = isNative ? '将捕获系统正在播放的全部声音' : '录制时由系统选择共享内容';
    }
    this.dom.micSelect.value = this.micDeviceId;
    this.dom.micSelect.disabled = busy || this.sourceMode !== 'mic';
    this.dom.appPickBtn.disabled = busy;
    for (const btn of $$('.seg-btn', this.dom.sourceSeg)) btn.disabled = busy;

    const mini = this.dom.appMini;
    if (this.appSource) {
      const icon = this.appSource.icon;
      mini.textContent = icon ? '' : (this.appSource.initial || '应');
      mini.style.background = icon ? 'none' : (this.appSource.color || 'var(--accent-soft)');
      mini.style.backgroundImage = icon ? `url("${icon}")` : '';
      mini.style.color = '#fff';
      this.dom.appPickLabel.textContent = this.appSource.name;
    } else {
      mini.textContent = '';
      mini.style.background = 'var(--accent-soft)';
      mini.style.backgroundImage = '';
      mini.style.color = 'var(--accent)';
      this.dom.appPickLabel.textContent = '选择应用';
    }
  }

  renderAssetList() {
    this.renderAssetCounts();
    const items = this.visibleAssets();
    if (!items.length) {
      this.dom.assetListInner.style.height = '100%';
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.innerHTML = this.assetSearch
        ? '<div><strong>没有匹配的素材</strong><span>换个关键词试试</span></div>'
        : '<div><strong>还没有素材</strong><span>在上方录制，或导入音频</span></div>';
      this.dom.assetListInner.replaceChildren(empty);
      return;
    }
    this.dom.assetListInner.style.height = `${items.length * ROW_H}px`;
    this.renderVisibleAssetRows();
  }

  renderVisibleAssetRows() {
    const items = this.visibleAssets();
    if (!items.length) return;
    const list = this.dom.assetList;
    const inner = this.dom.assetListInner;
    inner.style.height = `${items.length * ROW_H}px`;
    const scrollTop = list.scrollTop;
    const viewH = list.clientHeight || 400;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
    const end = Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW_H) + 4);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.appendChild(this.buildAssetRow(items[i], i));
    inner.replaceChildren(frag);
    this.updateRowState();
  }

  buildAssetRow(asset, index) {
    const selected = this.selectedAssetId === asset.id;
    const playing = selected && this.transport.playing;
    const row = document.createElement('div');
    row.className = 'clip-row';
    row.style.top = `${index * ROW_H}px`;
    row.dataset.assetId = asset.id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) row.classList.add('is-selected');
    if (playing) row.classList.add('is-playing');

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'row-play';
    play.dataset.action = 'play';
    play.title = playing ? '暂停' : '试听';
    play.setAttribute('aria-label', play.title);
    play.innerHTML = icon(playing ? 'pause' : 'play');

    const text = document.createElement('div');
    text.className = 'row-text';
    const name = document.createElement('div');
    name.className = 'row-name';
    name.textContent = asset.name;
    const sub = document.createElement('div');
    sub.className = 'row-sub';
    sub.textContent = `${fmtShort(asset.duration)} · ${fmtRate(asset.buffer.sampleRate)} · ${channelLabel(asset.buffer.numberOfChannels)}`;
    text.append(name, sub);

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'row-more';
    more.dataset.action = 'more';
    more.title = '素材操作';
    more.setAttribute('aria-label', '素材操作');
    more.innerHTML = icon('more');

    row.append(play, text, more);
    return row;
  }

  updateRowState() {
    for (const row of this.dom.assetListInner.querySelectorAll('.clip-row')) {
      const asset = this.findAsset(row.dataset.assetId);
      if (!asset) continue;
      const selected = this.selectedAssetId === asset.id;
      const playing = selected && this.transport.playing;
      row.classList.toggle('is-selected', selected);
      row.classList.toggle('is-playing', playing);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
      const play = row.querySelector('.row-play');
      if (play) {
        play.innerHTML = icon(playing ? 'pause' : 'play');
        play.title = playing ? '暂停' : '试听';
        play.setAttribute('aria-label', play.title);
      }
    }
  }

  scrollAssetIntoView(id) {
    const items = this.visibleAssets();
    const index = items.findIndex((a) => a.id === id);
    if (index < 0) return;
    const list = this.dom.assetList;
    const top = index * ROW_H;
    const bottom = top + ROW_H;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
    this.renderVisibleAssetRows();
  }

  syncFieldsFromAsset() {
    const asset = this.asset;
    const title = this.dom.assetTitle;
    const gain = this.dom.gainInput;
    const fadeIn = this.dom.fadeInInput;
    const fadeOut = this.dom.fadeOutInput;

    if (!asset) {
      if (document.activeElement !== title) title.value = '';
      this.dom.assetMeta.textContent = '选择左侧素材开始编辑';
      if (document.activeElement !== gain) gain.value = '0';
      if (document.activeElement !== fadeIn) fadeIn.value = '0';
      if (document.activeElement !== fadeOut) fadeOut.value = '0';
      this.dom.editWarning.classList.add('hidden');
      return;
    }

    if (document.activeElement !== title) title.value = asset.name;
    this.dom.assetMeta.textContent = `${fmtDuration(asset.duration, 3)} · ${fmtRate(asset.buffer.sampleRate)} · ${channelLabel(asset.buffer.numberOfChannels)}`;

    if (document.activeElement !== gain) gain.value = String(Number(asset.gainDb.toFixed(1)));
    if (document.activeElement !== fadeIn) fadeIn.value = String(Math.round(asset.fadeInMs));
    if (document.activeElement !== fadeOut) fadeOut.value = String(Math.round(asset.fadeOutMs));
    const maxFade = Math.min(5000, Math.floor((asset.duration * 1000) / 2));
    fadeIn.max = String(Math.max(0, maxFade));
    fadeOut.max = String(Math.max(0, maxFade));

    this.updateEditWarning();
  }

  updateEditWarning() {
    const asset = this.asset;
    const warning = this.dom.editWarning;
    if (!asset?.peaks?.peak) {
      warning.classList.add('hidden');
      return;
    }
    let gainDb = asset.gainDb;
    if (document.activeElement === this.dom.gainInput) {
      const typed = Number(this.dom.gainInput.value);
      if (Number.isFinite(typed)) gainDb = typed;
    }
    const outDb = peakDb(asset.peaks.peak) + gainDb;
    warning.textContent = '可能削波';
    warning.classList.toggle('hidden', outDb <= -0.1);
  }

  updateSelectionUI() {
    const asset = this.asset;
    const hasSel = !!(asset?.selection && asset.selection.end > asset.selection.start);
    const busy = this.isBusy();
    this.dom.trimBtn.disabled = !hasSel || busy;
    this.dom.deleteSelBtn.disabled = !hasSel || busy;
    this.dom.saveSelBtn.disabled = !hasSel || busy;
    this.updateTimeReadout();
  }

  updateZoomButtons() {
    const busy = this.isBusy();
    this.dom.fitBtn.disabled = !this.asset || busy;
    this.dom.zoomInBtn.disabled = !this.waveform?.canZoomIn() || busy;
    this.dom.zoomOutBtn.disabled = !this.waveform?.canZoomOut() || busy;
  }

  updateTimeReadout() {
    const asset = this.asset;
    const total = asset ? asset.duration : 0;
    const pos = asset ? clamp(this.transport.position, 0, total) : 0;
    this.dom.timeReadout.textContent = `${fmtDuration(pos, 3)} / ${fmtDuration(total, 3)}`;

    if (asset?.selection && asset.selection.end > asset.selection.start) {
      const dur = (asset.selection.end - asset.selection.start) / asset.buffer.sampleRate;
      this.dom.selectionReadout.textContent = `选区 ${dur.toFixed(3)} s`;
      this.dom.selectionReadout.classList.add('is-active');
    } else {
      this.dom.selectionReadout.textContent = '';
      this.dom.selectionReadout.classList.remove('is-active');
    }
  }

  updateControls() {
    const busy = this.isBusy();
    const hasAsset = !!this.asset;
    const rec = this.recording;

    this.dom.recordBtn.disabled = rec.preparing || rec.stopping || this._busyExporting || this._busyImporting;
    this.dom.recordBtn.classList.toggle('is-recording', rec.active && !rec.stopping && !rec.preparing);
    this.dom.recordLabel.textContent = rec.preparing ? '准备中…' : rec.stopping ? '处理中…' : rec.active ? '停止' : '录制';

    this.dom.assetTitle.disabled = !hasAsset || busy;
    this.dom.gainInput.disabled = !hasAsset || busy;
    this.dom.fadeInInput.disabled = !hasAsset || busy;
    this.dom.fadeOutInput.disabled = !hasAsset || busy;
    this.dom.normalizeBtn.disabled = !hasAsset || busy;
    this.dom.silenceBtn.disabled = !hasAsset || busy;
    this.dom.resetBtn.disabled = !hasAsset || busy;
    this.dom.exportBtn.disabled = !hasAsset || busy;
    this.dom.saveWholeBtn.disabled = !hasAsset || busy;
    this.dom.moreBtn.disabled = !hasAsset || busy;
    this.dom.targetPackSelect.disabled = busy || !this.packs.length;

    this.dom.playBtn.disabled = !hasAsset || busy;
    this.dom.stopBtn.disabled = !hasAsset || busy;
    this.dom.loopBtn.disabled = !hasAsset || busy;
    this.dom.playBtn.innerHTML = icon(this.transport.playing ? 'pause' : 'play');
    this.dom.playBtn.title = this.transport.playing ? '暂停 (Space)' : '试听 (Space)';
    this.dom.playBtn.setAttribute('aria-label', this.transport.playing ? '暂停' : '试听');
    this.dom.loopBtn.setAttribute('aria-pressed', this.transport.loop ? 'true' : 'false');
    this.dom.loopBtn.classList.toggle('toggle-on', this.transport.loop);

    const history = this.asset ? this.history.get(this.asset.id) : null;
    this.dom.undoBtn.disabled = !hasAsset || busy || !history?.undo.length;
    this.dom.redoBtn.disabled = !hasAsset || busy || !history?.redo.length;

    this.updateZoomButtons();
    this.renderSourceControls();

    this.dom.importBtn.disabled = busy;
    this.dom.assetSearchInput.disabled = busy;
    this.dom.boardSearch.disabled = busy;
    this.dom.boardPackBtn.disabled = busy;
    this.dom.outputSelect.disabled = busy || !this.engine.sinkSupported;
    if (!this.engine.sinkSupported) {
      this.dom.outputSelect.title = '当前环境不支持独立选择输出设备';
    }

    this.updateSelectionUI();
  }

  /* =========================================================
   * asset selection / peaks
   * ======================================================= */

  selectAsset(id, opts = {}) {
    if (!id) {
      this.clearAssetSelection();
      return;
    }
    if (this.isBusy() && !opts.initial) return;
    const asset = this.findAsset(id);
    if (!asset) return;
    if (this.asset?.id === asset.id) {
      this.updateRowState();
      if (opts.focus) this.focusTitle();
      return;
    }

    this.stopPlayback({ reset: true });
    this.selectedAssetId = asset.id;
    this.asset = asset;
    this.transport.position = 0;
    this.transport.range = null;
    this.waveAsset = this.makeWaveAsset(asset);
    this.dom.waveEmpty.classList.add('hidden');
    this.dom.waveLoading.classList.add('hidden');
    this.waveform.setClip(this.waveAsset);
    this.waveform.setPosition(0);
    this.syncFieldsFromAsset();
    this.updateControls();
    this.updateTimeReadout();
    this.updateRowState();
    if (opts.scroll !== false) this.scrollAssetIntoView(asset.id);
    if (opts.focus) this.focusTitle();

    if (asset.peaks) {
      this.showWaveLoading(false);
    } else {
      const timer = setTimeout(() => {
        if (this.asset?.id === asset.id && !asset.peaks) this.showWaveLoading(true);
      }, 120);
      this.ensurePeaks(asset).finally(() => {
        clearTimeout(timer);
        if (this.asset?.id === asset.id) this.showWaveLoading(false);
      });
    }
  }

  clearAssetSelection() {
    this.stopPlayback({ reset: true });
    this.asset = null;
    this.selectedAssetId = null;
    this.waveAsset = null;
    this.transport.position = 0;
    this.transport.range = null;
    this.waveform.clear();
    this.dom.waveLoading.classList.add('hidden');
    this.dom.waveEmpty.classList.remove('hidden');
    this.syncFieldsFromAsset();
    this.updateControls();
    this.updateTimeReadout();
    this.updateRowState();
  }

  showWaveLoading(show) {
    this.dom.waveLoading.classList.toggle('hidden', !show);
    if (show) this.dom.waveEmpty.classList.add('hidden');
  }

  async ensurePeaks(asset) {
    if (asset.peaks) return asset.peaks;
    if (asset._peaksPromise) return asset._peaksPromise;
    const token = ++asset.peaksToken;
    const promise = (async () => {
      const peaks = await buildPeaks(asset.renderBuffer, PEAKS_BUCKET);
      if (asset.peaksToken !== token) return null;
      asset.peaks = peaks;
      if (this.asset?.id === asset.id) {
        this.syncWaveFields();
        this.waveform.refresh();
        this.updateEditWarning();
        this.updateTimeReadout();
      }
      return peaks;
    })();
    asset._peaksPromise = promise;
    try {
      return await promise;
    } finally {
      if (asset._peaksPromise === promise) asset._peaksPromise = null;
    }
  }

  focusTitle() {
    if (!this.asset || this.isBusy()) return;
    this.dom.assetTitle.focus();
    this.dom.assetTitle.select();
  }

  /* =========================================================
   * asset preview transport
   * ======================================================= */

  getPlayRange() {
    if (!this.asset) return null;
    const sel = this.asset.selection;
    if (sel && sel.end > sel.start) {
      const sr = this.asset.buffer.sampleRate;
      return { start: sel.start / sr, end: sel.end / sr };
    }
    return { start: 0, end: this.asset.duration };
  }

  currentPlaybackPosition() {
    const h = this.transport.handle;
    if (!h || h.native || !this.engine.ctx) return this.transport.position;
    let pos = h.startOffset + (this.engine.ctx.currentTime - h.startCtx);
    if (h.loop) {
      const len = h.range.end - h.range.start;
      if (len > 0) pos = h.range.start + ((((pos - h.range.start) % len) + len) % len);
    }
    return clamp(pos, h.range.start, h.range.end);
  }

  stopSourceOnly() {
    cancelAnimationFrame(this.transport.raf);
    this.transport.raf = 0;
    const handle = this.transport.handle;
    this.transport.handle = null;
    if (!handle) return;
    if (handle.native) {
      invoke('playback_stop').catch(() => { /* 会话已结束 */ });
      return;
    }
    try { handle.source.onended = null; } catch { /* 忽略 */ }
    try { handle.source.stop(); } catch { /* 可能已结束 */ }
    try { handle.source.disconnect(); } catch { /* 忽略 */ }
    try { handle.gain.disconnect(); } catch { /* 忽略 */ }
  }

  async play({ restart = false } = {}) {
    if (!this.asset || this.isBusy()) return;
    const asset = this.asset;
    const range = this.getPlayRange();
    if (!range || range.end - range.start <= 0) return;

    let start = restart ? range.start : this.transport.position;
    if (start < range.start - 1e-6 || start >= range.end - 1e-4) start = range.start;

    if (isNative) {
      try {
        await this.playNativePreview(asset, range, start);
      } catch (err) {
        showToast(`无法播放：${err.message || '音频输出失败'}`, { type: 'error', duration: 5000 });
      }
      return;
    }

    try {
      await this.engine.ensure();
    } catch {
      showToast('无法启动音频输出', { type: 'error' });
      return;
    }
    if (this.asset !== asset) return;

    this.stopSourceOnly();
    const ctx = this.engine.ctx;
    const source = ctx.createBufferSource();
    source.buffer = asset.renderBuffer;
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime + 0.02;
    const base = gainForDb(asset.gainDb);
    const loop = this.transport.loop;
    gain.gain.cancelScheduledValues(0);

    if (loop) {
      source.loop = true;
      source.loopStart = range.start;
      source.loopEnd = range.end;
      gain.gain.setValueAtTime(base, now);
      source.start(now, start);
    } else {
      const remaining = Math.max(0.001, range.end - start);
      const fadeIn = Math.max(0, asset.fadeInMs) / 1000;
      const fadeOut = Math.max(0, asset.fadeOutMs) / 1000;
      if (start <= range.start + 0.002 && fadeIn > 0) {
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(base, now + Math.min(fadeIn, remaining));
      } else {
        gain.gain.setValueAtTime(base, now);
      }
      if (range.end >= asset.duration - 0.002 && fadeOut > 0) {
        const fadeStart = now + Math.max(0, remaining - fadeOut);
        if (fadeStart > now + 0.002) gain.gain.setValueAtTime(base, fadeStart);
        gain.gain.linearRampToValueAtTime(0, now + remaining);
      }
      source.start(now, start, remaining);
    }

    const handle = { source, gain, startCtx: now, startOffset: start, range, loop, baseGain: base };
    this.transport.handle = handle;
    this.transport.playing = true;
    this.transport.position = start;
    this.transport.range = range;
    this.waveform.setPlaying(true);
    this.waveform.setPosition(start);
    this.updateControls();
    this.updateTimeReadout();
    this.updateRowState();

    const tick = () => {
      if (this.transport.handle !== handle) return;
      const pos = this.currentPlaybackPosition();
      if (!loop && pos >= range.end - 0.001) {
        this.finishPlayback();
        return;
      }
      this.transport.position = pos;
      this.waveform.setPosition(pos);
      this.updateTimeReadout();
      this.transport.raf = requestAnimationFrame(tick);
    };
    this.transport.raf = requestAnimationFrame(tick);
  }

  /// Native preview: the whole play range goes to Rust as 48 kHz stereo float, fades ride
  /// along as parameters so the gain slider stays live without a re-render.
  async playNativePreview(asset, range, start) {
    const slice = await toNativePcm(asset.renderBuffer, range.start, range.end);
    const coversEnd = range.end >= asset.duration - 0.002;
    const loop = this.transport.loop;
    this.stopSourceOnly();
    await invoke('play_pcm', slice.buffer, {
      headers: {
        'x-sample-rate': '48000',
        'x-channels': '2',
        'x-gain-db': String(asset.gainDb || 0),
        'x-fade-in-ms': String(loop ? 0 : asset.fadeInMs || 0),
        'x-fade-out-ms': String(!loop && coversEnd ? asset.fadeOutMs || 0 : 0),
        'x-loop': loop ? '1' : '0',
        'x-device': this.outputId || '',
        'x-start-ms': String(Math.round((start - range.start) * 1000)),
      },
    });
    this.transport.handle = { native: true, loop, range };
    this.transport.playing = true;
    this.transport.position = start;
    this.transport.range = range;
    this.waveform.setPlaying(true);
    this.waveform.setPosition(start);
    this.updateControls();
    this.updateTimeReadout();
    this.updateRowState();
  }

  pausePlayback() {
    if (!this.transport.playing) return;
    if (this.transport.handle?.native) {
      invoke('playback_pause').catch(() => { /* 会话已结束 */ });
      this.transport.playing = false;
      this.transport.range = this.getPlayRange();
      this.waveform.setPlaying(false);
      this.updateControls();
      this.updateRowState();
      this.updateTimeReadout();
      return;
    }
    const pos = this.currentPlaybackPosition();
    this.stopSourceOnly();
    this.transport.playing = false;
    this.transport.position = pos;
    this.transport.range = this.getPlayRange();
    this.waveform.setPlaying(false);
    this.waveform.setPosition(pos);
    this.updateControls();
    this.updateTimeReadout();
    this.updateRowState();
  }

  stopPlayback({ reset = true } = {}) {
    const range = this.getPlayRange();
    const wasPlaying = this.transport.playing;
    this.stopSourceOnly();
    this.transport.playing = false;
    if (reset) {
      this.transport.position = range?.start ?? 0;
      this.transport.range = null;
    } else {
      this.transport.range = range;
    }
    this.waveform.setPlaying(false);
    this.waveform.setPosition(this.transport.position);
    if (wasPlaying) {
      this.updateControls();
      this.updateRowState();
    }
    this.updateTimeReadout();
  }

  finishPlayback() {
    const handle = this.transport.handle;
    const end = handle?.range.end ?? this.transport.position;
    this.stopSourceOnly();
    this.transport.playing = false;
    this.transport.position = end;
    this.transport.range = null;
    this.waveform.setPlaying(false);
    this.waveform.setPosition(end);
    this.updateControls();
    this.updateTimeReadout();
    this.updateRowState();
  }

  togglePlayback() {
    if (!this.asset || this.isBusy()) return;
    if (this.transport.playing) this.pausePlayback();
    else this.play();
  }

  toggleLoop() {
    this.transport.loop = !this.transport.loop;
    const wasPlaying = this.transport.playing;
    const pos = this.transport.position;
    if (wasPlaying) {
      this.pausePlayback();
      this.transport.position = pos;
      this.play();
    } else {
      this.updateControls();
    }
  }

  seekTo(sec) {
    if (!this.asset || this.isBusy()) return;
    if (this.transport.playing) this.pausePlayback();
    this.transport.position = clamp(sec, 0, this.asset.duration);
    this.waveform.setPosition(this.transport.position);
    this.updateTimeReadout();
  }

  seekBy(delta) {
    if (!this.asset) return;
    this.seekTo(this.transport.position + delta);
  }

  setLiveGain() {
    const handle = this.transport.handle;
    if (!handle) return;
    if (handle.native) {
      invoke('playback_set_gain', { gainDb: this.asset?.gainDb ?? 0 }).catch(() => { /* 会话已结束 */ });
      return;
    }
    if (!this.engine.ctx) return;
    const now = this.engine.ctx.currentTime;
    const base = gainForDb(this.asset?.gainDb ?? 0);
    try {
      handle.gain.gain.cancelScheduledValues(now);
      handle.gain.gain.setValueAtTime(base, now);
      handle.baseGain = base;
    } catch { /* 忽略 */ }
  }

  handleSelection(sel) {
    if (!this.asset) return;
    if (this.transport.playing) this.pausePlayback();
    this.asset.selection = sel ? { start: sel.start, end: sel.end } : null;
    if (this.waveAsset) this.waveAsset.selection = this.asset.selection;
    this.updateSelectionUI();
    this.updateTimeReadout();
  }

  handleSeek(sample) {
    if (!this.asset) return;
    if (this.transport.playing) this.pausePlayback();
    this.transport.position = clamp(sample, 0, this.asset.renderBuffer.length) / this.asset.buffer.sampleRate;
    this.waveform.setPosition(this.transport.position);
    this.updateTimeReadout();
  }

  /* =========================================================
   * voice board playback
   * ======================================================= */

  /// 语音文件解码一次就留在对象上，重复点击不再读盘；非 WAV 的时长也是这时才知道。
  async ensureVoiceBuffer(voice) {
    if (voice.buffer) return voice.buffer;
    const bytes = await packStore.read(voice);
    const buffer = await this.engine.decode(bytes);
    if (!buffer || !buffer.duration) throw new Error('解码不出音频');
    voice.buffer = buffer;
    const wasUnknown = voice.durationMs == null;
    voice.durationMs = Math.round(buffer.duration * 1000);
    voice.sampleRate = buffer.sampleRate;
    voice.channels = buffer.numberOfChannels;
    if (wasUnknown) this.renderBoard();
    return buffer;
  }

  async playVoice(voice) {
    if (!voice) return;
    if (this.voicePlay?.voice.path === voice.path) {
      this.stopVoicePlayback();
      return;
    }
    this.stopVoicePlayback();
    if (this.isBusy()) return;

    let buffer = null;
    try {
      buffer = await this.ensureVoiceBuffer(voice);
    } catch (err) {
      showToast(`播不了「${voice.name}」：${err?.message || err}`, { type: 'error', duration: 5000 });
      return;
    }
    const duration = buffer.duration;

    if (isNative) {
      try {
        const pcm = await toNativePcm(buffer, 0, duration);
        await invoke('play_pcm', pcm.buffer, {
          headers: {
            'x-sample-rate': '48000',
            'x-channels': '2',
            // 增益和淡变已经烘进文件，这里不再叠加。
            'x-gain-db': '0',
            'x-fade-in-ms': '0',
            'x-fade-out-ms': '0',
            'x-loop': '0',
            'x-device': this.outputId || '',
            'x-start-ms': '0',
          },
        });
        const token = ++this.voicePlayToken;
        this.voicePlay = { voice, token, native: true };
        this.updateVoicePlayingUI();
      } catch (err) {
        showToast(`无法播放：${err.message || '音频输出失败'}`, { type: 'error', duration: 5000 });
      }
      return;
    }

    try {
      await this.engine.ensure();
    } catch {
      showToast('无法启动音频输出', { type: 'error' });
      return;
    }

    const ctx = this.engine.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(ctx.currentTime + 0.02);

    const token = ++this.voicePlayToken;
    this.voicePlay = { voice, source, token };
    source.onended = () => {
      if (this.voicePlay?.token === token) this.stopVoicePlayback();
    };
    this.updateVoicePlayingUI();
  }

  stopVoicePlayback() {
    const play = this.voicePlay;
    this.voicePlay = null;
    if (!play) return;
    this.voicePlayToken++;
    if (play.native) {
      invoke('playback_stop').catch(() => { /* 会话已结束 */ });
      this.updateVoicePlayingUI();
      return;
    }
    try { play.source.onended = null; } catch { /* 忽略 */ }
    try { play.source.stop(); } catch { /* 可能已结束 */ }
    try { play.source.disconnect(); } catch { /* 忽略 */ }
    try { play.gain.disconnect(); } catch { /* 忽略 */ }
    this.updateVoicePlayingUI();
  }

  stopAll() {
    this.stopPlayback({ reset: true });
    this.stopVoicePlayback();
  }

  /// One subscription routes both preview and voice-board playback events; whichever is
  /// active owns the position, and a finished event ends exactly the active one.
  setupNativeEvents() {
    if (this._nativeEvents) return;
    this._nativeEvents = true;
    listen('vp:playback-progress', (event) => {
      const { positionMs, finished } = event.payload;
      if (this.voicePlay) {
        if (finished) this.stopVoicePlayback();
        return;
      }
      const handle = this.transport.handle;
      if (!handle?.native) return;
      if (finished) {
        this.finishPlayback();
        return;
      }
      if (!this.transport.playing) return;
      const pos = clamp(positionMs / 1000, handle.range.start, handle.range.end);
      this.transport.position = pos;
      this.waveform.setPosition(pos);
      this.updateTimeReadout();
    }).catch(() => { /* 原生事件不可用 */ });
  }

  updateVoicePlayingUI() {
    const playingPath = this.voicePlay?.voice.path || null;
    for (const tile of this.dom.voiceGrid.querySelectorAll('.voice-tile')) {
      const on = tile.dataset.voicePath === playingPath;
      tile.classList.toggle('is-playing', on);
      tile.setAttribute('aria-label', on ? `${tile.dataset.name}，正在播放` : tile.dataset.name);
    }
  }

  /* =========================================================
   * voice board rendering
   * ======================================================= */

  renderBoardTools() {
    for (const btn of $$('.layout-btn', this.dom.layoutToggle)) {
      const on = btn.dataset.layout === this.boardLayout;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this.dom.voiceGrid.classList.toggle('is-list', this.boardLayout === 'list');
  }

  renderBoard() {
    const items = this.visibleVoices();
    const total = this.currentVoices().length;
    this.dom.boardCount.textContent = this.voiceSearch ? `${items.length}/${total} 条` : `${total} 条`;
    this.dom.boardPackName.textContent = this.currentPack()?.name || '语音包';

    if (!items.length) {
      this.dom.voiceGrid.replaceChildren();
      this.dom.boardEmpty.classList.remove('hidden');
      if (this.voiceSearch) {
        this.dom.boardEmptyTitle.textContent = '没有匹配的语音';
        this.dom.boardEmptyText.textContent = '换个关键词试试';
        this.dom.boardEmptyAction.textContent = '清除搜索';
      } else {
        this.dom.boardEmptyTitle.textContent = '这个语音包还没有语音';
        this.dom.boardEmptyText.textContent = '去素材库切好语音后保存进来';
        this.dom.boardEmptyAction.textContent = '去素材库';
      }
      return;
    }

    this.dom.boardEmpty.classList.add('hidden');
    const frag = document.createDocumentFragment();
    for (const voice of items) frag.appendChild(this.buildVoiceTile(voice));
    this.dom.voiceGrid.replaceChildren(frag);
    this.updateVoicePlayingUI();
  }

  buildVoiceTile(voice) {
    const tile = document.createElement('div');
    tile.className = 'voice-tile';
    tile.dataset.voicePath = voice.path;
    tile.dataset.name = voice.name;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'option');
    tile.setAttribute('aria-selected', 'false');

    const main = document.createElement('div');
    main.className = 'voice-main';

    const mark = document.createElement('span');
    mark.className = 'voice-icon';
    const play = document.createElement('span');
    play.className = 'vi-play';
    play.innerHTML = icon('play');
    const eq = document.createElement('span');
    eq.className = 'vi-eq';
    eq.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    mark.append(play, eq);

    const text = document.createElement('div');
    text.className = 'voice-text';
    const name = document.createElement('div');
    name.className = 'voice-name';
    name.textContent = voice.name;
    const meta = document.createElement('div');
    meta.className = 'voice-meta';
    const dur = document.createElement('span');
    dur.className = 'voice-duration';
    dur.textContent = voice.durationMs
      ? `${fmtShort(voice.durationMs / 1000)} · ${fmtRate(voice.sampleRate || 48000)}`
      : `${(voice.size / 1024).toFixed(0)} KB`;
    meta.appendChild(dur);
    if (voice.hotkey) {
      const chip = document.createElement('span');
      chip.className = 'hotkey-chip';
      chip.textContent = voice.hotkey;
      meta.appendChild(chip);
    }
    text.append(name, meta);
    main.append(mark, text);

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'voice-more';
    more.dataset.action = 'more';
    more.title = '语音操作';
    more.setAttribute('aria-label', `语音操作：${voice.name}`);
    more.innerHTML = icon('more');

    tile.append(main, more);
    return tile;
  }

  /* =========================================================
   * saving voices from an asset
   * ======================================================= */

  async saveVoiceFromAsset({ assetId = null, selectionOnly = false } = {}) {
    const asset = this.findAsset(assetId) || this.asset;
    if (!asset || this.isBusy()) return;
    const pack = this.packName || this.packs[0]?.name;
    if (!pack) {
      showToast('还没有语音包', { type: 'error' });
      return;
    }

    let segments;
    if (selectionOnly) {
      if (!asset.selection || asset.selection.end <= asset.selection.start) {
        showToast('先在波形上拖出一段选区', { type: 'error' });
        return;
      }
      segments = keepRenderedRange(asset.segments, asset.selection.start, asset.selection.end);
    } else {
      segments = deepCopySegments(asset.segments);
    }
    const minRemain = Math.round(MIN_REMAIN_SECONDS * asset.buffer.sampleRate);
    if (totalLength(segments) < minRemain) {
      showToast('语音至少要有 20 ms 音频', { type: 'error' });
      return;
    }

    // 命名放在保存这一刻：省掉"先落一个默认名、再去语音板里找出来改名"的往返。
    const name = await promptDialog({
      title: selectionOnly ? '保存选区为语音' : '保存整段为语音',
      label: '名称',
      value: this.uniqueVoiceName(asset.name),
      hint: `保存为「${pack}」文件夹里的一个 WAV，文件名就是这个名字；增益和淡变会烘进音频。`,
      confirmLabel: '保存',
      validate: (v) => (!v
        ? '名称不能为空'
        : (this.voices.some((x) => x.name.toLowerCase() === sanitizeName(v).toLowerCase())
          ? '这个包里已经有同名语音' : '')),
    });
    if (!name) return;

    const file = voiceFile(name);
    try {
      const bytes = await this.renderVoiceWav(asset, segments);
      await packStore.write(`${pack}/${file}`, bytes);
    } catch (err) {
      showToast(`保存失败：${err.message || err}`, { type: 'error', duration: 6000 });
      return;
    }
    await this.scanVoices();
    this.renderTargetPacks();
    this.renderBoard();
    this.updateControls();
    showToast(`已保存「${sanitizeName(name)}」到「${pack}」`, {
      action: { label: '去语音板', onClick: () => this.setView('board') },
    });
  }

  async renameVoice(voice) {
    if (!voice || this.isBusy()) return;
    const name = await promptDialog({
      title: '重命名语音',
      label: '名称',
      value: voice.name,
      confirmLabel: '保存',
      validate: (v) => (!v
        ? '名称不能为空'
        : (this.voices.some((x) => x !== voice && x.name.toLowerCase() === sanitizeName(v).toLowerCase())
          ? '这个包里已经有同名语音' : '')),
    });
    if (!name) return;
    const target = `${voice.pack}/${voiceFile(name)}`;
    if (target === voice.path) return;
    try {
      await packStore.move(voice.path, target);
    } catch (err) {
      showToast(`重命名失败：${err.message || err}`, { type: 'error', duration: 6000 });
      return;
    }
    const from = voiceKey(voice.pack, voice.name);
    const to = voiceKey(voice.pack, sanitizeName(name));
    if (this.hotkeys[from] && from !== to) {
      this.hotkeys[to] = this.hotkeys[from];
      delete this.hotkeys[from];
    }
    await this.scanVoices();
    this.renderBoard();
  }

  checkVoiceHotkey(voice, combo) {
    if (!combo) return '';
    if (RESERVED_HOTKEYS.has(combo)) return '该组合已用于界面操作，请换一个';
    const conflict = this.voices.find((v) => v.path !== voice.path && v.hotkey === combo);
    if (conflict) return `快捷键已被「${conflict.name}」使用`;
    return '';
  }

  setVoiceHotkey(voice, combo) {
    if (!voice) return;
    const key = voiceKey(voice.pack, voice.name);
    if (combo) this.hotkeys[key] = combo;
    else delete this.hotkeys[key];
    voice.hotkey = combo || '';
    this.renderBoard();
  }

  /// 删语音就是删文件。撤销靠内存里那份字节，6 秒内写回同名文件。
  async deleteVoice(voice) {
    if (!voice || this.isBusy()) return;
    if (!this.voices.includes(voice)) return;
    let bytes = null;
    try {
      bytes = new Uint8Array(await packStore.read(voice));
    } catch {
      bytes = null;
    }
    if (this.voicePlay?.voice.path === voice.path) this.stopVoicePlayback();
    try {
      await packStore.remove(voice.path);
    } catch (err) {
      showToast(`删除失败：${err.message || err}`, { type: 'error', duration: 6000 });
      return;
    }
    const key = voiceKey(voice.pack, voice.name);
    const bound = this.hotkeys[key] || '';
    delete this.hotkeys[key];
    await this.scanVoices();
    this.renderTargetPacks();
    this.renderBoard();
    this.updateControls();
    showToast(`已删除语音「${voice.name}」`, {
      duration: 6000,
      action: bytes ? {
        label: '撤销',
        onClick: async () => {
          if (this.voices.some((v) => v.path === voice.path)) return;
          try {
            await packStore.write(voice.path, bytes);
          } catch (err) {
            showToast(`恢复失败：${err.message || err}`, { type: 'error', duration: 6000 });
            return;
          }
          if (bound) this.hotkeys[key] = bound;
          await this.scanVoices();
          this.renderTargetPacks();
          this.renderBoard();
        },
      } : undefined,
    });
  }

  /* =========================================================
   * asset management
   * ======================================================= */

  deleteAsset(asset) {
    if (!asset || this.isBusy()) return;
    confirmDialog({
      title: '删除素材',
      message: `将删除「${asset.name}」。已经保存的语音不受影响。6 秒内可撤销。`,
      confirmLabel: '删除',
      danger: true,
    })
      .then((ok) => {
        if (!ok) return;
        this.removeAsset(asset);
      });
  }

  removeAsset(asset) {
    const index = this.assets.indexOf(asset);
    if (index < 0) return;
    this.assets.splice(index, 1);
    const wasSelected = this.asset?.id === asset.id;
    this.history.delete(asset.id);
    if (wasSelected) {
      const after = this.visibleAssets();
      const next = after[Math.min(Math.max(0, index), after.length - 1)];
      this.asset = null;
      this.selectedAssetId = null;
      if (next) this.selectAsset(next.id, { scroll: false });
      else this.clearAssetSelection();
    }
    this.renderAssetList();
    this.renderTargetPacks();
    this.renderBoard();
    this.updateControls();
    showToast(`已删除「${asset.name}」`, {
      duration: 6000,
      action: {
        label: '撤销',
        onClick: () => {
          if (this.assets.includes(asset)) return;
          this.assets.splice(Math.min(index, this.assets.length), 0, asset);
          this.renderAssetList();
          this.renderTargetPacks();
          this.renderBoard();
          this.selectAsset(asset.id, { scroll: true });
        },
      },
    });
  }

  renameAssetCommit() {
    const asset = this.asset;
    if (!asset || this.isBusy()) return;
    const value = this.dom.assetTitle.value.trim().slice(0, 60);
    if (!value) {
      this.dom.assetTitle.value = asset.name;
      return;
    }
    if (value === asset.name) return;
    asset.name = value;
    this.dom.assetTitle.value = value;
    this.renderAssetList();
  }

  /* =========================================================
   * editing
   * ======================================================= */

  snapshot(asset) {
    return {
      segments: deepCopySegments(asset.segments),
      gainDb: asset.gainDb,
      fadeInMs: asset.fadeInMs,
      fadeOutMs: asset.fadeOutMs,
    };
  }

  pushHistory(asset) {
    const entry = this.history.get(asset.id) || { undo: [], redo: [] };
    entry.undo.push(this.snapshot(asset));
    if (entry.undo.length > 100) entry.undo.shift();
    entry.redo = [];
    this.history.set(asset.id, entry);
    this.updateControls();
  }

  async applySnapshot(asset, snap) {
    const segmentsChanged = !segmentsEqual(asset.segments, snap.segments);
    asset.gainDb = clamp(snap.gainDb, -24, 24);
    asset.fadeInMs = Math.max(0, snap.fadeInMs);
    asset.fadeOutMs = Math.max(0, snap.fadeOutMs);
    if (segmentsChanged) {
      asset.segments = deepCopySegments(snap.segments);
      await this.rebuildFromSegments(asset);
    } else {
      if (this.transport.playing) this.pausePlayback();
      const maxFade = Math.min(5000, Math.floor((asset.duration * 1000) / 2));
      asset.fadeInMs = clamp(asset.fadeInMs, 0, maxFade);
      asset.fadeOutMs = clamp(asset.fadeOutMs, 0, maxFade);
      this.syncWaveFields();
      this.waveform.refresh();
      this.syncFieldsFromAsset();
      this.updateControls();
      this.updateTimeReadout();
    }
  }

  undo() {
    const asset = this.asset;
    if (!asset || this.isBusy()) return;
    const entry = this.history.get(asset.id);
    if (!entry?.undo.length) return;
    const current = this.snapshot(asset);
    const snap = entry.undo.pop();
    entry.redo.push(current);
    this.applySnapshot(asset, snap).then(() => this.updateControls());
  }

  redo() {
    const asset = this.asset;
    if (!asset || this.isBusy()) return;
    const entry = this.history.get(asset.id);
    if (!entry?.redo.length) return;
    const current = this.snapshot(asset);
    const snap = entry.redo.pop();
    entry.undo.push(current);
    this.applySnapshot(asset, snap).then(() => this.updateControls());
  }

  async rebuildFromSegments(asset) {
    if (this.transport.playing) this.pausePlayback();
    let renderBuffer;
    try {
      renderBuffer = this.engine.renderSegments(asset.buffer, asset.segments);
    } catch (err) {
      showToast(err.message || '无法生成编辑结果', { type: 'error' });
      return false;
    }
    asset.segments = normalizeSegments(asset.segments, asset.buffer.length);
    asset.renderBuffer = renderBuffer;
    asset.duration = renderBuffer.duration;
    asset.peaks = null;
    asset.peaksToken++;
    asset.selection = null;
    asset.version++;
    const maxFade = Math.min(5000, Math.floor((asset.duration * 1000) / 2));
    asset.fadeInMs = clamp(asset.fadeInMs, 0, maxFade);
    asset.fadeOutMs = clamp(asset.fadeOutMs, 0, maxFade);

    if (this.asset?.id === asset.id) {
      this.transport.position = 0;
      this.transport.range = null;
      this.waveAsset = this.makeWaveAsset(asset);
      this.waveform.setClip(this.waveAsset);
      this.waveform.setPosition(0);
      this.syncFieldsFromAsset();
      this.updateControls();
      this.updateTimeReadout();
      this.updateRowState();
      this.showWaveLoading(true);
      await this.ensurePeaks(asset);
      if (this.asset?.id === asset.id) this.showWaveLoading(false);
    } else {
      await this.ensurePeaks(asset);
    }
    this.updateControls();
    return true;
  }

  trimSelection() {
    const asset = this.asset;
    if (!asset?.selection || this.isBusy()) return;
    const minRemain = Math.round(MIN_REMAIN_SECONDS * asset.buffer.sampleRate);
    const next = keepRenderedRange(asset.segments, asset.selection.start, asset.selection.end);
    if (totalLength(next) < minRemain) {
      showToast('至少保留 20 ms 音频', { type: 'error' });
      return;
    }
    this.pushHistory(asset);
    asset.segments = next;
    this.rebuildFromSegments(asset);
  }

  deleteSelection() {
    const asset = this.asset;
    if (!asset?.selection || this.isBusy()) return;
    const minRemain = Math.round(MIN_REMAIN_SECONDS * asset.buffer.sampleRate);
    const next = removeRenderedRange(asset.segments, asset.selection.start, asset.selection.end);
    if (totalLength(next) < minRemain) {
      showToast('至少保留 20 ms 音频', { type: 'error' });
      return;
    }
    this.pushHistory(asset);
    asset.segments = next;
    this.rebuildFromSegments(asset);
  }

  clearSelectionOnly() {
    if (!this.asset?.selection) return;
    this.asset.selection = null;
    if (this.waveAsset) this.waveAsset.selection = null;
    this.waveform.scheduleOverlay();
    this.updateSelectionUI();
  }

  commitGain() {
    const asset = this.asset;
    if (!asset || this.isBusy()) return;
    const input = this.dom.gainInput;
    let value = Number(input.value);
    if (!Number.isFinite(value)) value = asset.gainDb;
    value = clamp(Math.round(value * 10) / 10, -24, 24);
    if (Math.abs(value - asset.gainDb) < 1e-9) {
      input.value = String(Number(asset.gainDb.toFixed(1)));
      this.updateEditWarning();
      return;
    }
    this.pushHistory(asset);
    asset.gainDb = value;
    input.value = String(Number(value.toFixed(1)));
    this.syncWaveFields();
    this.waveform.refresh();
    this.updateEditWarning();
    if (this.transport.playing) this.setLiveGain();
    this.updateControls();
  }

  commitFade(which) {
    const asset = this.asset;
    if (!asset || this.isBusy()) return;
    const input = which === 'in' ? this.dom.fadeInInput : this.dom.fadeOutInput;
    const maxFade = Math.min(5000, Math.floor((asset.duration * 1000) / 2));
    let value = Number(input.value);
    if (!Number.isFinite(value)) value = which === 'in' ? asset.fadeInMs : asset.fadeOutMs;
    value = clamp(Math.round(value), 0, Math.max(0, maxFade));
    const old = which === 'in' ? asset.fadeInMs : asset.fadeOutMs;
    if (value === old) {
      input.value = String(Math.round(old));
      return;
    }
    this.pushHistory(asset);
    if (which === 'in') asset.fadeInMs = value;
    else asset.fadeOutMs = value;
    input.value = String(value);
    if (this.transport.playing) this.pausePlayback();
    this.syncWaveFields();
    this.waveform.refresh();
    this.updateControls();
  }

  normalizeAsset() {
    const asset = this.asset;
    if (!asset || this.isBusy()) return;
    const peak = asset.peaks?.peak || peakOf(asset.renderBuffer);
    if (!peak || peak < 1e-6) {
      showToast('这条素材没有可归一化的声音', { type: 'error' });
      return;
    }
    const wanted = -1 - peakDb(peak);
    const value = Math.round(clamp(wanted, -24, 24) * 10) / 10;
    if (Math.abs(value - asset.gainDb) < 0.05) {
      showToast('当前音量已在标准附近');
      return;
    }
    this.pushHistory(asset);
    asset.gainDb = value;
    this.dom.gainInput.value = String(Number(value.toFixed(1)));
    this.syncWaveFields();
    this.waveform.refresh();
    this.updateEditWarning();
    if (this.transport.playing) this.setLiveGain();
    this.updateControls();
    if (Math.abs(value - wanted) > 0.05) {
      showToast(`已应用增益上限 ${value > 0 ? '+' : ''}${value.toFixed(1)} dB`);
    }
  }

  trimSilence() {
    const asset = this.asset;
    if (!asset || this.isBusy()) return;
    const bounds = findAudibleBounds(asset.renderBuffer, -50, 0.05);
    if (!bounds) {
      showToast('没有检测到有效声音', { type: 'error' });
      return;
    }
    const total = asset.renderBuffer.length;
    const pad = Math.round(asset.buffer.sampleRate * 0.005);
    if (bounds.start <= pad && bounds.end >= total - pad) {
      showToast('没有可去除的首尾静音');
      return;
    }
    const next = keepRenderedRange(asset.segments, bounds.start, bounds.end);
    const minRemain = Math.round(MIN_REMAIN_SECONDS * asset.buffer.sampleRate);
    if (totalLength(next) < minRemain) {
      showToast('至少保留 20 ms 音频', { type: 'error' });
      return;
    }
    const removed = (totalLength(asset.segments) - totalLength(next)) / asset.buffer.sampleRate;
    this.pushHistory(asset);
    asset.segments = next;
    this.rebuildFromSegments(asset);
    showToast(`已去除 ${removed.toFixed(3)} s 静音`);
  }

  resetEdits() {
    const asset = this.asset;
    if (!asset || this.isBusy()) return;
    const isFull = asset.segments.length === 1
      && asset.segments[0].start === 0
      && asset.segments[0].end === asset.buffer.length;
    if (isFull && asset.gainDb === 0 && asset.fadeInMs === 0 && asset.fadeOutMs === 0) {
      showToast('没有可重置的编辑');
      return;
    }
    this.pushHistory(asset);
    asset.segments = fullSegments(asset.buffer.length);
    asset.gainDb = 0;
    asset.fadeInMs = 0;
    asset.fadeOutMs = 0;
    this.rebuildFromSegments(asset);
  }

  /* =========================================================
   * recording
   * ======================================================= */

  friendlyRecordError(err, mode) {
    const name = err?.name || '';
    if (name === 'NotAllowedError') {
      return mode === 'system' ? '已取消共享，或未授予共享权限' : '麦克风权限被拒绝，请在地址栏允许后重试';
    }
    if (name === 'NotFoundError') return '没有找到可用的音频设备';
    if (name === 'NotReadableError') return '音频设备被其它程序占用';
    return err?.message || '无法开始录制';
  }

  async startRecording() {
    if (this.isBusy() || this.recording.active) return;
    if (this.sourceMode === 'app' && !this.appSource) {
      openAppPicker(this);
      return;
    }
    this.stopAll();

    const mode = this.sourceMode === 'mic' ? 'mic' : this.sourceMode === 'app' ? (isNative ? 'app' : 'demo') : 'system';
    const sourceName = this.sourceMode === 'mic'
      ? (this.dom.micSelect.selectedOptions[0]?.textContent || '麦克风')
      : this.sourceMode === 'app'
        ? this.appSource.name
        : '系统共享';

    this.recording.session++;
    const session = this.recording.session;
    this.recording.active = mode === 'demo';
    this.recording.preparing = mode !== 'demo';
    this.recording.stopping = false;
    this.recording.mode = mode;
    this.recording.sourceName = sourceName;
    this.recording.elapsed = 0;

    this.dom.recordOverlay.classList.remove('hidden');
    this.dom.waveEmpty.classList.add('hidden');
    this.dom.waveLoading.classList.add('hidden');
    this.dom.recordBtn.classList.add('is-recording');
    this.dom.recordLabel.textContent = this.recording.preparing ? '准备中…' : '停止';
    this.dom.discardBtn.disabled = this.recording.preparing;
    this.dom.recSourceName.textContent = sourceName;
    this.dom.recOverlayTime.textContent = '0:00.0';
    this.dom.recTime.textContent = '0:00.0';
    this.dom.recTime.classList.remove('hidden');
    this.dom.recHint.textContent = '再次点击「停止」结束录制';
    this.live.reset();
    this.meter.reset();
    this.updateControls();

    const onLevel = (level) => {
      if (this.recording.session !== session) return;
      this.meter.update(level.db);
      this.live.push(level.elapsed, level.min, level.max);
    };
    const onTick = ({ elapsed }) => {
      if (this.recording.session !== session) return;
      this.recording.elapsed = elapsed;
      const text = fmtShort(elapsed);
      this.dom.recOverlayTime.textContent = text;
      this.dom.recTime.textContent = text;
    };

    try {
      await this.recorder.start({
        mode,
        native: isNative,
        deviceId: this.micDeviceId || undefined,
        pid: isNative && this.sourceMode === 'app' ? this.appSource?.pid : undefined,
        demoBuffer: mode === 'demo' ? this.ensureDemoBuffers()[this.appSource.bufferKey] : null,
        demoName: sourceName,
        nativeName: sourceName,
        onLevel,
        onTick,
        onLimit: () => this.stopRecording({ auto: true }),
        onStreamEnded: () => this.stopRecording({ endedBySystem: true }),
      });
      if (this.recording.session !== session) return;
      this.recording.preparing = false;
      this.recording.active = true;
      this.dom.recordLabel.textContent = '停止';
      this.dom.discardBtn.disabled = false;
      this.updateControls();
      if (mode === 'mic') this.refreshDevices();
    } catch (err) {
      if (this.recording.session !== session) return;
      this.resetRecordingState();
      showToast(this.friendlyRecordError(err, mode), { type: 'error', duration: 5000 });
    }
  }

  async stopRecording({ auto = false, endedBySystem = false } = {}) {
    if (this.recording.stopping) return;
    if (!this.recording.active) return;
    const session = this.recording.session;
    this.recording.stopping = true;
    this.dom.recordLabel.textContent = '处理中…';
    this.dom.discardBtn.disabled = true;
    this.dom.recHint.textContent = '正在生成素材…';
    this.updateControls();

    try {
      const result = await this.recorder.stop();
      if (this.recording.session !== session) return;
      if (!result) throw new Error('录音没有产生数据');

      let buffer = result.buffer;
      if (result.kind === 'demo') {
        const take = Math.min(result.elapsed, result.buffer.duration);
        if (take < 0.12) throw new Error('录制时间太短');
        const length = Math.max(1, Math.round(take * result.buffer.sampleRate));
        const out = this.engine.context().createBuffer(result.buffer.numberOfChannels, length, result.buffer.sampleRate);
        for (let c = 0; c < result.buffer.numberOfChannels; c++) {
          out.copyToChannel(result.buffer.getChannelData(c).subarray(0, length), c);
        }
        buffer = out;
      }
      if (!buffer || buffer.duration < 0.05) throw new Error('录制时间太短');

      const asset = this.buildAsset({ name: this.nextRecordingName(), buffer });
      this.assets.push(asset);
      this.resetRecordingState();
      this.renderAssetList();
      this.selectAsset(asset.id, { scroll: true });
      if (auto) showToast(`已达到 ${MAX_RECORD_SECONDS / 60} 分钟上限，录音已保存为素材`);
      else if (endedBySystem) showToast('共享已结束，录音已保存为素材');
    } catch (err) {
      if (this.recording.session !== session) return;
      this.resetRecordingState();
      showToast(err.message || '录音失败', { type: 'error', duration: 5000 });
    }
  }

  resetRecordingState() {
    this.recording.session++;
    this.recording.active = false;
    this.recording.preparing = false;
    this.recording.stopping = false;
    this.recording.mode = null;
    this.recording.elapsed = 0;
    this.dom.recordOverlay.classList.add('hidden');
    this.dom.recTime.classList.add('hidden');
    this.dom.recordBtn.classList.remove('is-recording');
    this.dom.recordLabel.textContent = '录制';
    this.dom.discardBtn.disabled = false;
    this.dom.recHint.textContent = '再次点击「停止」结束录制';
    this.live.reset();
    this.meter.reset();
    this.updateControls();
    this.updateTimeReadout();
  }

  async discardRecording() {
    if (!this.recording.active || this.recording.stopping) return;
    const ok = await confirmDialog({
      title: '放弃这次录音？',
      message: '已经录下的内容不会保留。',
      confirmLabel: '放弃',
      danger: true,
    });
    if (!ok) return;
    this.recorder.discard();
    this.resetRecordingState();
    showToast('已放弃本次录音');
  }

  /* =========================================================
   * pack management
   * ======================================================= */

  setPack(name) {
    if (!this.packs.some((pack) => pack.name === name) || name === this.packName) return;
    this.packName = name;
    this.scanVoices().then(() => {
      this.renderTargetPacks();
      this.renderBoard();
      this.updateControls();
    });
  }

  switchPack(name) {
    if (this.isBusy()) {
      showToast('正在录制或处理，稍后再切换语音包', { type: 'error' });
      return;
    }
    this.setPack(name);
  }

  /// 语音包是目录，人在资源管理器里改完，回到窗口就该看见。
  async refreshPacks() {
    if (!this._initialized) return;
    const ok = await this.scanPacks();
    if (!ok) return;
    this.renderTargetPacks();
    this.renderBoard();
    this.updateControls();
  }

  /// 在资源管理器里打开当前包（没有当前包时打开根目录）。
  async revealPack() {
    try {
      await packStore.reveal(this.packName ? `${this.packName}/` : null);
    } catch (err) {
      showToast(err?.message || '打不开目录', { type: 'error', duration: 5000 });
    }
  }

  async revealVoice(voice) {
    if (!voice) return;
    try {
      await packStore.reveal(voice.path);
    } catch (err) {
      showToast(err?.message || '打不开目录', { type: 'error', duration: 5000 });
    }
  }

  /// 浏览器回退没有目录可打开，把文件本身下下来就是出口。
  async downloadVoice(voice) {
    if (!voice) return;
    try {
      const bytes = await packStore.read(voice);
      downloadBlob(new Blob([bytes], { type: 'audio/wav' }), voice.file);
    } catch (err) {
      showToast(`读不了这个文件：${err?.message || err}`, { type: 'error', duration: 5000 });
    }
  }

  /// 根目录是设置，不是包内容：换目录后整个语音板就是另一个库了，所以先确认。
  async choosePackRoot() {
    const info = await packStore.rootInfo().catch(() => ({ root: '', defaultRoot: '' }));
    const path = await promptDialog({
      title: '语音包根目录',
      label: '路径',
      value: info.root,
      hint: '根目录下每个文件夹是一个语音包。换到这里后，语音板显示这个目录里的内容；原目录的文件不会被移动。',
      confirmLabel: '切换',
      validate: (v) => (!v ? '路径不能为空' : (!/^[a-zA-Z]:[\\/]/.test(v) ? '请填写完整路径，比如 D:\\语音包' : '')),
    });
    if (!path || path === info.root) return;
    try {
      const applied = await packStore.setRoot(path);
      this.packName = '';
      await this.scanPacks();
      this.renderTargetPacks();
      this.renderBoard();
      this.updateControls();
      showToast(`语音包根目录已切到 ${applied}`, { duration: 5000 });
    } catch (err) {
      showToast(`切换失败：${err.message || err}`, { type: 'error', duration: 6000 });
    }
  }

  /// 换包 = 把文件挪到另一个文件夹。
  moveVoiceToPack(voice, anchor) {
    if (!voice || this.isBusy()) return;
    const others = this.packs.filter((pack) => pack.name !== voice.pack);
    if (!others.length) return;
    openMenu(anchor || this.dom.boardPackBtn, others.map((pack) => ({
      label: pack.name,
      icon: 'folder',
      onClick: async () => {
        try {
          await packStore.move(voice.path, `${pack.name}/${voice.file}`);
        } catch (err) {
          showToast(`移动失败：${err.message || err}`, { type: 'error', duration: 6000 });
          return;
        }
        const from = voiceKey(voice.pack, voice.name);
        const to = voiceKey(pack.name, voice.name);
        if (this.hotkeys[from]) {
          this.hotkeys[to] = this.hotkeys[from];
          delete this.hotkeys[from];
        }
        if (this.voicePlay?.voice.path === voice.path) this.stopVoicePlayback();
        await this.scanPacks();
        this.renderTargetPacks();
        this.renderBoard();
        showToast(`已把「${voice.name}」移到「${pack.name}」`);
      },
    })));
  }

  async newPack() {
    if (this.isBusy()) return;
    const name = await promptDialog({
      title: '新建语音包',
      label: '名称',
      value: `语音包 ${this.packs.length + 1}`,
      placeholder: '例如：游戏语音',
      hint: '在语音包根目录下新建一个同名文件夹。',
      confirmLabel: '创建',
      validate: (v) => (!v
        ? '名称不能为空'
        : (this.packs.some((p) => p.name.toLowerCase() === sanitizeName(v).toLowerCase()) ? '已有同名语音包' : '')),
    });
    if (!name) return;
    try {
      await packStore.createPack(name);
    } catch (err) {
      showToast(`建不了语音包：${err.message || err}`, { type: 'error', duration: 6000 });
      return;
    }
    await this.scanPacks();
    this.packName = sanitizeName(name);
    await this.scanVoices();
    this.renderTargetPacks();
    this.renderBoard();
    this.updateControls();
    showToast(`已创建「${this.packName}」`);
  }

  async renameCurrentPack() {
    const pack = this.currentPack();
    if (!pack || this.isBusy()) return;
    const name = await promptDialog({
      title: '重命名语音包',
      label: '名称',
      value: pack.name,
      confirmLabel: '保存',
      validate: (v) => (!v
        ? '名称不能为空'
        : (this.packs.some((p) => p.name !== pack.name && p.name.toLowerCase() === sanitizeName(v).toLowerCase())
          ? '已有同名语音包' : '')),
    });
    if (!name) return;
    try {
      await packStore.renamePack(pack.name, name);
    } catch (err) {
      showToast(`重命名失败：${err.message || err}`, { type: 'error', duration: 6000 });
      return;
    }
    // 热键按「包名/语音名」记，包改名后整段前缀搬过去。
    const from = `${pack.name}/`;
    const to = `${sanitizeName(name)}/`;
    for (const key of Object.keys(this.hotkeys)) {
      if (key.startsWith(from)) {
        this.hotkeys[to + key.slice(from.length)] = this.hotkeys[key];
        delete this.hotkeys[key];
      }
    }
    this.packName = to.slice(0, -1);
    await this.scanPacks();
    this.renderTargetPacks();
    this.renderBoard();
  }

  /// 「清空整个会话」只清素材和热键：语音包是用户目录里的文件，不该由这个动作删掉。
  async clearSession() {
    if (this.isBusy()) {
      showToast('正在录制或处理，稍后再试', { type: 'error' });
      return;
    }
    const assets = this.assets.length;
    const bound = Object.keys(this.hotkeys).length;
    if (!assets && !bound) {
      showToast('当前会话已经是空的');
      return;
    }
    const ok = await confirmDialog({
      title: '清空整个会话',
      message: `将删除 ${assets} 段素材和 ${bound} 个热键绑定，连同本机已保存的副本。语音包文件夹里的音频不动。这一步不能撤销。`,
      confirmLabel: '清空',
      danger: true,
    });
    if (!ok) return;
    this.stopAll();
    this.assets = [];
    this.asset = null;
    this.selectedAssetId = null;
    this.waveAsset = null;
    this.history = new Map();
    this.hotkeys = {};
    for (const voice of this.voices) voice.hotkey = '';
    try {
      await this.session.clear();
    } catch (err) {
      showToast(`界面已清空，但本机副本没删掉：${err?.message || err}`, { type: 'error', duration: 6000 });
    }
    this.renderTargetPacks();
    this.renderAssetList();
    this.renderBoard();
    this.updateControls();
    this.setView('edit');
    showToast('会话已清空');
  }

  async deleteCurrentPack() {
    const pack = this.currentPack();
    if (!pack || this.isBusy()) {
      showToast('正在录制或处理，稍后再试', { type: 'error' });
      return;
    }
    if (this.packs.length <= 1) {
      showToast('至少保留一个语音包');
      return;
    }
    const ok = await confirmDialog({
      title: '删除语音包',
      message: pack.voices
        ? `将删除文件夹「${pack.name}」和里面的 ${pack.voices} 条语音。这一步不能撤销。`
        : `将删除空文件夹「${pack.name}」。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    if (this.voicePlay?.voice.pack === pack.name) this.stopVoicePlayback();
    try {
      await packStore.deletePack(pack.name, true);
    } catch (err) {
      showToast(`删除失败：${err.message || err}`, { type: 'error', duration: 6000 });
      return;
    }
    for (const key of Object.keys(this.hotkeys)) {
      if (key.startsWith(`${pack.name}/`)) delete this.hotkeys[key];
    }
    this.packName = '';
    await this.scanPacks();
    this.renderTargetPacks();
    this.renderBoard();
    this.updateControls();
    showToast(`已删除「${pack.name}」`);
  }

  /* =========================================================
   * import / export
   * ======================================================= */

  async importAudioFiles(files) {
    if (!files.length) return;
    this._busyImporting = true;
    this.updateControls();
    const close = showToast('正在导入素材…', { duration: 20000 });
    const created = [];
    const errors = [];
    for (const file of files) {
      try {
        const bytes = await file.arrayBuffer();
        const buffer = await this.engine.decode(bytes);
        if (!buffer || buffer.duration < 0.02) throw new Error('音频太短');
        const base = file.name.replace(/\.[^.]+$/, '').trim() || '导入素材';
        const asset = this.buildAsset({ name: this.uniqueAssetName(base.slice(0, 60)), buffer });
        this.assets.push(asset);
        created.push(asset);
      } catch (err) {
        errors.push({ name: file.name, message: err?.message || '无法解码' });
      }
    }
    this._busyImporting = false;
    close();
    this.renderAssetList();
    if (created.length) this.selectAsset(created[created.length - 1].id, { scroll: true });
    if (errors.length) {
      showToast(
        created.length
          ? `已导入 ${created.length} 个，${errors.length} 个失败`
          : `导入失败：${errors[0].name} · ${errors[0].message}`,
        { type: 'error', duration: 6000 },
      );
    } else {
      showToast(created.length > 1 ? `已导入 ${created.length} 个素材` : `已导入「${created[0].name}」`);
    }
    this.updateControls();
  }

  async handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (this.isBusy()) {
      showToast('正在录制或处理，稍后再导入', { type: 'error' });
      return;
    }
    const audioFiles = files.filter((f) => (
      f.type.startsWith('audio/')
      || /\.(wav|mp3|flac|ogg|oga|m4a|aac|webm|opus)$/i.test(f.name)
    ));
    if (!audioFiles.length) {
      showToast('没有可导入的音频文件', { type: 'error' });
      return;
    }
    await this.importAudioFiles(audioFiles);
  }

  async exportCurrentAsset() {
    if (!this.asset || this.isBusy()) return;
    openExportClipDialog(this, this.asset);
  }

  /* =========================================================
   * devices
   * ======================================================= */

  setAppSource(def) {
    this.appSource = def;
    this.renderSourceControls();
  }

  async refreshMicDevices() {
    if (isNative) {
      let devices = [];
      try { devices = await invoke('list_input_devices'); } catch { devices = []; }
      const select = this.dom.micSelect;
      const previous = this.micDeviceId;
      const options = [];
      const def = document.createElement('option');
      def.value = '';
      def.textContent = '默认麦克风';
      options.push(def);
      devices.forEach((device) => {
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = device.name || '麦克风';
        options.push(option);
      });
      if (!devices.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '未找到麦克风';
        options.push(option);
      }
      select.replaceChildren(...options);
      this.micDeviceId = devices.some((d) => d.id === previous) ? previous : '';
      select.value = this.micDeviceId;
      return;
    }
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const select = this.dom.micSelect;
    const previous = this.micDeviceId;
    const options = [];
    const def = document.createElement('option');
    def.value = '';
    def.textContent = '默认麦克风';
    options.push(def);
    mics.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `麦克风 ${index + 1}`;
      options.push(option);
    });
    if (!mics.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '未找到麦克风';
      options.push(option);
    }
    select.replaceChildren(...options);
    const exists = mics.some((d) => d.deviceId === previous);
    this.micDeviceId = exists ? previous : '';
    select.value = this.micDeviceId;
  }

  async refreshOutputs() {
    const select = this.dom.outputSelect;
    if (isNative) {
      let devices = [];
      try { devices = await invoke('list_output_devices'); } catch { devices = []; }
      const options = [];
      const def = document.createElement('option');
      def.value = '';
      def.textContent = '系统默认';
      options.push(def);
      devices.forEach((device) => {
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = device.name || '输出设备';
        options.push(option);
      });
      select.replaceChildren(...options);
      if (!devices.some((d) => d.id === this.outputId)) this.outputId = '';
      select.value = this.outputId;
      this.updateOutputUI();
      return;
    }
    if (!this.engine.sinkSupported) {
      select.disabled = true;
      select.title = '当前环境不支持独立选择输出设备';
      return;
    }
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    const options = [];
    const def = document.createElement('option');
    def.value = '';
    def.textContent = '系统默认';
    options.push(def);
    outputs.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `输出设备 ${index + 1}`;
      options.push(option);
    });
    select.replaceChildren(...options);
    if (!outputs.some((d) => d.deviceId === this.outputId)) this.outputId = '';
    select.value = this.outputId;
    this.updateOutputUI();
  }

  updateOutputUI() {
    const select = this.dom.outputSelect;
    if (!isNative && !this.engine.sinkSupported) {
      select.disabled = true;
      select.title = '当前环境不支持独立选择输出设备';
    } else {
      select.disabled = false;
      select.title = '';
      select.value = this.outputId;
    }
  }

  async setOutput(value) {
    if (isNative) {
      try {
        await invoke('set_output_device', { deviceId: value || null });
        this.outputId = value || '';
        this.dom.outputSelect.value = this.outputId;
      } catch (err) {
        showToast(`无法切换输出设备：${err.message || '系统拒绝'}`, { type: 'error', duration: 5000 });
        this.dom.outputSelect.value = this.outputId;
      }
      return;
    }
    const previous = this.outputId;
    this.stopAll();
    try {
      await this.engine.setSink(value);
      this.outputId = value || '';
      this.dom.outputSelect.value = this.outputId;
    } catch (err) {
      this.outputId = previous;
      this.dom.outputSelect.value = previous;
      showToast(`无法切换输出设备：${err.message || '系统拒绝'}`, { type: 'error', duration: 5000 });
    }
  }

  async refreshDevices() {
    await this.refreshMicDevices();
    await this.refreshOutputs();
  }

  /* =========================================================
   * events
   * ======================================================= */

  wireEvents() {
    this.dom.viewSwitch.addEventListener('click', (event) => {
      const btn = event.target.closest('.seg-btn');
      if (!btn) return;
      this.setView(btn.dataset.view);
    });

    this.dom.boardPackBtn.addEventListener('click', () => openPackMenu(this, this.dom.boardPackBtn));
    this.dom.importBtn.addEventListener('click', () => {
      if (this.isBusy()) return;
      this.dom.fileInput.value = '';
      this.dom.fileInput.click();
    });
    this.dom.fileInput.addEventListener('change', () => {
      const files = Array.from(this.dom.fileInput.files || []);
      this.dom.fileInput.value = '';
      if (files.length) this.handleFiles(files);
    });
    this.dom.sourceSeg.addEventListener('click', (event) => {
      const btn = event.target.closest('.seg-btn');
      if (!btn || this.isBusy() || this.recording.active) return;
      this.sourceMode = btn.dataset.mode;
      this.renderSourceControls();
      this.updateControls();
    });
    this.dom.micSelect.addEventListener('change', () => {
      this.micDeviceId = this.dom.micSelect.value;
    });
    this.dom.appPickBtn.addEventListener('click', () => {
      if (this.isBusy()) return;
      openAppPicker(this);
    });
    this.dom.recordBtn.addEventListener('click', () => {
      if (this.recording.preparing || this.recording.stopping) return;
      if (this.recording.active) this.stopRecording();
      else this.startRecording();
    });
    this.dom.discardBtn.addEventListener('click', () => this.discardRecording());

    this.dom.assetList.addEventListener('click', (event) => {
      const row = event.target.closest('.clip-row');
      if (!row) return;
      const asset = this.findAsset(row.dataset.assetId);
      if (!asset) return;
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'more') {
        openAssetMenu(this, asset, event.target.closest('[data-action]'));
        return;
      }
      if (action === 'play') {
        const wasSelected = this.asset?.id === asset.id;
        const wasPlaying = wasSelected && this.transport.playing;
        this.stopVoicePlayback();
        if (!wasSelected) this.selectAsset(asset.id);
        this.dom.assetList.focus({ preventScroll: true });
        if (wasPlaying) this.pausePlayback();
        else this.play();
        return;
      }
      this.stopVoicePlayback();
      this.selectAsset(asset.id);
      this.dom.assetList.focus({ preventScroll: true });
    });

    this.dom.assetList.addEventListener('scroll', () => {
      if (this._listRaf) return;
      this._listRaf = requestAnimationFrame(() => {
        this._listRaf = 0;
        this.renderVisibleAssetRows();
      });
    }, { passive: true });

    this.dom.assetList.addEventListener('keydown', (event) => {
      const items = this.visibleAssets();
      if (!items.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const index = items.findIndex((a) => a.id === this.selectedAssetId);
        const next = event.key === 'ArrowDown'
          ? (index < 0 ? 0 : Math.min(items.length - 1, index + 1))
          : (index < 0 ? items.length - 1 : Math.max(0, index - 1));
        if (this.isBusy()) return;
        this.selectAsset(items[next].id, { scroll: true });
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        if (this.isBusy()) return;
        this.selectAsset(event.key === 'Home' ? items[0].id : items[items.length - 1].id, { scroll: true });
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        if (!this.selectedAssetId) {
          if (!this.isBusy()) this.selectAsset(items[0].id, { scroll: true });
        } else {
          this.togglePlayback();
        }
      }
    });

    this.dom.assetSearchInput.addEventListener('input', () => {
      this.assetSearch = this.dom.assetSearchInput.value;
      this.renderAssetList();
    });

    this.dom.assetTitle.addEventListener('focus', () => {
      this._titleBefore = this.asset?.name || '';
    });
    this.dom.assetTitle.addEventListener('blur', () => this.renameAssetCommit());
    this.dom.assetTitle.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.dom.assetTitle.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.dom.assetTitle.value = this._titleBefore;
        this.dom.assetTitle.blur();
      }
    });

    this.dom.trimBtn.addEventListener('click', () => this.trimSelection());
    this.dom.deleteSelBtn.addEventListener('click', () => this.deleteSelection());
    this.dom.undoBtn.addEventListener('click', () => this.undo());
    this.dom.redoBtn.addEventListener('click', () => this.redo());
    this.dom.fitBtn.addEventListener('click', () => { if (!this.isBusy()) this.waveform.fit(); });
    this.dom.zoomInBtn.addEventListener('click', () => { if (!this.isBusy()) this.waveform.zoomBy(1.4, this.waveform.width / 2); });
    this.dom.zoomOutBtn.addEventListener('click', () => { if (!this.isBusy()) this.waveform.zoomBy(1 / 1.4, this.waveform.width / 2); });
    this.dom.moreBtn.addEventListener('click', () => {
      if (this.asset) openAssetMenu(this, this.asset, this.dom.moreBtn);
    });

    this.dom.playBtn.addEventListener('click', () => this.togglePlayback());
    this.dom.stopBtn.addEventListener('click', () => this.stopPlayback({ reset: true }));
    this.dom.loopBtn.addEventListener('click', () => { if (!this.isBusy()) this.toggleLoop(); });

    this.dom.gainInput.addEventListener('input', () => this.updateEditWarning());
    this.dom.gainInput.addEventListener('change', () => this.commitGain());
    this.dom.fadeInInput.addEventListener('change', () => this.commitFade('in'));
    this.dom.fadeOutInput.addEventListener('change', () => this.commitFade('out'));
    this.dom.targetPackSelect.addEventListener('change', () => {
      this.setPack(this.dom.targetPackSelect.value);
    });
    this.dom.normalizeBtn.addEventListener('click', () => this.normalizeAsset());
    this.dom.silenceBtn.addEventListener('click', () => this.trimSilence());
    this.dom.resetBtn.addEventListener('click', () => this.resetEdits());
    this.dom.exportBtn.addEventListener('click', () => this.exportCurrentAsset());
    this.dom.saveWholeBtn.addEventListener('click', () => this.saveVoiceFromAsset({ selectionOnly: false }));
    this.dom.saveSelBtn.addEventListener('click', () => this.saveVoiceFromAsset({ selectionOnly: true }));

    this.dom.boardSearch.addEventListener('input', () => {
      this.voiceSearch = this.dom.boardSearch.value;
      this.renderBoard();
    });

    this.dom.layoutToggle.addEventListener('click', (event) => {
      const btn = event.target.closest('.layout-btn');
      if (!btn) return;
      this.boardLayout = btn.dataset.layout;
      this.renderBoardTools();
    });

    this.dom.voiceGrid.addEventListener('click', (event) => {
      const tile = event.target.closest('.voice-tile');
      if (!tile) return;
      const voice = this.findVoice(tile.dataset.voicePath);
      if (!voice) return;
      if (event.target.closest('[data-action="more"]')) {
        openVoiceMenu(this, voice, event.target.closest('[data-action="more"]'));
        return;
      }
      this.stopPlayback({ reset: true });
      this.playVoice(voice);
    });

    this.dom.voiceGrid.addEventListener('keydown', (event) => {
      const tiles = $$('.voice-tile', this.dom.voiceGrid);
      if (!tiles.length) return;
      const current = event.target.closest('.voice-tile');
      const index = tiles.findIndex((t) => t === current);
      if (event.key === 'Enter' || event.key === ' ') {
        if (index < 0) return;
        event.preventDefault();
        const voice = this.findVoice(tiles[index].dataset.voicePath);
        if (voice) {
          this.stopPlayback({ reset: true });
          this.playVoice(voice);
        }
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const columns = this.boardLayout === 'list'
        ? 1
        : (getComputedStyle(this.dom.voiceGrid).gridTemplateColumns.split(' ').length || 1);
      let next = index < 0 ? 0 : index;
      if (event.key === 'ArrowRight') next = Math.min(tiles.length - 1, next + 1);
      else if (event.key === 'ArrowLeft') next = Math.max(0, next - 1);
      else if (event.key === 'ArrowDown') next = Math.min(tiles.length - 1, next + columns);
      else if (event.key === 'ArrowUp') next = Math.max(0, next - columns);
      else if (event.key === 'Home') next = 0;
      else next = tiles.length - 1;
      tiles[next].focus();
    });

    this.dom.boardEmptyAction.addEventListener('click', () => {
      if (this.voiceSearch) {
        this.voiceSearch = '';
        this.dom.boardSearch.value = '';
        this.renderBoard();
        return;
      }
      this.setView('edit');
    });

    this.dom.outputSelect.addEventListener('change', () => this.setOutput(this.dom.outputSelect.value));
    this.dom.aboutBtn.addEventListener('click', () => openAbout(this));

    document.addEventListener('keydown', (event) => this.onKeyDown(event));
    document.addEventListener('dragenter', (event) => this.onDragEnter(event));
    document.addEventListener('dragover', (event) => this.onDragOver(event));
    document.addEventListener('dragleave', (event) => this.onDragLeave(event));
    document.addEventListener('drop', (event) => this.onDrop(event));
    window.addEventListener('resize', () => {
      cancelAnimationFrame(this._listRaf);
      this._listRaf = requestAnimationFrame(() => {
        this._listRaf = 0;
        if (this.view === 'edit') this.renderVisibleAssetRows();
      });
    });
    // 语音包是目录：在资源管理器里改完，回到窗口就重新扫一遍。弹窗或菜单开着时不动，免得打断操作。
    const rescan = () => {
      if (document.querySelector('.modal-backdrop') || document.querySelector('.menu')) return;
      this.refreshPacks();
    };
    addEventListener('focus', rescan);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) rescan();
    });
    window.addEventListener('beforeunload', (event) => {
      if (this.recording.active || this.recording.preparing) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.refreshDevices());
  }

  onKeyDown(event) {
    if (event.defaultPrevented) return;
    if (document.querySelector('.modal-backdrop') || document.querySelector('.menu')) return;
    const typing = isTypingTarget(event.target);
    if (typing) {
      if (event.key === 'Escape') event.target.blur();
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    for (const voice of this.currentVoices()) {
      if (matchHotkey(event, voice.hotkey)) {
        event.preventDefault();
        this.stopAll();
        this.playVoice(voice);
        return;
      }
    }

    if (key === 'Escape' && this.voicePlay) {
      event.preventDefault();
      this.stopVoicePlayback();
      return;
    }

    if (this.view !== 'edit' || this.isBusy()) return;

    if (mod && lower === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && lower === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (mod && lower === 's') {
      event.preventDefault();
      if (!isNative) {
        showToast('浏览器回退不落盘，请用「导出语音包」', { duration: 4000 });
        return;
      }
      this.session.flush()
        .then(() => showToast('已保存到本机', { duration: 1600 }))
        .catch((err) => showToast(`保存失败：${err?.message || err}`, { type: 'error', duration: 5000 }));
      return;
    }
    if (mod && lower === 'e') {
      event.preventDefault();
      this.exportCurrentAsset();
      return;
    }
    if (key === ' ' || event.code === 'Space') {
      if (this.asset) {
        event.preventDefault();
        this.togglePlayback();
      }
      return;
    }
    if (!mod && lower === 'r') {
      event.preventDefault();
      if (this.recording.active) this.stopRecording();
      else this.startRecording();
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      if (this.asset?.selection) {
        event.preventDefault();
        this.deleteSelection();
      }
      return;
    }
    if (key === 'F2') {
      if (this.asset) {
        event.preventDefault();
        this.focusTitle();
      }
      return;
    }
    if (key === 'Escape') {
      if (this.asset?.selection) {
        event.preventDefault();
        this.clearSelectionOnly();
      }
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (this.asset) {
        event.preventDefault();
        const delta = (event.shiftKey ? 0.01 : 0.1) * (key === 'ArrowLeft' ? -1 : 1);
        this.seekBy(delta);
      }
      return;
    }
    if (key === 'Home' || key === 'End') {
      if (this.asset) {
        event.preventDefault();
        this.seekTo(key === 'Home' ? 0 : this.asset.duration);
      }
      return;
    }
  }

  onDragEnter(event) {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    this._dropDepth++;
    this.dom.dropVeil.classList.remove('hidden');
  }

  onDragOver(event) {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  onDragLeave(event) {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    if (event.relatedTarget === null) {
      this._dropDepth = 0;
      this.dom.dropVeil.classList.add('hidden');
    }
  }

  onDrop(event) {
    if (!event.dataTransfer) return;
    event.preventDefault();
    this._dropDepth = 0;
    this.dom.dropVeil.classList.add('hidden');
    const files = event.dataTransfer.files;
    if (files?.length) this.handleFiles(files);
  }
}
