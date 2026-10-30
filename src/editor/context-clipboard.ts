import { Fragment, Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import type { Editor } from '@tiptap/core';
import { makeId, plainText, validateDocument, validateCueSettings, defaultSettings } from '../domain/model/document.mjs';
import { toEditorContent } from './story-editor.ts';

export type StoryClipboard = { version: 1; projectId: string; kind: 'paragraph' | 'text' | 'asset' | 'layer'; value: any };
export function validateClipboard(value: unknown): StoryClipboard {
  const payload = value as StoryClipboard;
  if (!payload || payload.version !== 1 || typeof payload.projectId !== 'string' || !['paragraph', 'text', 'asset', 'layer'].includes(payload.kind)) throw Error('剪贴板剧情数据无效。');
  if (payload.kind === 'paragraph') validateDocument({ type: 'doc', blocks: [payload.value] });
  if (payload.kind === 'text' && (!payload.value || !Array.isArray(payload.value.content))) throw Error('剪贴板文字结构无效。');
  if (payload.kind === 'asset' && typeof payload.value?.assetId !== 'string') throw Error('剪贴板素材无效。');
  if (payload.kind === 'layer') validateCueSettings(defaultSettings({ sceneLayers: [payload.value] }));
  return payload;
}
export function checkClipboardReferences(payload: StoryClipboard, project: any) {
  validateClipboard(payload);
  if (payload.kind === 'asset' && (payload.projectId !== project.id || !project.assets.some((asset: any) => asset.id === payload.value.assetId))) throw Error('素材副本仅能在原工程粘贴；跨工程请先导入素材。');
  const assets = new Map<string, any>(project.assets.map((asset: any) => [asset.id, asset]));
  const check = (id: string | null | undefined, kinds: string[]) => { if (id && id !== '__clear__' && (!assets.has(id) || !kinds.includes(assets.get(id).kind))) throw Error('剪贴板包含当前工程缺失或类型不符的素材，请先导入相应素材。'); };
  const settings = (value: any) => { validateCueSettings(defaultSettings(value)); check(value.backgroundId, ['image']); check(value.audioId, ['audio']); for (const layer of value.sceneLayers ?? []) check(layer.assetId, ['image', 'video']); };
  if (payload.kind === 'paragraph') for (const child of payload.value.children) if (child.type === 'cue') settings(child.settings);
  if (payload.kind === 'layer') check(payload.value.assetId, ['image', 'video']);
  if (payload.kind === 'text') {
    const visit = (node: any) => { for (const mark of node.marks ?? []) if (mark.type === 'cue') settings(JSON.parse(mark.attrs.cueMeta)); for (const child of node.content ?? []) visit(child); };
    for (const child of payload.value.content) visit(child);
  }
}
function duplicateSettings(value: any) {
  return { ...structuredClone(value), ...(value.sceneLayers ? { sceneLayers: value.sceneLayers.map((layer: any) => ({ ...structuredClone(layer), id: makeId('layer') })) } : {}) };
}
export function duplicateParagraph(value: any, groupId: string | null = null, musicRange: any = null) {
  validateDocument({ type: 'doc', blocks: [value] });
  const block = structuredClone(value);
  block.id = makeId('p'); block.groupId = groupId; block.musicRange = structuredClone(musicRange);
  for (const child of block.children) if (child.type === 'cue') { child.id = makeId('cue'); child.settings = duplicateSettings(child.settings); }
  return block;
}
export function duplicateSlice(value: any, groupId: string | null, musicRange: any) {
  const json = structuredClone(value), cues = new Map<string, { id: string; meta: string }>();
  const visit = (node: any) => {
    if (node.type === 'paragraph') node.attrs = { ...(node.attrs ?? {}), paragraphId: makeId('p'), groupId, musicRange: structuredClone(musicRange) };
    for (const mark of node.marks ?? []) if (mark.type === 'cue') {
      const old = String(mark.attrs.cueId);
      if (!cues.has(old)) cues.set(old, { id: makeId('cue'), meta: JSON.stringify(duplicateSettings(JSON.parse(mark.attrs.cueMeta))) });
      const copy = cues.get(old)!; mark.attrs = { ...mark.attrs, cueId: copy.id, cueMeta: copy.meta };
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const child of json.content ?? []) visit(child);
  return json;
}
export function paragraphPosition(editor: Editor, id: string) {
  let found: { from: number; to: number; node: any } | null = null;
  editor.state.doc.forEach((node, pos) => { if (node.type.name === 'paragraph' && String(node.attrs.paragraphId) === id) found = { from: pos, to: pos + node.nodeSize, node }; });
  return found as { from: number; to: number; node: any } | null;
}
export function deleteEditorParagraph(editor: Editor, id: string) {
  const range = paragraphPosition(editor, id); if (!range) throw Error('段落已不存在。');
  let tr = closeHistory(editor.state.tr);
  if (editor.state.doc.childCount === 1) tr = tr.replaceWith(range.from, range.to, editor.schema.nodes.paragraph.create({ paragraphId: makeId('p'), groupId: range.node.attrs.groupId, musicRange: range.node.attrs.musicRange }));
  else tr = tr.delete(range.from, range.to);
  editor.view.dispatch(tr); return true;
}
export function pasteEditorClipboard(editor: Editor, payload: StoryClipboard | null, text: string, paragraphId: string, selection?: { anchor: number; head: number }) {
  const range = paragraphPosition(editor, paragraphId); if (!range) throw Error('粘贴目标已不存在。');
  const { groupId, musicRange } = range.node.attrs;
  let tr = closeHistory(editor.state.tr);
  if (payload?.kind === 'paragraph') {
    const block = duplicateParagraph(payload.value, groupId, musicRange), json = toEditorContent({ type: 'doc', blocks: [block] });
    const node = editor.schema.nodeFromJSON(json.content![0]); tr = tr.insert(range.to, node).setSelection(TextSelection.create(tr.doc, range.to + 1));
  } else {
    const anchor = selection?.anchor ?? range.to - 1, head = selection?.head ?? anchor;
    tr = tr.setSelection(TextSelection.create(tr.doc, anchor, head));
    if (payload?.kind === 'text') tr = tr.replaceSelection(Slice.fromJSON(editor.schema, duplicateSlice(payload.value, groupId, musicRange)));
    else if (text) {
      const blocks = text.replace(/\r\n?/g, '\n').split('\n').map((value) => editor.schema.nodes.paragraph.create({ paragraphId: makeId('p'), groupId, musicRange }, value ? editor.schema.text(value) : undefined));
      tr = tr.replaceSelection(new Slice(Fragment.fromArray(blocks), 1, 1));
    } else throw Error('剪贴板中没有可粘贴的正文。');
  }
  editor.view.dispatch(tr.scrollIntoView());
}
export function clipboardText(payload: StoryClipboard) {
  if (payload.kind === 'paragraph') return plainText(payload.value.children);
  return '';
}
