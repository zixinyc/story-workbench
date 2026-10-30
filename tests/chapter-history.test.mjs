import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeChapterHistorySnapshot } from '../src/runtime/chapter-history.mjs';

test('章节历史撤销只还原目标章节并保留当前活动章节与其他章节', () => {
  const otherChapter = { id: 'chapter-b', document: { blocks: [{ id: 'b1', text: '最新正文' }] } };
  const current = { id: 'project-1', activeChapterId: 'chapter-b', updatedAt: 'new', chapters: [{ id: 'chapter-a', document: { blocks: [{ id: 'a1', text: '新正文' }] } }, otherChapter] };
  const snapshot = { id: 'project-1', activeChapterId: 'chapter-a', updatedAt: 'old', chapters: [{ id: 'chapter-a', document: { blocks: [{ id: 'a1', text: '旧正文' }] } }, { id: 'chapter-b', document: { blocks: [{ id: 'b1', text: '旧的另一章' }] } }] };

  const restored = mergeChapterHistorySnapshot(current, snapshot, 'chapter-a');

  assert.equal(restored.activeChapterId, 'chapter-b');
  assert.equal(restored.chapters[0].document.blocks[0].text, '旧正文');
  assert.equal(restored.chapters[1], otherChapter);
  assert.equal(mergeChapterHistorySnapshot(current, { ...snapshot, id: 'other-project' }, 'chapter-a'), current);
  assert.equal(mergeChapterHistorySnapshot(current, snapshot, 'missing'), current);
});
