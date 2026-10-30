import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fitMenu, type MenuCommand } from './context-menu-model';

export function ContextMenu({ x, y, title, commands, onExecute, onClose }: { x: number; y: number; title: string; commands: MenuCommand[]; onExecute: (command: MenuCommand) => void; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState<string[]>([]);
  const [indices, setIndices] = useState<number[]>([0]);
  const [positions, setPositions] = useState<Array<{ left: number; top: number }>>([]);
  const panels: MenuCommand[][] = [commands];
  for (const id of path) { const children = panels.at(-1)!.find((item) => item.id === id)?.children; if (children) panels.push(children); }
  useLayoutEffect(() => { root.current?.focus(); }, []);
  useLayoutEffect(() => {
    const elements = [...(root.current?.querySelectorAll<HTMLElement>('.context-menu-panel') ?? [])];
    const result: Array<{ left: number; top: number }> = [];
    elements.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      if (!index) result.push(fitMenu(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight));
      else {
        const parent = elements[index - 1], row = parent.querySelector<HTMLElement>('[data-command-id="' + CSS.escape(path[index - 1]) + '"]');
        const bounds = row?.getBoundingClientRect() ?? parent.getBoundingClientRect();
        const previous = result[index - 1], right = previous.left + parent.offsetWidth + 4;
        result.push(fitMenu(right + rect.width <= window.innerWidth - 8 ? right : previous.left - rect.width - 4, bounds.top, rect.width, rect.height, window.innerWidth, window.innerHeight));
      }
    });
    if (JSON.stringify(result) !== JSON.stringify(positions)) setPositions(result);
  }, [x, y, path, commands, positions]);
  useLayoutEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    const dismiss = () => onClose();
    window.addEventListener('pointerdown', close, true); window.addEventListener('resize', dismiss);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('resize', dismiss); };
  }, [onClose]);
  const open = (level: number, command: MenuCommand, index: number) => {
    setIndices([...indices.slice(0, level), index]);
    setPath([...path.slice(0, level), ...(command.children ? [command.id] : [])]);
  };
  const keydown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    const level = panels.length - 1, panel = panels[level], index = indices[level] ?? 0, command = panel[index];
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? panel.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + panel.length) % panel.length;
      setIndices([...indices.slice(0, level), next]);
      root.current?.querySelectorAll('.context-menu-panel')[level]?.querySelectorAll('button')[next]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); setPath(path.slice(0, -1)); }
    else if ((event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') && command) {
      event.preventDefault(); event.stopPropagation();
      if (command.children && !command.reason) { setPath([...path.slice(0, level), command.id]); setIndices([...indices.slice(0, level + 1), 0]); }
      else if (event.key !== 'ArrowRight') onExecute(command);
    }
  };
  return createPortal(<div ref={root} className="context-menu-root" tabIndex={-1} onKeyDown={keydown} onContextMenu={(event) => event.preventDefault()}>
    {panels.map((items, level) => <div key={level} role="menu" aria-label={level ? '子菜单' : title} aria-activedescendant={'menu-' + level + '-' + (indices[level] ?? 0)} className="context-menu-panel" style={{ left: positions[level]?.left ?? x, top: positions[level]?.top ?? y, visibility: positions[level] ? 'visible' : 'hidden' }}>
      <div className="context-menu-caption">{level ? panels[level - 1].find((item) => item.id === path[level - 1])?.label : title}</div>
      {items.map((command, index) => <button type="button" role="menuitem" id={'menu-' + level + '-' + index} data-command-id={command.id} key={command.id} aria-disabled={!!command.reason} aria-haspopup={command.children ? 'menu' : undefined} aria-expanded={command.children ? path[level] === command.id : undefined} title={command.reason} className={[(indices[level] ?? 0) === index ? 'is-focused' : '', command.danger ? 'is-danger' : '', index && command.section !== items[index - 1].section ? 'starts-section' : ''].join(' ')} onPointerEnter={() => open(level, command, index)} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (command.children && !command.reason) { open(level, command, index); setIndices([...indices.slice(0, level), index, 0]); } else onExecute(command); }}>
        <span className="context-command-icon" aria-hidden="true">{command.icon ?? '·'}</span><span className="context-command-label">{command.label}{command.reason && <small>{command.reason}</small>}</span><span className="context-command-key">{command.children ? '›' : command.shortcut}</span>
      </button>)}
    </div>)}
  </div>, window.document.body);
}
