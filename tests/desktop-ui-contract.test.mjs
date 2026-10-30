import test from 'node:test';
import {Editor} from '@tiptap/core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindEditorViewListeners } from '../src/editor/editor-view.mjs';

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const electronMain = readFileSync(new URL('../electron/main.mjs', import.meta.url), 'utf8');

test('章节和段落组命名不依赖 Electron 不支持的原生 prompt', () => {
  assert.doesNotMatch(source, /window\.prompt\s*\(/);
  assert.equal((source.match(/normalize: normalizeChapterName/g) ?? []).length, 2);
  assert.equal((source.match(/normalize: normalizeParagraphGroupName/g) ?? []).length, 3);
  assert.match(source, /function NameInputDialog/);
  assert.match(source, /role="dialog" aria-modal="true"/);
  assert.match(source, /inputRef\.current\?\.focus\(\);[\s\S]*inputRef\.current\?\.select\(\)/);
  assert.match(source, /onSubmit=\{submit\}/);
  assert.match(source, /event\.key === 'Escape'[\s\S]*onCancel\(\)/);
  assert.match(source, /maxLength=\{120\}/);
  assert.match(source, /className="name-dialog-error" role="alert"/);
});

test('新建段落组用确认前捕获的章节和段落 ID', () => {
  assert.match(source, /const chapterId = chapter\.id;\s*const paragraphIds = \[\.\.\.selectedParagraphs\]/);
  assert.match(source, /createParagraphGroup\(value, paragraphIds, name\)/);
  assert.match(source, /current\.activeChapterId !== chapterId/);
});

test('剧情目录按章节→组定位，不再逐句重复列出；组操作有明确边界', () => {
  assert.doesNotMatch(source, /renderOutlineParagraph/);
  assert.match(source, /<strong>剧情目录<\/strong>/);
  assert.match(source, /locateGroup\(item\.chapter\.id, group\.id\)/);
  assert.match(source, /未分组（\{item\.ungroupedCount\} 段）/);
  assert.match(source, /data-group-header="\$\{CSS\.escape\(pending\.id\)\}"/);
  assert.match(source, /disabled=\{chapterIndex <= 0\}/);
  assert.match(source, /disabled=\{chapterIndex >= project\.chapters\.length - 1\}/);
  assert.match(source, /if \(!result\) \{\s*updateSaveLabel\(previousSaveLabel\);\s*return null;/);
  assert.match(source, /if \(!asCopy && saveTimer\.current !== null\)/);
});

test('保存归属在调用时锁定，迟到的保存不会写进别的工程', () => {
  assert.match(source, /const targetKey = libraryKeyRef\.current;/);
  assert.match(source, /if \(libraryKeyRef\.current !== targetKey\) return result;/);
  assert.match(source, /savedSnapshotRef\.current = \{ key: targetKey, \.\.\.snapshot \};/);
  assert.match(source, /savedSnapshotRef\.current\?\.key === targetKey/);
});

test('目录定位不写结构历史、不改正文、组成员与配乐', () => {
  const start = source.indexOf('const runLocate =');
  const end = source.indexOf('const locateGroup =');
  assert.ok(start > 0 && end > start, '应能找到定位实现');
  const locate = source.slice(start, end);
  assert.doesNotMatch(locate, /commitChapterStructure|updateChapter|moveParagraphs|setMusicRange|setGroupCollapsed/);
  assert.doesNotMatch(locate, /startPlayback|playerRef\.current\.play/);
  /* 定位用令牌，旧的定位回调必须失效 */
  assert.match(source, /if \(pending\.token !== locateTokenRef\.current\) return;/);
  /* 跨章定位要等编辑器视图就绪，不用延时去猜挂载 */
  assert.match(source, /pendingLocateRef\.current = null;\s*runLocate\(pendingLocate\);/);
});

test('工程库按工程隔离内容与外部保存位置，界面不再有全局保存目标', () => {
  assert.match(preload, /library:save/);
  assert.match(preload, /library:save-as/);
  assert.match(preload, /library:create/);
  assert.match(electronMain, /library:save-as/);
  assert.match(electronMain, /library:import-commit/);
  assert.doesNotMatch(electronMain, /let manualSaveTarget/);
  assert.doesNotMatch(electronMain, /saveTargetSettingsPath/);
  /* 顶部要有清楚的「切换工程」入口 */
  assert.match(source, /<summary>切换工程<\/summary>/);
  assert.match(source, /切换到/);
});

test('AI 审阅导出与建议导入使用独立本地 IPC，界面明确分开工程包和审阅包', () => {
  assert.match(source, /导出完整审阅包/);
  assert.match(source, /导出作品说明/);
  assert.match(source, /导入改进建议/);
  assert.match(source, /导出工程包/);
  assert.match(source, /检查 AI 改进建议/);
  assert.match(source, /Ctrl\+Z 一次撤销整批修改/);
  assert.match(preload, /workspace:review-export/);
  assert.match(preload, /workspace:export-document/);
  assert.match(preload, /workspace:ai-changes-import/);
  assert.match(electronMain, /maxAiChangesBytes = 2 \* 1024 \* 1024/);
  assert.match(electronMain, /\.storyreview\.zip/);
  assert.doesNotMatch(source, /fetch\s*\(/);
});

test('切章和新建章销毁旧编辑器后，清理绑定不再读取已卸载的 Tiptap view', () => {
  assert.match(source, /return bindEditorViewListeners\(editor, \[/);
  const names=['story-paragraph-select','story-group-select','story-group-music'];
  for(let chapter=0;chapter<3;chapter++){
    const dom=new EventTarget();
    const editor=Object.create(Editor.prototype);
    editor.callbacks={};
    editor.editorView={dom,isDestroyed:false};
    let calls=0;
    const handler=()=>{calls++;};
    const cleanup=bindEditorViewListeners(editor,names.map((name)=>[name,handler]));
    for(const name of names)dom.dispatchEvent(new Event(name));
    assert.equal(calls,3);
    editor.editorView=null; // Tiptap unmount 后 view.dom 确实抛错。
    assert.throws(()=>editor.view.dom,/editor view is not available/);
    assert.doesNotThrow(cleanup);
    for(const name of names)dom.dispatchEvent(new Event(name));
    assert.equal(calls,3,'旧章事件均已移除，不残留到新章');
  }
});
