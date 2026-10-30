import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewSnapshot, createReviewDocuments } from '../src/ai-review/review-package.mjs';
import { createWorkDescription } from '../src/ai-review/work-description.mjs';
import { createParagraphGroup, setMusicRange, activeChapter } from '../src/domain/model/chapters.mjs';
import { createDemoProject } from '../src/domain/model/project.mjs';

function fixtureProject() {
  let project = createDemoProject();
  const chapter = activeChapter(project);
  const ids = chapter.document.blocks.map((block) => block.id);
  let next = createParagraphGroup(chapter, ids.slice(0, 2), '第一组');
  next = setMusicRange(next, 'asset-bgm', ids.slice(0, 2), { volume: 0.7, loop: true });
  project = {
    ...project,
    assets: [
      { id: 'asset-bg', name: '夜街.jpg', kind: 'image', mime: 'image/jpeg', size: 100, width: 1920, height: 1080 },
      { id: 'asset-img', name: '纸条.png', kind: 'image', mime: 'image/png', size: 50, width: 640, height: 360 },
      { id: 'asset-sfx', name: '雨声.wav', kind: 'audio', mime: 'audio/wav', size: 80 },
      { id: 'asset-bgm', name: '弦乐.ogg', kind: 'audio', mime: 'audio/ogg', size: 90 },
    ],
    chapters: project.chapters.map((item) => item.id === chapter.id ? next : item),
  };
  const current = activeChapter(project);
  const explicit = current.document.blocks.flatMap((paragraph) => paragraph.children.filter((node) => node.type === 'cue').map((cue) => ({ cue, paragraph })));
  // 第一句设背景与图层，第二句不设，用来验证"本句设置 / 沿用前句"的区分
  const first = explicit[0].cue;
  first.settings = { ...first.settings, backgroundId: 'asset-bg', speaker: '应子汐', motion: 'decode', motionSettings: { seed: 7, startMs: 400, charStepMs: 100, settleMs: 80, holdMs: 1200, exitMs: 300 }, sceneLayers: [{ id: 'layer-1', assetId: 'asset-img', x: 100, y: 200, width: 640, height: 360, opacity: 0.8, zIndex: 1, rotation: 45, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } }], audioId: 'asset-sfx' };
  const second = explicit[1]?.cue;
  if (second) { const { backgroundId, sceneLayers, ...rest } = second.settings; second.settings = rest; }
  return project;
}

const baseHash = 'hash-for-test';
const goal = '让循环感更强';

test('作品说明自带上下文，不依赖旧对话，且不编造软件没有的数据', () => {
  const project = fixtureProject();
  const snapshot = createReviewSnapshot(project, { type: 'chapter', chapterId: project.activeChapterId });
  const text = createWorkDescription(snapshot, baseHash, goal);
  assert.match(text, /没有看过之前对话/);
  assert.ok(!text.includes('你应该知道之前的讨论'));
  assert.ok(text.includes(baseHash), '必须带基线指纹');
  assert.ok(text.includes(project.name));
  assert.match(text, /未提供/, '软件没有人物表，必须写明未提供而不是编造');
});

test('作品说明给出稳定 ID 与正文全文，可直接定位要改哪一句', () => {
  const project = fixtureProject();
  const chapter = activeChapter(project);
  const snapshot = createReviewSnapshot(project, { type: 'chapter', chapterId: chapter.id });
  const text = createWorkDescription(snapshot, baseHash, goal);
  const cueIds = chapter.document.blocks.flatMap((block) => block.children.filter((node) => node.type === 'cue').map((node) => node.id));
  for (const cueId of cueIds) assert.ok(text.includes(cueId), `缺少演出句 ID ${cueId}`);
  assert.ok(text.includes(chapter.groups[0].id), '缺少组 ID');
  for (const block of chapter.document.blocks) assert.ok(text.includes(block.id), `缺少段落 ID ${block.id}`);
});

test('作品说明区分本句设置与沿用前句，不把继承写成无背景', () => {
  const project = fixtureProject();
  const chapter = activeChapter(project);
  const snapshot = createReviewSnapshot(project, { type: 'chapter', chapterId: chapter.id });
  const text = createWorkDescription(snapshot, baseHash, goal);
  assert.ok(text.includes('本句设置'), '设置了背景的那句应标为本句设置');
  assert.ok(text.includes('沿用前句'), '其后的句子应标为沿用前句');
  // 设置背景之前的句子本来就没有背景可继承，那处出现"无背景"是正确的
  const lines = text.split('\n');
  const inherited = lines.filter((line) => line.includes('背景：沿用前句'));
  assert.ok(inherited.length > 0, '至少应有句子沿用前句背景');
  assert.ok(inherited.every((line) => line.includes('夜街.jpg')), '沿用时必须写出实际生效的背景素材，不能只写"沿用前句"而留空');
});

