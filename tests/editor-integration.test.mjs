import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import UniqueID from '@tiptap/extension-unique-id';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { history, redo, undo } from '@tiptap/pm/history';
import { CueMark, StoryAttributes, applyCuePatch, applyMode, moveEditorParagraphs, replaceEditorDocument, selectedStoryId, toEditorContent } from '../src/editor/story-editor.ts';
import { defaultSettings } from '../src/domain/model/document.mjs';

const schema = getSchema([StarterKit, CueMark]);
const cueMark = (id) => schema.marks.cue.create({ cueId: id, cueMeta: JSON.stringify(defaultSettings()) });

function applyStoryRepairPlugin(doc) {
  const plugin = StoryAttributes.config.addProseMirrorPlugins()[0];
  const state = EditorState.create({ schema, plugins: [plugin] });
  return state.applyTransaction(state.tr.replaceWith(0, 0, doc.content)).state.doc;
}

function cueIds(doc) {
  const ids = [];
  doc.descendants((node) => {
    const mark = node.marks.find((item) => item.type.name === 'cue');
    if (mark) ids.push(mark.attrs.cueId);
  });
  return ids;
}

test('ProseMirror repair separates duplicate cue IDs across paragraphs but preserves inline splits', () => {
  const marked = cueMark('same-cue');
  const duplicated = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('甲', [marked]), schema.text('乙', [marked, schema.marks.bold.create()])]),
    schema.node('paragraph', null, schema.text('丙', [marked])),
  ]);
  const repaired = applyStoryRepairPlugin(duplicated);
  const ids = cueIds(repaired);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[1], ids[2]);

  const hardBreakRun = schema.node('doc', null, [schema.node('paragraph', null, [
    schema.text('甲', [marked]), schema.nodes.hardBreak.create(null, null, [marked]), schema.text('乙', [marked]),
  ])]);
  assert.deepEqual(cueIds(applyStoryRepairPlugin(hardBreakRun)), ['same-cue', 'same-cue', 'same-cue']);
});

test('跨段切换演出会被拒绝，ProseMirror 正文完全不变', () => {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text('第一段')), schema.node('paragraph', null, schema.text('第二段'))]);
  const selection = TextSelection.create(doc, 1, 8);
  let commandUsed = false;
  const editor = { state: { doc, selection, schema }, chain() { commandUsed = true; throw new Error('不应创建演出事务'); } };
  const result = applyMode(editor, null, defaultSettings(), 'free');
  assert.equal(result.ok, false);
  assert.equal(commandUsed, false);
  assert.deepEqual(doc.toJSON(), { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一段' }] }, { type: 'paragraph', content: [{ type: 'text', text: '第二段' }] }] });
});

test('同一段落选择后一个演出单元时，正向和反向选择都返回其 cue ID', () => {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [
    schema.text('AAA', [cueMark('cue-a')]),
    schema.text('BBB', [cueMark('cue-b')]),
  ])]);
  for (const [from, to] of [[4, 7], [7, 4]]) {
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, from, to) });
    assert.equal(selectedStoryId({ state }), 'cue-b');
  }
});

test('段落拖放作为一个可撤销事务，撤销重做同时还原顺序和组 ID', () => {
  const fullSchema = getSchema([StarterKit, UniqueID.configure({ types: ['paragraph'], attributeName: 'paragraphId' }), CueMark, StoryAttributes]);
  const doc = fullSchema.node('doc', null, [
    fullSchema.node('paragraph', { paragraphId: 'p-a', groupId: 'group-a' }, fullSchema.text('甲')),
    fullSchema.node('paragraph', { paragraphId: 'p-b', groupId: null }, fullSchema.text('乙')),
  ]);
  let state = EditorState.create({ schema: fullSchema, doc, plugins: [history()] });
  const editor = {
    get state() { return state; },
    schema: fullSchema,
    view: { dispatch(transaction) { state = state.apply(transaction); } },
  };
  assert.equal(moveEditorParagraphs(editor, [{ id: 'p-b', groupId: 'group-a' }, { id: 'p-a', groupId: null }]), true);
  const snapshot = () => state.doc.content.content.map((node) => [node.attrs.paragraphId, node.attrs.groupId, node.textContent]);
  assert.deepEqual(snapshot(), [['p-b', 'group-a', '乙'], ['p-a', null, '甲']]);
  assert.equal(undo(state, (transaction) => { state = state.apply(transaction); }), true);
  assert.deepEqual(snapshot(), [['p-a', 'group-a', '甲'], ['p-b', null, '乙']]);
  assert.equal(redo(state, (transaction) => { state = state.apply(transaction); }), true);
  assert.deepEqual(snapshot(), [['p-b', 'group-a', '乙'], ['p-a', null, '甲']]);
});

