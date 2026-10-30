import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoProject, validateProject } from '../src/domain/model/project.mjs';
import { activeChapter, createParagraphGroup } from '../src/domain/model/chapters.mjs';
import { toEditorContent, fromEditorContent } from '../src/editor/story-editor.ts';
import { createPlayer, playbackStartIndex } from '../src/runtime/player.mjs';

test('示例工程的正文和演出可往返，段落与 cue ID 保持稳定', () => {
  const project = createDemoProject();
  const document = activeChapter(project).document;
  const roundTrip = fromEditorContent(toEditorContent(document));
  assert.deepEqual(roundTrip, document);
});

test('连续换行作为同一正文和同一演出单元保存', () => {
  const project = createDemoProject();
  const document = activeChapter(project).document;
  const paragraph = document.blocks.find((block) => block.children[0]?.type === 'cue');
  const cue = paragraph.children[0];
  cue.children[0].text = '第一行\n第二行';
  const editorContent = toEditorContent(document);
  assert.equal(editorContent.content.find((block) => block.attrs.paragraphId === paragraph.id).content.length, 1);
  assert.deepEqual(fromEditorContent(editorContent), document);
});

test('段落组稳定 ID 随正文编辑器内容往返保存', () => {
  const project = createDemoProject();
  const chapter = activeChapter(project);
  const ids = chapter.document.blocks.slice(0, 2).map((block) => block.id);
  const grouped = createParagraphGroup(chapter, ids, '开场');
  const roundTrip = fromEditorContent(toEditorContent(grouped.document, grouped.groups));
  assert.deepEqual(roundTrip, grouped.document);
  assert.equal(roundTrip.blocks[0].groupId, grouped.groups[0].id);
  assert.equal(roundTrip.blocks[2].groupId, undefined);
});

test('工程校验拒绝无效颜色、舞台坐标和图层层级', () => {
  const base = createDemoProject();
  const invalidColor = structuredClone(base);
  activeChapter(invalidColor).document.blocks.find((block) => block.children[0]?.type === 'cue').children[0].settings.color = null;
  assert.throws(() => validateProject(invalidColor), /颜色/);

  const invalidLayer = structuredClone(base);
  invalidLayer.assets.push({ id: 'image-1', name: '背景.png', kind: 'image', mime: 'image/png', size: 10 });
  const cue = activeChapter(invalidLayer).document.blocks.find((block) => block.children[0]?.type === 'cue').children[0];
  cue.settings.sceneLayers = [{ id: 'layer-1', assetId: 'image-1', x: 0, y: 0, width: 100, height: 100, opacity: 1, zIndex: 0.5 }];
  assert.throws(() => validateProject(invalidLayer), /图层/);
});

test('舞台图层保存完整裁剪、变换与视频片段设置', () => {
  const project = createDemoProject();
  const chapter = activeChapter(project);
  project.assets.push({ id: 'image-1', name: '透明.png', kind: 'image', mime: 'image/png', size: 10, width: 200, height: 300 });
  project.assets.push({ id: 'video-1', name: '片段.mp4', kind: 'video', mime: 'video/mp4', size: 20 });
  const cue = chapter.document.blocks.find((block) => block.children[0]?.type === 'cue').children[0];
  cue.settings.sceneLayers = [
    { id: 'image-layer', assetId: 'image-1', x: 20, y: 30, width: 500, height: 750, opacity: 0.8, zIndex: 0, rotation: 24, flipX: true, crop: { left: 0.1, top: 0, right: 0.05, bottom: 0 }, fit: 'cover', locked: true, hidden: false },
    { id: 'video-layer', assetId: 'video-1', x: 800, y: 500, width: 500, height: 300, opacity: 1, zIndex: 1, videoStartMs: 500, videoEndMs: 2600, videoMuted: true, videoVolume: 0.4, videoLoop: true },
  ];
  assert.equal(validateProject(project), true);
});

test('播放进度拖动会把相同毫秒位置传给媒体会话', () => {
  const project = createDemoProject();
  const seeks = [];
  const player = createPlayer({
    getPlan: () => activeChapter(project).document.blocks.map((block, index) => ({ id: String(index), settings: { durationMs: 3500, advance: 'click' } })),
    onChange() {}, onEnter() {}, onPauseMedia() {}, onResumeMedia() {}, onSeekMedia: (milliseconds) => seeks.push(milliseconds), onStopMedia() {},
  });
  player.playFrom(0);
  player.seek(0.5);
  player.stop();
  assert.equal(seeks[0], 1750);
});

test('播放整段从第一句开始，而从当前句预览保留当前句起点', () => {
  const plan = Array.from({ length: 10 }, (_, index) => ({ id: `cue-${index}` }));
  assert.equal(playbackStartIndex(plan, 'cue-5', 'auto'), 0);
  assert.equal(playbackStartIndex(plan, 'cue-5', null), 5);
});
