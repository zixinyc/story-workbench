export function parseArticleText(name, source) {
  if (/\.pdf$/i.test(name)) throw new Error('PDF 暂不支持直接转正文，请先导出 TXT 或 Markdown。');
  if (!/\.(txt|md|markdown)$/i.test(name)) throw new Error('目前只支持 TXT、MD、Markdown 文章。');
  if (typeof source !== 'string') throw new Error('文章内容无法读取。');
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const markdown = /\.(md|markdown)$/i.test(name);
  const paragraphs = normalized.split(/\n[\t \u3000]*\n+/).map((part) => {
    if (!markdown) return part.trim();
    return part.split('\n').map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s{0,3}\x60{3}[^\n]*$/, '')
      .replace(/^\s*\|[-| :]+\|?\s*$/, ''))
      .join('\n')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\x60([^\x60]+)\x60/g, '$1')
      .trim();
  }).filter(Boolean);
  if (!paragraphs.length) throw new Error('文章中没有可追加的正文。');
  return paragraphs;
}
