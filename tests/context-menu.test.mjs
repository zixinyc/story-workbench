import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkspaceMenu, menuTitle } from '../src/ui/workspace-menu.ts';
import { commandForKey, deferToNativeMenu, fitMenu } from '../src/ui/context-menu-model.ts';
import { checkClipboardReferences, duplicateParagraph, duplicateSlice, validateClipboard } from '../src/editor/context-clipboard.ts';

const calls = [];
const action = (name) => () => { calls.push(name); };
const ACTIONS = {
  undo: action('undo'), redo: action('redo'), cut: action('cut'), copy: action('copy'), paste: action('paste'),
  deleteSelection: action('deleteSelection'), deleteParagraph: action('deleteParagraph'),
  convert: () => { calls.push('convert'); }, moveToGroup: (id) => { calls.push('move:' + id); },
  moveParagraph: (d) => { calls.push('moveParagraph:' + d); }, toggleCollapse: action('collapse'),
  insertImage: action('insertImage'), insertVideo: action('insertVideo'), insertAudio: (w) => { calls.push('audio:' + w); },
  importAsset: action('import'), applyAsset: (t) => { calls.push('apply:' + t); },
  copyAsset: action('copyAsset'), pasteAsset: action('pasteAsset'), removeAsset: action('removeAsset'),
  layerZ: (d) => { calls.push('layerZ:' + d); }, toggleLayerLock: action('lock'),
  duplicateLayer: action('dupLayer'), removeLayer: action('removeLayer'),
};

function facts(overrides = {}) {
  return {
    canUndo: true, canRedo: true, hasTextSelection: false, paragraphIndex: 0, paragraphCount: 3,
    groupCount: 0, collapsed: false, inGroup: false, mode: null, hasSpeaker: false,
    layerLocked: false, layerAtTop: false, layerAtBottom: false,
    assetKind: null, assetReferenced: false, canPaste: true,
    ...overrides,
  };
}
const target = (overrides = {}) => ({ kind: 'paragraph', projectId: 'p1', chapterId: 'c1', paragraphId: 'para-1', ...overrides });
const ids = (menu) => menu.map((c) => c.id);
const find = (menu, id) => menu.find((c) => c.id === id);
const flat = (menu) => menu.flatMap((c) => [c, ...(c.children ?? [])]);

test('正文段落菜单只提供真实可用的基础与对象操作', () => {
  const menu = buildWorkspaceMenu(target(), facts(), ACTIONS, []);
  assert.ok(ids(menu).includes('undo'));
  assert.ok(ids(menu).includes('delete'), '段落菜单必须有"删除此段"');
  assert.ok(!ids(menu).includes('delete-selection'), '无选区时不应出现"删除选中文字"');
  assert.equal(menuTitle(target(), facts()), '第 1 段');
});

test('有文字选区时改为操作选区，且不再提供删除此段', () => {
  const menu = buildWorkspaceMenu(target({ kind: 'text' }), facts({ hasTextSelection: true }), ACTIONS, []);
  assert.ok(ids(menu).includes('delete-selection'));
  assert.ok(!ids(menu).includes('delete'));
  assert.equal(find(menu, 'cut').label, '剪切选中文字');
  assert.equal(find(menu, 'copy').label, '复制选中文字');
});

test('章节首尾段落的排序边界禁用并给出具体原因', () => {
  const first = buildWorkspaceMenu(target({ paragraphId: 'para-1' }), facts({ paragraphIndex: 0, paragraphCount: 3 }), ACTIONS, []);
  assert.match(find(first, 'move-up').reason, /第一段/);
  assert.equal(find(first, 'move-down').reason, undefined);
  const last = buildWorkspaceMenu(target({ paragraphId: 'para-3' }), facts({ paragraphIndex: 2, paragraphCount: 3 }), ACTIONS, []);
  assert.match(find(last, 'move-down').reason, /最后一段/);
  assert.equal(find(last, 'move-up').reason, undefined);
});

test('没有已有组时"加入已有组"禁用并说明原因；有组时逐组列出', () => {
  const none = buildWorkspaceMenu(target(), facts(), ACTIONS, []);
  assert.match(find(none, 'move-to-group').reason, /还没有段落组/);
  const some = buildWorkspaceMenu(target({ groupId: 'g1' }), facts({ inGroup: true }), ACTIONS, [{ id: 'g1', name: '日常' }, { id: 'g2', name: '回忆' }]);
  const submenu = find(some, 'move-to-group');
  assert.equal(submenu.reason, undefined);
  assert.deepEqual(submenu.children.map((c) => c.label), ['第 1 组 · 日常', '第 2 组 · 回忆']);
  assert.match(submenu.children[0].reason, /已在该组/);
  assert.equal(submenu.children[1].reason, undefined);
});

