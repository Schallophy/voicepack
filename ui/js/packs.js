// 语音包 = 根目录下的一个文件夹；一条语音 = 里面的一个音频文件，文件名就是语音名。
// 原生走真实目录（Rust 的 packs 命令），浏览器回退用同一套接口的内存实现：界面逻辑只有一套，
// 回归测试也能覆盖到目录语义（重名、改名、外部丢文件）。

import { isNative, invoke } from './native.js';

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
export const DEFAULT_PACK = '默认语音包';

export function sanitizeName(name) {
  let out = String(name ?? '').replace(ILLEGAL, '·').trim().slice(0, 80).replace(/[. ]+$/, '');
  return out || '语音';
}

/// 语音一律写成 WAV；名字里已经带 .wav 就不重复。
export function voiceFile(name) {
  const stem = sanitizeName(name);
  return /\.wav$/i.test(stem) ? stem : `${stem}.wav`;
}

export function voiceKey(pack, name) {
  return `${pack}/${name}`;
}

export function keyOf(path) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

class DirStore {
  async rootInfo() {
    const info = await invoke('pack_root_info');
    return { root: info.root, defaultRoot: info.default };
  }

  setRoot(path) {
    return invoke('set_pack_root', { path });
  }

  async listPacks() {
    return (await invoke('list_packs')).map((row) => ({ name: row.name, voices: row.voices }));
  }

  async listVoices(pack) {
    const rows = await invoke('list_pack_voices', { pack });
    return rows.map((row) => ({
      pack,
      name: row.name,
      file: row.file,
      path: `${pack}/${row.file}`,
      size: row.size,
      durationMs: row.durationMs ?? null,
      sampleRate: row.sampleRate ?? null,
      channels: row.channels ?? null,
    }));
  }

  read(voice) {
    return invoke('read_voice_file', { path: voice.path });
  }

  /// raw body = [u32 路径字节数][路径 UTF-8][文件内容]；路径有中文，HTTP 头装不下。
  async write(path, bytes) {
    const encoded = new TextEncoder().encode(path);
    const frame = new ArrayBuffer(4 + encoded.length + bytes.byteLength);
    new DataView(frame).setUint32(0, encoded.length, true);
    new Uint8Array(frame, 4, encoded.length).set(encoded);
    new Uint8Array(frame, 4 + encoded.length).set(bytes);
    return invoke('write_voice_file', frame);
  }

  move(from, to) {
    return invoke('move_voice_file', { from, to });
  }

  remove(path) {
    return invoke('delete_voice_file', { path });
  }

  createPack(name) {
    return invoke('create_pack', { name: sanitizeName(name) });
  }

  renamePack(from, to) {
    return invoke('rename_pack', { from, to: sanitizeName(to) });
  }

  deletePack(name, force = false) {
    return invoke('delete_pack', { name, force });
  }

  reveal(path = null) {
    return invoke('reveal_in_explorer', { path });
  }
}

class MemoryStore {
  constructor() {
    this.packs = new Map([[DEFAULT_PACK, new Map()]]);
    this.root = '(内存)';
  }

  async rootInfo() {
    return { root: this.root, defaultRoot: this.root };
  }

  async setRoot() {
    throw new Error('浏览器回退没有语音包目录');
  }

  async listPacks() {
    return [...this.packs.entries()]
      .map(([name, files]) => ({ name, voices: files.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listVoices(pack) {
    const files = this.packs.get(pack);
    if (!files) throw new Error(`语音包「${pack}」不在了`);
    return [...files.entries()]
      .map(([file, bytes]) => ({
        pack,
        name: file.replace(/\.wav$/i, ''),
        file,
        path: `${pack}/${file}`,
        size: bytes.byteLength,
        durationMs: null,
        sampleRate: null,
        channels: null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(voice) {
    const bytes = this.packs.get(voice.pack)?.get(voice.file);
    if (!bytes) throw new Error(`语音「${voice.name}」不在了`);
    return bytes.slice().buffer;
  }

  async write(path, bytes) {
    const slash = path.indexOf('/');
    const pack = path.slice(0, slash);
    const file = path.slice(slash + 1);
    const files = this.packs.get(pack);
    if (!files) throw new Error(`语音包「${pack}」不在了`);
    if (files.has(file)) throw new Error('这个包里已经有同名语音');
    files.set(file, bytes.slice());
    return path;
  }

  async move(from, to) {
    const split = (path) => {
      const slash = path.indexOf('/');
      return [path.slice(0, slash), path.slice(slash + 1)];
    };
    const [fromPack, fromFile] = split(from);
    const [toPack, toFile] = split(to);
    const source = this.packs.get(fromPack);
    const target = this.packs.get(toPack);
    if (!source?.has(fromFile)) throw new Error('源文件不在了');
    if (!target) throw new Error(`语音包「${toPack}」不在了`);
    if (target.has(toFile)) throw new Error('目标位置已经有同名语音');
    target.set(toFile, source.get(fromFile));
    source.delete(fromFile);
    return to;
  }

  async remove(path) {
    const slash = path.indexOf('/');
    this.packs.get(path.slice(0, slash))?.delete(path.slice(slash + 1));
  }

  async createPack(name) {
    const pack = sanitizeName(name);
    if (this.packs.has(pack)) throw new Error('已经有同名语音包');
    this.packs.set(pack, new Map());
    return pack;
  }

  async renamePack(from, to) {
    const pack = sanitizeName(to);
    const files = this.packs.get(from);
    if (!files) throw new Error('语音包不在了');
    if (this.packs.has(pack)) throw new Error('已经有同名语音包');
    this.packs.delete(from);
    this.packs.set(pack, files);
    return pack;
  }

  async deletePack(name) {
    this.packs.delete(name);
  }

  async reveal() {
    throw new Error('浏览器回退没有可打开的目录');
  }
}

export const packs = isNative ? new DirStore() : new MemoryStore();
