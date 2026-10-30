import { paragraphBodyBounds } from './paragraph-drop-target.ts';
import { Extension, Mark, type Editor, type JSONContent } from '@tiptap/core';
import { Plugin, TextSelection, type Selection, type Transaction } from '@tiptap/pm/state';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { DEFAULT_SETTINGS, clone, makeId, defaultSettings, plainCueId, plainText, validateDocument } from '../domain/model/document.mjs';

export type CueSettings = {
  mode: 'dialogue' | 'free';
  speaker: string;
  fontSize: number;
  color: string;
  x: number;
  y: number;
  align: 'left' | 'center' | 'right';
  motion: 'none' | 'typing' | 'blurSharp' | 'rise' | 'shake' | 'decode' | 'wordUnderline' | 'keywordChip' | 'translationWires' | 'rewrite' | 'strikeRewrite' | 'evaporate' | 'verticalReveal' | 'ghostConverge';
  motionSettings?: Record<string, any>;
  advance: 'click' | 'timed';
  durationMs: number;
  backgroundId: string | null | '__clear__';
  audioId: string | null;
  sceneLayers?: Array<{ id: string; assetId: string; x: number; y: number; width: number; height: number; opacity: number; zIndex: number; rotation?: number; flipX?: boolean; flipY?: boolean; locked?: boolean; hidden?: boolean; fit?: 'contain' | 'cover' | 'fill'; crop?: { left: number; top: number; right: number; bottom: number }; videoStartMs?: number; videoEndMs?: number; videoMuted?: boolean; videoVolume?: number; videoLoop?: boolean }>;
};


export type ParagraphPresentation = {
  groupId: string | null; label: string; summary: string; musicLabel: string;
  paragraphSelected: boolean; groupSelected: boolean; groupDrop: boolean; groupDropLabel: string; dropBefore: boolean; dropAfter: boolean;
  collapsed?: boolean; groupStart?: boolean;
};
type ParagraphPresentationReader = (paragraphId: string) => ParagraphPresentation | null;

function projectParagraphWidget(element: HTMLElement, presentation: ParagraphPresentation | null) {
  if (!presentation) return;
  const title = element.querySelector<HTMLElement>('[data-group-title]');
  const summary = element.querySelector<HTMLElement>('[data-group-summary]');
  const music = element.querySelector<HTMLElement>('[data-group-music-button]');
  const label = element.querySelector<HTMLElement>('[data-paragraph-group-label]');
  const select = element.querySelector<HTMLElement>('[data-paragraph-select]');
  const marker = element.querySelector<HTMLElement>('[data-paragraph-drop-marker]');
  const caption = element.querySelector<HTMLElement>('[data-group-drop-caption]');
  const collapse = element.querySelector<HTMLButtonElement>('[data-group-collapse]');
  if (collapse) { collapse.textContent = presentation.collapsed ? '▸ 展开此组' : '▾ 折叠此组'; collapse.setAttribute('aria-expanded', String(!presentation.collapsed)); }
  if (marker) { marker.hidden = !presentation.dropBefore && !presentation.dropAfter; marker.textContent = presentation.dropBefore ? '放到此段之前' : '放到此段之后'; }
  if (caption) { caption.hidden = !presentation.groupDrop; caption.textContent = presentation.groupDropLabel; }
  if (title) title.textContent = presentation.label;
  if (summary) summary.textContent = presentation.summary;
  if (music) music.textContent = presentation.musicLabel;
  if (label) label.textContent = presentation.label;
  if (select) { select.textContent = presentation.paragraphSelected ? '■' : '□'; select.setAttribute('aria-pressed', String(presentation.paragraphSelected)); }
  if (element.dataset.groupHeader) {
    element.classList.toggle('selected', presentation.groupSelected);
    element.classList.toggle('drop-target', presentation.groupDrop);
  }
}