test('作品说明同时给出动效易读名称与内部 ID，并写出实际参数', () => {
  const project = fixtureProject();
  const snapshot = createReviewSnapshot(project, { type: 'chapter', chapterId: project.activeChapterId });
  const text = createWorkDescription(snapshot, baseHash, goal);
  assert.ok(text.includes('D01 解码显字'), '应有易读名称');
  assert.ok(text.includes('motionId: decode'), '应同时给内部 ID');
  assert.ok(/seed=7/.test(text), '应写出实际生效参数');
});

test('独立作品说明不含媒体时明确声明，不能让 agent 声称看过媒体', () => {
  const project = fixtureProject();
  const snapshot = createReviewSnapshot(project, { type: 'chapter', chapterId: project.activeChapterId });
  const text = createWorkDescription(snapshot, baseHash, goal, new Set(), false);
  assert.match(text, /未附带任何媒体文件/);
  assert.match(text, /不要声称看过图片或听过声音/);
  const table = text.split('## 七、素材清单')[1] ?? '';
  assert.match(table, /\| 否 \|/);
});

test('随包附带媒体时给出包内相对路径，且不写本机绝对路径', () => {
  const project = fixtureProject();
  const snapshot = createReviewSnapshot(project, { type: 'chapter', chapterId: project.activeChapterId });
  const attached = new Set(snapshot.assets.map((asset) => asset.id));
  const text = createWorkDescription(snapshot, baseHash, goal, attached, true);
  assert.match(text, /媒体\/asset-bg\.jpg/);
  assert.ok(!/[A-Za-z]:\\/.test(text), '不应导出本机绝对路径');
});

test('作品说明把背景音乐写成按组连续覆盖，而不是每句重播', () => {
  const project = fixtureProject();
  const chapter = activeChapter(project);
  const snapshot = createReviewSnapshot(project, { type: 'chapter', chapterId: chapter.id });
  const text = createWorkDescription(snapshot, baseHash, goal);
  assert.ok(text.includes('按组覆盖的连续播放'), '必须写明 BGM 是组范围连续播放');
  assert.ok(text.includes('弦乐.ogg'));
  assert.ok(text.includes('音量 0.7'));
});

test('作品说明明确列出软件不支持、需作者处理的动作', () => {
  const project = fixtureProject();
  const snapshot = createReviewSnapshot(project, { type: 'chapter', chapterId: project.activeChapterId });
  const text = createWorkDescription(snapshot, baseHash, goal);
  for (const item of ['新增或删除章节', '重组组结构', '局部字色']) {
    assert.ok(text.includes(item), `未列出未支持项：${item}`);
  }
});

test('完整审阅包内含同一份作品说明，且提示词要求双结果分开', () => {
  const project = fixtureProject();
  const snapshot = createReviewSnapshot(project, { type: 'chapter', chapterId: project.activeChapterId });
  const files = createReviewDocuments(snapshot, baseHash, goal);
  assert.ok(files['作品说明.md'], 'ZIP 内必须含作品说明');
  assert.ok(files['作品说明.md'].includes(baseHash));
  const prompt = files['改进提示词.md'];
  assert.ok(prompt.includes('审阅意见.md'), '提示词应要求产出审阅意见');
  assert.ok(prompt.includes('改进建议.json'), '提示词应要求产出可导回 JSON');
  assert.ok(prompt.includes('两份'), '提示词应强调两份分开');
  assert.ok(!prompt.includes('只输出符合'), '旧的"只输出 JSON"口径应已移除');
  assert.match(files['阅读说明.md'], /作品说明\.md/);
});

test('按组导出只包含选中的组，并说明范围', () => {
  const project = fixtureProject();
  const chapter = activeChapter(project);
  const target = chapter.groups[0];
  const snapshot = createReviewSnapshot(project, { type: 'groups', chapterId: chapter.id, groupIds: [target.id] });
  assert.equal(snapshot.chapters.length, 1);
  assert.equal(snapshot.chapters[0].groups.length, 1);
  assert.equal(snapshot.chapters[0].document.blocks.length, target.paragraphIds.length);
  const text = createWorkDescription(snapshot, baseHash, goal);
  assert.match(text, /指定组/);
  assert.ok(!text.includes(chapter.document.blocks.at(-1).id), '范围外的段落不应出现');
});

test('导出作品说明不改动工程本身（只读快照）', () => {
  const project = fixtureProject();
  const before = JSON.stringify(project);
  const snapshot = createReviewSnapshot(project, { type: 'chapter', chapterId: project.activeChapterId });
  createWorkDescription(snapshot, baseHash, goal, new Set(), false);
  assert.equal(JSON.stringify(project), before, '生成文档不得修改工程数据');
});
