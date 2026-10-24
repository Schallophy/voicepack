# VoicePack

录音 · 剪辑 · 语音包。把游戏/应用的声音、麦克风录下来，剪成一条条语音，点一下（或按热键）就播。

- **素材**：原始录音或导入的音频；非破坏剪辑（裁剪/删除/增益/淡入淡出/归一化/去静音，撤销重做）。
- **语音**：保存整段或选区即成为独立个体，与素材再无关联；可设页面内热键。
- **语音包**：语音包根目录（默认 `文档\语音包`，可改）下的**一个文件夹**；里面**一个音频文件就是一条语音，文件名就是语音名**。保存时把选好的段落连同增益和淡变烘进采样，写成 24-bit WAV。

所以这套东西没有自定义的包文件格式：在资源管理器里复制、改名、丢一个 WAV 进去，回到软件刷新一下就看见；反过来，把某个包文件夹压成 zip 发给别人，就是分发。热键是界面绑定，按「包名/语音名」记在本机，不跟着音频文件走。

桌面端为 Tauri 2 + Rust：采集（麦克风 / 按进程回环，复用 [MicDeck]）与播放输出（WASAPI，可选输出设备）都在原生层；剪辑、波形、语音包管理在 WebView 内完成。**素材实时保存在本机**（`%LOCALAPPDATA%\com.schallophy.voicepack\session`：一份 `state.json` + 每段素材一个不可变的 f32 音频块），关掉软件、进程被杀都不丢，重启接着剪；语音本来就在磁盘上。全程不联网、不上传。浏览器回退不落盘，关掉页面就清空。

## 开发

```bash
npm install
npm run tauri dev     # 桌面版（Rust 采集/播放）
npm start             # 仅前端（浏览器回退：Web Audio 播放、演示应用音源），http://127.0.0.1:4178/
```

- Rust 侧依赖同级的 `../micdeck`（lib 目标名 `micdeck_lib`）。
- 语音包目录层在 `src-tauri/src/packs.rs`：根目录是 Rust 侧的设置（`settings.json`），路径拼接只允许根目录以内的相对片段，读写走长度前缀的 raw body（中文路径装不进 HTTP 头）。
- 单实例守卫（`tauri-plugin-single-instance`）：会话存储只允许一个写者，第二次启动会把已有窗口叫到前面。
- 前端是无打包器的原生 ES modules；`ui/js/native.js` 按运行环境自动选择原生命令或 Web Audio 回退，`ui/js/packs.js` 同理在真实目录与内存实现之间切换。

## 测试

回归靠三套 CDP 脚本（放在本地 `_test/`，不随仓库发布）：浏览器回退 34 例、桌面冒烟 8 例、目录格式真机重启 9 例。前两套需要一个开着调试端口的浏览器：

```bash
python -m http.server 4178 --directory ui                       # 静态前端
node _test/run.mjs            # 9333：Edge --remote-debugging-port=9333 --use-fake-device-for-media-stream
node _test/native_smoke.mjs   # 9334：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9334 voicepack.exe
node _test/native_persist.mjs # 自己起进程、杀进程，把语音包根目录临时借到 _test 下面
```

[MicDeck]: https://github.com/Schallophy/micdeck

## 许可

MIT，见 [LICENSE](LICENSE)。
