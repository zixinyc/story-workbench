import { musicRangeAt } from '../domain/model/chapters.mjs';

export function createParagraphPresentationReader(getContext) {
  let lastChapter;
  let lastAssets;
  let presentations = new Map();
  return (paragraphId) => {
    const context = getContext();
    const { chapter, assets } = context;
    if (chapter !== lastChapter || assets !== lastAssets) {
      const positions = new Map(chapter.document.blocks.map((block, index) => [block.id, index]));
      const groups = [...chapter.groups].sort((a, b) => (positions.get(a.paragraphIds[0]) ?? -1) - (positions.get(b.paragraphIds[0]) ?? -1));
      const assetById = new Map(assets.map((asset) => [asset.id, asset]));
      presentations = new Map(chapter.document.blocks.map((block) => [block.id, { groupId: null, label: '未分组', summary: '', musicLabel: '＋ 添加背景音乐' }]));
      groups.forEach((group, index) => {
        const music = musicRangeAt(chapter, group.paragraphIds[0]);
        const audio = assetById.get(music?.assetId);
        const label = '第 ' + (index + 1) + ' 组 · ' + group.name;
        const summary = audio ? '♫ ' + audio.name + (music?.groupIds?.length ? ' · 连续 ' + music.groupIds.length + ' 组' : '') : '无配乐';
        for (const id of group.paragraphIds) presentations.set(id, { groupId: group.id, label, summary: group.paragraphIds.length + ' 段 · ' + summary, collapsed: !!group.collapsed, groupStart: id === group.paragraphIds[0], musicLabel: audio ? '更换背景音乐' : '＋ 添加背景音乐' });
      });
      lastChapter = chapter;
      lastAssets = assets;
    }
    const presentation = presentations.get(paragraphId) ?? { groupId: null, label: '未分组', summary: '', musicLabel: '＋ 添加背景音乐' };
    return {
      ...presentation,
      paragraphSelected: context.paragraphIds.includes(paragraphId),
      groupSelected: context.groupIds.includes(presentation.groupId),
      groupDropLabel: context.dropHint?.intent === 'audio' ? '设为该组配乐' : '放到组末',
      groupDrop: !!presentation.groupId && context.dropHint?.groupId === presentation.groupId,
      dropBefore: context.dropHint?.paragraphId === paragraphId && context.dropHint.position === 'before',
      dropAfter: context.dropHint?.paragraphId === paragraphId && context.dropHint.position === 'after',
    };
  };
}
