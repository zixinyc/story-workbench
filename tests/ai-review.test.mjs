import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { activeChapter, createParagraphGroup, removeMusicRange, setMusicRange } from '../src/domain/model/chapters.mjs';
import { createDemoProject, validateProject } from '../src/domain/model/project.mjs';
import { defaultSettings, plainText } from '../src/domain/model/document.mjs';
import { applyReviewChanges, createReviewArchive, createReviewDocuments, createReviewSnapshot, reviewHash, validateReviewChanges } from '../src/ai-review/review-package.mjs';

function fixture() {
  let project = createDemoProject();
  const chapter = activeChapter(project);
  const ids = chapter.document.blocks.map((block) => block.id);
  let nextChapter = createParagraphGroup(chapter, ids.slice(1, 3), '循环');
  nextChapter = setMusicRange(nextChapter, 'audio-loop', ids.slice(1, 3));
  project = {
    ...project,
    assets: [{ id: 'audio-loop', name: '循环底噪.mp3', kind: 'audio', mime: 'audio/mpeg', size: 128 }],
    chapters: project.chapters.map((item) => item.id === chapter.id ? nextChapter : item),
  };
  assert.equal(validateProject(project), true);
  const current = activeChapter(project);
  const explicitCues = current.document.blocks.flatMap((paragraph) => paragraph.children.filter((node) => node.type === 'cue').map((cue) => ({ cue, paragraph })));
  return { project, chapter: current, group: current.groups[0], textCue: explicitCues[0], settingsCue: explicitCues.at(-1) };
}

function envelope(project, scope, baseHash, changes) {
  return { format: 'story-workbench-ai-changes', version: 1, baseProjectId: project.id, baseHash, scope, changes };
}