test('AI 建议整批正文与历史标记作为一个可撤销事务', () => {
  const fullSchema = getSchema([StarterKit, UniqueID.configure({ types: ['paragraph'], attributeName: 'paragraphId' }), CueMark, StoryAttributes]);
  const old = { type: 'doc', attrs: { reviewToken: null, chapterId: 'chapter-a' }, content: [
    { type: 'paragraph', attrs: { paragraphId: 'p-a', groupId: 'group-a', musicRange: null }, content: [{ type: 'text', text: '旧正文' }] },
  ] };
  let state = EditorState.create({ schema: fullSchema, doc: fullSchema.nodeFromJSON(old), plugins: [history()] });
  const editor = { get state() { return state; }, schema: fullSchema, view: { dispatch(transaction) { state = state.apply(transaction); } } };
  const nextDocument = { type: 'doc', blocks: [{ type: 'paragraph', id: 'p-a', children: [{ type: 'text', text: '改后正文' }] }] };
  replaceEditorDocument(editor, nextDocument, [{ id: 'group-a', paragraphIds: ['p-a'] }], [], 'review-1', 'chapter-a');
  assert.equal(state.doc.attrs.reviewToken, 'review-1');
  assert.equal(state.doc.attrs.chapterId, 'chapter-a');
  assert.equal(state.doc.textContent, '改后正文');
  assert.equal(undo(state, (transaction) => { assert.equal(transaction.getMeta('history$').redo, false); state = state.apply(transaction); }), true);
  assert.equal(state.doc.attrs.reviewToken, null);
  assert.equal(state.doc.attrs.chapterId, 'chapter-a');
  assert.equal(state.doc.textContent, '旧正文');
  assert.equal(redo(state, (transaction) => { assert.equal(transaction.getMeta('history$').redo, true); state = state.apply(transaction); }), true);
  assert.equal(state.doc.attrs.reviewToken, 'review-1');
  assert.equal(state.doc.textContent, '改后正文');
});

test('改属性与演出模式保持插入点，后续空格只插入一个字符', () => {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text('完整正文', [cueMark('safe-cue')]))]);
  for (const operation of ['patch', 'mode']) {
    let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 3) });
    const editor = { get state() { return state; }, schema, view: { dispatch(transaction) { state = state.apply(transaction); } } };
    if (operation === 'patch') assert.equal(applyCuePatch(editor, 'safe-cue', defaultSettings(), { fontSize: 72 }), true);
    else assert.equal(applyMode(editor, 'safe-cue', defaultSettings(), 'free').ok, true);
    assert.equal(state.selection.from, 3);
    assert.equal(state.selection.to, 3);
    assert.equal(state.doc.textContent, '完整正文');
    state = state.apply(state.tr.insertText(' '));
    assert.equal(state.doc.textContent, '完整 正文');
    assert.equal(state.doc.nodeAt(1).marks.find((mark) => mark.type.name === 'cue').attrs.cueId, 'safe-cue');
  }
});
test('属性修改保留显式文字选区，并且不将多段选区改成首句', () => {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text('第一段', [cueMark('first')])), schema.node('paragraph', null, schema.text('第二段', [cueMark('second')]))]);
  let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 2, 8) });
  const editor = { get state() { return state; }, schema, view: { dispatch(transaction) { state = state.apply(transaction); } } };
  applyCuePatch(editor, 'second', defaultSettings(), { durationMs: 5000 });
  assert.deepEqual([state.selection.from, state.selection.to], [2, 8]);
  assert.equal(state.doc.textContent, '第一段第二段');
});
test('连续 cue 的属性修改保留目标 ID，不把后句标成前句', () => {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('甲', [cueMark('a')]), schema.text('乙', [cueMark('b')])])]);
  let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 2) });
  const editor = { get state() { return state; }, schema, view: { dispatch(transaction) { state = state.apply(transaction); } } };
  applyCuePatch(editor, 'b', defaultSettings(), { fontSize: 60 });
  assert.deepEqual(cueIds(state.doc), ['a', 'b']);
});
test('结构操作失败不发事务，成功后历史标记与组归属一起撤销', () => {
  const fullSchema = getSchema([StarterKit, UniqueID.configure({ types: ['paragraph'], attributeName: 'paragraphId' }), CueMark, StoryAttributes]);
  const doc = fullSchema.node('doc', { chapterId: 'chapter-a' }, [fullSchema.node('paragraph', { paragraphId: 'a' }, fullSchema.text('正文'))]);
  let state = EditorState.create({ schema: fullSchema, doc, plugins: [history()] });
  let dispatched = 0;
  const editor = { get state() { return state; }, schema: fullSchema, view: { dispatch(transaction) { dispatched++; state = state.apply(transaction); } } };
  assert.equal(moveEditorParagraphs(editor, [{ id: 'missing' }], 'bad-token'), false);
  assert.equal(dispatched, 0);
  assert.equal(moveEditorParagraphs(editor, [{ id: 'a', groupId: 'new-group' }], 'structure-token', 'chapter-a'), true);
  assert.equal(state.doc.attrs.reviewToken, 'structure-token');
  assert.equal(state.doc.attrs.chapterId, 'chapter-a');
  undo(state, (transaction) => { state = state.apply(transaction); });
  assert.equal(state.doc.attrs.reviewToken, null);
  assert.equal(state.doc.firstChild.attrs.groupId, null);
  redo(state, (transaction) => { state = state.apply(transaction); });
  assert.equal(state.doc.attrs.reviewToken, 'structure-token');
  assert.equal(state.doc.attrs.chapterId, 'chapter-a');
  assert.equal(state.doc.firstChild.attrs.groupId, 'new-group');
});

