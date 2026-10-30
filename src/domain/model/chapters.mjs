import { clone, makeId } from './document.mjs';

const MAX_NAME_LENGTH = 120;

export function normalizeChapterName(name) {
  return normalizeName(name, '章节名称');
}

export function normalizeParagraphGroupName(name) {
  return normalizeName(name, '段落组名称');
}

function normalizeName(name, label) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) throw new Error(`${label}不能为空，请填写名称。`);
  if (value.length > MAX_NAME_LENGTH) throw new Error(`${label}最多 ${MAX_NAME_LENGTH} 个字符，请缩短后重试。`);
  return value;
}

export function migrateProject(project) {
  if (!project || typeof project !== 'object') throw new Error('工程文件格式无效。');
  if (project.schemaVersion === 2) return clone(project);
  if (project.schemaVersion !== 1) throw new Error(`不支持工程版本：${project.schemaVersion ?? '未知'}。`);
  const chapterId = `${project.id}-chapter-01`;
  const { document, ...legacy } = clone(project);
  return {
    ...legacy,
    schemaVersion: 2,
    activeChapterId: chapterId,
    chapters: [{ id: chapterId, name: '第01章', document, groups: [], musicRanges: [] }],
    assets: legacy.assets.map((asset) => ({ ...asset, kind: asset.kind === 'music' ? 'audio' : asset.kind })),
  };
}

export function activeChapter(project) {
  return project.chapters.find((chapter) => chapter.id === project.activeChapterId) ?? project.chapters[0] ?? null;
}

export function addChapter(project, name) {
  const chapter = { id: makeId('chapter'), name: normalizeChapterName(name), document: { type: 'doc', blocks: [] }, groups: [], musicRanges: [] };
  return { ...project, activeChapterId: chapter.id, chapters: [...project.chapters, chapter], updatedAt: new Date().toISOString() };
}

export function renameChapter(project, chapterId, name) {
  const value = normalizeChapterName(name);
  return updateChapter(project, chapterId, (chapter) => ({ ...chapter, name: value }));
}

export function reorderChapter(project, chapterId, direction) {
  const chapters = [...project.chapters];
  const index = chapters.findIndex((chapter) => chapter.id === chapterId);
  const next = Math.max(0, Math.min(chapters.length - 1, index + direction));
  if (index < 0 || index === next) return project;
  [chapters[index], chapters[next]] = [chapters[next], chapters[index]];
  return { ...project, chapters, updatedAt: new Date().toISOString() };
}

export function removeChapter(project, chapterId) {
  if (project.chapters.length <= 1) throw new Error('工程至少保留一个章节。');
  const index = project.chapters.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) throw new Error('要删除的章节已不存在。');
  const chapters = project.chapters.filter((chapter) => chapter.id !== chapterId);
  const activeChapterId = project.activeChapterId === chapterId
    ? chapters[Math.min(index, chapters.length - 1)].id
    : project.activeChapterId;
  return { ...project, chapters, activeChapterId, updatedAt: new Date().toISOString() };
}

export function updateChapter(project, chapterId, update) {
  return { ...project, chapters: project.chapters.map((chapter) => chapter.id === chapterId ? update(chapter) : chapter), updatedAt: new Date().toISOString() };
}

export function createParagraphGroup(chapter, paragraphIds, name) {
  const selected = orderedContiguousIds(chapter, paragraphIds);
  if (!selected.length) throw new Error('请先选择连续的正文段落。');
  const cleaned = splitGroups(chapter, new Set(selected));
  const group = { id: makeId('group'), name: normalizeParagraphGroupName(name), paragraphIds: selected, collapsed: false };
  const updated = withGroupIds({ ...cleaned, groups: [...cleaned.groups, group] });
  return withMusicAttributes(preserveMusicRangeMembership(chapter, updated));
}

