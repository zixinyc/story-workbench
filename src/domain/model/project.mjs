import { makeId, defaultSettings, validateCueSettings, validateDocument } from './document.mjs';
import { musicRangeParagraphIds } from './chapters.mjs';

export const SCHEMA_VERSION = 2;

const demoLines = [
  ['如果说系统真的存在于这个世界上的话，那它一定不会是这样子。'],
  ['你还没感到异常吗？', { mode: 'dialogue', speaker: '【红色的？？】', advance: 'click' }],
  ['自从脑子里突然出现这个信息开始，'],
  ['应子汐好像活在过去一样，'],
  ['感觉什么都已经经历过了，只是重复地再过一天而已。'],
  ['唉，这循环到底什么时候是个头？', { mode: 'free', speaker: '【红色的？？】', color: '#f27469', fontSize: 58, motion: 'rise', advance: 'timed' }],
  ['说实话，虽然【红】已经知道目前这个世界的究极金手指【project】，已经跟系统差不多了。'],
  ['可面对我——应子汐来说，我只是一名普通的学生罢了。'],
  ['如果面对末世，更多的只是无奈吧。况且可能还没末世呢。'],
  ['怎么真末世了？？？？', { mode: 'free', fontSize: 74, color: '#f27469', motion: 'shake', advance: 'timed', durationMs: 2600 }],
];

export function createDemoProject() {
  const blocks = demoLines.map(([text, settings]) => {
    const id = makeId('p');
    const textNode = { type: 'text', text };
    return {
      type: 'paragraph',
      id,
      children: settings
        ? [{ type: 'cue', id: makeId('cue'), settings: defaultSettings(settings), children: [textNode] }]
        : [textNode],
    };
  });
  const chapter = { id: makeId('chapter'), name: '第01章 · 序章', document: { type: 'doc', blocks }, groups: [], musicRanges: [] };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: makeId('project'),
    name: '应子汐 · 开场序章',
    canvas: { width: 1920, height: 1080 },
    activeChapterId: chapter.id,
    chapters: [chapter],
    assets: [],
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeProjectName(name) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) throw new Error('工程名称不能为空。');
  if (value.length > 120) throw new Error('工程名称最多 120 个字符。');
  return value;
}

export function renameProject(project, name) {
  return { ...project, name: normalizeProjectName(name), updatedAt: new Date().toISOString() };
}

export function createBlankProject() {
  const project = createDemoProject();
  return {
    ...project,
    name: '未命名剧情工程',
    chapters: project.chapters.map((chapter) => ({ ...chapter, name: '第01章', document: { type: 'doc', blocks: [] } })),
  };
}

export function validateProject(project) {
  if (!project || project.schemaVersion !== SCHEMA_VERSION) throw new Error(`不支持工程版本：${project?.schemaVersion ?? '未知'}。`);
  if (typeof project.id !== 'string' || !project.id || typeof project.name !== 'string') throw new Error('工程信息不完整。');
  if (!project.canvas || project.canvas.width !== 1920 || project.canvas.height !== 1080) throw new Error('工程画布尺寸无效。');
  if (!Array.isArray(project.chapters) || !project.chapters.length || project.chapters.length > 1000) throw new Error('工程章节列表无效。');
  const chapterIds = new Set();
  const globalNodeIds = new Set();
  for (const chapter of project.chapters) {
    if (typeof chapter.id !== 'string' || !chapter.id || chapterIds.has(chapter.id) || typeof chapter.name !== 'string' || !chapter.name.trim() || chapter.name.length > 120) throw new Error('章节 ID 或名称无效。');
    chapterIds.add(chapter.id);
    validateDocument(chapter.document);
    collectNodeIds(chapter.document, globalNodeIds);
  }
  if (!chapterIds.has(project.activeChapterId)) throw new Error('当前章节引用无效。');
  if (!Array.isArray(project.assets)) throw new Error('工程素材清单无效。');
  const assets = new Map();
  let totalAssetBytes = 0;
  for (const asset of project.assets) {
    if (typeof asset.id !== 'string' || !asset.id || asset.id.length > 200 || assets.has(asset.id) || typeof asset.name !== 'string' || !asset.name || asset.name.length > 255 || !['image', 'audio', 'video', 'article', 'other'].includes(asset.kind) || typeof asset.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+(?:;[\w=.+-]+)*$/.test(asset.mime) || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > 100 * 1024 * 1024) throw new Error('工程素材清单包含无效项目。');
    if (asset.kind === 'image' && !asset.mime.startsWith('image/')) throw new Error('图片素材 MIME 类型无效。');
    if (asset.kind === 'audio' && !asset.mime.startsWith('audio/')) throw new Error('音频素材 MIME 类型无效。');
    if (asset.kind === 'video' && asset.mime !== 'video/mp4') throw new Error('舞台视频目前只支持 MP4。');
    if (asset.kind === 'article' && !(/^(text\/|application\/pdf$)/.test(asset.mime))) throw new Error('文章素材 MIME 类型无效。');
    if (asset.width !== undefined && (!Number.isFinite(asset.width) || asset.width <= 0 || asset.width > 100000)) throw new Error('素材宽度无效。');
    if (asset.height !== undefined && (!Number.isFinite(asset.height) || asset.height <= 0 || asset.height > 100000)) throw new Error('素材高度无效。');
    totalAssetBytes += asset.size;
    if (totalAssetBytes > 512 * 1024 * 1024) throw new Error('工程素材总量超过 512 MB。');
    assets.set(asset.id, asset);
  }
  for (const chapter of project.chapters) {
    validateChapter(chapter, assets);
  }
  return true;
}

