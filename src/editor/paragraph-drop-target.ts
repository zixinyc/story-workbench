export type ParagraphDropTarget = { type: 'group'; groupId: string } | { type: 'paragraph'; paragraphId: string; position: 'before' | 'after' };
export function paragraphBodyBounds(paragraph: HTMLElement) {
  const bounds = paragraph.getBoundingClientRect();
  if (paragraph.matches('.outline-paragraph-row')) return bounds;
  const children = [...paragraph.childNodes].filter((node) => !(node instanceof Element && node.matches('[data-group-paragraph-id],[data-paragraph-tools]')));
  if (children.length) {
    const range = paragraph.ownerDocument.createRange();
    range.setStartBefore(children[0]); range.setEndAfter(children.at(-1)!);
    const body = range.getBoundingClientRect();
    if (body.height > 0) return body;
  }
  const widgets = [...paragraph.children].filter((node) => node.matches('[data-group-paragraph-id],[data-paragraph-tools]'));
  const top = Math.min(bounds.bottom, Math.max(bounds.top + 10, ...widgets.map((node) => node.getBoundingClientRect().bottom + 7)));
  return { ...bounds, top, bottom: Math.max(top + 1, bounds.bottom - 10), height: Math.max(1, bounds.bottom - 10 - top) };
}
export function resolveParagraphDropTarget(target: EventTarget | null, clientY: number, kind: 'paragraph' | 'audio' = 'paragraph'): ParagraphDropTarget | null {
  const element = target instanceof Element ? target : null;
  const header = element?.closest<HTMLElement>('[data-group-drop]');
  if (header?.dataset.groupDrop) return { type: 'group', groupId: header.dataset.groupDrop };
  const paragraph = element?.closest<HTMLElement>('p[data-paragraph-id],p[data-paragraphid],.outline-paragraph-row[data-paragraph-id]');
  if (!paragraph) return null;
  if (kind === 'audio') return paragraph.dataset.groupId ? { type: 'group', groupId: paragraph.dataset.groupId } : null;
  const paragraphId = paragraph.getAttribute('data-paragraph-id') ?? paragraph.getAttribute('data-paragraphid');
  if (!paragraphId) return null;
  const body = paragraphBodyBounds(paragraph);
  return { type: 'paragraph', paragraphId, position: clientY < body.top + body.height / 2 ? 'before' : 'after' };
}