test('加入已有组只作用于右键这一段，不带入多选', () => {
  const menu = buildWorkspaceMenu(target({ paragraphId: 'only-this' }), facts(), ACTIONS, [{ id: 'g9', name: '目标组' }]);
  calls.length = 0;
  find(menu, 'move-to-group').children[0].run();
  assert.deepEqual(calls, ['move:g9']);
});

test('未加入组时背景音乐入口禁用，提示先加入组', () => {
  const outside = buildWorkspaceMenu(target(), facts({ inGroup: false }), ACTIONS, []);
  assert.match(find(flat(outside), 'insert-audio-bgm').reason, /先加入组/);
  const inside = buildWorkspaceMenu(target({ groupId: 'g1' }), facts({ inGroup: true }), ACTIONS, []);
  assert.equal(find(flat(inside), 'insert-audio-bgm').reason, undefined);
});

test('折叠文案跟随当前折叠状态', () => {
  const open = buildWorkspaceMenu(target({ groupId: 'g1' }), facts({ collapsed: false }), ACTIONS, []);
  assert.equal(find(open, 'toggle-collapse').label, '折叠此组');
  const shut = buildWorkspaceMenu(target({ groupId: 'g1' }), facts({ collapsed: true }), ACTIONS, []);
  assert.equal(find(shut, 'toggle-collapse').label, '展开此组');
});

test('素材菜单按素材类型给出真实禁用原因', () => {
  const audio = buildWorkspaceMenu(target({ kind: 'asset', assetId: 'a1' }), facts({ assetKind: 'audio' }), ACTIONS, []);
  assert.match(find(audio, 'asset-background').reason, /只有图片/);
  assert.match(find(audio, 'asset-layer').reason, /只有图片或视频/);
  assert.equal(find(audio, 'asset-audio').reason, undefined);
  const image = buildWorkspaceMenu(target({ kind: 'asset', assetId: 'a2' }), facts({ assetKind: 'image' }), ACTIONS, []);
  assert.equal(find(image, 'asset-background').reason, undefined);
  assert.match(find(image, 'asset-article').reason, /文章/);
});

test('被引用的素材不能直接移除', () => {
  const free = buildWorkspaceMenu(target({ kind: 'asset', assetId: 'a1' }), facts({ assetKind: 'audio' }), ACTIONS, []);
  assert.equal(find(free, 'remove-asset').reason, undefined);
  const used = buildWorkspaceMenu(target({ kind: 'asset', assetId: 'a1' }), facts({ assetKind: 'audio', assetReferenced: true }), ACTIONS, []);
  assert.match(find(used, 'remove-asset').reason, /仍被剧情引用/);
});

test('图层菜单在锁定与层级边界处禁用，并说明不可用原因', () => {
  const locked = buildWorkspaceMenu(target({ kind: 'layer', layerId: 'l1' }), facts({ layerLocked: true, layerAtTop: true, layerAtBottom: true }), ACTIONS, []);
  assert.equal(find(locked, 'layer-lock').label, '解锁图层');
  assert.match(find(locked, 'remove-layer').reason, /已锁定/);
  assert.match(find(locked, 'layer-front').reason, /最顶层/);
  assert.match(find(locked, 'layer-back').reason, /最底层/);
  const free = buildWorkspaceMenu(target({ kind: 'layer', layerId: 'l1' }), facts(), ACTIONS, []);
  assert.equal(find(free, 'remove-layer').reason, undefined);
  assert.equal(find(free, 'layer-front').reason, undefined);
});

test('D 键只在段落右键菜单打开时映射到删除此段', () => {
  const context = { kind: 'paragraph', projectId: 'p1', chapterId: 'c1', doc: null, focus: null };
  const menu = buildWorkspaceMenu(target(), facts(), ACTIONS, []);
  const key = (over = {}) => ({ key: 'd', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...over });
  assert.equal(commandForKey(flat(menu), key(), context, true)?.id, 'delete', '菜单打开时应命中删除');
  assert.equal(commandForKey(flat(menu), key(), context, false), null, '菜单未打开时 D 不得删除整段');
  assert.equal(commandForKey(flat(menu), key({ shiftKey: true }), context, true), null, 'Shift+D 不得触发');
  assert.equal(commandForKey(flat(menu), key({ isComposing: true }), context, true), null, '输入法组合中不得触发');
  const textMenu = buildWorkspaceMenu(target({ kind: 'text' }), facts({ hasTextSelection: true }), ACTIONS, []);
  assert.equal(commandForKey(flat(textMenu), key(), { ...context, kind: 'text' }, true), null, '文字选择菜单不得删整段');
});