function collectNodeIds(document, ids) {
  const visit = (node) => {
    if (node.type === 'paragraph' || node.type === 'cue') {
      if (ids.has(node.id)) throw new Error('不同章节之间存在重复的段落或演出单元 ID。');
      ids.add(node.id);
    }
    node.children?.forEach(visit);
  };
  document.blocks.forEach(visit);
}

function validateChapter(chapter, assets) {
  const paragraphIndexes = new Map(chapter.document.blocks.map((block, index) => [block.id, index]));
  const grouped = new Set();
  const groupIds = new Set();
  if (!Array.isArray(chapter.groups) || chapter.groups.length > chapter.document.blocks.length) throw new Error('段落组列表无效。');
  for (const group of chapter.groups) {
    if (typeof group.id !== 'string' || !group.id || groupIds.has(group.id) || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 120 || !Array.isArray(group.paragraphIds) || !group.paragraphIds.length || typeof group.collapsed !== 'boolean') throw new Error('段落组结构无效。');
    groupIds.add(group.id);
    const indexes = group.paragraphIds.map((id) => paragraphIndexes.get(id));
    if (indexes.some((index) => index === undefined) || indexes.some((index) => grouped.has(chapter.document.blocks[index].id)) || indexes.at(-1) - indexes[0] + 1 !== indexes.length) throw new Error('段落组必须引用连续且未重复归组的正文段落。');
    group.paragraphIds.forEach((id) => grouped.add(id));
  }
  if (!Array.isArray(chapter.musicRanges)) throw new Error('背景音乐范围列表无效。');
  const rangeIds = new Set();
  const intervals = [];
  for (const range of chapter.musicRanges) {
    const start = paragraphIndexes.get(range.startParagraphId);
    const end = paragraphIndexes.get(range.endParagraphId);
    const asset = assets.get(range.assetId);
    const memberIds = musicRangeParagraphIds(chapter, range);
    const memberIndexes = memberIds.map((id) => paragraphIndexes.get(id)).sort((a, b) => a - b);
    const groupIdsValid = range.groupIds === undefined || (Array.isArray(range.groupIds) && range.groupIds.length > 0 && new Set(range.groupIds).size === range.groupIds.length && range.groupIds.every((id) => groupIds.has(id)));
    if (typeof range.id !== 'string' || !range.id || rangeIds.has(range.id) || !asset || asset.kind !== 'audio' || start === undefined || end === undefined || start > end || !groupIdsValid || !memberIndexes.length || memberIndexes.at(0) !== start || memberIndexes.at(-1) !== end || memberIndexes.at(-1) - memberIndexes[0] + 1 !== memberIndexes.length || !Number.isFinite(range.volume) || range.volume < 0 || range.volume > 1 || typeof range.loop !== 'boolean') throw new Error('背景音乐范围或素材引用无效。');
    rangeIds.add(range.id);
    intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  if (intervals.some((interval, index) => index > 0 && interval[0] <= intervals[index - 1][1])) throw new Error('背景音乐范围不能重叠。');
  if (chapter.document.blocks.some((block) => Object.hasOwn(block, 'musicRange'))) {
    for (const range of chapter.musicRanges) {
      const expectedIds = musicRangeParagraphIds(chapter, range);
      const expectedGroupIds = range.groupIds ?? null;
      for (const id of expectedIds) {
        const metadata = chapter.document.blocks.find((block) => block.id === id)?.musicRange;
        if (!metadata || metadata.id !== range.id || metadata.assetId !== range.assetId || metadata.volume !== range.volume || metadata.loop !== range.loop || JSON.stringify(metadata.groupIds ?? null) !== JSON.stringify(expectedGroupIds)) throw new Error('背景音乐段落标记与范围清单不一致。');
      }
    }
    for (const block of chapter.document.blocks) {
      if (block.musicRange && !chapter.musicRanges.some((range) => range.id === block.musicRange.id && musicRangeParagraphIds(chapter, range).includes(block.id))) throw new Error('正文引用了无效的背景音乐范围。');
    }
  }

  const checkCue = (node) => {
    if (node.type === 'cue') {
      validateCueSettings(node.settings);
      const layers = node.settings.sceneLayers ?? [];
      for (const layer of layers) {
        const asset = assets.get(layer.assetId);
        if (!asset || !['image', 'video'].includes(asset.kind)) throw new Error('场景图层引用了缺失或不支持的视觉素材。');
      }
      for (const [id, kind] of [[node.settings.backgroundId, 'image'], [node.settings.audioId, 'audio']]) {
        if (id && id !== '__clear__' && assets.get(id)?.kind !== kind) throw new Error(kind === 'image' ? '背景素材必须是图片。' : '句音效素材必须是音频。');
      }
    }
    node.children?.forEach(checkCue);
  };
  chapter.document.blocks.forEach(checkCue);
}