/** @param {any} chapter @param {string} name @param {string|null} [afterGroupId] */
export function createEmptyParagraphGroup(chapter, name, afterGroupId = null) {
  const groupName = normalizeParagraphGroupName(name);
  const paragraph = { type: 'paragraph', id: makeId('p'), children: [] };
  const groups = [...chapter.groups];
  const targetIndex = afterGroupId ? groups.findIndex((group) => group.id === afterGroupId) : groups.length - 1;
  const target = groups[targetIndex];
  const blockIndex = target ? chapter.document.blocks.findIndex((block) => block.id === target.paragraphIds.at(-1)) + 1 : chapter.document.blocks.length;
  const blocks = [...chapter.document.blocks];
  blocks.splice(Math.max(0, blockIndex), 0, paragraph);
  const group = { id: makeId('group'), name: groupName, paragraphIds: [paragraph.id], collapsed: false };
  paragraph.groupId = group.id;
  groups.splice(target ? targetIndex + 1 : groups.length, 0, group);
  return { ...chapter, document: { ...chapter.document, blocks }, groups };
}

export function removeParagraphGroup(chapter, groupId) {
  const updated = withGroupIds({ ...chapter, groups: chapter.groups.filter((group) => group.id !== groupId) });
  return withMusicAttributes(preserveMusicRangeMembership(chapter, updated));
}

export function setGroupCollapsed(chapter, groupId, collapsed) {
  return { ...chapter, groups: chapter.groups.map((group) => group.id === groupId ? { ...group, collapsed } : group) };
}

export function renameParagraphGroup(chapter, groupId, name) {
  const value = normalizeParagraphGroupName(name);
  return { ...chapter, groups: chapter.groups.map((group) => group.id === groupId ? { ...group, name: value } : group) };
}

export function moveParagraphGroup(chapter, groupId, direction) {
  const ordered = [...chapter.groups].sort((a, b) => chapter.document.blocks.findIndex((block) => block.id === a.paragraphIds[0]) - chapter.document.blocks.findIndex((block) => block.id === b.paragraphIds[0]));
  const groupIndex = ordered.findIndex((group) => group.id === groupId);
  if (groupIndex < 0) return chapter;
  const group = ordered[groupIndex];
  const ids = orderedContiguousIds(chapter, group.paragraphIds);
  if (!ids.length) throw new Error('段落组内容不连续，请先整理分组。');
  const selected = new Set(ids);
  const movedBlocks = ids.map((id) => chapter.document.blocks.find((block) => block.id === id));
  const start = chapter.document.blocks.findIndex((block) => selected.has(block.id));
  const end = start + ids.length - 1;
  const adjacent = direction < 0 ? chapter.document.blocks[start - 1] : chapter.document.blocks[end + 1];
  if (!adjacent) return chapter;
  const adjacentGroup = chapter.groups.find((item) => item.paragraphIds.includes(adjacent.id));
  const anchor = direction < 0 ? adjacentGroup?.paragraphIds[0] ?? adjacent.id : adjacentGroup?.paragraphIds.at(-1) ?? adjacent.id;
  const blocks = chapter.document.blocks.filter((block) => !selected.has(block.id));
  const anchorIndex = blocks.findIndex((block) => block.id === anchor);
  blocks.splice(direction < 0 ? anchorIndex : anchorIndex + 1, 0, ...movedBlocks);
  const unchangedGroups = withGroupIds({ ...chapter, document: { ...chapter.document, blocks } });
  return withMusicAttributes(reconcileMusicAfterMove(chapter, unchangedGroups, new Map(chapter.groups.map((item) => [item.id, [item.id]]))));
}