test('菜单与快捷键共用同一份命令定义', () => {
  const menu = buildWorkspaceMenu(target(), facts(), ACTIONS, []);
  const context = { kind: 'paragraph', projectId: 'p1', chapterId: 'c1', doc: null, focus: null };
  const ctrl = (k) => ({ key: k, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false });
  assert.equal(commandForKey(flat(menu), ctrl('c'), context, false)?.id, 'copy');
  assert.equal(commandForKey(flat(menu), ctrl('x'), context, false)?.id, 'cut');
  assert.equal(commandForKey(flat(menu), ctrl('v'), context, false)?.id, 'paste');
  assert.equal(commandForKey(flat(menu), ctrl('z'), context, false)?.id, 'undo');
  assert.equal(commandForKey(flat(menu), ctrl('z', ), { ...context }, false)?.id, 'undo');
  assert.equal(commandForKey(flat(menu), { ...ctrl('z'), shiftKey: true }, context, false)?.id, 'redo');
  assert.equal(commandForKey(flat(menu), ctrl('y'), context, false)?.id, 'redo');
  // 菜单里的按钮和快捷键命中的是同一个对象
  assert.equal(commandForKey(flat(menu), ctrl('c'), context, false), find(menu, 'copy'));
});

test('菜单在窗口边缘避让，不会溢出视口', () => {
  const near = fitMenu(1590, 990, 280, 320, 1600, 1000);
  assert.ok(near.left + 280 <= 1600 && near.top + 320 <= 1000);
  assert.ok(near.left >= 8 && near.top >= 8);
  const topLeft = fitMenu(2, 3, 280, 320, 1600, 1000);
  assert.equal(topLeft.left, 8);
  assert.equal(topLeft.top, 8);
});

/* ── 剪贴板 ─────────────────────────────────────────────── */

const layer = (id, assetId) => ({ id, assetId, x: 100, y: 80, width: 640, height: 360, opacity: 1, zIndex: 0 });
const cue = (id, extra = {}) => ({ type: 'cue', id, settings: { mode: 'dialogue', speaker: '甲', color: '#ff0000', audioId: 'aud-1', sceneLayers: [layer('layer-old', 'img-1')], ...extra }, children: [{ type: 'text', text: '台词', color: '#00ff00' }] });
const block = () => ({ type: 'paragraph', id: 'p-old', groupId: 'g-1', children: [cue('c-old')] });

test('剪贴板载荷被完整校验，非法结构明确拒绝', () => {
  assert.throws(() => validateClipboard(null), /剪贴板剧情数据无效/);
  assert.throws(() => validateClipboard({ version: 2, projectId: 'p', kind: 'text' }), /剪贴板剧情数据无效/);
  assert.throws(() => validateClipboard({ version: 1, projectId: 'p', kind: 'text', value: {} }), /剪贴板文字结构无效/);
  assert.throws(() => validateClipboard({ version: 1, projectId: 'p', kind: 'asset', value: {} }), /剪贴板素材无效/);
  assert.throws(() => validateClipboard({ version: 1, projectId: 'p', kind: 'bogus', value: {} }), /剪贴板剧情数据无效/);
  const ok = validateClipboard({ version: 1, projectId: 'p', kind: 'paragraph', value: block() });
  assert.equal(ok.kind, 'paragraph');
});

test('素材与引用跨工程或缺失时明确拒绝', () => {
  const project = { id: 'p1', assets: [{ id: 'img-1', kind: 'image' }, { id: 'aud-1', kind: 'audio' }] };
  const other = { id: 'p2', assets: [{ id: 'img-1', kind: 'image' }] };
  const assetClip = (projectId) => ({ version: 1, projectId, kind: 'asset', value: { assetId: 'img-1' } });
  assert.throws(() => checkClipboardReferences(assetClip('p2'), project), /仅能在原工程粘贴/);
  assert.throws(() => checkClipboardReferences(assetClip('p1'), other), /仅能在原工程粘贴/);
  const para = { version: 1, projectId: 'p1', kind: 'paragraph', value: block() };
  assert.doesNotThrow(() => checkClipboardReferences(para, project));
  const broken = { version: 1, projectId: 'p1', kind: 'paragraph', value: { type: 'paragraph', id: 'x', children: [cue('c', { audioId: 'missing-audio' })] } };
  assert.throws(() => checkClipboardReferences(broken, project), /缺失或类型不符/);
});

