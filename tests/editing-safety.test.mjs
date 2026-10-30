import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldHandlePlaybackSpace } from '../src/runtime/hotkeys.mjs';
import { chapterTextCounts, isLargeTextDeletion } from '../src/persistence/save-safety.mjs';
const event = (patch = {}) => ({ key: ' ', target: { closest: () => null }, ...patch });
test('空格播放只处理非输入区域，忽略 IME、重复、修饰键及原生按钮', () => {
  assert.equal(shouldHandlePlaybackSpace(event()), true);
  for (const patch of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { defaultPrevented: true }, { key: 'Enter' }, { target: { isContentEditable: true } }, { target: { closest: () => ({}) } }]) assert.equal(shouldHandlePlaybackSpace(event(patch)), false);
});
test('单章大量删字会保护旧版本，不被其他长章节掩盖', () => {
  const project = { chapters: [{ id: 'a', document: { blocks: [{ children: [{ type: 'cue', children: [{ type: 'text', text: '甲'.repeat(100) }] }] }] } }, { id: 'b', document: { blocks: [{ children: [{ type: 'text', text: '乙'.repeat(10000) }] }] } }] };
  const counts = chapterTextCounts(project);
  assert.deepEqual(counts, { a: 100, b: 10000 });
  assert.equal(isLargeTextDeletion(counts, { a: 0, b: 10000 }), true);
  assert.equal(isLargeTextDeletion(counts, { a: 70, b: 10000 }), false);
});
