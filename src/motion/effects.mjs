export const MOTION_PRESETS = [
  { id: 'none', name: '无动效', summary: '静态显示完整文字' },
  { id: 'typing', name: '普通打字', summary: '按固定速度逐字显现' },
  { id: 'blurSharp', name: '模糊变清晰', summary: '文字从柔焦逐步变清楚' },
  { id: 'rise', name: '上移淡入', summary: '轻微上移并淡入' },
  { id: 'shake', name: '轻微震动', summary: '短时、小幅度震动' },
  { id: 'decode', name: 'D01 解码显字', summary: '只有新字短暂乱码，随后固定' },
  { id: 'wordUnderline', name: 'D02 逐词出字与扫线', summary: '按词组出现，下划线跟随当前词推进' },
  { id: 'keywordChip', name: 'D03 关键词反色强调', summary: '关键词完整出现后切换反色块' },
  { id: 'translationWires', name: 'D04 双语词块连线', summary: '中文词块与英文词组之间生长连线' },
  { id: 'rewrite', name: 'D05 犹豫退格重写', summary: '先写草稿、停顿、退格，再重写' },
  { id: 'strikeRewrite', name: 'D06 划掉再改写', summary: '旧句先可读，再划线、收拢并写新句' },
  { id: 'evaporate', name: 'D07 原位蒸发与末句退格', summary: '按固定种子原位消失，保护句最后退格' },
  { id: 'verticalReveal', name: 'RP-A2 竖排递进', summary: '固定字槽从上向下显字，按列阅读后退出' },
  { id: 'ghostConverge', name: 'RP-F1 错色残影收敛', summary: '正文保持可读，青紫残影分离后回到清晰文字' },
];

export const SUPPORTED_MOTIONS = new Set(MOTION_PRESETS.map((item) => item.id));

const numberRule = (min, max, integer = false) => ({ type: 'number', min, max, ...(integer ? { integer: true } : {}) });
const textRule = (maxLength = 20000) => ({ type: 'string', maxLength });
const boolRule = { type: 'boolean' };
const colorRule = { type: 'color' };
export const MOTION_PARAMETER_RULES = {
  none: {},
  typing: { startMs: numberRule(0, 600000), charStepMs: numberRule(1, 5000), holdMs: numberRule(0, 600000) },
  blurSharp: { strength: numberRule(0, 1), clearMs: numberRule(1, 60000) },
  rise: { strength: numberRule(0, 1), risePx: numberRule(0, 1000), fadeMs: numberRule(1, 60000) },
  shake: { strength: numberRule(0, 1), durationMs: numberRule(1, 60000) },
  decode: { seed: numberRule(-2147483648, 2147483647, true), startMs: numberRule(0, 600000), charStepMs: numberRule(1, 5000), settleMs: numberRule(1, 5000), holdMs: numberRule(0, 600000), exitMs: numberRule(0, 60000) },
  wordUnderline: { wordsText: textRule(), startMs: numberRule(0, 600000), wordDurationMs: numberRule(1, 30000), charStepMs: numberRule(1, 5000), underlineThickness: numberRule(1, 20), holdMs: numberRule(0, 600000), exitMs: numberRule(0, 60000) },
  keywordChip: { keywordsText: textRule(), startMs: numberRule(0, 600000), charStepMs: numberRule(1, 5000), chipPadding: numberRule(0, 60), chipColor: colorRule, chipTextColor: colorRule, showIds: boolRule, holdMs: numberRule(0, 600000), exitMs: numberRule(0, 60000) },
  translationWires: { englishText: textRule(), chineseText: textRule(), mappingText: textRule(), lineGrowMs: numberRule(1, 30000), startMs: numberRule(0, 600000), holdMs: numberRule(0, 600000), exitMs: numberRule(0, 60000) },
  rewrite: { draftText: textRule(), rewriteText: textRule(), startMs: numberRule(0, 600000), pauseMs: numberRule(0, 60000), deleteCount: numberRule(0, 10000, true), typeCps: numberRule(0.1, 100), backspaceCps: numberRule(0.1, 100), holdMs: numberRule(0, 600000) },
  strikeRewrite: { oldText: textRule(), newText: textRule(), strikeAtMs: numberRule(0, 600000), strikeDrawMs: numberRule(1, 10000), strikeHoldMs: numberRule(0, 60000), collapseMs: numberRule(1, 10000), typeCps: numberRule(0.1, 100), holdMs: numberRule(0, 600000), strikeColor: colorRule },
  evaporate: { seed: numberRule(-2147483648, 2147483647, true), protectedText: textRule(), evaporationStartMs: numberRule(0, 600000), evaporationEndMs: numberRule(1, 600000), finalHoldMs: numberRule(0, 60000), backspaceDurationMs: numberRule(1, 60000) },
  verticalReveal: { startMs: numberRule(0, 600000), charStepMs: numberRule(1, 5000), columnLength: numberRule(2, 16, true), holdMs: numberRule(0, 600000), columnExitStepMs: numberRule(0, 5000), exitMs: numberRule(1, 60000) },
  ghostConverge: { startMs: numberRule(0, 600000), fadeMs: numberRule(1, 60000), changeAtMs: numberRule(0, 600000), splitMs: numberRule(1, 60000), returnMs: numberRule(1, 60000), offsetEm: numberRule(0, 1), strength: numberRule(0, 1), holdMs: numberRule(0, 600000), exitMs: numberRule(1, 60000) },
};

