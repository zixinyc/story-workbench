export function mergeChapterHistorySnapshot(currentProject, snapshot, chapterId) {
  if (!currentProject || !snapshot || currentProject.id !== snapshot.id) return currentProject;
  const historicalChapter = snapshot.chapters.find((chapter) => chapter.id === chapterId);
  if (!historicalChapter || !currentProject.chapters.some((chapter) => chapter.id === chapterId)) return currentProject;
  return {
    ...currentProject,
    chapters: currentProject.chapters.map((chapter) => chapter.id === chapterId ? historicalChapter : chapter),
    updatedAt: snapshot.updatedAt,
  };
}