export function projectParagraphDecorations(root: HTMLElement, read: ParagraphPresentationReader) {
  for (const widget of root.querySelectorAll<HTMLElement>('[data-group-paragraph-id],[data-paragraph-tools]')) {
    projectParagraphWidget(widget, read(widget.dataset.groupParagraphId ?? widget.dataset.paragraphTools!));
  }
  for (const paragraph of root.querySelectorAll<HTMLElement>('p')) {
    const id = paragraph.getAttribute('data-paragraph-id') ?? paragraph.getAttribute('data-paragraphid');
    if (!id) continue;
    const presentation = read(id);
    paragraph.classList.toggle('group-collapsed-first', !!presentation?.collapsed && !!presentation.groupStart);
    paragraph.classList.toggle('group-collapsed-hidden', !!presentation?.collapsed && !presentation.groupStart);
    if (presentation?.collapsed) paragraph.contentEditable = 'false'; else paragraph.removeAttribute('contenteditable');
    paragraph.classList.toggle('paragraph-selected', !!presentation?.paragraphSelected);
    paragraph.classList.toggle('drop-before', !!presentation?.dropBefore);
    paragraph.classList.toggle('drop-after', !!presentation?.dropAfter);
    if (presentation?.dropBefore || presentation?.dropAfter) {
      const bounds = paragraph.getBoundingClientRect();
      const body = paragraphBodyBounds(paragraph);
      const line = presentation.dropBefore ? body.top - 4 : body.bottom + 4;
      paragraph.style.setProperty('--paragraph-drop-top', Math.max(0, line - bounds.top) + 'px');
    } else paragraph.style.removeProperty('--paragraph-drop-top');
  }
}

function buildParagraphDecorations(doc: ProseMirrorNode, read: ParagraphPresentationReader): DecorationSet {
  const widgets: Decoration[] = [];
  let previousGroupId: string | null = null;
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph' || !node.attrs.paragraphId) return;
    const groupId = node.attrs.groupId ? String(node.attrs.groupId) : null;
    if (!groupId) previousGroupId = null;
    if (groupId && groupId !== previousGroupId) {
      widgets.push(Decoration.widget(pos + 1, () => {
      const header = document.createElement('span');
      header.className = 'paragraph-group-header';
      header.contentEditable = 'false';
      header.dataset.groupHeader = groupId;
      header.dataset.groupParagraphId = String(node.attrs.paragraphId);
      header.dataset.groupDrop = groupId;
      const title = document.createElement('strong');
      title.dataset.groupTitle = '';
      title.textContent = '未分组';
      const summary = document.createElement('small');
      summary.dataset.groupSummary = '';
      summary.textContent = '';
      const music = document.createElement('button');
      music.type = 'button';
      music.className = 'paragraph-group-music';
      music.dataset.groupMusicButton = '';
      music.textContent = '＋ 添加背景音乐';
      music.addEventListener('mousedown', (event) => event.preventDefault());
      music.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        header.closest('.ProseMirror')?.dispatchEvent(new CustomEvent('story-group-music', { bubbles: true, detail: { groupId } }));
      });
      const caption = document.createElement('span');
      caption.className = 'paragraph-group-drop-caption'; caption.dataset.groupDropCaption = ''; caption.hidden = true;
      const collapse = document.createElement('button');
      collapse.type = 'button'; collapse.className = 'paragraph-group-collapse'; collapse.dataset.groupCollapse = groupId;
      collapse.addEventListener('mousedown', (event) => event.preventDefault());
      collapse.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); header.closest('.ProseMirror')?.dispatchEvent(new CustomEvent('story-group-collapse', { bubbles: true, detail: { groupId } })); });
      header.append(title, summary, music, collapse, caption);
      header.addEventListener('click', (event) => {
        if ((event.target as Element).closest('button')) return;
        event.preventDefault();
        event.stopPropagation();
        header.closest('.ProseMirror')?.dispatchEvent(new CustomEvent('story-group-select', { bubbles: true, detail: { groupId, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey } }));
      });
      projectParagraphWidget(header, read(String(node.attrs.paragraphId)));
      return header;
      }, { key: `paragraph-group-header:${groupId}:${node.attrs.paragraphId}`, side: -2 }));
    }
    previousGroupId = groupId;
    widgets.push(Decoration.widget(pos + 1, () => {
    const controls = document.createElement('span');
    controls.className = 'paragraph-editor-tools';
    controls.dataset.paragraphTools = String(node.attrs.paragraphId);
    controls.contentEditable = 'false';
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'paragraph-select-handle';
    select.textContent = '□';
    select.setAttribute('aria-label', '选择此正文段落');
    select.setAttribute('aria-pressed', 'false');
    select.dataset.paragraphSelect = String(node.attrs.paragraphId);
    select.addEventListener('mousedown', (event) => event.preventDefault());
    select.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      select.closest('.ProseMirror')?.dispatchEvent(new CustomEvent('story-paragraph-select', { bubbles: true, detail: { paragraphId: String(node.attrs.paragraphId), shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey } }));
    });
    controls.appendChild(select);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'paragraph-drag-handle';
    button.textContent = '⠿';
    button.title = '拖动整段正文';
    button.setAttribute('aria-label', '拖动整段正文');
    button.dataset.paragraphId = String(node.attrs.paragraphId);
    button.draggable = true;
    button.addEventListener('mousedown', (event) => event.stopPropagation());
    controls.appendChild(button);
    const label = document.createElement('span');
    label.className = 'paragraph-group-label';
    label.dataset.paragraphGroupLabel = String(node.attrs.paragraphId);
    controls.appendChild(label);
    const marker = document.createElement('span');
    marker.className = 'paragraph-insertion-guide'; marker.dataset.paragraphDropMarker = ''; marker.hidden = true;
    controls.appendChild(marker);
    projectParagraphWidget(controls, read(String(node.attrs.paragraphId)));
    return controls;
    }, { key: `paragraph-controls:${node.attrs.paragraphId}`, side: -1 }));
  });

  return DecorationSet.create(doc, widgets);
}