export function defaultMotionSettings(motion, text = '') {
  const chars = graphemes(text);
  const lastLine = String(text).split('\n').at(-1) ?? '';
  switch (motion) {
    case 'typing': return { startMs: 250, charStepMs: 70, holdMs: 1000 };
    case 'blurSharp': return { strength: 1, clearMs: 650 };
    case 'rise': return { strength: 1, risePx: 22, fadeMs: 600 };
    case 'shake': return { strength: 0.35, durationMs: 800 };
    case 'decode': return { seed: 17, startMs: 400, charStepMs: 100, settleMs: 80, holdMs: 1200, exitMs: 300 };
    case 'wordUnderline': return { wordsText: text.trim().split(/\s+/).filter(Boolean).join(' / ') || text, startMs: 500, wordDurationMs: 430, charStepMs: 65, underlineThickness: 2, holdMs: 1200, exitMs: 300 };
    case 'keywordChip': return { keywordsText: '', startMs: 500, charStepMs: 55, chipPadding: 7, chipColor: '#252b26', chipTextColor: '#fff8eb', showIds: false, holdMs: 1200, exitMs: 300 };
    case 'translationWires': return { englishText: '', chineseText: '', mappingText: '', lineGrowMs: 120, startMs: 500, holdMs: 1200, exitMs: 300 };
    case 'rewrite': return { draftText: chars.slice(0, Math.max(1, Math.ceil(chars.length * 0.55))).join(''), rewriteText: text, startMs: 500, pauseMs: 700, deleteCount: 2, typeCps: 8, backspaceCps: 12, holdMs: 1200 };
    case 'strikeRewrite': return { oldText: text, newText: text, strikeAtMs: 1400, strikeDrawMs: 120, strikeHoldMs: 300, collapseMs: 150, typeCps: 4, holdMs: 1200, strikeColor: '#b84a43' };
    case 'evaporate': return { seed: 31, protectedText: lastLine, evaporationStartMs: 1600, evaporationEndMs: 4300, finalHoldMs: 700, backspaceDurationMs: 700 };
    case 'verticalReveal': return { startMs: 500, charStepMs: 200, columnLength: 8, holdMs: 1200, columnExitStepMs: 100, exitMs: 300 };
    case 'ghostConverge': return { startMs: 250, fadeMs: 500, changeAtMs: 2200, splitMs: 550, returnMs: 1250, offsetEm: 0.28, strength: 1, holdMs: 1200, exitMs: 300 };
    default: return {};
  }
}

