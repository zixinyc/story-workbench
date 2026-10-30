export type MenuContext = {
  kind: 'text' | 'paragraph' | 'group' | 'chapter' | 'asset' | 'assets' | 'layer' | 'stage';
  projectId: string; chapterId: string; paragraphId?: string; groupId?: string;
  assetId?: string; layerId?: string; cueId?: string;
  selection?: { anchor: number; head: number }; doc: unknown; focus: HTMLElement | null;
};
export type MenuCommand = {
  id: string; label: string; icon?: string; shortcut?: string; reason?: string;
  danger?: boolean; section?: number; children?: MenuCommand[]; run?: () => void | Promise<void>;
};
export function commandForKey(commands: MenuCommand[], event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>, context: MenuContext, opened: boolean) {
  if (event.isComposing || event.altKey) return null;
  const key = event.key.toLowerCase(), control = event.ctrlKey || event.metaKey;
  const id = control ? key === 'z' ? event.shiftKey ? 'redo' : 'undo' : key === 'y' ? 'redo' : key === 'c' ? 'copy' : key === 'x' ? 'cut' : key === 'v' ? 'paste' : null
    : opened && !event.shiftKey && key === 'd' && context.kind === 'paragraph' ? 'delete' : null;
  return commands.find((command) => command.id === id) ?? null;
}
export function fitMenu(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  return { left: Math.max(8, Math.min(x, viewportWidth - width - 8)), top: Math.max(8, Math.min(y, viewportHeight - height - 8)) };
}
/** 右键是否应让给浏览器原生文字菜单。
    正文编辑器容器本身就是 contenteditable="true"，若只按 contenteditable 判断，
    C 区任意位置右键都会被挡掉、菜单永不弹出；因此编辑器内部一律交给工作台菜单，
    只有编辑器之外的输入控件才保留原生文字语义。 */
export function deferToNativeMenu(target: EventTarget | null, editorDom: Node | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  if (editorDom && editorDom.contains(target as Node)) return false;
  return !!(target as Element).closest('input,textarea,select,[contenteditable="true"]');
}
export async function executeMenuCommand(command: MenuCommand, valid: () => boolean, report: (message: string) => void) {
  if (!valid()) { report('目标已变化，请重新右键选择。'); return false; }
  if (command.reason) { report(command.reason); return false; }
  if (!command.run) return false;
  try { await command.run(); return true; }
  catch (error) { report(error instanceof Error ? error.message : '操作未完成。'); return false; }
}