export const StoryAttributes = Extension.create<{ getParagraphPresentation: ParagraphPresentationReader }>({
  name: 'storyAttributes',
  addOptions() { return { getParagraphPresentation: () => null }; },
  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        groupId: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-group-id'),
          renderHTML: (attributes) => attributes.groupId ? { 'data-group-id': attributes.groupId } : {},
        },
        musicRange: {
          default: null,
          parseHTML: (element) => { try { return JSON.parse(element.getAttribute('data-music-range') || 'null'); } catch { return null; } },
          renderHTML: (attributes) => attributes.musicRange ? { 'data-music-range': JSON.stringify(attributes.musicRange) } : {},
        },
      },
    }, {
      types: ['doc'],
      attributes: {
        reviewToken: { default: null },
        chapterId: { default: null },
      },
    }];
  },
  addProseMirrorPlugins() {
    const read = this.options?.getParagraphPresentation ?? (() => null);
    const paragraphDecorations: Plugin<DecorationSet> = new Plugin<DecorationSet>({
      state: {
        init: (_config, state) => buildParagraphDecorations(state.doc, read),
        apply: (transaction, decorations, _oldState, state) => transaction.docChanged ? buildParagraphDecorations(state.doc, read) : decorations,
      },
      props: {
        decorations: (state) => paragraphDecorations.getState(state) ?? DecorationSet.empty,
      },
    });
    return [new Plugin({
      appendTransaction: (transactions, _oldState, state) => {
        if (!transactions.some((transaction) => transaction.docChanged)) return null;
        const tr = state.tr;
        const runs: Array<{ cueId: string; ranges: Array<{ from: number; to: number; attrs: Record<string, unknown> }> }> = [];
        const seenCueIds = new Set<string>();
        let lastOriginalId: string | null = null;
        let lastRun: (typeof runs)[number] | null = null;
        let lastTo = -1;

        state.doc.descendants((node, pos) => {
          if (node.type.name === 'paragraph') {
            lastOriginalId = null;
            lastRun = null;
            lastTo = -1;
            return;
          }
          if (!node.isInline) return;
          const cue = node.marks.find((mark) => mark.type.name === 'cue');
          if (!cue?.attrs.cueId) {
            lastOriginalId = null;
            lastRun = null;
            lastTo = -1;
            return;
          }
          const originalId = String(cue.attrs.cueId);
          if (lastOriginalId !== originalId || lastTo !== pos || !lastRun) {
            const uniqueId = seenCueIds.has(originalId) ? makeId('cue') : originalId;
            lastRun = { cueId: uniqueId, ranges: [] };
            runs.push(lastRun);
            seenCueIds.add(uniqueId);
            lastOriginalId = originalId;
          }
          lastRun.ranges.push({ from: pos, to: pos + node.nodeSize, attrs: cue.attrs });
          lastTo = pos + node.nodeSize;
        });

        for (const run of runs) {
          for (const range of run.ranges) {
            if (run.cueId !== range.attrs.cueId) {
              tr.addMark(range.from, range.to, state.schema.marks.cue.create({ ...range.attrs, cueId: run.cueId }));
            }
          }
        }
        return tr.docChanged ? tr : null;
      },
    }), paragraphDecorations];
  },
});