export function evaluateTextEffect(settings, text, elapsedMs) {
  const motion = settings?.motion ?? 'none';
  const parameters = { ...defaultMotionSettings(motion, text), ...(settings?.motionSettings ?? {}) };
  const time = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const chars = graphemes(text);
  const base = { motion, parameters, time, text: String(text ?? ''), characters: chars.map((char) => ({ text: char, visible: true, opacity: 1 })), transform: '', opacity: 1, blurPx: 0, words: null, keywords: [], translation: null, strike: null };
  if (motion === 'verticalReveal') {
    const plan = verticalPhasePlan(parameters, text);
    const columns = plan.columns.map((column, index) => ({
      characters: column.map((item) => ({ ...item, visible: time >= parameters.startMs + item.order * parameters.charStepMs })),
      opacity: 1 - clamp((time - plan.exitAt - index * parameters.columnExitStepMs) / parameters.exitMs),
    }));
    return { ...base, mode: 'verticalReveal', columns, rows: plan.rows };
  }
  if (motion === 'ghostConverge') {
    const plan = ghostPhasePlan(parameters);
    const local = time - plan.changeAt;
    const splitProgress = clamp(local / Math.min(220, parameters.splitMs));
    const returnProgress = clamp((local - parameters.splitMs) / parameters.returnMs);
    const smoothReturn = returnProgress * returnProgress * (3 - 2 * returnProgress);
    const ghostAmount = local < 0 ? 0 : splitProgress * (1 - smoothReturn) * parameters.strength;
    return { ...base, mode: 'ghostConverge', ghostAmount, ghostOffsetEm: parameters.offsetEm * ghostAmount, opacity: clamp((time - parameters.startMs) / parameters.fadeMs) * exitAfter(time, plan.completeAt, parameters.holdMs, parameters.exitMs) };
  }
  if (motion === 'typing') {
    const visibleCount = Math.min(chars.length, Math.max(0, Math.floor((time - parameters.startMs) / parameters.charStepMs) + 1));
    return { ...base, mode: 'characters', characters: chars.map((char, index) => ({ text: char, visible: index < visibleCount, opacity: index < visibleCount ? 1 : 0 })) };
  }
  if (motion === 'blurSharp') {
    const progress = clamp(time / parameters.clearMs);
    return { ...base, mode: 'plain', blurPx: (1 - progress) * 10 * parameters.strength };
  }
  if (motion === 'rise') {
    const progress = clamp(time / parameters.fadeMs);
    return { ...base, mode: 'plain', opacity: progress, transform: `translateY(${(1 - progress) * parameters.risePx * parameters.strength}px)` };
  }
  if (motion === 'shake') {
    const progress = clamp(time / parameters.durationMs);
    const angle = time < parameters.durationMs ? Math.sin(time / 42) * parameters.strength * 2.4 * (1 - progress * 0.45) : 0;
    return { ...base, mode: 'plain', transform: `rotate(${angle}deg)` };
  }
  if (motion === 'decode') {
    const slots = chars.map((char, index) => {
      const start = parameters.startMs + index * parameters.charStepMs;
      if (time < start) return { text: char, visible: false, glitch: null };
      if (time < start + parameters.settleMs && !/[\s，。！？、；：,.!?]/u.test(char)) return { text: char, visible: true, glitch: glitchGlyph(parameters.seed, index, char) };
      return { text: char, visible: true, glitch: null };
    });
    const lastStart = parameters.startMs + Math.max(0, chars.length - 1) * parameters.charStepMs + parameters.settleMs;
    const exit = time > lastStart + parameters.holdMs ? clamp((lastStart + parameters.holdMs + parameters.exitMs - time) / parameters.exitMs) : 1;
    return { ...base, mode: 'decode', characters: slots, opacity: exit };
  }
  if (motion === 'wordUnderline') {
    const plan = wordPhasePlan(parameters, text);
    const words = plan.words.map((item) => {
      const local = time - item.start;
      const visibleCount = Math.min(item.chars.length, Math.max(0, Math.floor(local / parameters.charStepMs) + 1));
      const progress = clamp(local / Math.max(1, item.span));
      return { text: item.text, startIndex: item.startIndex, spaceAfter: item.spaceAfter, characters: item.chars.map((char, charIndex) => ({ text: char, visible: charIndex < visibleCount, opacity: charIndex < visibleCount ? 1 : 0 })), underline: local >= 0 && local < item.span + 250 ? progress : 0 };
    });
    return { ...base, mode: 'wordUnderline', words, opacity: exitAfter(time, plan.completeAt, parameters.holdMs, parameters.exitMs) };
  }
  if (motion === 'keywordChip') {
    const visibleCount = Math.min(chars.length, Math.max(0, Math.floor((time - parameters.startMs) / parameters.charStepMs) + 1));
    const keywords = parseList(parameters.keywordsText).flatMap((keyword) => allOccurrences(String(text), keyword).map(([start, end]) => ({ text: keyword, start, end, complete: visibleCount >= end })));
    return { ...base, mode: 'keywordChip', characters: chars.map((char, index) => ({ text: char, visible: index < visibleCount, opacity: index < visibleCount ? 1 : 0 })), keywords, opacity: exitAfter(time, parameters.startMs + chars.length * parameters.charStepMs, parameters.holdMs, parameters.exitMs) };
  }
  if (motion === 'translationWires') {
    const sourceWords = String(parameters.englishText || '').trim().split(/\s+/).filter(Boolean);
    const targetWords = parseList(parameters.chineseText);
    const mappings = parseMappings(parameters.mappingText, sourceWords, targetWords);
    return { ...base, mode: 'translationWires', translation: { sourceWords, targetWords, mappings, lineProgress: clamp((time - parameters.startMs) / parameters.lineGrowMs) }, opacity: exitAfter(time, parameters.startMs, parameters.holdMs, parameters.exitMs) };
  }
  if (motion === 'rewrite') {
    const draft = graphemes(String(parameters.draftText ?? ''));
    const revised = graphemes(String(parameters.rewriteText ?? text));
    const cps = Math.max(1, parameters.typeCps);
    const firstFinish = parameters.startMs + draft.length / cps * 1000;
    const deleteStart = firstFinish + parameters.pauseMs;
    const deleteCount = Math.min(draft.length, Math.max(0, parameters.deleteCount));
    const deleteEnd = deleteStart + deleteCount / Math.max(1, parameters.backspaceCps) * 1000;
    let visibleText = '';
    if (time < parameters.startMs) visibleText = '';
    else if (time < firstFinish) visibleText = draft.slice(0, Math.min(draft.length, Math.floor((time - parameters.startMs) / 1000 * cps) + 1)).join('');
    else if (time < deleteStart) visibleText = draft.join('');
    else if (time < deleteEnd && deleteCount) visibleText = draft.slice(0, Math.max(0, draft.length - Math.floor((time - deleteStart) / 1000 * parameters.backspaceCps) - 1)).join('');
    else if (time < deleteEnd + revised.length / cps * 1000) visibleText = revised.slice(0, Math.min(revised.length, Math.floor((time - deleteEnd) / 1000 * cps) + 1)).join('');
    else visibleText = revised.join('');
    return { ...base, mode: 'rewrite', visibleText, caret: time >= parameters.startMs && time < deleteEnd + revised.length / cps * 1000, caretVisible: Math.floor(time / 450) % 2 === 0, opacity: 1 };
  }
  if (motion === 'strikeRewrite') {
    const oldText = String(parameters.oldText ?? text);
    const newText = String(parameters.newText ?? text);
    const drawStart = parameters.strikeAtMs;
    const drawEnd = drawStart + parameters.strikeDrawMs;
    const collapseStart = drawEnd + parameters.strikeHoldMs;
    const newStart = collapseStart + parameters.collapseMs;
    const newCount = Math.min(graphemes(newText).length, Math.max(0, Math.floor((time - newStart) / (1000 / Math.max(1, parameters.typeCps))) + 1));
    return { ...base, mode: 'strikeRewrite', oldText, newText, newVisible: time >= newStart, newCount, oldOpacity: time < collapseStart ? 1 : time < newStart ? 1 - clamp((time - collapseStart) / parameters.collapseMs) : 0, strikeProgress: clamp((time - drawStart) / parameters.strikeDrawMs), strikeVisible: time >= drawStart, strikeColor: parameters.strikeColor, opacity: time >= newStart + graphemes(newText).length / Math.max(1, parameters.typeCps) * 1000 + parameters.holdMs ? 0 : 1 };
  }
  if (motion === 'evaporate') {
    const protectedText = String(parameters.protectedText ?? '');
    const protectedCodeUnitStart = protectedText ? String(text).lastIndexOf(protectedText) : -1;
    const protectedStart = protectedCodeUnitStart < 0 ? -1 : graphemes(String(text).slice(0, protectedCodeUnitStart)).length;
    const protectedEnd = protectedStart < 0 ? -1 : protectedStart + graphemes(protectedText).length;
    const duration = Math.max(1, parameters.evaporationEndMs - parameters.evaporationStartMs);
    const charsFrame = chars.map((char, index) => {
      const isProtected = index >= protectedStart && index < protectedEnd;
      const threshold = parameters.evaporationStartMs + seededUnit(parameters.seed, index) * duration;
      let visible = isProtected || time < threshold;
      if (isProtected && time >= parameters.evaporationEndMs + parameters.finalHoldMs) {
        const deleteProgress = clamp((time - parameters.evaporationEndMs - parameters.finalHoldMs) / Math.max(1, parameters.backspaceDurationMs));
        visible = index - protectedStart < Math.ceil((1 - deleteProgress) * (protectedEnd - protectedStart));
      }
      return { text: char, visible, opacity: visible ? 1 : 0, protected: isProtected };
    });
    return { ...base, mode: 'evaporate', characters: charsFrame, opacity: 1 };
  }
  return { ...base, mode: 'plain' };
}