export function moveParagraphs(chapter, paragraphIds, target, position = target.position ?? 'after') {
  const selected = orderedContiguousIds(chapter, paragraphIds);
  if (!selected.length) throw new Error('只能拖动本章中连续的正文段落。');
  const selectedSet = new Set(selected);
  const blocksById = new Map(chapter.document.blocks.map((block) => [block.id, block]));
  const moving = selected.map((id) => blocksById.get(id));
  const rest = chapter.document.blocks.filter((block) => !selectedSet.has(block.id));
  let insertionIndex;
  if (target.type === 'group') {
    const group = chapter.groups.find((item) => item.id === target.groupId);
    if (!group) throw new Error('目标段落组已不存在，请重新拖动。');
    if (group.paragraphIds.every((id) => selectedSet.has(id))) return chapter;
    const lastRemaining = group.paragraphIds.filter((id) => !selectedSet.has(id)).at(-1);
    const lastIndex = rest.findIndex((block) => block.id === lastRemaining);
    if (lastIndex < 0) throw new Error('目标段落组内容已变化，请重新拖动。');
    insertionIndex = lastIndex + 1;
  } else if (target.type === 'paragraph') {
    if (selectedSet.has(target.paragraphId)) return chapter;
    const targetIndex = rest.findIndex((block) => block.id === target.paragraphId);
    if (targetIndex < 0) throw new Error('目标正文段落已变化，请重新拖动。');
    insertionIndex = targetIndex + (position === 'after' ? 1 : 0);
  } else throw new Error('拖放目标无效。');

  const oldIndex = new Map(chapter.document.blocks.map((block, index) => [block.id, index]));
  const nextBlocks = [...rest];
  nextBlocks.splice(insertionIndex, 0, ...moving);
  const destinationId = target.type === 'group' ? target.groupId : chapter.groups.find((group) => group.paragraphIds.includes(target.paragraphId))?.id;
  if (nextBlocks.every((block, index) => block.id === chapter.document.blocks[index]?.id) && selected.every((id) => chapter.groups.find((group) => group.paragraphIds.includes(id))?.id === destinationId)) return chapter;

  const nextDocument = { ...chapter.document, blocks: nextBlocks };
  const targetGroup = target.type === 'group' ? chapter.groups.find((group) => group.id === target.groupId) : null;
  const targetParagraph = target.type === 'paragraph' ? target.paragraphId : targetGroup?.paragraphIds.at(-1);
  const destinationGroup = chapter.groups.find((group) => group.paragraphIds.includes(targetParagraph)) ?? null;
  const groupMembership = new Map();
  for (const group of chapter.groups) {
    for (const id of group.paragraphIds) if (!selectedSet.has(id)) groupMembership.set(id, group.id);
  }
  if (destinationGroup) for (const id of selected) groupMembership.set(id, destinationGroup.id);

  const groups = [];
  const groupAliases = new Map();
  for (const group of chapter.groups) {
    const ids = nextBlocks.filter((block) => groupMembership.get(block.id) === group.id).map((block) => block.id);
    const runs = contiguousRuns({ document: nextDocument }, ids);
    if (runs.length) {
      const aliases = runs.map((run, index) => {
        const nextId = index === 0 ? group.id : makeId('group');
        groups.push({ ...group, id: nextId, name: index === 0 ? group.name : `${group.name}（续）`, paragraphIds: run });
        return nextId;
      });
      groupAliases.set(group.id, aliases);
    } else {
      const placeholder = { type: 'paragraph', id: makeId('p'), children: [] };
      const sourceIndex = Math.min(oldIndex.get(group.paragraphIds[0]) ?? nextBlocks.length, nextBlocks.length);
      nextBlocks.splice(sourceIndex, 0, placeholder);
      groupMembership.set(placeholder.id, group.id);
      groups.push({ ...group, paragraphIds: [placeholder.id] });
      groupAliases.set(group.id, [group.id]);
    }
  }
  const groupedChapter = withGroupIds({ ...chapter, document: { ...chapter.document, blocks: nextBlocks }, groups });
  const reconciled = withMusicAttributes(reconcileMusicAfterMove(chapter, groupedChapter, groupAliases, { movedIds: selected, targetRange: targetParagraph ? musicRangeAt(chapter, targetParagraph) : null }));
  return reconciled;
}

export function setMusicRange(chapter, assetId, paragraphIds, options = {}) {
  const selected = orderedContiguousIds(chapter, paragraphIds);
  if (!selected.length) throw new Error('请先选择一个连续的段落范围。');
  const selectedKey = new Set(selected);
  const existingExact = chapter.musicRanges.find((range) => sameMembers(musicRangeParagraphIds(chapter, range), selected));
  const overlaps = chapter.musicRanges.find((range) => range.id !== existingExact?.id && musicRangeParagraphIds(chapter, range).some((id) => selectedKey.has(id)));
  if (overlaps) throw new Error('这个范围与已有背景音乐范围重叠，请先移除或调整原范围。');
  const matchedGroups = chapter.groups.filter((group) => group.paragraphIds.every((id) => selectedKey.has(id)));
  const groupIds = matchedGroups.length && matchedGroups.flatMap((group) => group.paragraphIds).length === selected.length ? matchedGroups.map((group) => group.id) : null;
  const range = { id: existingExact?.id ?? makeId('music-range'), assetId, startParagraphId: selected[0], endParagraphId: selected.at(-1), ...(groupIds ? { groupIds } : {}), volume: options.volume ?? existingExact?.volume ?? 1, loop: options.loop ?? existingExact?.loop ?? false };
  return withMusicAttributes({ ...chapter, musicRanges: [...chapter.musicRanges.filter((item) => item.id !== existingExact?.id), range] });
}