export const CueMark = Mark.create({
  name: 'cue',
  addOptions() { return {}; },
  addAttributes() {
    return {
      cueId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-cue-id'),
        renderHTML: (attributes) => ({ 'data-cue-id': attributes.cueId }),
      },
      cueMeta: {
        default: JSON.stringify(DEFAULT_SETTINGS),
        parseHTML: (element) => element.getAttribute('data-cue-meta') || JSON.stringify(DEFAULT_SETTINGS),
        renderHTML: (attributes) => ({ 'data-cue-meta': attributes.cueMeta }),
      },
      cueSource: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-cue-source'),
        renderHTML: (attributes) => attributes.cueSource ? { 'data-cue-source': attributes.cueSource } : {},
      },
    };
  },
  parseHTML() { return [{ tag: 'span[data-cue-id]' }]; },
  renderHTML({ HTMLAttributes }) { return ['span', HTMLAttributes, 0]; },
});

function cueAttributes(cueId: string, settings: CueSettings, cueSource?: string) {
  return { cueId, cueMeta: JSON.stringify(settings), ...(cueSource ? { cueSource } : {}) };
}

function flattenNodes(nodes: any[], inheritedCue?: { id: string; settings: CueSettings; source?: string }): JSONContent[] {
  const result: JSONContent[] = [];
  for (const node of nodes ?? []) {
    if (node.type === 'cue') {
      result.push(...flattenNodes(node.children, { id: node.id, settings: defaultSettings(node.settings) }));
      continue;
    }
    if (node.type !== 'text' || typeof node.text !== 'string') continue;
    const marks: NonNullable<JSONContent['marks']> = [];
    if (inheritedCue) marks.push({ type: 'cue', attrs: cueAttributes(inheritedCue.id, inheritedCue.settings, inheritedCue.source) });
    if (node.color) marks.push({ type: 'textStyle', attrs: { color: node.color } });
    if (node.text) result.push({ type: 'text', text: node.text, ...(marks.length ? { marks: clone(marks) } : {}) });
  }
  return result;
}

function flattenParagraphContent(paragraph: any, reserved: Set<string>): JSONContent[] {
  const result: JSONContent[] = [];
  let loose: any[] = [];
  let looseIndex = 0;
  const flushLoose = () => {
    if (plainText(loose).trim()) result.push(...flattenNodes(loose, { id: plainCueId(paragraph.id, looseIndex++, reserved), settings: defaultSettings(), source: 'plain' }));
    else result.push(...flattenNodes(loose));
    loose = [];
  };
  for (const node of paragraph.children ?? []) {
    if (node.type === 'cue') { flushLoose(); result.push(...flattenNodes([node])); }
    else loose.push(node);
  }
  flushLoose();
  return result;
}

export function toEditorContent(document: any, groups: Array<{ id: string; paragraphIds: string[] }> = [], musicRanges: any[] = []): JSONContent {
  const groupByParagraph = new Map(groups.flatMap((group) => group.paragraphIds.map((id) => [id, group.id] as const)));
  const reserved = new Set<string>(document.blocks.flatMap((block: any) => block.children.filter((node: any) => node.type === 'cue').map((node: any) => node.id)));
  const musicByParagraph = new Map<string, any>();
  for (const range of musicRanges) {
    let ids: string[] = [];
    if (range.groupIds?.length) ids = groups.filter((group) => range.groupIds.includes(group.id)).flatMap((group) => group.paragraphIds);
    else {
      const start = document.blocks.findIndex((block: any) => block.id === range.startParagraphId);
      const end = document.blocks.findIndex((block: any) => block.id === range.endParagraphId);
      if (start >= 0 && end >= start) ids = document.blocks.slice(start, end + 1).map((block: any) => block.id);
    }
    const data = { id: range.id, assetId: range.assetId, volume: range.volume, loop: range.loop, ...(range.groupIds ? { groupIds: range.groupIds } : {}) };
    ids.forEach((id) => musicByParagraph.set(id, data));
  }
  return {
    type: 'doc',
    attrs: { reviewToken: null },
    content: (document.blocks ?? []).map((paragraph: any) => ({
      type: 'paragraph',
      attrs: { paragraphId: paragraph.id, groupId: paragraph.groupId ?? groupByParagraph.get(paragraph.id) ?? null, musicRange: paragraph.musicRange ?? musicByParagraph.get(paragraph.id) ?? null },
      content: flattenParagraphContent(paragraph, reserved),
    })),
  };
}

