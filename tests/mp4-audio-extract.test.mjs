import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../src/media/mp4-audio-extract.ts';

function fakeBuffer({ sampleRate, channels }) {
  const length = channels[0].length;
  return { sampleRate, length, numberOfChannels: channels.length, getChannelData: (index) => Float32Array.from(channels[index]) };
}

test('WAV 封装生成标准 RIFF 头并按小端写入 PCM16 双声道采样', async () => {
  const result = await encodeWav(fakeBuffer({ sampleRate: 2, channels: [[-1, 1], [0.5, -0.5]] }));
  const view = new DataView(result);
  assert.equal(new TextDecoder().decode(new Uint8Array(result, 0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(new Uint8Array(result, 8, 4)), 'WAVE');
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 2);
  assert.equal(view.getUint32(40, true), 8);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 16383);
  assert.equal(view.getInt16(48, true), 32767);
  assert.equal(view.getInt16(50, true), -16384);
});

test('分段封装会检查取消信号并停止生成', async () => {
  const controller = new AbortController();
  const task = encodeWav(fakeBuffer({ sampleRate: 1, channels: [[0, 0]] }), 1, controller.signal, () => controller.abort());
  await assert.rejects(task, /已取消/);
});
