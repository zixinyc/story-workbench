import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { defaultMotionSettings, evaluateTextEffect, graphemes, minimumMotionDuration, verticalPhasePlan, ghostPhasePlan } from '../src/motion/effects.mjs';
import { defaultSettings, validateCueSettings, compileDocument } from '../src/domain/model/document.mjs';
import { createBlankProject, validateProject } from '../src/domain/model/project.mjs';
import { fromEditorContent, toEditorContent } from '../src/editor/story-editor.ts';
import { createProjectArchive, readProjectArchive } from '../src/persistence/archive.mjs';
import { createReviewSnapshot, reviewHash, createReviewArchive, validateReviewChanges, applyReviewChanges } from '../src/ai-review/review-package.mjs';

globalThis.JSZip = JSZip;
const settingsFor = (motion, text, parameters = {}) => defaultSettings({ motion, motionSettings: { ...defaultMotionSettings(motion, text), ...parameters } });

test('RP-A2 固定字槽、按列逐字、换行和字素索引不丢失，完整阅读后错峰退出', () => {
  const text = '仍然相信A，🙂\n请记得这一刻。';
  const settings = settingsFor('verticalReveal', text, { columnLength: 4 });
  const plan = verticalPhasePlan(settings.motionSettings, text);
  const at = (time) => evaluateTextEffect(settings, text, time);
  const visible = (frame) => frame.columns.flatMap((column) => column.characters).filter((char) => char.visible);
  assert.equal(visible(at(499)).length, 0);
  assert.equal(visible(at(500)).length, 1);
  assert.equal(visible(at(1100)).length, 4);
  assert.equal(at(499).columns.length, at(plan.completeAt).columns.length);
  assert.equal(visible(at(plan.completeAt)).map((char) => char.text).join(''), text.replace(/\n/g, ''));
  for (const item of visible(at(plan.completeAt))) assert.equal(item.text, graphemes(text)[item.index]);
  assert.equal(plan.exitAt - plan.completeAt, 1200);
  assert.ok(at(plan.exitAt).columns.every((column) => column.opacity === 1));
  assert.ok(at(plan.exitAt + 50).columns[0].opacity < 1);
  assert.equal(at(plan.exitAt + 50).columns[1].opacity, 1);
  assert.ok(at(plan.total).columns.every((column) => column.opacity === 0));
  assert.equal(minimumMotionDuration('verticalReveal', text, settings.motionSettings), plan.total);
  const frame = at(1100);
  at(plan.total);
  assert.deepEqual(at(1100), frame);
});

test('RP-A2 长中文和中英文混排完整显字，空行留列，不改写正文和参数', () => {
  for (const text of ['记忆与时间，A/B 🙂 e\u0301。'.repeat(12), '甲\n\n乙', '甲\r\n乙', '']) {
    const settings = settingsFor('verticalReveal', text);
    const before = JSON.stringify(settings);
    const plan = verticalPhasePlan(settings.motionSettings, text);
    const frame = evaluateTextEffect(settings, text, plan.completeAt + 1000);
    assert.equal(frame.columns.flatMap((column) => column.characters).map((char) => char.text).join(''), text.replace(/[\r\n]/g, ''));
    assert.ok(frame.columns.every((column) => column.opacity === 1 && column.characters.every((char) => char.visible)));
    assert.equal(JSON.stringify(settings), before);
  }
});

test('RP-F1 先阅读，残影分离、连续回收、完全消失后阅读再退出，倒拖确定', () => {
  const text = '请记得这一刻，A 🙂。';
  const settings = settingsFor('ghostConverge', text);
  const p = settings.motionSettings;
  const plan = ghostPhasePlan(p);
  const at = (time) => evaluateTextEffect(settings, text, time);
  assert.equal(at(0).opacity, 0);
  assert.equal(at(p.startMs + p.fadeMs).opacity, 1);
  assert.equal(at(plan.changeAt - 1).ghostAmount, 0);
  assert.equal(at(plan.changeAt + 220).ghostAmount, 1);
  assert.equal(at(plan.changeAt + p.splitMs).ghostAmount, 1);
  const middle = at(plan.changeAt + p.splitMs + p.returnMs / 2);
  assert.equal(middle.ghostAmount, 0.5);
  assert.ok(middle.ghostOffsetEm < at(plan.changeAt + 220).ghostOffsetEm);
  assert.equal(at(plan.completeAt).ghostAmount, 0);
  assert.equal(at(plan.completeAt + p.holdMs).opacity, 1);
  assert.equal(at(plan.total).opacity, 0);
  assert.equal(minimumMotionDuration('ghostConverge', text, p), plan.total);
  assert.deepEqual(at(plan.changeAt + p.splitMs + p.returnMs / 2), middle);
  assert.equal(at(plan.completeAt).text, text);
  assert.ok(at(plan.changeAt + 220).characters.every((char) => char.visible));
});

