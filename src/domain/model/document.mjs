import { SUPPORTED_MOTIONS, validateMotionSettings } from '../../motion/effects.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'dialogue',
  speaker: '',
  fontSize: 48,
  color: '#f5f1e9',
  x: 960,
  y: 540,
  align: 'center',
  motion: 'none',
  advance: 'click',
  durationMs: 3500,
  backgroundId: null,
  audioId: null,
});

export function makeId(prefix = 'id') {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${value}`;
}

export function clone(value) {
  return structuredClone(value);
}

export function defaultSettings(overrides = {}) {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

export function plainText(nodes = []) {
  return nodes.map((node) => node.type === 'cue' ? plainText(node.children) : node.text ?? '').join('');
}

export function plainCueId(paragraphId, index, reserved = new Set()) {
  let id = String(paragraphId) + '-plain-' + index;
  while (reserved.has(id)) id += '-raw';
  return id;
}

export function compileDocument(document) {
  const cues = [];
  const reserved = new Set((document.blocks ?? []).flatMap((paragraph) => paragraph.children.filter((node) => node.type === 'cue').map((node) => node.id)));
  for (const paragraph of document.blocks ?? []) {
    let loose = [];
    let looseIndex = 0;
    const flushLoose = () => {
      const text = plainText(loose);
      if (text.trim()) {
        const id = plainCueId(paragraph.id, looseIndex, reserved);
        cues.push({ id, paragraphId: paragraph.id, settings: defaultSettings(), children: clone(loose), text });
        looseIndex += 1;
      }
      loose = [];
    };

    for (const node of paragraph.children ?? []) {
      if (node.type === 'cue') {
        flushLoose();
        const settings = defaultSettings(node.settings);
        cues.push({ id: node.id, paragraphId: paragraph.id, settings, children: clone(node.children), text: plainText(node.children) });
      } else {
        loose.push(clone(node));
      }
    }
    flushLoose();
  }
  return cues.filter((cue) => cue.text.trim());
}


export function resolveState(plan, cueId) {
  let backgroundId = null;
  let sceneLayers = [];
  for (const cue of plan) {
    if (cue.settings.backgroundId === '__clear__') backgroundId = null;
    else if (cue.settings.backgroundId) backgroundId = cue.settings.backgroundId;
    if (Array.isArray(cue.settings.sceneLayers)) sceneLayers = clone(cue.settings.sceneLayers);
    if (cue.id === cueId) return { backgroundId, sceneLayers };
  }
  return { backgroundId: null, sceneLayers: [] };
}

export function validateDocument(document) {
  if (!document || document.type !== 'doc' || !Array.isArray(document.blocks)) throw new Error('工程正文结构无效。');
  const ids = new Set();
  const visit = (node) => {
    if (node.type === 'paragraph' || node.type === 'cue') {
      if (!node.id || ids.has(node.id)) throw new Error('段落或演出单元 ID 缺失或重复。');
      ids.add(node.id);
      if (!Array.isArray(node.children)) throw new Error('正文节点缺少内容。');
      if (node.type === 'cue' && node.settings?.sceneLayers !== undefined) {
        if (!Array.isArray(node.settings.sceneLayers)) throw new Error('场景图层结构无效。');
        const layerIds = new Set();
        for (const layer of node.settings.sceneLayers) {
          if (typeof layer.id !== 'string' || !layer.id || layerIds.has(layer.id) || typeof layer.assetId !== 'string' || !layer.assetId) throw new Error('场景图层 ID 或素材引用无效。');
          if (![layer.x, layer.y, layer.width, layer.height, layer.opacity, layer.zIndex].every(Number.isFinite)) throw new Error('场景图层位置或尺寸无效。');
          if (layer.x < 0 || layer.x > 1920 || layer.y < 0 || layer.y > 1080 || layer.width <= 0 || layer.width > 3840 || layer.height <= 0 || layer.height > 2160 || layer.opacity < 0 || layer.opacity > 1 || !Number.isInteger(layer.zIndex) || layer.zIndex < 0) throw new Error('场景图层尺寸、坐标、层级或透明度超出范围。');
          if (layer.rotation !== undefined && (!Number.isFinite(layer.rotation) || Math.abs(layer.rotation) > 3600)) throw new Error('场景图层旋转角度无效。');
          if (['flipX', 'flipY', 'locked', 'hidden', 'videoMuted', 'videoLoop'].some((key) => layer[key] !== undefined && typeof layer[key] !== 'boolean')) throw new Error('场景图层开关无效。');
          if (layer.fit !== undefined && !['contain', 'cover', 'fill'].includes(layer.fit)) throw new Error('场景图层适配方式无效。');
          if (layer.videoVolume !== undefined && (!Number.isFinite(layer.videoVolume) || layer.videoVolume < 0 || layer.videoVolume > 1)) throw new Error('视频原声音量无效。');
          if (layer.videoStartMs !== undefined && (!Number.isFinite(layer.videoStartMs) || layer.videoStartMs < 0)) throw new Error('视频片段起点无效。');
          if (layer.videoEndMs !== undefined && (!Number.isFinite(layer.videoEndMs) || layer.videoEndMs <= (layer.videoStartMs ?? 0))) throw new Error('视频片段终点必须晚于起点。');
          if (layer.crop !== undefined) {
            const crop = layer.crop;
            if (!crop || !['left', 'top', 'right', 'bottom'].every((key) => Number.isFinite(crop[key]) && crop[key] >= 0 && crop[key] < 0.95) || crop.left + crop.right >= 0.95 || crop.top + crop.bottom >= 0.95) throw new Error('图片裁剪范围无效。');
          }
          layerIds.add(layer.id);
        }
      }
      if (node.type === 'cue') validateCueSettings(node.settings);
      node.children.forEach(visit);
      return;
    }
    if (node.type === 'text') {
      if (typeof node.text !== 'string') throw new Error('正文文字格式无效。');
      if (node.color !== undefined && (typeof node.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(node.color))) throw new Error('正文颜色格式无效。');
      return;
    }
    throw new Error('工程包含不支持的正文节点。');
  };
  document.blocks.forEach((block) => {
    if (block.type !== 'paragraph') throw new Error('正文段落格式无效。');
    visit(block);
  });
  return true;
}

export function validateCueSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('演出设置结构无效。');
  const settings = { ...DEFAULT_SETTINGS, ...value };
  if (!['dialogue', 'free'].includes(settings.mode)) throw new Error('演出模式无效。');
  if (typeof settings.speaker !== 'string' || settings.speaker.length > 120) throw new Error('说话人名称无效。');
  if (!Number.isFinite(settings.fontSize) || settings.fontSize < 8 || settings.fontSize > 256) throw new Error('字号必须在 8–256 之间。');
  if (typeof settings.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(settings.color)) throw new Error('演出颜色格式无效。');
  if (!Number.isFinite(settings.x) || settings.x < 0 || settings.x > 1920 || !Number.isFinite(settings.y) || settings.y < 0 || settings.y > 1080) throw new Error('演出坐标超出画布范围。');
  if (!['left', 'center', 'right'].includes(settings.align)) throw new Error('文字对齐方式无效。');
  if (!SUPPORTED_MOTIONS.has(settings.motion)) throw new Error('动效类型无效。');
  validateMotionSettings(settings.motion, settings.motionSettings);
  if (!['click', 'timed'].includes(settings.advance)) throw new Error('下一句推进方式无效。');
  if (!Number.isFinite(settings.durationMs) || settings.durationMs < 500 || settings.durationMs > 600000) throw new Error('演出时长必须在 0.5–600 秒之间。');
  for (const reference of [settings.backgroundId, settings.audioId]) {
    if (reference !== null && reference !== '__clear__' && (typeof reference !== 'string' || reference.length > 200)) throw new Error('素材引用格式无效。');
  }
  if (settings.sceneLayers !== undefined && !Array.isArray(settings.sceneLayers)) throw new Error('场景图层结构无效。');
}