function mergeText(target: any[], text: string, color?: string) {
  if (!text) return;
  const previous = target.at(-1);
  if (previous?.type === 'text' && previous.color === color) previous.text += text;
  else target.push({ type: 'text', text, ...(color ? { color } : {}) });
}

function nestedParagraphs(block: any): any[] {
  const result: any[] = [];
  const visit = (node: any, root = false) => {
    if (!root && node.type === 'paragraph') { result.push(node); return; }
    for (const child of node.content ?? []) visit(child);
  };
  visit(block, true);
  return result;
}

function visibleInlineNodes(block: any): any[] {
  const result: any[] = [];
  const visit = (node: any) => {
    if (node.type === 'text' || node.type === 'hardBreak') { result.push(node); return; }
    for (const child of node.content ?? []) visit(child);
  };
  visit(block);
  return result;
}

function appendEditorInline(children: any[], node: any) {
  const value = node.type === 'hardBreak' ? '\n' : node.type === 'text' ? String(node.text ?? '') : '';
  if (!value) return;
  const cueMark = node.marks?.find((mark: any) => mark.type === 'cue');
  const color = node.marks?.find((mark: any) => mark.type === 'textStyle')?.attrs?.color;
  const cueId = cueMark?.attrs?.cueId;
  if (cueId && cueMark?.attrs?.cueSource !== 'plain') {
    let cue = children.at(-1);
    if (cue?.type !== 'cue' || cue.id !== cueId) {
      cue = { type: 'cue', id: String(cueId), settings: decodeCueSettings(cueMark?.attrs?.cueMeta), children: [] };
      children.push(cue);
    }
    mergeText(cue.children, value, color);
  } else mergeText(children, value, color);
}

