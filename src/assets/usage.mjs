import { compileDocument } from '../domain/model/document.mjs';
export function assetUsages(project, assetId) {
  const result = [];
  for (const chapter of project.chapters) {
    for (const [index, cue] of compileDocument(chapter.document).entries()) {
      if (cue.settings.backgroundId === assetId || cue.settings.audioId === assetId || cue.settings.sceneLayers?.some((layer) => layer.assetId === assetId)) {
        result.push(chapter.name + ' · 第 ' + (index + 1) + ' 句');
      }
    }
    for (const range of chapter.musicRanges) {
      if (range.assetId === assetId) result.push(chapter.name + ' · 背景音乐范围');
    }
  }
  return result;
}