test('选区事务复用段落装饰，输入/撤销/结构变化才重建，不清空已投影组标题', () => {
  const fullSchema = getSchema([StarterKit, UniqueID.configure({ types: ['paragraph'], attributeName: 'paragraphId' }), CueMark, StoryAttributes]);
  const plugin = StoryAttributes.config.addProseMirrorPlugins()[1];
  const doc = fullSchema.node('doc', null, [
    fullSchema.node('paragraph', { paragraphId: 'p-a', groupId: 'g-a' }, fullSchema.text('甲乙')),
    fullSchema.node('paragraph', { paragraphId: 'p-b', groupId: 'g-a' }, fullSchema.text('丙丁')),
  ]);
  let state = EditorState.create({ schema: fullSchema, doc, plugins: [plugin, history()] });
  const initial = plugin.getState(state);
  assert.equal(plugin.props.decorations(state), initial);
  assert.equal(initial.find().length, 3);
  const originalDocument = globalThis.document;
  let created = 0;
  globalThis.document = { createElement: () => {
    created++;
    return { dataset: {}, children: [], textContent: '', append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); }, addEventListener() {}, setAttribute() {} };
  } };
  try {
    const header = initial.find().find((decoration) => decoration.spec.key.startsWith('paragraph-group-header:')).type.toDOM();
    const controls = initial.find().find((decoration) => decoration.spec.key === 'paragraph-controls:p-a').type.toDOM();
    header.children[0].textContent = '第 1 组 · 日常';
    header.children[1].textContent = '♫ 合成配乐.wav';
    controls.children.at(-1).textContent = '第 1 组 · 日常';
    const count = created;
    for (const position of [2, 6, 1]) {
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, position)));
      assert.equal(plugin.getState(state), initial);
      assert.equal(plugin.props.decorations(state), initial);
    }
    state = state.apply(state.tr.setMeta('paragraph-selection', ['p-a']));
    assert.equal(plugin.getState(state), initial);
    assert.equal(created, count);
    assert.equal(header.children[0].textContent, '第 1 组 · 日常');
    assert.equal(header.children[1].textContent, '♫ 合成配乐.wav');
    assert.equal(controls.children.at(-1).textContent, '第 1 组 · 日常');
    state = state.apply(state.tr.insertText('新', 2));
    assert.notEqual(plugin.getState(state), initial);
    assert.equal(created, count, '重建仅计算装饰，DOM在视图真正需要时创建');
    let last = plugin.getState(state);
    undo(state, (transaction) => { state = state.apply(transaction); });
    assert.notEqual(plugin.getState(state), last);
    last = plugin.getState(state);
    redo(state, (transaction) => { state = state.apply(transaction); });
    assert.notEqual(plugin.getState(state), last);
    state = state.apply(state.tr.setNodeMarkup(0, undefined, { ...state.doc.firstChild.attrs, groupId: 'g-new' }));
    assert.ok(plugin.getState(state).find().some((decoration) => decoration.spec.key === 'paragraph-group-header:g-new:p-a'));
    assert.equal(state.doc.textContent, '甲新乙丙丁');
  } finally {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  }
});