export function fromEditorContent(content: JSONContent): any {
  const blocks: any[] = [];
  for (const block of content.content ?? []) {
    const nested = block.type === 'paragraph' ? [block] : nestedParagraphs(block);
    const candidates = nested.length ? nested : block.type === 'paragraph' ? [] : [block];
    for (const paragraph of candidates) {
      const inline = paragraph.type === 'paragraph' ? paragraph.content ?? [] : visibleInlineNodes(paragraph);
      if (paragraph.type !== 'paragraph' && !inline.some((node: any) => node.type === 'text' ? !!node.text : node.type === 'hardBreak')) continue;
      const children: any[] = [];
      for (const node of inline) appendEditorInline(children, node);
      const index = blocks.length;
      const id = String(paragraph.attrs?.paragraphId || makeId('p' + index));
      blocks.push({ type: 'paragraph', id, ...(paragraph.attrs?.groupId ? { groupId: String(paragraph.attrs.groupId) } : {}), ...(paragraph.attrs?.musicRange ? { musicRange: clone(paragraph.attrs.musicRange) } : {}), children });
    }
  }
  return { type: 'doc', blocks };
}
export function appendEditorParagraphs(editor: Editor, paragraphs: Array<{ id: string; text: string }>, replacePlaceholder = false) {
  if (!paragraphs.length) return false;
  const nodes = paragraphs.map((paragraph) => editor.schema.nodes.paragraph.create(
    { paragraphId: paragraph.id },
    paragraph.text ? editor.schema.text(paragraph.text) : null,
  ));
  const transaction = replacePlaceholder
    ? editor.state.tr.replaceWith(0, editor.state.doc.content.size, Fragment.fromArray(nodes))
    : editor.state.tr.insert(editor.state.doc.content.size, Fragment.fromArray(nodes));
  transaction.setMeta('addToHistory', true);
  closeHistory(transaction);
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

function restoreParagraphSelection(transaction: Transaction, selection: Selection) {
  const anchorParagraph = selection.$anchor.parent.attrs.paragraphId;
  const headParagraph = selection.$head.parent.attrs.paragraphId;
  let anchor: number | undefined;
  let head: number | undefined;
  transaction.doc.descendants((node, position) => {
    if (node.type.name !== 'paragraph') return;
    if (node.attrs.paragraphId === anchorParagraph) anchor = position + 1 + Math.min(selection.$anchor.parentOffset, node.content.size);
    if (node.attrs.paragraphId === headParagraph) head = position + 1 + Math.min(selection.$head.parentOffset, node.content.size);
  });
  if (anchor !== undefined && head !== undefined) transaction.setSelection(TextSelection.create(transaction.doc, anchor, head));
}

export function moveEditorParagraphs(editor: Editor, paragraphs: Array<{ id: string; groupId?: string | null; musicRange?: any }>, reviewToken?: string, chapterId?: string) {
  const byId = new Map<string, any>();
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'paragraph' && node.attrs.paragraphId) byId.set(String(node.attrs.paragraphId), node);
  });
  if (new Set(paragraphs.map((paragraph) => paragraph.id)).size !== paragraphs.length || [...byId.keys()].some((id) => !paragraphs.some((paragraph) => paragraph.id === id))) return false;
  const nodes = paragraphs.map((paragraph) => {
    const node = byId.get(paragraph.id) ?? editor.schema.nodes.paragraph.create({ paragraphId: paragraph.id, groupId: paragraph.groupId ?? null, musicRange: paragraph.musicRange ?? null });
    return node.type.create({ ...node.attrs, groupId: paragraph.groupId ?? null, musicRange: paragraph.musicRange ?? null }, node.content, node.marks);
  });
  const selection = editor.state.selection;
  const transaction = editor.state.tr.replaceWith(0, editor.state.doc.content.size, Fragment.fromArray(nodes));
  restoreParagraphSelection(transaction, selection);
  if (reviewToken !== undefined) transaction.setDocAttribute('reviewToken', reviewToken);
  if (chapterId !== undefined) transaction.setDocAttribute('chapterId', chapterId);
  transaction.setMeta('addToHistory', true);
  editor.view.dispatch(closeHistory(transaction));
  editor.view.dispatch(closeHistory(editor.state.tr));
  return true;
}

export function replaceEditorDocument(editor: Editor, document: any, groups: any[] = [], musicRanges: any[] = [], reviewToken: string | null = null, chapterId: string | null = null) {
  const next = editor.schema.nodeFromJSON(toEditorContent(document, groups, musicRanges));
  const transaction = editor.state.tr.replaceWith(0, editor.state.doc.content.size, next.content);
  restoreParagraphSelection(transaction, editor.state.selection);
  transaction.setDocAttribute('reviewToken', reviewToken);
  if (chapterId !== null) transaction.setDocAttribute('chapterId', chapterId);
  transaction.setMeta('addToHistory', true);
  editor.view.dispatch(closeHistory(transaction));
  editor.view.dispatch(closeHistory(editor.state.tr));
}

function decodeCueSettings(value: unknown): CueSettings {
  try { return defaultSettings(JSON.parse(String(value ?? '{}'))); }
  catch { return defaultSettings(); }
}

function editorCueRanges(editor: Editor) {
  const ranges: Array<{ from: number; to: number; cueId: string }> = [];
  const reserved = new Set<string>();
  editor.state.doc.descendants((node) => { for (const mark of node.marks) if (mark.type.name === 'cue' && mark.attrs.cueSource !== 'plain') reserved.add(String(mark.attrs.cueId)); });
  editor.state.doc.descendants((paragraph, position) => {
    if (paragraph.type.name !== 'paragraph') return;
    let plainIndex = 0;
    let run: { from: number; to: number; cueId: string; text: string; plain: boolean } | null = null;
    const flush = () => {
      if (run && run.text.trim()) {
        ranges.push({ from: run.from, to: run.to, cueId: run.plain ? plainCueId(String(paragraph.attrs.paragraphId), plainIndex++, reserved) : run.cueId });
      }
      run = null;
    };
    paragraph.forEach((node, offset) => {
      const mark = node.marks.find((item) => item.type.name === 'cue' && item.attrs.cueSource !== 'plain');
      const cueId = mark ? String(mark.attrs.cueId) : '';
      const plain = !mark;
      const from = position + 1 + offset;
      if (run && (run.plain !== plain || (!plain && run.cueId !== cueId))) flush();
      const text = node.type.name === 'hardBreak' ? '\n' : node.textContent;
      if (!run) run = { from, to: from + node.nodeSize, cueId, text, plain };
      else { run.to = from + node.nodeSize; run.text += text; }
    });
    flush();
    return false;
  });
  return ranges;
}