export function replaceMusicRange(chapter, assetId, paragraphIds, options = {}) {
  const selected = orderedContiguousIds(chapter, paragraphIds);
  if (!selected.length) throw new Error('请先选择连续段落或连续段落组。');
  const selectedSet = new Set(selected);
  let next = { ...chapter, musicRanges: [] };
  for (const range of chapter.musicRanges) {
    const remaining = musicRangeParagraphIds(chapter, range).filter((id) => !selectedSet.has(id));
    for (const [index, run] of contiguousRuns(chapter, remaining).entries()) {
      next = setMusicRange(next, range.assetId, run, { volume: range.volume, loop: range.loop });
      const added = next.musicRanges.at(-1);
      added.id = index === 0 ? range.id : makeId('music-range');
    }
  }
  return setMusicRange(next, assetId, selected, options);
}

export function removeMusicRange(chapter, rangeId) {
  return withMusicAttributes({ ...chapter, musicRanges: chapter.musicRanges.filter((range) => range.id !== rangeId) });
}

export function musicRangeAt(chapter, paragraphId) {
  const indexes = paragraphIndexes(chapter);
  const index = indexes.get(paragraphId);
  if (index === undefined) return null;
  return chapter.musicRanges.find((range) => musicRangeParagraphIds(chapter, range).includes(paragraphId)) ?? null;
}

export function reconcileChapterDocument(previous, document) {
  const chapter = { ...previous, document };
  const existing = new Set(document.blocks.map((block) => block.id));
  const chapterIndexes = paragraphIndexes(chapter);
  const newIds = new Set(document.blocks.map((block) => block.id).filter((id) => !oldIndexesHas(previous, id)));
  const groupAttributesPresent = document.blocks.some((block) => Object.hasOwn(block, 'groupId'));
  const groups = [];
  for (const group of previous.groups) {
    if (groupAttributesPresent) {
      const tagged = document.blocks.filter((block) => block.groupId === group.id).map((block) => block.id);
      let ids = tagged;
      if (tagged.length) {
        const start = Math.min(...tagged.map((id) => chapterIndexes.get(id)));
        const end = Math.max(...tagged.map((id) => chapterIndexes.get(id)));
        const span = document.blocks.slice(start, end + 1).map((block) => block.id);
        if (span.every((id) => tagged.includes(id) || newIds.has(id))) ids = span;
      }
      for (const [index, run] of contiguousRuns(chapter, ids).entries()) {
        if (run.length) groups.push({ ...group, id: index === 0 ? group.id : makeId('group'), name: index === 0 ? group.name : `${group.name}（续）`, paragraphIds: run });
      }
      continue;
    }
    const retained = group.paragraphIds.filter((id) => existing.has(id));
    if (!retained.length) continue;
    const min = Math.min(...retained.map((id) => chapterIndexes.get(id)));
    const max = Math.max(...retained.map((id) => chapterIndexes.get(id)));
    const expanded = document.blocks.slice(min, max + 1).map((block) => block.id).filter((id) => retained.includes(id) || newIds.has(id));
    const ids = expanded.length === max - min + 1 ? expanded : retained;
    for (const [index, run] of contiguousRuns(chapter, ids).entries()) {
      if (!run.length) continue;
      groups.push({ ...group, id: index === 0 ? group.id : makeId('group'), name: index === 0 ? group.name : `${group.name}（续）`, paragraphIds: run });
    }
  }
  const musicRanges = [];
  const oldIndexes = paragraphIndexes(previous);
  const newIndexes = paragraphIndexes(chapter);
  const metadataPresent = document.blocks.some((block) => Object.hasOwn(block, 'musicRange'));
  if (metadataPresent) {
    musicRanges.push(...musicRangesFromDocument(chapter, groups));
  } else for (const range of previous.musicRanges) {
    const retained = musicRangeParagraphIds(previous, range).filter((id) => newIndexes.has(id));
    if (!retained.length) continue;
    const musicMembers = Array.isArray(range.groupIds) && range.groupIds.length
      ? groups.filter((group) => range.groupIds.includes(group.id)).flatMap((group) => group.paragraphIds)
      : retained;
    const currentMembers = [...new Set(musicMembers)].filter((id) => newIndexes.has(id));
    for (const [index, run] of contiguousRuns(chapter, currentMembers).entries()) {
      const start = newIndexes.get(run[0]); const end = newIndexes.get(run.at(-1));
      if (end - start + 1 !== run.length) continue;
      const groupIds = range.groupIds ? groups.filter((group) => group.paragraphIds.every((id) => run.includes(id))).map((group) => group.id) : undefined;
      musicRanges.push({ ...range, id: index === 0 ? range.id : makeId('music-range'), startParagraphId: run[0], endParagraphId: run.at(-1), ...(range.groupIds ? { groupIds } : {}) });
    }
  }
  return withMusicAttributes(withGroupIds({ ...chapter, groups, musicRanges }));
}