export function minimumMotionDuration(motion, text, parameters = {}) {
  const settings = { ...defaultMotionSettings(motion, text), ...parameters };
  const count = graphemes(text).length;
  if (motion === 'verticalReveal') return verticalPhasePlan(settings, text).total;
  if (motion === 'ghostConverge') return ghostPhasePlan(settings).total;
  if (motion === 'typing' || motion === 'keywordChip') return settings.startMs + count * (motion === 'typing' ? settings.charStepMs : settings.charStepMs) + settings.holdMs;
  if (motion === 'decode') return settings.startMs + count * settings.charStepMs + settings.settleMs + settings.holdMs + settings.exitMs;
  if (motion === 'wordUnderline') return wordPhasePlan(settings, text).total;
  if (motion === 'rewrite') return settings.startMs + graphemes(settings.draftText).length / settings.typeCps * 1000 + settings.pauseMs + settings.deleteCount / settings.backspaceCps * 1000 + graphemes(settings.rewriteText).length / settings.typeCps * 1000 + settings.holdMs;
  if (motion === 'strikeRewrite') return settings.strikeAtMs + settings.strikeDrawMs + settings.strikeHoldMs + settings.collapseMs + graphemes(settings.newText).length / settings.typeCps * 1000 + settings.holdMs;
  if (motion === 'evaporate') return settings.evaporationEndMs + settings.finalHoldMs + settings.backspaceDurationMs;
  if (motion === 'translationWires') return settings.startMs + settings.lineGrowMs + settings.holdMs + settings.exitMs;
  if (motion === 'blurSharp') return settings.clearMs + 1000;
  if (motion === 'rise') return settings.fadeMs + 1000;
  if (motion === 'shake') return settings.durationMs + 1000;
  return settings.holdMs ?? 0;
}

