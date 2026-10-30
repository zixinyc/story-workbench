import test from 'node:test';
import assert from 'node:assert/strict';
import { activeChapter, addChapter, createEmptyParagraphGroup, createParagraphGroup, migrateProject, moveParagraphGroup, moveParagraphs, musicRangeAt, normalizeChapterName, normalizeParagraphGroupName, reconcileChapterDocument, renameChapter, renameParagraphGroup, setMusicRange, replaceMusicRange } from '../src/domain/model/chapters.mjs';
import { createDemoProject, validateProject } from '../src/domain/model/project.mjs';

test('v1 工程迁移到默认第01章并保留句音效与稳定 ID', () => {
  const current = createDemoProject();
  const chapter = activeChapter(current);
  chapter.document.blocks[0].children = [{ type: 'cue', id: 'cue-kept', settings: { audioId: 'old-music-id' }, children: [{ type: 'text', text: '原文' }] }];
  const { chapters: _chapters, activeChapterId: _activeChapterId, schemaVersion: _schemaVersion, ...legacy } = current;
  legacy.schemaVersion = 1;
  legacy.document = chapter.document;
  legacy.assets = [{ id: 'old-music-id', name: '配乐.wav', kind: 'music', mime: 'audio/wav', size: 4 }];
  const migrated = migrateProject(legacy);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.chapters[0].name, '第01章');
  assert.equal(migrated.chapters[0].document.blocks[0].children[0].id, 'cue-kept');
  assert.equal(migrated.chapters[0].document.blocks[0].children[0].settings.audioId, 'old-music-id');
  assert.equal(migrated.assets[0].kind, 'audio');
  assert.equal('document' in migrated, false);
  assert.equal(validateProject(migrated), true);
});

test('段落组可移动，音乐范围仍绑定原段落且跨组编辑不会按序号漂移', () => {
  const project = createDemoProject();
  let chapter = activeChapter(project);
  const ids = chapter.document.blocks.map((block) => block.id);
  chapter = createParagraphGroup(chapter, ids.slice(2, 4), '中段');
  chapter = setMusicRange(chapter, 'music-1', ids.slice(1, 6));
  chapter = moveParagraphGroup(chapter, chapter.groups[0].id, 1);
  const range = chapter.musicRanges[0];
  const start = chapter.document.blocks.findIndex((block) => block.id === range.startParagraphId);
  const end = chapter.document.blocks.findIndex((block) => block.id === range.endParagraphId);
  assert.equal(end - start + 1, 5);
  assert.deepEqual(chapter.document.blocks.slice(start, end + 1).map((block) => block.id).sort(), ids.slice(1, 6).sort());
});

test('章节与段落组名称会去除首尾空白并遵守工程的 120 字符限制', () => {
  const project = createDemoProject();
  const chapter = activeChapter(project);
  const ids = chapter.document.blocks.map((block) => block.id);
  const added = addChapter(project, '  第二章  ');
  assert.equal(activeChapter(added).name, '第二章');
  assert.equal(renameChapter(added, activeChapter(added).id, '  雨夜  ').chapters.at(-1).name, '雨夜');
  const grouped = createParagraphGroup(chapter, ids.slice(0, 2), '  开场  ');
  assert.equal(grouped.groups[0].name, '开场');
  assert.equal(renameParagraphGroup(grouped, grouped.groups[0].id, '  校园  ').groups[0].name, '校园');
  assert.equal(normalizeChapterName('  第一章  '), '第一章');
  assert.equal(normalizeParagraphGroupName('  引子  '), '引子');
  assert.throws(() => normalizeChapterName('   '), /章节名称不能为空/);
  assert.throws(() => normalizeParagraphGroupName('   '), /段落组名称不能为空/);
  assert.throws(() => normalizeChapterName('章'.repeat(121)), /最多 120 个字符/);
  assert.throws(() => normalizeParagraphGroupName('组'.repeat(121)), /最多 120 个字符/);
});

test('已有段落组时追加空正文段仍能协调工程结构', () => {
  const project = createDemoProject();
  const chapter = activeChapter(project);
  const ids = chapter.document.blocks.map((block) => block.id);
  const grouped = createParagraphGroup(chapter, ids.slice(0, 2), '开场');
  const emptyParagraph = { type: 'paragraph', id: 'paragraph-empty', children: [] };
  const document = { ...grouped.document, blocks: [...grouped.document.blocks, emptyParagraph] };
  const reconciled = reconcileChapterDocument(grouped, document);
  const nextProject = { ...project, chapters: project.chapters.map((item) => item.id === chapter.id ? reconciled : item) };

  assert.deepEqual(reconciled.document.blocks.map((block) => block.id), [...ids, emptyParagraph.id]);
  assert.deepEqual(reconciled.groups.map((group) => group.paragraphIds), [ids.slice(0, 2)]);
  assert.equal(validateProject(nextProject), true);
});