test('RP-F1 起始时间不会抢过淡入，强度零可停用残影；非法参数被拒绝', () => {
  const settings = settingsFor('ghostConverge', '正文', { startMs: 2000, fadeMs: 1000, changeAtMs: 100, strength: 0 });
  const plan = ghostPhasePlan(settings.motionSettings);
  assert.equal(plan.changeAt, 3000);
  assert.equal(evaluateTextEffect(settings, '正文', 3200).ghostAmount, 0);
  for (const [motion, parameters] of [['verticalReveal', { columnLength: 2.5 }], ['verticalReveal', { columnLength: 0 }], ['ghostConverge', { strength: 2 }], ['ghostConverge', { returnMs: 0 }], ['ghostConverge', { offsetEm: NaN }], ['ghostConverge', { secret: 1 }]]) {
    assert.throws(() => validateCueSettings(defaultSettings({ motion, motionSettings: parameters })));
  }
});

test('两项效果编辑器、工程包和审阅 ZIP 往返，AI 可改参导回且正文与 ID 保持一致', async () => {
  const project = createBlankProject();
  const chapter = project.chapters[0];
  chapter.document.blocks = ['verticalReveal', 'ghostConverge'].map((motion, index) => ({
    type: 'paragraph', id: `rp-p-${index}`, children: [{ type: 'cue', id: `rp-c-${index}`, settings: settingsFor(motion, '请记得这一刻。'), children: [{ type: 'text', text: '请记得', color: '#ff8844' }, { type: 'text', text: '这一刻。' }] }],
  }));
  assert.equal(validateProject(project), true);
  assert.deepEqual(fromEditorContent(toEditorContent(chapter.document)), chapter.document);
  const blob = await createProjectArchive(project, []);
  const restored = await readProjectArchive(await blob.arrayBuffer());
  assert.deepEqual(restored.project, project);
  const scope = { type: 'chapter', chapterId: chapter.id };
  const snapshot = createReviewSnapshot(project, scope);
  const baseHash = await reviewHash(snapshot);
  const archive = await createReviewArchive(JSZip, snapshot, baseHash, '保留正文，只调整动效', [], false);
  const zip = await JSZip.loadAsync(archive.bytes);
  const description = await zip.file('作品说明.md').async('string');
  assert.match(description, /RP-A2 竖排递进/);
  assert.match(description, /RP-F1 错色残影收敛/);
  const schema = await zip.file('supported-changes.schema.json').async('string');
  assert.match(schema, /verticalReveal/);
  assert.match(schema, /ghostConverge/);
  assert.match(schema, /columnLength/);
  assert.match(schema, /returnMs/);
  const changes = chapter.document.blocks.map((block) => {
    const cue = block.children[0];
    return { op: 'updateCueSettings', chapterId: chapter.id, cueId: cue.id, before: cue.settings, after: { ...cue.settings, motionSettings: { ...cue.settings.motionSettings, holdMs: 1800 } }, reason: '延长清晰阅读时间' };
  });
  const raw = JSON.stringify({ format: 'story-workbench-ai-changes', version: 1, baseProjectId: project.id, baseHash, scope, changes });
  const result = applyReviewChanges(project, await validateReviewChanges(project, raw));
  assert.equal(validateProject(result), true);
  const cues = compileDocument(result.chapters[0].document);
  assert.deepEqual(cues.map((cue) => cue.id), ['rp-c-0', 'rp-c-1']);
  assert.ok(cues.every((cue) => cue.text === '请记得这一刻。' && cue.settings.motionSettings.holdMs === 1800 && cue.children[0].color === '#ff8844'));
  assert.ok(compileDocument(chapter.document).every((cue) => cue.settings.motionSettings.holdMs === 1200));
});