export function validateMotionSettings(motion, value) {
  if (value === undefined) return true;
  if (!SUPPORTED_MOTIONS.has(motion)) throw new Error('包含当前版本不支持的文字动效。');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文字动效参数结构无效。');
  const rules = MOTION_PARAMETER_RULES[motion] ?? {};
  for (const key of Object.keys(value)) if (!Object.hasOwn(rules, key)) throw new Error(`文字动效参数 ${key} 不适用于“${motion}”。`);
  for (const [key, rule] of Object.entries(rules)) {
    const item = value[key];
    if (item === undefined) continue;
    if (rule.type === 'number' && (!Number.isFinite(item) || item < rule.min || item > rule.max || (rule.integer && !Number.isInteger(item)))) throw new Error(`文字动效参数 ${key} 超出允许范围。`);
    if (rule.type === 'string' && (typeof item !== 'string' || item.length > rule.maxLength)) throw new Error(`文字动效参数 ${key} 格式无效。`);
    if (rule.type === 'boolean' && typeof item !== 'boolean') throw new Error(`${key} 必须是布尔值。`);
    if (rule.type === 'color' && (typeof item !== 'string' || !/^#[0-9a-f]{6}$/i.test(item))) throw new Error(`文字动效参数 ${key} 颜色格式无效。`);
  }
  if (motion === 'evaporate' && value.evaporationStartMs !== undefined && value.evaporationEndMs !== undefined && value.evaporationEndMs <= value.evaporationStartMs) throw new Error('原位蒸发结束时间必须晚于开始时间。');
  return true;
}

export function graphemes(value) {
  const text = String(value ?? '');
  if (typeof Intl.Segmenter === 'function') return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((item) => item.segment);
  return Array.from(text);
}

export function verticalPhasePlan(parameters, text) {
  const columns = [[]];
  let order = 0;
  graphemes(text).forEach((char, index) => {
    if (/^[\r\n]+$/.test(char)) { columns.push([]); return; }
    if (columns.at(-1).length >= parameters.columnLength) columns.push([]);
    columns.at(-1).push({ text: char, index, order: order++ });
  });
  const completeAt = parameters.startMs + Math.max(0, order - 1) * parameters.charStepMs;
  const exitAt = completeAt + parameters.holdMs;
  return { columns, rows: Math.max(1, ...columns.map((column) => column.length)), completeAt, exitAt, total: exitAt + Math.max(0, columns.length - 1) * parameters.columnExitStepMs + parameters.exitMs };
}

export function ghostPhasePlan(parameters) {
  const changeAt = Math.max(parameters.changeAtMs, parameters.startMs + parameters.fadeMs);
  const completeAt = changeAt + parameters.splitMs + parameters.returnMs;
  return { changeAt, completeAt, total: completeAt + parameters.holdMs + parameters.exitMs };
}

function parseWordGroups(value, text) {
  const words = String(value ?? '').split('/').map((item) => item.trim()).filter(Boolean);
  if (!words.length) return [text];
  return words.join('') === text || words.join(' ') === text ? words : [text];
}

// 词组阶段：每个词至少占用 wordDurationMs；词太长时延长到"最后一个字显现完"，
// 后一个词按累计时长开始，全文完成后才进入阅读停留与退场。
// 求帧与建议时长都引用这一份纯计算，避免出现"建议时长够、实际提前退场"的长中文显示不全。
export function wordPhasePlan(parameters, text) {
  const tokens = parseWordGroups(parameters.wordsText, String(text));
  const source = String(text);
  const hasSpace = source.includes(' ');
  let cursor = parameters.startMs;
  let offset = 0;
  const words = tokens.map((word, index) => {
    const chars = graphemes(word);
    const typeMs = Math.max(0, chars.length - 1) * parameters.charStepMs;
    const span = Math.max(parameters.wordDurationMs, typeMs);
    const spaceAfter = hasSpace && index < tokens.length - 1;
    const item = { text: word, chars, start: cursor, span, typedAt: cursor + typeMs, startIndex: offset, spaceAfter };
    cursor += span;
    offset += chars.length + (spaceAfter ? 1 : 0);
    return item;
  });
  return { words, completeAt: cursor, exitAt: cursor + parameters.holdMs, total: cursor + parameters.holdMs + parameters.exitMs };
}

function parseList(value) { return String(value ?? '').split(/[\/\n,，;]/).map((item) => item.trim()).filter(Boolean); }

function parseMappings(value, sourceWords, targetWords) {
  return String(value ?? '').split('\n').map((line) => {
    const [target, sources = ''] = line.split(':');
    const targetIndex = targetWords.indexOf(target.trim());
    const sourceIndexes = sources.split(/[,+、]/).map((word) => sourceWords.indexOf(word.trim())).filter((index) => index >= 0);
    return targetIndex >= 0 && sourceIndexes.length ? { targetIndex, sourceIndexes } : null;
  }).filter(Boolean);
}

function allOccurrences(text, target) {
  const starts = [];
  let position = 0;
  while (target && (position = text.indexOf(target, position)) >= 0) { starts.push([graphemes(text.slice(0, position)).length, graphemes(text.slice(0, position + target.length)).length]); position += target.length; }
  return starts;
}

function seededUnit(seed, index) {
  let value = (Number(seed) | 0) ^ Math.imul(index + 1, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function glitchGlyph(seed, index, original) {
  const glyphs = '▓▒░◇◆△▽○●×+*/?';
  const unit = seededUnit(seed, index);
  return graphemes(glyphs)[Math.floor(unit * graphemes(glyphs).length)] ?? original;
}

function exitAfter(time, completeAt, holdMs, exitMs) {
  if (time <= completeAt + holdMs || exitMs <= 0) return 1;
  return clamp((completeAt + holdMs + exitMs - time) / exitMs);
}

function clamp(value) { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