test('背景音乐范围拒绝重叠，删除端点后只保留原范围中的相邻正文', () => {
  const project = createDemoProject();
  let chapter = activeChapter(project);
  const ids = chapter.document.blocks.map((block) => block.id);
  chapter = setMusicRange(chapter, 'music-1', ids.slice(1, 5));
  assert.throws(() => setMusicRange(chapter, 'music-2', ids.slice(4, 7)), /重叠/);
  const document = { ...chapter.document, blocks: chapter.document.blocks.filter((block) => block.id !== ids[1]) };
  const reconciled = reconcileChapterDocument(chapter, document);
  assert.equal(reconciled.musicRanges.length, 1);
  assert.equal(reconciled.musicRanges[0].startParagraphId, ids[2]);
});

test('组内输入新段落继承原组和组配乐，原组 ID 与句子 ID 保持稳定', () => {
  const project = createDemoProject();
  const base = activeChapter(project);
  const ids = base.document.blocks.map((block) => block.id);
  let chapter = createParagraphGroup(base, ids.slice(1, 4), '循环');
  chapter = setMusicRange(chapter, 'music-loop', ids.slice(1, 4));
  const groupId = chapter.groups[0].id;
  const cueId = chapter.document.blocks[1].children[0].id;
  const inserted = { type: 'paragraph', id: 'p-added-inside-group', children: [{ type: 'text', text: '新加的句子' }] };
  const document = { ...chapter.document, blocks: [...chapter.document.blocks.slice(0, 3), inserted, ...chapter.document.blocks.slice(3)] };
  const next = reconcileChapterDocument(chapter, document);
  const updatedProject = { ...project, assets: [{ id: 'music-loop', name: '循环音轨', kind: 'audio', mime: 'audio/mpeg', size: 1 }], chapters: project.chapters.map((item) => item.id === base.id ? next : item) };
  assert.equal(next.groups.length, 1);
  assert.equal(next.groups[0].id, groupId);
  assert.deepEqual(next.groups[0].paragraphIds, [...ids.slice(1, 3), inserted.id, ids[3]]);
  assert.equal(next.document.blocks[1].children[0].id, cueId);
  assert.equal(musicRangeAt(next, inserted.id)?.assetId, 'music-loop');
  assert.equal(validateProject(updatedProject), true);
});

test('拖入已有组保留段落与句子身份，拖走最后一句时源组保留空正文占位', () => {
  const project = createDemoProject();
  const base = activeChapter(project);
  const ids = base.document.blocks.map((block) => block.id);
  let chapter = createParagraphGroup(base, ids.slice(0, 2), '开场');
  chapter = createParagraphGroup(chapter, ids.slice(3, 5), '回忆');
  chapter = setMusicRange(chapter, 'music-open', ids.slice(0, 2));
  const source = chapter.groups.find((group) => group.name === '开场');
  const target = chapter.groups.find((group) => group.name === '回忆');
  const originalBlock = chapter.document.blocks.find((block) => block.id === ids[0]);
  const next = moveParagraphs(chapter, [ids[0], ids[1]], { type: 'group', groupId: target.id });
  const updatedProject = { ...project, assets: [{ id: 'music-open', name: '开场音轨', kind: 'audio', mime: 'audio/mpeg', size: 1 }], chapters: project.chapters.map((item) => item.id === base.id ? next : item) };
  assert.deepEqual(next.document.blocks.filter((block) => block.id === ids[0] || block.id === ids[1]).map((block) => block.id), ids.slice(0, 2));
  assert.deepEqual(next.groups.find((group) => group.id === target.id).paragraphIds.slice(0, 2), ids.slice(3, 5));
  assert.deepEqual(next.document.blocks.find((block) => block.id === ids[0]).children, originalBlock.children);
  assert.equal(next.document.blocks.find((block) => block.id === ids[0]).groupId, target.id);
  assert.deepEqual(next.groups.find((group) => group.id === source.id).paragraphIds, [next.document.blocks.find((block) => plainParagraph(block)).id].filter((id) => !ids.includes(id)));
  assert.equal(next.document.blocks.some((block) => block.id === ids[0] && next.groups.find((group) => group.id === source.id).paragraphIds.includes(block.id)), false);
  assert.equal(validateProject(updatedProject), true);
});

test('相同段落范围改配乐会替换音轨而不是以重叠错误拒绝', () => {
  const project = createDemoProject();
  const base = activeChapter(project);
  const ids = base.document.blocks.map((block) => block.id);
  const first = setMusicRange(base, 'music-a', ids.slice(0, 3));
  const replaced = setMusicRange(first, 'music-b', ids.slice(0, 3));
  assert.equal(replaced.musicRanges.length, 1);
  assert.equal(replaced.musicRanges[0].id, first.musicRanges[0].id);
  assert.equal(replaced.musicRanges[0].assetId, 'music-b');
});

