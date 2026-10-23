# VoicePack

录音 · 剪辑 · 语音包。把游戏/应用的声音、麦克风录下来，剪成一条条语音，点一下（或按热键）就播。

- **素材**：原始录音或导入的音频；非破坏剪辑（裁剪/删除/增益/淡入淡出/归一化/去静音，撤销重做）。
- **语音**：保存整段或选区即成为独立个体，与素材再无关联；可设页面内热键。
- **语音包**：语音分组；导出为 ZIP（schema v3：每条语音一个 24-bit WAV），可直接再导入。

桌面端为 Tauri 2 + Rust：采集（麦克风 / 按进程回环，复用 [MicDeck]）与播放输出（WASAPI，可选输出设备）都在原生层；剪辑、波形、语音包管理在 WebView 内完成。素材和语音**实时保存在本机**（`%LOCALAPPDATA%\com.schallophy.voicepack\session`：一份 `state.json` + 每条素材/语音一个不可变的 f32 音频块），不联网、不上传；「导出 / 导入语音包」是拿给别人用的分发格式，不是备份手段。浏览器回退仍然不落盘。

## 开发

```bash
npm install
npm run tauri dev     # 桌面版（Rust 采集/播放）
npm start             # 仅前端（浏览器回退：Web Audio 播放、演示应用音源），http://127.0.0.1:4178/
```

- Rust 侧依赖同级的 `../micdeck`（lib 目标名 `micdeck_lib`）。
- 单实例守卫（`tauri-plugin-single-instance`）：会话存储只允许一个写者，第二次启动会把已有窗口叫到前面。
- 前端是无打包器的原生 ES modules；`ui/js/native.js` 按运行环境自动选择原生命令或 Web Audio 回退。

## 测试

```bash
node _test/run.mjs    # 浏览器回退路径的 CDP 回归（需 Edge 调试端口 9333）
```

[MicDeck]: https://github.com/Schallophy/micdeck

## 许可

MIT，见 [LICENSE](LICENSE)。
