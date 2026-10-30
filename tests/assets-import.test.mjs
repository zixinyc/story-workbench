import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFile } from '../src/assets/manager.mjs';

test('音频用途不依据英文文件名推测，MP4 按视频资产导入', () => {
  assert.equal(describeFile({ name: 'BGM_final.mp3', type: 'audio/mpeg', size: 12 }).kind, 'audio');
  assert.equal(describeFile({ name: '旁白.wav', type: 'audio/wav', size: 12 }).kind, 'audio');
  assert.equal(describeFile({ name: 'cutscene.mp4', type: 'video/mp4', size: 12 }).kind, 'video');
});
