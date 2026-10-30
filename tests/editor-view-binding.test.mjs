import test from 'node:test';
import assert from 'node:assert/strict';
import { bindEditorViewListeners, editorViewDom, isEditorViewReady, onEditorViewMount } from '../src/editor/editor-view.mjs';

/**
 * 假编辑器按本地 Tiptap 3.31.4 的真实行为写：
 * - 没有 editorView 时 isDestroyed 就是 true；
 * - 读取 view.dom 这类未准备属性会主动抛错（不是返回空）。
 * 因此「直接读 editor.view.dom」在这个替身上会真的抛异常，回归才有意义。
 */
function fakeEditor() {
  let view = null;
  const registered = [];
  const emit = (event) => registered.filter((item) => item.event === event).forEach((item) => item.fn());
  const editor = {
    get isDestroyed() { return !view; },
    get view() {
      if (view) return view;
      return new Proxy({}, {
        get(_target, key) {
          if (key === 'state') return { doc: {} };
          throw new Error(`[tiptap error]: The editor view is not available. Cannot access view['${String(key)}'].`);
        },
      });
    },
    on(event, fn) { registered.push({ event, fn }); return editor; },
    off(event, fn) {
      const index = registered.findIndex((item) => item.event === event && item.fn === fn);
      if (index >= 0) registered.splice(index, 1);
      return editor;
    },
    __pending: registered,
    __mount(nextDom) { view = { dom: nextDom }; emit('mount'); },
    __unmount() { view = null; emit('unmount'); },
  };
  return editor;
}

function fakeDom() {
  const bound = [];
  return {
    bound,
    addEventListener(type, handler) { bound.push({ type, handler }); },
    removeEventListener(type, handler) {
      const index = bound.findIndex((item) => item.type === type && item.handler === handler);
      if (index >= 0) bound.splice(index, 1);
    },
  };
}

test('视图未挂载时就绪判定为否，读取 DOM 返回空而不是抛错', () => {
  const editor = fakeEditor();
  assert.equal(isEditorViewReady(editor), false);
  assert.equal(isEditorViewReady(null), false);
  assert.throws(() => editor.view.dom, /editor view is not available/);
  assert.equal(editorViewDom(editor), null);
  const dom = fakeDom();
  editor.__mount(dom);
  assert.equal(isEditorViewReady(editor), true);
  assert.equal(editorViewDom(editor), dom);
});

test('切换工程后实例重建：登记时不挂载，挂载后监听自动补上', () => {
  const editor = fakeEditor();
  const dom = fakeDom();
  const handler = () => {};
  const dispose = bindEditorViewListeners(editor, [['story-group-collapse', handler]]);
  assert.deepEqual(dom.bound, [], '未挂载时不应有任何 DOM 监听');
  editor.__mount(dom);
  assert.equal(dom.bound.length, 1, '视图挂载后必须补绑');
  assert.equal(dom.bound[0].type, 'story-group-collapse');
  dispose();
  assert.equal(dom.bound.length, 0);
});

test('登记时已经挂载：立即绑定；同一实例收到重复挂载事件不会叠加监听', () => {
  const editor = fakeEditor();
  const dom = fakeDom();
  editor.__mount(dom);
  const handler = () => {};
  bindEditorViewListeners(editor, [['story-group-collapse', handler], ['story-paragraph-select', handler]]);
  assert.equal(dom.bound.length, 2, '登记时已挂载必须立即绑定');
  editor.__mount(dom);
  assert.equal(dom.bound.length, 2, '同一个 DOM 再挂载一次不重复叠加');
  editor.__mount(fakeDom());
  assert.equal(dom.bound.length, 0, '换到新视图后旧 DOM 上的监听要清掉');
});

test('两条不同的绑定互不覆盖，各自都能收事件', () => {
  const editor = fakeEditor();
  const dom = fakeDom();
  editor.__mount(dom);
  const first = () => {};
  const second = () => {};
  bindEditorViewListeners(editor, [['story-group-collapse', first]]);
  bindEditorViewListeners(editor, [['story-group-collapse', second]]);
  assert.equal(dom.bound.length, 2);
});

test('视图被卸载后旧 DOM 监听被清掉，重新挂载到新 DOM 会重新绑定', () => {
  const editor = fakeEditor();
  const first = fakeDom();
  const second = fakeDom();
  const handler = () => {};
  bindEditorViewListeners(editor, [['story-group-collapse', handler]]);
  editor.__mount(first);
  assert.equal(first.bound.length, 1);
  editor.__unmount();
  assert.equal(first.bound.length, 0, '卸载后不能留下悬空监听');
  editor.__mount(second);
  assert.equal(second.bound.length, 1, '换到新视图必须重新绑定');
});

test('effect 清理后不再跟随挂载重绑', () => {
  const editor = fakeEditor();
  const dom = fakeDom();
  const handler = () => {};
  const dispose = bindEditorViewListeners(editor, [['story-group-collapse', handler]]);
  dispose();
  editor.__mount(dom);
  assert.equal(dom.bound.length, 0, '已清理的 effect 不该在挂载后再绑回来');
});

test('投影类回调：就绪后执行一次，未就绪等到挂载，取消后不再执行', () => {
  const editor = fakeEditor();
  const dom = fakeDom();
  const seen = [];
  const cancel = onEditorViewMount(editor, (node) => seen.push(node));
  assert.deepEqual(seen, []);
  editor.__mount(dom);
  assert.deepEqual(seen, [dom]);
  const later = fakeDom();
  editor.__unmount();
  editor.__mount(later);
  assert.deepEqual(seen, [dom, later]);
  cancel();
  const after = fakeDom();
  editor.__unmount();
  editor.__mount(after);
  assert.equal(seen.length, 2);
});

test('已经就绪时投影立即执行一次，不等挂载事件', () => {
  const editor = fakeEditor();
  const dom = fakeDom();
  editor.__mount(dom);
  const seen = [];
  onEditorViewMount(editor, (node) => seen.push(node));
  assert.deepEqual(seen, [dom]);
});

test('没有编辑器实例时不抛错，返回空操作', () => {
  assert.doesNotThrow(() => bindEditorViewListeners(null, [['x', () => {}]])());
  assert.doesNotThrow(() => onEditorViewMount(null, () => {})());
});