test('结构移动按段落 ID 和段内位置恢复正反向选区，不跳到末段', () => {
  const fullSchema=getSchema([StarterKit, UniqueID.configure({types:['paragraph'],attributeName:'paragraphId'}), CueMark,StoryAttributes]);
  const doc=fullSchema.node('doc',null,['p-a','p-b','p-c'].map(id=>fullSchema.node('paragraph',{paragraphId:id},fullSchema.text('正文ABC'))));
  for(const [anchor,head] of [[9,9],[9,3],[3,9]]) {
    let state=EditorState.create({schema:fullSchema,doc,selection:TextSelection.create(doc,anchor,head)});
    const original=[state.selection.$anchor,state.selection.$head].map(pos=>[pos.parent.attrs.paragraphId,pos.parentOffset]);
    const editor={get state(){return state;},schema:fullSchema,view:{dispatch(tr){state=state.apply(tr);}}};
    assert.equal(moveEditorParagraphs(editor,[{id:'p-c'},{id:'p-b',groupId:'g-new'},{id:'p-a'}]),true);
    assert.deepEqual([state.selection.$anchor,state.selection.$head].map(pos=>[pos.parent.attrs.paragraphId,pos.parentOffset]),original);
  }
});

test('AI整章替换保留当前段落/正反向选区，正文变短钳制偏移且撤销重做稳定', () => {
  const fullSchema=getSchema([StarterKit,UniqueID.configure({types:['paragraph'],attributeName:'paragraphId'}),CueMark,StoryAttributes]);
  const document={type:'doc',blocks:['a','b','c','d'].map(id=>({type:'paragraph',id:'p-'+id,children:[{type:'text',text:'原始正文ABCDE'}]}))};
  const doc=fullSchema.nodeFromJSON(toEditorContent(document));
  const positions=new Map();
  doc.forEach((node,pos)=>positions.set(node.attrs.paragraphId,pos+1));
  const incoming={...document,blocks:document.blocks.map((p,index)=>({...p,children:[{type:'text',text:index===1?'短':index===0?'AI扩充前文以改变后段的绝对位置':'AI修改后正文'}]}))};
  for(const [a,h] of [[['p-a',1],['p-a',1]],[['p-b',6],['p-b',6]],[['p-a',2],['p-b',5]],[['p-b',5],['p-a',2]]]){
    let state=EditorState.create({schema:fullSchema,doc,selection:TextSelection.create(doc,positions.get(a[0])+a[1],positions.get(h[0])+h[1]),plugins:[history()]});
    const editor={get state(){return state;},schema:fullSchema,view:{dispatch(tr){state=state.apply(tr);}}};
    const snapshot=()=>[state.selection.$anchor,state.selection.$head].map(pos=>[pos.parent.attrs.paragraphId,pos.parentOffset]);
    const original=snapshot(),originalCue=selectedStoryId(editor);
    replaceEditorDocument(editor,incoming,[],[],'ai-revision','chapter');
    const expected=[a,h].map(([id,offset])=>[id,Math.min(offset,incoming.blocks.find(p=>p.id===id).children[0].text.length)]);
    assert.deepEqual(snapshot(),expected);
    if(a[0]===h[0])assert.equal(selectedStoryId(editor),originalCue,'预览保持原句，不跳末段');
    assert.equal(state.doc.child(1).textContent,'短');
    assert.equal(undo(state,tr=>{state=state.apply(tr);}),true);
    assert.deepEqual(snapshot(),original);
    assert.equal(state.doc.textContent,doc.textContent);
    assert.equal(redo(state,tr=>{state=state.apply(tr);}),true);
    assert.deepEqual(snapshot(),expected);
  }
});
