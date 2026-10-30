import React, { useEffect, useMemo, useRef, useState } from 'react';
import { evaluateTextEffect, graphemes } from './effects.mjs';

type Cue = { id: string; text: string; children?: Array<{ type: string; text?: string; color?: string }>; settings: any };

function colorSlots(cue: Cue) {
  const colors: string[] = [];
  for (const child of cue.children ?? []) {
    colors.push(...graphemes(child.text ?? '').map(() => child.color ?? ''));
  }
  const count = graphemes(cue.text).length;
  while (colors.length < count) colors.push('');
  return colors.slice(0, count);
}

function colorFor(colors: string[], index: number, fallback: string) {
  return colors[index] || fallback;
}

function NewlineText({ value, colors, fallback }: { value: string; colors: string[]; fallback: string }) {
  return <>{graphemes(value).map((char, index) => /^[\r\n]+$/.test(char) ? <br key={index} /> : <span key={index} style={{ color: colorFor(colors, index, fallback) }}>{char}</span>)}</>;
}

function Slots({ characters, colors, fallback, opacity = 1 }: { characters: any[]; colors: string[]; fallback: string; opacity?: number }) {
  return <span className="effect-slots" style={{ opacity }}>
    {characters.map((item, index) => <span key={`${index}-${item.text}`} className="effect-glyph-slot" style={{ color: colorFor(colors, index, fallback) }}>
      <span className={item.visible ? '' : 'effect-glyph-hidden'}>{item.text === ' ' ? '\u00a0' : item.text}</span>
      {item.glitch && <span className="effect-glitch" aria-hidden="true">{item.glitch}</span>}
    </span>)}
  </span>;
}

function TranslationLines({ cue, frame }: { cue: Cue; frame: any }) {
  const host = useRef<HTMLSpanElement | null>(null);
  const sourceRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const targetRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [paths, setPaths] = useState<Array<{ d: string; key: string }>>([]);
  const translation = frame.translation;
  const source = translation?.sourceWords?.length ? translation.sourceWords : cue.text.split(/\s+/).filter(Boolean);
  const target = translation?.targetWords ?? [];
  const layoutKey = `${source.join('|')}::${target.join('|')}::${JSON.stringify(translation?.mappings ?? [])}`;

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const bounds = root.getBoundingClientRect();
    const points = translation?.mappings?.flatMap((mapping: any) => mapping.sourceIndexes.map((sourceIndex: number) => {
      const from = sourceRefs.current[sourceIndex]?.getBoundingClientRect();
      const to = targetRefs.current[mapping.targetIndex]?.getBoundingClientRect();
      if (!from || !to) return null;
      const x1 = from.left + from.width / 2 - bounds.left;
      const y1 = from.bottom - bounds.top + 2;
      const x2 = to.left + to.width / 2 - bounds.left;
      const y2 = to.top - bounds.top - 3;
      const laneY = y1 + Math.max(10, (y2 - y1) * 0.55);
      return { d: `M ${x1} ${y1} C ${x1} ${laneY}, ${x2} ${laneY}, ${x2} ${y2}`, key: `${sourceIndex}-${mapping.targetIndex}` };
    }).filter(Boolean) ?? []);
    setPaths(points as Array<{ d: string; key: string }>);
  }, [layoutKey, cue.id]);

  return <span ref={host} className="translation-effect">
    <svg className="translation-wires" aria-hidden="true">
      {paths.map((path) => <path key={path.key} d={path.d} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - (translation?.lineProgress ?? 0)} />)}
    </svg>
    <span className="translation-row source-row">{source.map((word: string, index: number) => <span key={`en-${index}`} ref={(node) => { sourceRefs.current[index] = node; }}>{word}</span>)}</span>
    <span className="translation-row target-row">{target.map((word: string, index: number) => <span key={`zh-${index}`} ref={(node) => { targetRefs.current[index] = node; }}>{word}</span>)}</span>
  </span>;
}

