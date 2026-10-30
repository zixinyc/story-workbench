import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, validateCueSettings } from '../src/domain/model/document.mjs';
import { defaultMotionSettings, evaluateTextEffect, graphemes, minimumMotionDuration, MOTION_PRESETS, wordPhasePlan } from '../src/motion/effects.mjs';
import { fromEditorContent, toEditorContent } from '../src/editor/story-editor.ts';

test('文字效果参数以兼容方式保存在演出设置中，旧动效仍可验证', () => {
  const old = defaultSettings({ motion: 'shake' });
  assert.equal(validateCueSettings(old), undefined);
  const settings = defaultSettings({ motion: 'decode', motionSettings: defaultMotionSettings('decode', '你好') });
  assert.equal(validateCueSettings(settings), undefined);
  const document = { type: 'doc', blocks: [{ type: 'paragraph', id: 'p1', children: [{ type: 'cue', id: 'cue1', settings, children: [{ type: 'text', text: '你好' }] }] }] };
  assert.deepEqual(fromEditorContent(toEditorContent(document)), document);
  assert.throws(() => validateCueSettings(defaultSettings({ motion: 'decode', motionSettings: { seed: '随机' } })), /seed/);
  assert.throws(() => validateCueSettings(defaultSettings({ motion: 'typing', motionSettings: { secret: 'ignored' } })), /不适用于/);
  assert.throws(() => validateCueSettings(defaultSettings({ motion: 'evaporate', motionSettings: { evaporationStartMs: 400, evaporationEndMs: 300 } })), /结束时间必须晚于开始时间/);
  assert.throws(() => validateCueSettings(defaultSettings({ motion: 'unknown' })), /动效/);
  assert.ok(MOTION_PRESETS.length >= 12);
});

test('D01 只短暂替换新字，固定种子下任意时间求值一致', () => {
  const settings = defaultSettings({ motion: 'decode', motionSettings: { seed: 91, startMs: 0, charStepMs: 100, settleMs: 80, holdMs: 1000, exitMs: 300 } });
  const first = evaluateTextEffect(settings, '解码 A', 40);
  const repeated = evaluateTextEffect(settings, '解码 A', 40);
  assert.deepEqual(first, repeated);
  assert.notEqual(first.characters[0].glitch, null);
  assert.equal(first.characters[0].text, '解');
  assert.equal(evaluateTextEffect(settings, '解码 A', 500).characters[0].glitch, null);
  assert.equal(evaluateTextEffect(settings, '解码 A', 0).characters[1].visible, false);
});

test('普通打字和模糊变清晰都是时间驱动的单调效果', () => {
  const typing = evaluateTextEffect(defaultSettings({ motion: 'typing', motionSettings: { startMs: 0, charStepMs: 100 } }), '甲乙丙', 100);
  assert.equal(typing.characters.filter((item) => item.visible).length, 2);
  const blur = defaultSettings({ motion: 'blurSharp', motionSettings: { strength: 1, clearMs: 500 } });
  assert.equal(evaluateTextEffect(blur, '清晰', 0).blurPx, 10);
  assert.equal(evaluateTextEffect(blur, '清晰', 500).blurPx, 0);
});

test('D02 词组依次显示并让扫线进度随当前词时间生长', () => {
  const settings = defaultSettings({ motion: 'wordUnderline', motionSettings: { wordsText: '明天 / 留住 / 记忆', startMs: 0, wordDurationMs: 400, charStepMs: 70, underlineThickness: 2, holdMs: 1200, exitMs: 300 } });
  const start = evaluateTextEffect(settings, '明天留住记忆', 0);
  const middle = evaluateTextEffect(settings, '明天留住记忆', 200);
  assert.equal(start.words[0].underline, 0);
  assert.ok(middle.words[0].underline > 0.4 && middle.words[0].underline < 0.6);
  assert.equal(middle.words[1].characters[0].visible, false);
});

test('D02 长中文必须存在全文完整可见的时刻，且落在建议时长之内', () => {
  const text = '这是一个没有分词的长中文句子用来验证词组动效不会让文字显示不全而提前退场的情况';
  const parameters = defaultMotionSettings('wordUnderline', text);
  const settings = defaultSettings({ motion: 'wordUnderline', motionSettings: parameters });
  const total = minimumMotionDuration('wordUnderline', text, parameters);
  const plan = wordPhasePlan(parameters, text);
  const totalChars = graphemes(text).length;
  let fullFrame = -1;
  for (let time = 0; time <= total + 500; time += 10) {
    const frame = evaluateTextEffect(settings, text, time);
    const visible = frame.words.flatMap((word) => word.characters).filter((item) => item.visible).length;
    if (visible === totalChars && frame.opacity === 1) { fullFrame = time; break; }
  }
  assert.ok(fullFrame >= 0, '原缺陷：长中文显到一半就退场，从未完整显示');
  assert.ok(plan.completeAt >= plan.words.at(-1).typedAt, '退场不得早于最后一个字显现完');
  assert.ok(fullFrame < total, '完整显示必须发生在建议时长之内');
});

test('D02 建议时长与渲染引用同一份词组阶段计算', () => {
  const parameters = { wordsText: '明天 / 留住 / 记忆', startMs: 0, wordDurationMs: 400, charStepMs: 70, underlineThickness: 2, holdMs: 1200, exitMs: 300 };
  const plan = wordPhasePlan(parameters, '明天留住记忆');
  assert.equal(minimumMotionDuration('wordUnderline', '明天留住记忆', parameters), plan.total);
  assert.equal(plan.completeAt, 3 * 400, '每词都显得完时按每词 400ms 累计，原有行为不变');
  const settings = defaultSettings({ motion: 'wordUnderline', motionSettings: parameters });
  const atExit = evaluateTextEffect(settings, '明天留住记忆', plan.exitAt);
  assert.equal(atExit.opacity, 1, '退场开始那一刻仍应完全不透明');
  assert.ok(atExit.words.every((word) => word.characters.every((item) => item.visible)));
});