test('审阅包导出剧情、演出/配乐清单、媒体标记和匹配导入 schema', async () => {
  const { project } = fixture();
  const scope = { type: 'chapter', chapterId: project.activeChapterId };
  const snapshot = createReviewSnapshot(project, scope);
  const baseHash = await reviewHash(snapshot);
  const files = createReviewDocuments(snapshot, baseHash, '加强循环感', new Set());
  assert.deepEqual(Object.keys(files), ['作品说明.md', '阅读说明.md', '剧情.md', '演出配乐清单.json', 'project.snapshot.json', 'supported-changes.schema.json', '改进提示词.md']);
  assert.match(files['剧情.md'], /groupId/);
  assert.match(files['演出配乐清单.json'], /motionSettings|motion/);
  assert.match(files['演出配乐清单.json'], /attachedToPackage": false/);
  assert.match(files['改进提示词.md'], /story-workbench-ai-changes/);
  assert.equal(JSON.parse(files['project.snapshot.json']).baseHash, baseHash);
  assert.equal(JSON.parse(files['supported-changes.schema.json']).properties.baseHash.const, baseHash);
  const withMedia = createReviewDocuments(snapshot, baseHash, '加强循环感', new Set(['audio-loop']));
  assert.match(withMedia['演出配乐清单.json'], /媒体\/audio-loop\.mp3/);
});

test('审阅 ZIP 可往返读取，媒体附带状态与实际归档路径一致', async () => {
  const { project } = fixture();
  const scope = { type: 'chapter', chapterId: project.activeChapterId };
  const snapshot = createReviewSnapshot(project, scope);
  const baseHash = await reviewHash(snapshot);
  const assets = [{ id: 'audio-loop', name: '循环底噪.mp3', size: 128, blob: new Blob([new Uint8Array([1, 2, 3, 4])]) }];
  const { bytes } = await createReviewArchive(JSZip, snapshot, baseHash, '带上音频', assets, true);
  const zip = await JSZip.loadAsync(bytes);
  for (const fileName of ['作品说明.md', '阅读说明.md', '剧情.md', '演出配乐清单.json', 'project.snapshot.json', 'supported-changes.schema.json', '改进提示词.md', '媒体/audio-loop.mp3']) assert.ok(zip.file(fileName));
  const manifest = JSON.parse(await zip.file('演出配乐清单.json').async('string'));
  const audio = manifest.assets.find((asset) => asset.id === 'audio-loop');
  assert.equal(audio.attachedToPackage, true);
  assert.equal(audio.packagePath, '媒体/audio-loop.mp3');
  assert.deepEqual([...new Uint8Array(await zip.file(audio.packagePath).async('uint8array'))], [1, 2, 3, 4]);
  const metadataOnly = await createReviewArchive(JSZip, snapshot, baseHash, '', assets, false);
  const metadataZip = await JSZip.loadAsync(metadataOnly.bytes);
  const metadata = JSON.parse(await metadataZip.file('演出配乐清单.json').async('string'));
  assert.equal(metadata.assets.find((asset) => asset.id === 'audio-loop').attachedToPackage, false);
  assert.equal(metadataZip.file('媒体/audio-loop.mp3'), null);
});

test('建议校验并原子应用正文、演出与连续段落组配乐，保留所有稳定 ID', async () => {
  const { project, textCue, settingsCue, group } = fixture();
  const scope = { type: 'chapter', chapterId: project.activeChapterId };
  const baseHash = await reviewHash(createReviewSnapshot(project, scope));
  const beforeSettings = defaultSettings(settingsCue.cue.settings);
  const afterSettings = { ...beforeSettings, mode: 'free', motion: 'shake', x: 820, y: 420, durationMs: 5400 };
  const beforeMusic = { assetId: 'audio-loop', volume: 1, loop: false };
  const changes = [
    { op: 'replaceCueText', chapterId: scope.chapterId, cueId: textCue.cue.id, before: plainText(textCue.cue.children), after: '新的显字内容', reason: '让循环伏笔更清楚。' },
    { op: 'updateCueSettings', chapterId: scope.chapterId, cueId: settingsCue.cue.id, before: beforeSettings, after: afterSettings, reason: '使用自由文字并拉长阅读时间。' },
    { op: 'updateGroupMusic', chapterId: scope.chapterId, groupIds: [group.id], before: beforeMusic, after: { ...beforeMusic, volume: 0.62, loop: true }, reason: '降低音量并保持循环。' },
  ];
  const raw = JSON.stringify(envelope(project, scope, baseHash, changes));
  const proposal = await validateReviewChanges(project, raw);
  const updated = applyReviewChanges(project, proposal);
  assert.equal(validateProject(updated), true);
  const updatedChapter = activeChapter(updated);
  assert.equal(updatedChapter.document.blocks.find((block) => block.id === textCue.paragraph.id).children.find((node) => node.id === textCue.cue.id).children[0].text, '新的显字内容');
  const updatedSettingsCue = updatedChapter.document.blocks.flatMap((block) => block.children).find((node) => node.type === 'cue' && node.id === settingsCue.cue.id);
  assert.equal(updatedSettingsCue.settings.x, 820);
  assert.equal(updatedSettingsCue.settings.motion, 'shake');
  assert.equal(updatedSettingsCue.id, settingsCue.cue.id);
  assert.deepEqual(updatedChapter.musicRanges[0].groupIds, [group.id]);
  assert.equal(updatedChapter.musicRanges[0].volume, 0.62);
  assert.equal(updatedChapter.musicRanges[0].loop, true);
});

test('过期基线、未知目标、局部字色改写、坏参数和音乐冲突都整份拒绝', async () => {
  const { project, textCue, settingsCue, group } = fixture();
  const scope = { type: 'chapter', chapterId: project.activeChapterId };
  const baseHash = await reviewHash(createReviewSnapshot(project, scope));
  const goodText = { op: 'replaceCueText', chapterId: scope.chapterId, cueId: textCue.cue.id, before: plainText(textCue.cue.children), after: '改写', reason: '用词更准确。' };
  await assert.rejects(validateReviewChanges(project, JSON.stringify({ ...envelope(project, scope, baseHash, [goodText]), baseHash: '0'.repeat(64) })), /工程在导出后已变化/);
  await assert.rejects(validateReviewChanges(project, JSON.stringify(envelope(project, scope, baseHash, [{ ...goodText, cueId: 'missing-cue' }]))), /cueId 不存在/);
  const badSettings = { op: 'updateCueSettings', chapterId: scope.chapterId, cueId: settingsCue.cue.id, before: defaultSettings(settingsCue.cue.settings), after: { ...defaultSettings(settingsCue.cue.settings), fontSize: 999 }, reason: '测试越界。' };
  await assert.rejects(validateReviewChanges(project, JSON.stringify(envelope(project, scope, baseHash, [goodText, badSettings]))), /字号必须/);
  const colored = structuredClone(project);
  const coloredCue = activeChapter(colored).document.blocks.flatMap((block) => block.children).find((node) => node.type === 'cue' && node.id === textCue.cue.id);
  coloredCue.children = [{ type: 'text', text: '有颜色', color: '#ff0000' }];
  const coloredHash = await reviewHash(createReviewSnapshot(colored, scope));
  const coloredChange = { ...goodText, before: '有颜色' };
  await assert.rejects(validateReviewChanges(colored, JSON.stringify(envelope(colored, scope, coloredHash, [coloredChange]))), /含有局部字色/);
  const overlapping = structuredClone(project);
  const chapterWithoutMusic = removeMusicRange(activeChapter(overlapping), activeChapter(overlapping).musicRanges[0].id);
  const overlappingChapter = setMusicRange(chapterWithoutMusic, 'audio-loop', [group.paragraphIds[0]]);
  overlapping.chapters = overlapping.chapters.map((item) => item.id === overlappingChapter.id ? overlappingChapter : item);
  const overlappingHash = await reviewHash(createReviewSnapshot(overlapping, scope));
  const overlappingMusic = { op: 'updateGroupMusic', chapterId: scope.chapterId, groupIds: [group.id], before: null, after: null, reason: '清理冲突范围。' };
  await assert.rejects(validateReviewChanges(overlapping, JSON.stringify(envelope(overlapping, scope, overlappingHash, [overlappingMusic]))), /部分重叠/);
});

test('导入只接受精确字段，不执行附带代码，也拒绝范围外组', async () => {
  const { project, settingsCue, group } = fixture();
  const scope = { type: 'groups', chapterId: project.activeChapterId, groupIds: [group.id] };
  const baseHash = await reviewHash(createReviewSnapshot(project, scope));
  const cue = group.paragraphIds.map((id) => activeChapter(project).document.blocks.find((block) => block.id === id)).flatMap((block) => block.children).find((node) => node.type === 'cue');
  assert.ok(cue);
  const allowed = { op: 'replaceCueText', chapterId: scope.chapterId, cueId: cue.id, before: plainText(cue.children), after: '段落组内改文', reason: '改进表述。' };
  const extraField = { ...allowed, script: 'globalThis.pwned=true' };
  await assert.rejects(validateReviewChanges(project, JSON.stringify(envelope(project, scope, baseHash, [extraField]))), /字段缺失或包含不支持/);
  await assert.rejects(validateReviewChanges(project, JSON.stringify(envelope(project, scope, baseHash, [{ ...allowed, cueId: settingsCue.cue.id }]))), /超出审阅范围/);
});
