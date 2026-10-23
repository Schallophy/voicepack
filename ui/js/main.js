import { App } from './app.js';
import { toNativePcm } from './native.js';

const app = new App();

app.init().catch((err) => {
  console.error('voicepack init failed', err);
  const box = document.createElement('div');
  box.className = 'fatal-error';
  box.textContent = `启动失败：${err?.message || err}`;
  document.body.appendChild(box);
});

if (new URLSearchParams(location.search).has('debug')) {
  window.__voicepack = app;
  window.__vpToPcm = toNativePcm;
}