export function CueMotionText({ cue, elapsedMs, staticPreview = false }: { cue: Cue; elapsedMs: number; staticPreview?: boolean }) {
  const settings = cue.settings;
  const colors = useMemo(() => colorSlots(cue), [cue]);
  const frame: any = useMemo(() => evaluateTextEffect(settings, cue.text, elapsedMs), [settings, cue.text, elapsedMs]);
  if (frame.mode === 'verticalReveal') return <span className="cue-text-content vertical-reveal" style={{ fontSize: `min(1em, ${40 / frame.rows / 1.2}cqi, ${75 / frame.columns.length / 1.4}cqi)` }}>
    {frame.columns.map((column: any, index: number) => <span className="vertical-reveal-column" key={index} style={{ opacity: staticPreview ? 1 : column.opacity }}>{column.characters.map((item: any) => <span key={item.index} className={!staticPreview && !item.visible ? 'effect-glyph-hidden' : undefined} style={{ color: colorFor(colors, item.index, settings.color) }}>{item.text === ' ' ? '\u00a0' : item.text}</span>)}</span>)}
  </span>;
  if (staticPreview || frame.mode === 'plain') {
    return <span className="cue-text-content" style={staticPreview ? undefined : { opacity: frame.opacity, filter: frame.blurPx ? `blur(${frame.blurPx}px)` : undefined, transform: frame.transform || undefined }}><NewlineText value={cue.text} colors={colors} fallback={settings.color} /></span>;
  }
  if (frame.mode === 'ghostConverge') {
    const shadows = frame.ghostAmount > 0 ? [1, 1.5, 2].flatMap((tail, index) => {
      const offset = frame.ghostOffsetEm * tail;
      const alpha = frame.ghostAmount * [0.88, 0.35, 0.15][index];
      return [`${-offset}em -0.04em 0 rgba(44,220,230,${alpha})`, `${offset}em 0.04em 0 rgba(182,100,240,${alpha})`];
    }).join(',') : 'none';
    return <span className="cue-text-content ghost-converge" style={{ opacity: frame.opacity, textShadow: shadows }}><NewlineText value={cue.text} colors={colors} fallback={settings.color} /></span>;
  }
  if (frame.mode === 'decode') return <span className="cue-text-content" style={{ opacity: frame.opacity }}><Slots characters={frame.characters} colors={colors} fallback={settings.color} /></span>;
  if (frame.mode === 'characters') return <span className="cue-text-content"><Slots characters={frame.characters} colors={colors} fallback={settings.color} /></span>;
  if (frame.mode === 'wordUnderline') return <span className="cue-text-content word-effect-content" style={{ opacity: frame.opacity }}>{(frame.words ?? []).map((word: any, wordIndex: number) => <span className="word-effect" key={`${wordIndex}-${word.text}`}>
    {word.characters.map((item: any, charIndex: number) => <span key={`${wordIndex}-${charIndex}`} className={item.visible ? '' : 'effect-glyph-hidden'} style={{ color: colorFor(colors, word.startIndex + charIndex, settings.color) }}>{item.text === ' ' ? '\u00a0' : item.text}</span>)}
    {word.spaceAfter && <span> </span>}
    {word.underline > 0 && <i style={{ width: `${word.underline * 100}%`, height: `${frame.parameters.underlineThickness}px` }} />}
  </span>)}</span>;
  if (frame.mode === 'keywordChip') {
    return <span className="cue-text-content keyword-effect-content" style={{ opacity: frame.opacity }}>{frame.characters.map((item: any, index: number) => {
      const keyword = frame.keywords.find((entry: any) => entry.complete && index >= entry.start && index < entry.end);
      const settingsStyle = keyword ? { background: frame.parameters.chipColor, color: colorFor(colors, index, frame.parameters.chipTextColor), paddingLeft: index === keyword.start ? `${frame.parameters.chipPadding}px` : undefined, paddingRight: index === keyword.end - 1 ? `${frame.parameters.chipPadding}px` : undefined } : { color: colorFor(colors, index, settings.color) };
      return <React.Fragment key={`${index}-${item.text}`}><span className={keyword ? 'keyword-chip-glyph' : item.visible ? '' : 'effect-glyph-hidden'} style={{ ...settingsStyle, opacity: item.opacity }}>{item.text}</span>{keyword && index === keyword.end - 1 && frame.parameters.showIds && <sup className="keyword-demo-id">示意 {101 + frame.keywords.indexOf(keyword)}</sup>}</React.Fragment>;
    })}</span>;
  }
  if (frame.mode === 'translationWires') return <TranslationLines cue={cue} frame={frame} />;
  if (frame.mode === 'rewrite') {
    const chars = graphemes(frame.visibleText);
    return <span className="cue-text-content rewrite-effect">{chars.map((char, index) => <span key={`${index}-${char}`} style={{ color: colorFor(colors, index, settings.color) }}>{char}</span>)}{frame.caret && <i className="rewrite-caret" style={{ opacity: frame.caretVisible ? 1 : 0 }} />}</span>;
  }
  if (frame.mode === 'strikeRewrite') {
    const oldChars = graphemes(frame.oldText);
    const newChars = graphemes(frame.newText).slice(0, frame.newCount);
    return <span className="cue-text-content strike-effect">
      <span className="strike-old" style={{ opacity: frame.oldOpacity }}>{oldChars.map((char: string, index: number) => <span key={`${index}-${char}`} style={{ color: colorFor(colors, index, settings.color) }}>{char}</span>)}{frame.strikeVisible && <i style={{ width: `${frame.strikeProgress * 100}%`, background: frame.strikeColor }} />}</span>
      {frame.newVisible && <span className="strike-new">{newChars.map((char: string, index: number) => <span key={`${index}-${char}`} style={{ color: colorFor(colors, index, settings.color) }}>{char}</span>)}</span>}
    </span>;
  }
  if (frame.mode === 'evaporate') return <span className="cue-text-content"><Slots characters={frame.characters} colors={colors} fallback={settings.color} /></span>;
  return <span className="cue-text-content"><NewlineText value={cue.text} colors={colors} fallback={settings.color} /></span>;
}