test('D02 长词延长占位并把后续词后移，短词起始时间不变', () => {
  const short = wordPhasePlan({ wordsText: '明天 / 留住', startMs: 0, wordDurationMs: 400, charStepMs: 70 }, '明天留住');
  assert.equal(short.words[1].start, 400);
  const long = wordPhasePlan({ wordsText: '第一段很长的中文 / 短', startMs: 0, wordDurationMs: 400, charStepMs: 70 }, '第一段很长的中文短');
  assert.equal(long.words[0].span, 7 * 70, '长词占位等于最后一个字显现所需的字间隔总数');
  assert.ok(long.words[1].start > 400, '后续词必须整体后移');
});

test('D02 词组文本与正文不一致时回退整句，且求值不改写参数', () => {
  const plan = wordPhasePlan({ wordsText: '完全不相关的词', startMs: 0, wordDurationMs: 400, charStepMs: 70 }, '明天留住记忆');
  assert.equal(plan.words.length, 1);
  assert.equal(plan.words[0].text, '明天留住记忆');
  const parameters = { wordsText: '', startMs: 0, wordDurationMs: 400, charStepMs: 70, holdMs: 1200, exitMs: 300 };
  const snapshot = JSON.stringify(parameters);
  assert.equal(JSON.stringify(wordPhasePlan(parameters, '重复求帧')), JSON.stringify(wordPhasePlan(parameters, '重复求帧')));
  assert.equal(JSON.stringify(parameters), snapshot);
});

test('D03 关键词只在最后一个字完成后出现反色标记', () => {
  const settings = defaultSettings({ motion: 'keywordChip', motionSettings: { keywordsText: '记忆', startMs: 0, charStepMs: 200, chipPadding: 7, chipColor: '#252b26', chipTextColor: '#fff8eb' } });
  assert.equal(evaluateTextEffect(settings, '保留记忆', 400).keywords[0].complete, false);
  assert.equal(evaluateTextEffect(settings, '保留记忆', 600).keywords[0].complete, true);
});

test('D04 支持自然语序的一对多映射，并按时间推进连线', () => {
  const settings = defaultSettings({ motion: 'translationWires', motionSettings: { englishText: 'we keep memory', chineseText: '我们 / 留住 / 这段记忆', mappingText: '我们:we\n留住:keep\n这段记忆:keep,memory', startMs: 0, lineGrowMs: 200, holdMs: 1000, exitMs: 200 } });
  const frame = evaluateTextEffect(settings, 'we keep memory', 100);
  assert.equal(frame.translation.targetWords[0], '我们');
  assert.equal(frame.translation.mappings[2].sourceIndexes.length, 2);
  assert.equal(frame.translation.lineProgress, 0.5);
});

test('D05 在停顿后真的缩短草稿，再从同一事件时间重建改写文本', () => {
  const settings = defaultSettings({ motion: 'rewrite', motionSettings: { draftText: '我想说清楚', rewriteText: '我想先听你说。', startMs: 0, pauseMs: 500, deleteCount: 3, typeCps: 10, backspaceCps: 10, holdMs: 1200 } });
  const draft = evaluateTextEffect(settings, '正文不被改写', 700).visibleText;
  const deleted = evaluateTextEffect(settings, '正文不被改写', 1100).visibleText;
  const rewritten = evaluateTextEffect(settings, '正文不被改写', 3000).visibleText;
  assert.equal(draft, '我想说清楚');
  assert.ok(deleted.length < draft.length);
  assert.equal(rewritten, '我想先听你说。');
});

test('D06 按旧句、红线、收拢、新句顺序演出', () => {
  const settings = defaultSettings({ motion: 'strikeRewrite', motionSettings: { oldText: '先下结论。', newText: '先核对证据。', strikeAtMs: 500, strikeDrawMs: 100, strikeHoldMs: 300, collapseMs: 100, typeCps: 10, holdMs: 1000, strikeColor: '#b84a43' } });
  assert.equal(evaluateTextEffect(settings, '正文', 400).strikeVisible, false);
  assert.equal(evaluateTextEffect(settings, '正文', 550).strikeProgress, 0.5);
  assert.equal(evaluateTextEffect(settings, '正文', 1000).newVisible, true);
  assert.equal(evaluateTextEffect(settings, '正文', 1500).oldOpacity, 0);
});

test('D07 保留原位和保护短句，使用字素及固定种子执行末句退格', () => {
  assert.deepEqual(graphemes('👨‍👩‍👧‍👦e\u0301'), ['👨‍👩‍👧‍👦', 'é']);
  const settings = defaultSettings({ motion: 'evaporate', motionSettings: { seed: 31, protectedText: '仍然记得。', evaporationStartMs: 0, evaporationEndMs: 1000, finalHoldMs: 0, backspaceDurationMs: 1000 } });
  const middle = evaluateTextEffect(settings, '遗失的片段。\n仍然记得。', 500);
  const repeat = evaluateTextEffect(settings, '遗失的片段。\n仍然记得。', 500);
  assert.deepEqual(middle, repeat);
  assert.ok(middle.characters.slice(-5).every((item) => item.visible));
  assert.ok(middle.characters.some((item) => !item.visible));
  const end = evaluateTextEffect(settings, '遗失的片段。\n仍然记得。', 2000);
  assert.ok(end.characters.every((item) => !item.visible));
});