export function orderedContiguousIds(chapter, paragraphIds) {
  const requested = new Set(paragraphIds);
  const blocks = chapter.document.blocks.filter((block) => requested.has(block.id));
  if (blocks.length !== requested.size || !blocks.length) return [];
  const indexes = blocks.map((block) => chapter.document.blocks.indexOf(block));
  return indexes.at(-1) - indexes[0] + 1 === indexes.length ? blocks.map((block) => block.id) : [];
}

function paragraphIndexes(chapter) {
  return new Map(chapter.document.blocks.map((block, index) => [block.id, index]));
}

function contiguousRuns(chapter, ids) {
  const wanted = new Set(ids);
  const runs = [];
  let run = [];
  for (const block of chapter.document.blocks) {
    if (wanted.has(block.id)) run.push(block.id);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs;
}

export function musicRangeParagraphIds(chapter, range) {
  if (Array.isArray(range.groupIds) && range.groupIds.length) {
    const groupIds = new Set(range.groupIds);
    return chapter.document.blocks.map((block) => block.id).filter((id) => chapter.groups.some((group) => groupIds.has(group.id) && group.paragraphIds.includes(id)));
  }
  const indexes = paragraphIndexes(chapter);
  const start = indexes.get(range.startParagraphId); const end = indexes.get(range.endParagraphId);
  if (start === undefined || end === undefined || start > end) return [];
  return chapter.document.blocks.slice(start, end + 1).map((block) => block.id);
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function oldIndexesHas(chapter, id) {
  return chapter.document.blocks.some((block) => block.id === id);
}

function withGroupIds(chapter) {
  const membership = new Map(chapter.groups.flatMap((group) => group.paragraphIds.map((id) => [id, group.id])));
  const blocks = chapter.document.blocks.map((block) => {
    const groupId = membership.get(block.id);
    if (groupId === undefined) {
      if (!Object.hasOwn(block, 'groupId')) return block;
      const { groupId: _groupId, ...plainBlock } = block;
      return plainBlock;
    }
    return block.groupId === groupId ? block : { ...block, groupId };
  });
  return { ...chapter, document: { ...chapter.document, blocks } };
}

function withMusicAttributes(chapter) {
  const membership = new Map();
  for (const range of chapter.musicRanges) {
    const metadata = { id: range.id, assetId: range.assetId, volume: range.volume, loop: range.loop, ...(range.groupIds ? { groupIds: range.groupIds } : {}) };
    for (const id of musicRangeParagraphIds(chapter, range)) membership.set(id, metadata);
  }
  const blocks = chapter.document.blocks.map((block) => {
    const musicRange = membership.get(block.id);
    if (!musicRange) {
      if (!Object.hasOwn(block, 'musicRange')) return block;
      const { musicRange: _musicRange, ...plainBlock } = block;
      return plainBlock;
    }
    return JSON.stringify(block.musicRange) === JSON.stringify(musicRange) ? block : { ...block, musicRange };
  });
  return { ...chapter, document: { ...chapter.document, blocks } };
}

function musicRangesFromDocument(chapter, groups) {
  const entries = new Map();
  for (const block of chapter.document.blocks) {
    const value = block.musicRange;
    if (!value || typeof value !== 'object' || !value.id) continue;
    const entry = entries.get(value.id) ?? { metadata: value, ids: [] };
    entry.ids.push(block.id);
    entries.set(value.id, entry);
  }
  for (const entry of entries.values()) {
    if (!Array.isArray(entry.metadata.groupIds)) continue;
    const groupIds = new Set(entry.metadata.groupIds);
    for (const group of groups) {
      if (!groupIds.has(group.id)) continue;
      for (const paragraphId of group.paragraphIds) if (!entry.ids.includes(paragraphId)) entry.ids.push(paragraphId);
    }
  }
  const ranges = [];
  for (const [id, entry] of entries) {
    for (const [index, run] of contiguousRuns(chapter, entry.ids).entries()) {
      const groupIds = entry.metadata.groupIds ? groups.filter((group) => entry.metadata.groupIds.includes(group.id) && group.paragraphIds.every((paragraphId) => run.includes(paragraphId))).map((group) => group.id) : undefined;
      ranges.push({ id: index === 0 ? id : makeId('music-range'), assetId: entry.metadata.assetId, startParagraphId: run[0], endParagraphId: run.at(-1), volume: entry.metadata.volume, loop: entry.metadata.loop, ...(groupIds?.length ? { groupIds } : {}) });
    }
  }
  return ranges;
}

function reconcileMusicAfterMove(before, after, groupAliases = new Map(), { movedIds = [], targetRange = null } = {}) {
  const ranges = [];
  const movedSet = new Set(movedIds);
  for (const range of before.musicRanges) {
    const memberSet = new Set(musicRangeParagraphIds(before, range).filter((id) => !movedSet.has(id)));
    if (targetRange?.id === range.id && !range.groupIds) movedSet.forEach((id) => memberSet.add(id));
    if (Array.isArray(range.groupIds) && range.groupIds.length) {
      const groupIds = [...new Set(range.groupIds.flatMap((id) => groupAliases.get(id) ?? [id]))].filter((id) => after.groups.some((group) => group.id === id));
      const members = after.document.blocks.map((block) => block.id).filter((id) => after.groups.some((group) => groupIds.includes(group.id) && group.paragraphIds.includes(id)));
      const runs = contiguousRuns(after, members);
      for (const [index, run] of runs.entries()) if (run.length) ranges.push({ ...range, id: index === 0 ? range.id : makeId('music-range'), groupIds: after.groups.filter((group) => group.paragraphIds.every((id) => run.includes(id))).map((group) => group.id), startParagraphId: run[0], endParagraphId: run.at(-1) });
      continue;
    }
    const members = after.document.blocks.map((block) => block.id).filter((id) => memberSet.has(id));
    const runs = contiguousRuns(after, members);
    for (const [index, run] of runs.entries()) if (run.length) ranges.push({ ...range, id: index === 0 ? range.id : makeId('music-range'), startParagraphId: run[0], endParagraphId: run.at(-1) });
  }
  return { ...after, musicRanges: ranges };
}

function splitGroups(chapter, movedIds) {
  const groups = [];
  for (const group of chapter.groups) {
    const retained = group.paragraphIds.filter((id) => !movedIds.has(id));
    for (const [index, ids] of contiguousRuns(chapter, retained).entries()) {
      if (ids.length) groups.push({ ...group, id: index === 0 ? group.id : makeId('group'), name: index === 0 ? group.name : `${group.name}（续）`, paragraphIds: ids });
    }
  }
  return { ...chapter, groups };
}

function preserveMusicRangeMembership(before, after) {
  const afterIndexes = paragraphIndexes(after);
  const ranges = before.musicRanges.map((range) => {
    const members = musicRangeParagraphIds(before, range);
    const positions = members.map((id) => afterIndexes.get(id)).sort((a, b) => a - b);
    if (positions.some((index) => index === undefined) || positions.at(-1) - positions.at(0) + 1 !== positions.length) throw new Error('移动段落组会拆开背景音乐范围，请先调整音乐范围。');
    const { groupIds: _groupIds, ...paragraphRange } = range;
    return { ...paragraphRange, startParagraphId: after.document.blocks[positions[0]].id, endParagraphId: after.document.blocks[positions.at(-1)].id };
  });
  return { ...after, musicRanges: ranges };
}
