import test from 'node:test';
import assert from 'node:assert/strict';
import { createHtmlAudioBackend } from '../src/media/html-audio-backend.ts';

class FakeAudio extends EventTarget {
  static instances = [];
  static autoReady = true;
  currentTime = 0;
  error = null;
  preload = '';
  src = '';
  playCount = 0;
  pauseCount = 0;
  loadCount = 0;
  constructor() {
    super();
    FakeAudio.instances.push(this);
  }
  load() {
    this.loadCount += 1;
    if (FakeAudio.autoReady && this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
  }
  play() { this.playCount += 1; return Promise.resolve(); }
  pause() { this.pauseCount += 1; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}

function installAudioFakes(t, autoReady = true) {
  const previousAudio = globalThis.Audio;
  const previousWindow = globalThis.window;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const revoked = [];
  FakeAudio.instances = [];
  FakeAudio.autoReady = autoReady;
  globalThis.Audio = FakeAudio;
  globalThis.window = { setTimeout, clearTimeout };
  URL.createObjectURL = () => 'blob:test-audio';
  URL.revokeObjectURL = (url) => revoked.push(url);
  t.after(() => {
    globalThis.Audio = previousAudio;
    globalThis.window = previousWindow;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  });
  return revoked;
}

test('原生音频适配器准备时静音，复用句柄并把毫秒定位转换为秒', async (t) => {
  const revoked = installAudioFakes(t);
  const events = [];
  const controller = new AbortController();
  const backend = createHtmlAudioBackend((id) => id === 'music-1' ? { id, mime: 'audio/mpeg', blob: new Blob(['sound'], { type: 'audio/mpeg' }) } : undefined);
  const handle = await backend.prepare('music-1', controller.signal, { ended: () => events.push('ended'), error: (error) => events.push(error.message) });
  const audio = FakeAudio.instances[0];
  assert.equal(audio.playCount, 0);
  assert.equal(audio.src, 'blob:test-audio');
  assert.equal(handle.play(), 1);
  assert.equal(handle.play(1), 1);
  handle.seekMs(1250, 1);
  assert.equal(audio.currentTime, 1.25);
  assert.equal(audio.playCount, 2);
  handle.dispose();
  assert.deepEqual(revoked, ['blob:test-audio']);
});

test('取消媒体准备会拒绝并释放 Blob URL', async (t) => {
  const revoked = installAudioFakes(t, false);
  const controller = new AbortController();
  const backend = createHtmlAudioBackend(() => ({ id: 'audio-1', mime: 'audio/wav', blob: new Blob(['sound'], { type: 'audio/wav' }) }));
  const pending = backend.prepare('audio-1', controller.signal, { ended() {}, error() {} });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(revoked, ['blob:test-audio']);
  assert.equal(FakeAudio.instances[0].src, '');
});

test('异步原生播放失败会反馈给媒体会话', async (t) => {
  installAudioFakes(t);
  FakeAudio.prototype.play = () => Promise.reject(new Error('播放被拒绝'));
  const errors = [];
  const backend = createHtmlAudioBackend(() => ({ id: 'audio-1', mime: 'audio/wav', blob: new Blob(['sound'], { type: 'audio/wav' }) }));
  const handle = await backend.prepare('audio-1', new AbortController().signal, { ended() {}, error: (error) => errors.push(error.message) });
  handle.play();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, ['播放被拒绝']);
  handle.dispose();
});