export function findCueRange(editor: Editor, cueId: string): { from: number; to: number; cueId: string } | null {
  return editorCueRanges(editor).find((range) => range.cueId === cueId) ?? null;
}

export function selectedStoryId(editor: Editor): string | null {
  const { selection } = editor.state;
  if (selection.$from.parent !== selection.$to.parent) return null;
  const ranges = editorCueRanges(editor);
  const target = selection.empty
    ? ranges.find((range) => selection.from >= range.from && selection.from < range.to)
      ?? ranges.find((range) => selection.from === range.to)
    : ranges.find((range) => selection.from >= range.from && selection.to <= range.to);
  return target?.cueId ?? null;
}

export function selectedParagraphIds(editor: Editor): string[] {
  const { selection, doc } = editor.state;
  if (selection.empty) {
    const paragraph = selection.$from.parent.type.name === 'paragraph' ? selection.$from.parent : null;
    return paragraph?.attrs.paragraphId ? [String(paragraph.attrs.paragraphId)] : [];
  }
  const ids: string[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph' || !node.attrs.paragraphId) return;
    const start = pos + 1;
    const end = pos + node.nodeSize - 1;
    if (end > selection.from && start < selection.to) ids.push(String(node.attrs.paragraphId));
  });
  return ids;
}

export function applyCuePatch(editor: Editor, cueId: string, current: CueSettings, patch: Partial<CueSettings>) {
  const range = findCueRange(editor, cueId);
  if (!range || range.to <= range.from) return false;
  const markAtStart = editor.state.doc.nodeAt(range.from)?.marks.find((mark) => mark.type.name === 'cue');
  const stableId = markAtStart?.attrs.cueSource !== 'plain' && markAtStart?.attrs.cueId || makeId('cue');
  const settings = defaultSettings({ ...current, ...patch });
  validateDocument({ type: 'doc', blocks: [{ type: 'paragraph', id: 'validation-paragraph', children: [{ type: 'cue', id: 'validation-cue', settings, children: [{ type: 'text', text: '校验' }] }] }] });
  editor.view.dispatch(editor.state.tr.addMark(range.from, range.to, editor.schema.marks.cue.create(cueAttributes(stableId, settings))));
  return true;
}

export function applyMode(editor: Editor, cueId: string | null, current: CueSettings, mode: 'dialogue' | 'free') {
  const { selection } = editor.state;
  if (!selection.empty && selection.$from.parent !== selection.$to.parent) return { ok: false, message: '跨段选择不能设为一种演出，请一次设置一句。' };
  const targetId = selection.empty ? cueId || selectedStoryId(editor) : selectedStoryId(editor);
  if (!targetId) return { ok: false, message: '请一次选择同一演出单元中的正文。' };
  let range = findCueRange(editor, targetId);
  if (!selection.empty && range) {
    const mark = editor.state.doc.nodeAt(range.from)?.marks.find((item) => item.type.name === 'cue' && item.attrs.cueSource !== 'plain');
    if (!mark) range = { from: selection.from, to: selection.to, cueId: makeId('cue') };
  }
  if (!range || range.to <= range.from) return { ok: false, message: '找不到当前正文段落。' };
  const activeMark = editor.state.doc.nodeAt(range.from)?.marks.find((mark) => mark.type.name === 'cue');
  const stableId = activeMark?.attrs.cueSource !== 'plain' && activeMark?.attrs.cueId || (!selection.empty ? range.cueId : makeId('cue'));
  editor.view.dispatch(editor.state.tr.addMark(range.from, range.to, editor.schema.marks.cue.create(cueAttributes(stableId, defaultSettings({ ...current, mode })))));
  return { ok: true, cueId: stableId };
}