test('复制整段重建段落、句和图层 ID，并保留颜色与演出信息', () => {
  const source = block();
  const before = JSON.stringify(source);
  const copy = duplicateParagraph(source, 'g-2', { id: 'm1', assetId: 'aud-1' });
  assert.notEqual(copy.id, source.id, '段落 ID 必须重建');
  assert.equal(copy.groupId, 'g-2');
  assert.deepEqual(copy.musicRange, { id: 'm1', assetId: 'aud-1' });
  const copyCue = copy.children[0];
  assert.notEqual(copyCue.id, 'c-old', '句 ID 必须重建');
  assert.equal(copyCue.settings.color, '#ff0000', '颜色必须保留');
  assert.equal(copyCue.settings.audioId, 'aud-1', '音效引用必须保留');
  assert.notEqual(copyCue.settings.sceneLayers[0].id, 'layer-old', '图层 ID 必须重建');
  assert.equal(copyCue.settings.sceneLayers[0].assetId, 'img-1', '素材引用必须保留');
  assert.equal(copyCue.children[0].color, '#00ff00', '局部颜色必须保留');
  assert.equal(JSON.stringify(source), before, '原对象不得被修改');
});

test('复制选区时同一句的分裂 mark 仍共享同一个新 ID', () => {
  const mark = (cueId) => ({ type: 'cue', attrs: { cueId, cueMeta: JSON.stringify({ mode: 'dialogue' }) } });
  const slice = {
    content: [{
      type: 'paragraph',
      attrs: { paragraphId: 'p-old', groupId: 'g-1' },
      content: [
        { type: 'text', text: '甲', marks: [mark('same')] },
        { type: 'text', text: '乙', marks: [mark('same'), { type: 'bold' }] },
        { type: 'text', text: '丙', marks: [mark('other')] },
      ],
    }],
  };
  const out = duplicateSlice(slice, 'g-2', null);
  assert.notEqual(out.content[0].attrs.paragraphId, 'p-old', '段落 ID 必须重建');
  assert.equal(out.content[0].attrs.groupId, 'g-2');
  const first = out.content[0].content;
  assert.equal(first[0].marks[0].attrs.cueId, first[1].marks[0].attrs.cueId, '同一句的分裂 mark 必须统一 ID');
  assert.notEqual(first[0].marks[0].attrs.cueId, 'same', 'ID 必须重建');
  assert.notEqual(first[2].marks[0].attrs.cueId, first[0].marks[0].attrs.cueId, '不同句必须得到不同 ID');
});

/* ── C 区正文右键入口 ──────────────────────────────────────────────
   回归缺陷：正文容器 ProseMirror 自身就是 contenteditable="true"，
   原实现只按 closest('[contenteditable="true"]') 判断，导致 C 区
   任意位置右键都提前 return，右键菜单在正文里永远不弹。 */

/** 造一个贴近真实 DOM 的桩：编辑器内部的元素，其 closest 能向上命中编辑器。 */
function editorStub() {
  const editorProxy = { tagName: 'DIV', isEditor: true };
  const inputSelf = { tagName: 'INPUT' };
  const inEditor = { inside: true, closest: (selector) => (selector.includes('[contenteditable="true"]') ? editorProxy : null) };
  const editorDom = { contains: (node) => node?.inside === true };
  return {
    editorDom,
    paragraph: inEditor,
    nestedSpan: { ...inEditor },
    /* 编辑器外的输入框：closest 命中自身 */
    outsideInput: { inside: false, closest: (selector) => (selector.includes('input') ? inputSelf : null) },
    /* 编辑器外的普通区域：不命中任何选择器 */
    outsideDiv: { inside: false, closest: () => null },
  };
}

test('C 区正文内的段落右键必须弹出工作台菜单', () => {
  const s = editorStub();
  assert.equal(deferToNativeMenu(s.paragraph, s.editorDom), false, '正文段落右键不得让给原生菜单');
});

test('C 区正文内嵌套的标记元素右键同样弹菜单', () => {
  const s = editorStub();
  assert.equal(deferToNativeMenu(s.nestedSpan, s.editorDom), false, '加粗/分段标记上的右键也必须能弹菜单');
});

test('编辑器之外的输入控件仍保留原生文字菜单', () => {
  const s = editorStub();
  assert.equal(deferToNativeMenu(s.outsideInput, s.editorDom), true, '属性框里的输入框不该被段落菜单劫持');
});

test('编辑器之外的普通区域右键照常弹工作台菜单', () => {
  const s = editorStub();
  assert.equal(deferToNativeMenu(s.outsideDiv, s.editorDom), false);
});

test('右键目标缺失时安全放行，不吞掉菜单', () => {
  assert.equal(deferToNativeMenu(null, { contains: () => false }), false);
  assert.equal(deferToNativeMenu(null, null), false);
});
