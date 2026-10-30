export function shouldHandlePlaybackSpace(event) {
  if (![' ', 'Spacebar'].includes(event.key) || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const target = event.target;
  return !target?.isContentEditable && !target?.closest?.('input,textarea,select,button,a,[contenteditable],[role="textbox"],[role="dialog"]');
}
