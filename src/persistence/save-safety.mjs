import { plainText } from '../domain/model/document.mjs';
export function chapterTextCounts(project) {
  return Object.fromEntries(project.chapters.map((chapter) => [chapter.id, chapter.document.blocks.reduce((count, block) => count + plainText(block.children).length, 0)]));
}
export function isLargeTextDeletion(previous, next) {
  return Object.entries(previous).some(([id, count]) => count >= 20 && (next[id] ?? 0) < count / 2);
}
