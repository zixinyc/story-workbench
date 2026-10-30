/**
 * 编辑器视图就绪判定与 DOM 监听绑定。
 *
 * 背景：本工程使用的 Tiptap 3.31.x 在实例刚建好、`<EditorContent>` 还没把视图挂上时，
 * `editor.view` 会返回一个代理对象；读取 `view.dom` 这类未准备的属性会**直接抛错**，
 * 而不是返回空值。工程或章节切换会按 deps 重建编辑器实例，存在一段“实例在、视图不在”的时间。
 * 所以这里统一用 Tiptap 自带的 mount / unmount 事件同步就绪状态，不另建第二套就绪标记，
 * 也不加延时去猜挂载是否完成。
 */

/** 实例是否已有可用视图：本地 Tiptap 的 isDestroyed 在没有 editorView 时即为 true，可直接当就绪判据 */
export function isEditorViewReady(editor) {
  return Boolean(editor) && !editor.isDestroyed;
}

/** 就绪后读取真实 DOM；未就绪返回 null，不抛错 */
export function editorViewDom(editor) {
  if (!isEditorViewReady(editor)) return null;
  const dom = editor.view.dom;
  return dom ?? null;
}

/**
 * 把一组监听绑到编辑器视图 DOM 上，并随视图挂载/卸载自动解绑重绑。
 * bindings: [事件名, 处理函数][]。返回解绑函数。
 */
export function bindEditorViewListeners(editor, bindings) {
  if (!editor) return () => {};
  const listeners = Array.isArray(bindings) ? bindings : Object.entries(bindings ?? {});
  let boundDom = null;
  const unbind = () => {
    if (!boundDom) return;
    for (const [type, handler] of listeners) boundDom.removeEventListener(type, handler);
    boundDom = null;
  };
  const bind = () => {
    /* 事件触发时实例可能已被销毁，此时不能再读 view */
    if (!isEditorViewReady(editor)) return;
    const dom = editor.view.dom;
    /* 同一个 DOM 不重复绑定，避免监听被叠加多份 */
    if (!dom || dom === boundDom) return;
    unbind();
    for (const [type, handler] of listeners) dom.addEventListener(type, handler);
    boundDom = dom;
  };
  /* 登记时可能已经挂载完成 */
  bind();
  editor.on('mount', bind);
  editor.on('unmount', unbind);
  return () => {
    editor.off('mount', bind);
    editor.off('unmount', unbind);
    unbind();
  };
}

/**
 * 视图就绪后执行一次投影/初始化（已就绪立即执行，未就绪等挂载）。
 * 视图 DOM 会被 EditorContent 重新挂载，因此必须跟着挂载事件走，不能只在 effect 里试一次。
 * 返回取消函数。
 */
export function onEditorViewMount(editor, callback) {
  if (!editor) return () => {};
  const run = () => {
    const dom = editorViewDom(editor);
    if (dom) callback(dom);
  };
  run();
  editor.on('mount', run);
  return () => editor.off('mount', run);
}