test('整组上下移动越过相邻组时，两组归属与各自组配乐保持独立', () => {
  const project = createDemoProject();
  const base = activeChapter(project);
  const ids = base.document.blocks.map((block) => block.id);
  let chapter = createParagraphGroup(base, ids.slice(0, 2), 'A');
  chapter = createParagraphGroup(chapter, ids.slice(2, 4), 'B');
  chapter = setMusicRange(chapter, 'music-a', ids.slice(0, 2));
  chapter = setMusicRange(chapter, 'music-b', ids.slice(2, 4));
  const groupA = chapter.groups.find((group) => group.name === 'A');
  const groupB = chapter.groups.find((group) => group.name === 'B');
  const moved = moveParagraphGroup(chapter, groupA.id, 1);
  const updatedProject = { ...project, assets: [
    { id: 'music-a', name: 'A 音轨', kind: 'audio', mime: 'audio/mpeg', size: 1 },
    { id: 'music-b', name: 'B 音轨', kind: 'audio', mime: 'audio/mpeg', size: 1 },
  ], chapters: project.chapters.map((item) => item.id === base.id ? moved : item) };
  assert.deepEqual(moved.document.blocks.slice(0, 4).map((block) => block.id), [...ids.slice(2, 4), ...ids.slice(0, 2)]);
  assert.deepEqual(moved.groups.find((group) => group.id === groupA.id).paragraphIds, ids.slice(0, 2));
  assert.deepEqual(moved.groups.find((group) => group.id === groupB.id).paragraphIds, ids.slice(2, 4));
  assert.equal(musicRangeAt(moved, ids[0]).assetId, 'music-a');
  assert.equal(musicRangeAt(moved, ids[2]).assetId, 'music-b');
  assert.equal(validateProject(updatedProject), true);
});

test('显式新建组在当前组后新增一个可写空段落，不改动原组内容', () => {
  const base = activeChapter(createDemoProject());
  const ids = base.document.blocks.map((block) => block.id);
  const original = createParagraphGroup(base, ids.slice(0, 2), '第一组');
  const added = createEmptyParagraphGroup(original, '第二组', original.groups[0].id);
  assert.equal(added.groups.length, 2);
  assert.deepEqual(added.groups[0].paragraphIds, ids.slice(0, 2));
  assert.equal(added.groups[1].paragraphIds.length, 1);
  assert.equal(added.document.blocks.find((block) => block.id === added.groups[1].paragraphIds[0]).children.length, 0);
});

function plainParagraph(block) { return block.type === 'paragraph' && !block.children.length; }

test('拖到正文前方正确插入，相邻未分组段移入组即使顺序不变也更新归属', () => {
  const base = activeChapter(createDemoProject());
  const ids = base.document.blocks.map((block) => block.id);
  const before = moveParagraphs(base, [ids[3]], { type: 'paragraph', paragraphId: ids[1], position: 'before' });
  assert.deepEqual(before.document.blocks.slice(0, 4).map((block) => block.id), [ids[0], ids[3], ids[1], ids[2]]);
  const grouped = createParagraphGroup(base, ids.slice(0, 2), '第一组');
  const moved = moveParagraphs(grouped, [ids[2]], { type: 'group', groupId: grouped.groups[0].id });
  assert.deepEqual(moved.document.blocks.map((block) => block.id), ids);
  assert.deepEqual(moved.groups[0].paragraphIds, ids.slice(0, 3));
});
test('确认音乐冲突后只替换目标范围，并保留范围外配乐与正文', () => {
  const base = activeChapter(createDemoProject());
  const ids = base.document.blocks.map((block) => block.id);
  let chapter = createParagraphGroup(base, ids.slice(0, 2), '甲组');
  chapter = createParagraphGroup(chapter, ids.slice(2, 4), '乙组');
  chapter = setMusicRange(chapter, 'old', ids.slice(0, 4));
  const next = replaceMusicRange(chapter, 'new', ids.slice(2, 4));
  assert.equal(musicRangeAt(next, ids[0]).assetId, 'old');
  assert.equal(musicRangeAt(next, ids[2]).assetId, 'new');
  assert.equal(musicRangeAt(next, ids[0]).id, chapter.musicRanges[0].id);
  assert.deepEqual(next.document.blocks.map((block) => block.children), chapter.document.blocks.map((block) => block.children));
  assert.deepEqual(musicRangeAt(next, ids[2]).groupIds, [chapter.groups[1].id]);
  assert.throws(() => replaceMusicRange(chapter, 'new', [ids[0], ids[2]]), /连续/);
});
