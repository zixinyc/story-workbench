import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, useEditor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Color from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import Placeholder from '@tiptap/extension-placeholder';
import UniqueID from '@tiptap/extension-unique-id';
import JSZip from 'jszip';
import { createBlankProject, createDemoProject, normalizeProjectName, renameProject, validateProject } from './domain/model/project.mjs';
import { activeChapter, addChapter, createEmptyParagraphGroup, createParagraphGroup, moveParagraphGroup, moveParagraphs, musicRangeAt, musicRangeParagraphIds, normalizeChapterName, normalizeParagraphGroupName, reconcileChapterDocument, removeChapter, removeMusicRange, removeParagraphGroup, renameChapter, renameParagraphGroup, reorderChapter, replaceMusicRange, setGroupCollapsed, setMusicRange, updateChapter } from './domain/model/chapters.mjs';
import { compileDocument, defaultSettings, makeId, plainText, resolveState, validateCueSettings } from './domain/model/document.mjs';
import { createPlayer, playbackStartIndex } from './runtime/player.mjs';
import { createChapterMediaController } from './runtime/chapter-media-controller.mjs';
import { objectUrl, recordsFromFiles, revokeUnusedUrls, disposeUrls } from './assets/manager.mjs';
import { createProjectArchive, readProjectArchive } from './persistence/archive.mjs';
import { recoverMissingWorkspace } from './persistence/startup-recovery.mjs';
import { appendEditorParagraphs, applyCuePatch, applyMode, CueMark, fromEditorContent, findCueRange, moveEditorParagraphs, projectParagraphDecorations, replaceEditorDocument, selectedStoryId, selectedParagraphIds as readSelectedParagraphIds, StoryAttributes, toEditorContent, type CueSettings } from './editor/story-editor';
import { resolveParagraphDropTarget } from './editor/paragraph-drop-target.ts';
import { resizeLayer } from './editor/layer-resize.mjs';
import { bindEditorViewListeners, editorViewDom, isEditorViewReady, onEditorViewMount } from './editor/editor-view.mjs';
import { createParagraphPresentationReader } from './editor/paragraph-presentation.mjs';
import { MediaSession } from './media/media-session';
import { createHtmlAudioBackend } from './media/html-audio-backend';
import { extractAudioFromVideo } from './media/mp4-audio-extract';
import { MOTION_PRESETS, defaultMotionSettings, minimumMotionDuration } from './motion/effects.mjs';
import { CueMotionText } from './motion/CueMotionText';
import { applyReviewChanges, createReviewArchive, createReviewSnapshot, reverseReviewChanges, reviewHash, validateReviewChanges } from './ai-review/review-package.mjs';
import { createWorkDescription } from './ai-review/work-description.mjs';
import { parseArticleText } from './domain/model/article-import.mjs';
import { assetUsages } from './assets/usage.mjs';
import { chapterTextCounts, isLargeTextDeletion } from './persistence/save-safety.mjs';
import { videoPositionSeconds } from './runtime/video-position.mjs';
import { shouldHandlePlaybackSpace } from './runtime/hotkeys.mjs';
import { mergeChapterHistorySnapshot } from './runtime/chapter-history.mjs';
import { ContextMenu } from './ui/ContextMenu';
import { commandForKey, deferToNativeMenu, executeMenuCommand, type MenuCommand, type MenuContext } from './ui/context-menu-model';
import { buildWorkspaceMenu, menuTitle, type MenuActions, type MenuFacts, type MenuTarget } from './ui/workspace-menu';
import { checkClipboardReferences, clipboardText, deleteEditorParagraph, paragraphPosition, pasteEditorClipboard, validateClipboard, type StoryClipboard } from './editor/context-clipboard';
import './app.css';

(globalThis as any).JSZip = JSZip;

type RestoreVersion = { id: string; savedAt: string; bytes: number; reason: string };
/** 本地工程库里的一条工程记录：只有目录元数据，内容另存在各自目录中 */
type LibraryEntry = { key: string; projectId: string; name: string; createdAt: string; updatedAt: string };
/** 导入时发现库里已有同一份作品，先让用户决定怎么处理 */
type ImportCandidateState = { name: string; bytes: Uint8Array; project: any; assets: AssetRecord[]; existing: LibraryEntry };
/** 左侧目录的一次定位：跨章时等编辑器就绪后再执行 */
type PendingLocate = { chapterId: string; kind: 'group' | 'paragraph'; id: string; token: number };
type PendingMusic = { chapterId: string; assetId: string; paragraphIds: string[]; base: any };
const PARAGRAPH_DRAG = 'application/x-story-workbench-paragraphs';
const AUDIO_DRAG = 'application/x-story-workbench-audio';
function paragraphTarget(element: EventTarget | null) {
  const node = element instanceof Element ? element.closest<HTMLElement>('[data-paragraph-id],[data-paragraphid]') : null;
  return node ? { node, id: node.getAttribute('data-paragraph-id') ?? node.getAttribute('data-paragraphid') } : null;
}
function editorContent(chapter: any) {
  return { ...toEditorContent(chapter.document, chapter.groups, chapter.musicRanges), attrs: { chapterId: chapter.id, reviewToken: null } };
}
type AssetRecord = { id: string; name: string; kind: string; mime: string; size: number; blob: Blob; width?: number; height?: number };
type Loaded = { project: any; assets: AssetRecord[]; message?: string; libraryKey: string };
/** 蓝黑 / 蓝白共用同一套页面，只换语义色；舞台画面不随主题变化 */
type ThemeName = 'ink' | 'paper';
const THEME_KEY = 'story-workbench-theme';
function readTheme(): ThemeName {
  try { return window.localStorage.getItem(THEME_KEY) === 'paper' ? 'paper' : 'ink'; } catch { return 'ink'; }
}
function applyTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
  try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* 记录失败不影响使用 */ }
}
type PlayerSnapshot = { status: 'stopped' | 'playing' | 'paused'; index: number; cue: any; elapsedMs: number; durationMs: number; runMode: string | null };
type PlaybackClock = { snapshot: PlayerSnapshot; listeners: Set<() => void> };
type NameDialogState = { title: string; fieldLabel: string; confirmLabel: string; initialValue: string; description?: string; normalize: (value: string) => string; onConfirm: (value: string) => string | undefined };
type AiReviewState = { mode: 'export'; scopeType: 'project' | 'chapter' | 'groups'; includeMedia: boolean; goal: string } | { mode: 'import'; fileName: string; rawText: string; proposal: any; checked: boolean[] } | { mode: 'prompt'; filePath: string; prompt: string };

async function measureAssets(assets: AssetRecord[]) {
  return Promise.all(assets.map(async (asset) => {
    if (asset.kind !== 'image' || typeof createImageBitmap !== 'function') return asset;
    try {
      const bitmap = await createImageBitmap(asset.blob);
      const measured = { ...asset, width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return measured;
    } catch { return asset; }
  }));
}

async function packBytes(project: any, assets: AssetRecord[]) {
  const blob = await createProjectArchive(project, assets);
  return new Uint8Array(await blob.arrayBuffer());
}

async function readPack(bytes: Uint8Array, name: string): Promise<Omit<Loaded, 'libraryKey'>> {
  const result = await readProjectArchive(new Blob([bytes.slice().buffer], { type: 'application/zip' }));
  return { project: result.project, assets: result.assets, message: `${name} 已通过校验。` };
}

/** 打不开工程时要记住是哪一个工程，恢复页才知道往哪恢复 */
class LibraryOpenError extends Error {
  libraryKey: string | null;
  constructor(message: string, libraryKey: string | null) {
    super(message);
    this.libraryKey = libraryKey;
  }
}

/**
 * 打开工程库里的一份工程。
 * 内容读不出来时依次尝试：这一份工程自己的恢复点 → 恢复历史/导入前备份。
 * 全部读不出来就抛错，绝不静默换成示例工程或空白工程。
 */
async function openLibraryProject(key: string): Promise<Loaded> {
  const bridge = window.storyWorkbench.library;
  const bytes = await bridge.load(key);
  if (bytes) {
    try {
      const data = await readPack(bytes, '本机工程');
      return { ...data, libraryKey: key };
    } catch (error) {
      const restore = await bridge.restorePoint(key);
      if (restore) {
        const data = await readPack(restore, '恢复点');
        await bridge.restoreApply(key, restore);
        data.message = '检测到工程包无效，已从独立恢复点恢复。';
        return { ...data, libraryKey: key };
      }
      throw new LibraryOpenError(error instanceof Error ? error.message : '工程包无法读取。', key);
    }
  }
  /* 当前工程文件缺失：先判断是不是首次使用。
     有恢复证据就找回可用工程，不能直接新建示例工程，否则用户会以为自己的工程没保存过。 */
  const scoped = {
    loadRestore: () => bridge.restorePoint(key),
    loadImportBackup: () => bridge.importBackup(key),
    listRestoreVersions: () => bridge.historyList(key),
    loadRestoreVersion: (id: string) => bridge.historyLoad(key, id),
  };
  let recovered: any = null;
  try { recovered = await recoverMissingWorkspace(scoped, readPack); }
  catch (error) { throw new LibraryOpenError(error instanceof Error ? error.message : '本机工程读取失败。', key); }
  if (recovered) {
    if (recovered.sourceBytes) {
      try { await bridge.restoreApply(key, recovered.sourceBytes); }
      catch { /* 写回失败不阻塞打开，用户下次保存会重新落盘 */ }
    }
    /* 有来源读不到时不能再承诺"历史版本仍可继续找回"，那是不实的话。 */
    const unreadableNote = recovered.unreadable?.length
      ? `另有 ${recovered.unreadable.length} 个恢复来源读不到：${recovered.unreadable.join('；')}。`
      : '原文件未删除，历史版本仍可继续找回。';
    return { ...recovered, libraryKey: key, message: `当前工程文件缺失，已从${recovered.recoveredFrom}恢复。${unreadableNote}` };
  }
  throw new LibraryOpenError('这个工程在本机没有可读取的内容。', key);
}

/**
 * 启动：先把旧版单工程纳入工程库，再打开当前工程。
 * 迁移只复制不删除；旧文件读不出来时抛错，不会被当成"首次使用"。
 */
async function openLibraryEntry(): Promise<Loaded> {
  const bridge = window.storyWorkbench.library;
  let state = await bridge.list();
  let note = '';
  if (state.legacyPending) {
    const legacyBytes = await bridge.loadLegacy();
    if (legacyBytes) {
      const migrated = await readPack(legacyBytes, '旧版本自动保存工程');
      await bridge.adoptLegacy(legacyBytes, { name: migrated.project.name, projectId: migrated.project.id });
      state = await bridge.list();
      note = '旧版自动保存工程已纳入本地工程库，原文件仍保留在数据目录。';
    }
  }
  let key = state.activeKey;
  if (!key) {
    const demo = createDemoProject();
    const entry = await bridge.create(await packBytes(demo, []), { name: demo.name, projectId: demo.id });
    key = entry.key;
    note = note || '已建立示例工程。之后新建的工程都会留在本地工程库里。';
  }
  const loaded = await openLibraryProject(key);
  return { ...loaded, message: note || loaded.message };
}

function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [startupError, setStartupError] = useState('');
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [theme, setTheme] = useState<ThemeName>(readTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (!window.storyWorkbench) throw new Error('请从桌面版程序启动工作台。浏览器页面不提供磁盘保存。');
        const data = await openLibraryEntry();
        if (active) { setLoaded(data); setFailedKey(null); }
      } catch (error) {
        if (!active) return;
        setFailedKey(error instanceof LibraryOpenError ? error.libraryKey : null);
        setStartupError(error instanceof Error ? error.message : '本机工程读取失败。');
      }
    })();
    return () => { active = false; };
  }, [retryCount]);

  if (startupError && !window.storyWorkbench) return <main className="recovery-screen"><h1>请启动桌面版</h1><p>{startupError}</p></main>;
  if (startupError) return <RecoveryScreen error={startupError} libraryKey={failedKey} onRetry={() => { setStartupError(''); setRetryCount((value) => value + 1); }} onLoaded={(value) => { setLoaded(value); setStartupError(''); setFailedKey(null); }} />;
  if (!loaded) return <div className="startup-loading">剧情创作工作台 · 正在检查本机工程…</div>;
  return <Workspace key={loaded.project.id} initial={loaded} theme={theme} onToggleTheme={() => setTheme((current) => current === 'ink' ? 'paper' : 'ink')} />;
}

function RecoveryScreen({ error, libraryKey, onRetry, onLoaded }: { error: string; libraryKey: string | null; onRetry: () => void; onLoaded: (value: Loaded) => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage('正在处理…');
    try { await action(); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : '处理失败。'); }
    finally { setBusy(false); }
  };
  /* 恢复只动这一份工程自己的备份，不会去写别的工程的外部保存位置。 */
  const restoreImportBackup = () => run(async () => {
    if (!libraryKey) throw new Error('没有可恢复的工程。');
    const bytes = await window.storyWorkbench.library.importBackup(libraryKey);
    if (!bytes) throw new Error('没有可用的导入前备份。');
    const restored = await readPack(bytes, '导入前备份');
    await window.storyWorkbench.library.importBackupApply(libraryKey, bytes);
    onLoaded({ ...restored, libraryKey });
  });
  /* 打开工程包 = 导入成一份新的工程条目，不覆盖当前这份工程。 */
  const importBackupFile = () => run(async () => {
    const selected = await window.storyWorkbench.importProject();
    if (!selected) return;
    const restored = await readPack(selected.bytes, selected.name);
    const entry = await window.storyWorkbench.library.create(selected.bytes, { name: restored.project.name, projectId: restored.project.id });
    onLoaded({ ...restored, libraryKey: entry.key, message: '已把工程包导入本地工程库；原来那份工程没有被动过。' });
  });
  /* 建立空白工程 = 新建一个工程条目，不覆盖原来那份工程，也不写它的外部文件。 */
  const createBlank = () => run(async () => {
    const project = createBlankProject();
    const entry = await window.storyWorkbench.library.create(await packBytes(project, []), { name: project.name, projectId: project.id });
    onLoaded({ project, assets: [], libraryKey: entry.key, message: '已建立空白工程；原来那份工程仍留在工程库里。' });
  });
  return <div className="startup-error recovery-screen"><strong>无法打开当前工程</strong><p>{error}</p><span>原工程文件仍保留。你可以重新尝试、从导入前备份恢复、导入成新的工程，或建立空白工程——这些都不会覆盖原来那份工程。</span><div className="recovery-actions"><button className="button" disabled={busy} onClick={onRetry}>重新尝试</button><button className="button" disabled={busy} onClick={restoreImportBackup}>恢复导入前备份</button><button className="button" disabled={busy} onClick={importBackupFile}>打开工程包（另存为新工程）</button><button className="button primary" disabled={busy} onClick={createBlank} title="会新建一个空白工程条目。原来的工程仍留在工程库里，不会被覆盖。">建立空白工程</button></div>{message && <small role="status">{message}</small>}</div>;
}

function Workspace({ initial, theme, onToggleTheme }: { initial: Loaded; theme: ThemeName; onToggleTheme: () => void }) {
  const [project, setProject] = useState(initial.project);
  /** 当前所在的工程库条目：正文、素材、恢复历史和外部保存位置都按它隔离 */
  const [libraryKey, setLibraryKey] = useState(initial.libraryKey);
  const [libraryProjects, setLibraryProjects] = useState<LibraryEntry[]>([]);
  const libraryMenuRef = useRef<HTMLDetailsElement | null>(null);
  const [importCandidate, setImportCandidate] = useState<ImportCandidateState | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [assets, setAssets] = useState<AssetRecord[]>(initial.assets);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [selectedParagraphs, setSelectedParagraphs] = useState<string[]>([]);
  const paragraphAnchorRef = useRef<string | null>(null);
  const [restoreVersions, setRestoreVersions] = useState<RestoreVersion[] | null>(null);
  const [pendingMusic, setPendingMusic] = useState<PendingMusic | null>(null);
  const [articlePreview, setArticlePreview] = useState<{ chapterId: string; name: string; paragraphs: string[] } | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; detail: string; action: () => void } | null>(null);
  const [groupMusicDialog, setGroupMusicDialog] = useState<{ chapterId: string; groupIds: string[]; assetId: string } | null>(null);
  const savedTextLengthRef = useRef(chapterTextCounts(initial.project));
  const [dropHint, setDropHint] = useState<{ groupId?: string; paragraphId?: string; position?: 'before' | 'after'; intent?: 'paragraph' | 'audio' } | null>(null);
  const [panelMode, setPanelMode] = useState<'assets' | 'outline'>('assets');
  const [sequenceCollapsed, setSequenceCollapsed] = useState(false);
  /** 顶部「工程」菜单：点击外部或 Esc 时收起，不与右键菜单系统混用（此处 document 被章节变量占用，用 window.document） */
  useEffect(() => {
    const closeMenus = (event: MouseEvent) => {
      window.document.querySelectorAll<HTMLDetailsElement>('details.toolbar-menu[open]').forEach((node) => { if (!node.contains(event.target as Node)) node.removeAttribute('open'); });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      window.document.querySelectorAll<HTMLDetailsElement>('details.toolbar-menu[open]').forEach((node) => node.removeAttribute('open'));
    };
    window.document.addEventListener('mousedown', closeMenus);
    window.document.addEventListener('keydown', onKeyDown);
    return () => { window.document.removeEventListener('mousedown', closeMenus); window.document.removeEventListener('keydown', onKeyDown); };
  }, []);
  const [filter, setFilter] = useState('all');
  const [saveLabel, setSaveLabel] = useState(initial.message ? '已读取本机工程' : '新工程 · 等待自动保存');
  const saveLabelRef = useRef(saveLabel);
  const updateSaveLabel = (value: string) => {
    saveLabelRef.current = value;
    setSaveLabel(value);
  };
  const [saveTarget, setSaveTarget] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<Array<{ name: string; status: 'success' | 'error'; detail: string }>>([]);
  const [newAssetIds, setNewAssetIds] = useState<string[]>([]);
  const [mediaProgress, setMediaProgress] = useState('');
  const [notice, setNotice] = useState(initial.message ?? '');
  const [playerState, setPlayerState] = useState<PlayerSnapshot>({ status: 'stopped', index: 0, cue: null, elapsedMs: 0, durationMs: 3500, runMode: null });
  const playbackClockRef = useRef<PlaybackClock>({ snapshot: playerState, listeners: new Set() });
  const [seekRevision, setSeekRevision] = useState(0);
  const [playSessionRevision, setPlaySessionRevision] = useState(0);
  const [projectOperation, setProjectOperation] = useState(false);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [aiReviewState, setAiReviewState] = useState<AiReviewState | null>(null);
  const [aiReviewBusy, setAiReviewBusy] = useState(false);
  const nameDialogTriggerRef = useRef<HTMLElement | null>(null);
  const projectRef = useRef(project);
  /** 切换工程时用它做令牌：快速连点只有最后一次生效 */
  const switchTokenRef = useRef(0);
  const libraryKeyRef = useRef(initial.libraryKey);
  /** 目录定位的令牌：快速点不同组时，旧定位回调自动失效 */
  const locateTokenRef = useRef(0);
  const pendingLocateRef = useRef<PendingLocate | null>(null);
  const pendingChapterActionRef = useRef<{ chapterId: string; run: () => void } | null>(null);
  const [locatedGroupId, setLocatedGroupId] = useState<string | null>(null);
  const reviewHistoryRef = useRef(new Map<string, { before: any; after: any; chapterId: string | null }>());
  const reviewChangeHistoryRef = useRef(new Map<string, { proposal: any; chapterId: string }>());
  const currentReviewTokenRef = useRef<string | null>(null);
  const playerRef = useRef<any>(null);
  const assetsRef = useRef(assets);
  const paragraphPresentationSelectionRef = useRef({ paragraphIds: selectedParagraphs, groupIds: selectedGroupIds, dropHint });
  paragraphPresentationSelectionRef.current = { paragraphIds: selectedParagraphs, groupIds: selectedGroupIds, dropHint };
  const readParagraphPresentation = useMemo(() => createParagraphPresentationReader(() => ({ chapter: activeChapter(projectRef.current), assets: assetsRef.current, ...paragraphPresentationSelectionRef.current })), []);
  const mediaSessionRef = useRef<MediaSession | null>(null);
  const musicSessionRef = useRef<MediaSession | null>(null);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const chapterCursorRef = useRef(new Map<string, { from: number; to: number; cueId: string | null }>());
  const chapter = activeChapter(project);
  const editorChapterIdRef = useRef(chapter.id);
  editorChapterIdRef.current = chapter.id;
  const chapterScrollRef = useRef(new Map<string, number>());
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const edgeScrollFrameRef = useRef<number | null>(null);
  const edgeScrollDirectionRef = useRef(0);
  const cancelledDragRef = useRef(false);
  const dragActiveRef = useRef(false);
  const chapterIndex = project.chapters.findIndex((item: any) => item.id === chapter.id);
  const document = chapter.document;
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const savedSnapshotRef = useRef<{ key: string; project: any; assets: AssetRecord[] } | null>(null);
  const pendingSaveRef = useRef<Promise<any> | null>(null);
  const saveTimer = useRef<number | null>(null);
  const autosaveSuppressed = useRef(false);
  const plan: any[] = useMemo(() => compileDocument(document), [document]);
  const planRef = useRef(plan);
  projectRef.current = project;
  assetsRef.current = assets;
  planRef.current = plan;
  libraryKeyRef.current = libraryKey;
  const openNameDialog = (trigger: HTMLElement | null, dialog: NameDialogState) => {
    nameDialogTriggerRef.current = trigger;
    setNameDialog(dialog);
  };
  const closeNameDialog = () => setNameDialog(null);
  useEffect(() => {
    if (nameDialog) return;
    const trigger = nameDialogTriggerRef.current;
    nameDialogTriggerRef.current = null;
    if (trigger?.isConnected) trigger.focus();
  }, [nameDialog]);
  useEffect(() => {
    const getAudio = (id: string) => assetsRef.current.find((asset) => asset.id === id && asset.kind === 'audio');
    const session = new MediaSession(createHtmlAudioBackend(getAudio), (snapshot) => {
      if (snapshot.status === 'error' && snapshot.error) setNotice(`声音播放失败：${snapshot.error}`);
    });
    const music = new MediaSession(createHtmlAudioBackend(getAudio), (snapshot) => {
      if (snapshot.status === 'error' && snapshot.error) setNotice(`背景音乐播放失败：${snapshot.error}`);
    });
    mediaSessionRef.current = session;
    musicSessionRef.current = music;
    return () => {
      session.dispose();
      music.dispose();
      if (mediaSessionRef.current === session) mediaSessionRef.current = null;
      if (musicSessionRef.current === music) musicSessionRef.current = null;
    };
  }, []);

  const onEditorUpdate = useCallback(({ editor, transaction }: { editor: any; transaction: any }) => {
    const editorChapterId = editor.state.doc.attrs.chapterId;
    if (!editorChapterId || editorChapterId !== editorChapterIdRef.current || projectRef.current.activeChapterId !== editorChapterId) return;
    if (transaction?.getMeta('workbench-history-rejected')) return;
    const reviewToken = editor.state.doc.attrs.reviewToken ?? null;
    const previousReviewToken = currentReviewTokenRef.current;
    currentReviewTokenRef.current = reviewToken;
    if (reviewToken !== previousReviewToken) {
      const appliedChanges = reviewToken ? reviewChangeHistoryRef.current.get(reviewToken) : null;
      const revertedChanges = previousReviewToken ? reviewChangeHistoryRef.current.get(previousReviewToken) : null;
      const historyReplay = transaction?.getMeta('history$');
      const isUndo = historyReplay?.redo === false;
      const changeEntry = isUndo ? revertedChanges : appliedChanges;
      if (changeEntry && changeEntry.chapterId === editorChapterId) {
        try {
          const proposal = isUndo ? reverseReviewChanges(changeEntry.proposal) : changeEntry.proposal;
          const next = applyReviewChanges(projectRef.current, proposal);
          projectRef.current = next;
          setProject(next);
        } catch (error) {
          currentReviewTokenRef.current = previousReviewToken;
          const source = activeChapter(projectRef.current);
          const content = editor.schema.nodeFromJSON(toEditorContent(source.document, source.groups, source.musicRanges));
          /* 视图未就绪时无法 dispatch，正文会在下一次编辑器重建时按当前工程数据重新载入 */
          if (isEditorViewReady(editor)) editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, content.content).setDocAttribute('reviewToken', previousReviewToken).setMeta('addToHistory', false).setMeta('workbench-history-rejected', true));
          setNotice(error instanceof Error ? 'AI 历史恢复失败：' + error.message : 'AI 历史恢复失败。');
        }
        return;
      }
      const applied = reviewToken ? reviewHistoryRef.current.get(reviewToken) : null;
      const reverted = previousReviewToken ? reviewHistoryRef.current.get(previousReviewToken) : null;
      const entry = historyReplay ? historyReplay.redo ? applied : reverted : applied;
      const appliesHere = entry?.chapterId === editorChapterId || entry?.chapterId === null;
      const snapshot = appliesHere && entry ? (historyReplay?.redo === false ? entry.before : entry.after) : null;
      if (snapshot) {
        const next = entry!.chapterId === null ? snapshot : mergeChapterHistorySnapshot(projectRef.current, snapshot, editorChapterId);
        projectRef.current = next;
        setProject(next);
        return;
      }
    }
    const nextDocument = fromEditorContent(editor.getJSON());
    const current = projectRef.current;
    if (current.activeChapterId !== editorChapterId) return;
    const next = updateChapter(current, editorChapterId, (active: any) => reconcileChapterDocument(active, nextDocument));
    projectRef.current = next;
    setProject(next);
  }, []);

  const onSelectionUpdate = useCallback(({ editor }: { editor: any }) => {
    if (editor.state.doc.attrs.chapterId !== editorChapterIdRef.current) return;
    playerRef.current?.stop();
    const id = selectedStoryId(editor);
    setSelectedCueId(id);
    setSelectedParagraphs(readSelectedParagraphIds(editor));
    setSelectedGroupId(null);
    setSelectedGroupIds([]);
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ blockquote: false, bulletList: false, codeBlock: false, heading: false, horizontalRule: false, listItem: false, orderedList: false }),
      TextStyle,
      Color.configure({ types: ['textStyle'] }),
      Placeholder.configure({ placeholder: '从这里开始写剧情。按 Enter 开始新段，选中一句再设置对白或自由演出。' }),
      UniqueID.configure({ types: ['paragraph'], attributeName: 'paragraphId', generateID: () => makeId('p') }),
      CueMark,
      StoryAttributes.configure({ getParagraphPresentation: readParagraphPresentation }),
    ],
    content: editorContent(chapter),
    onUpdate: onEditorUpdate,
    onSelectionUpdate,
    editorProps: {
      attributes: { class: 'story-editor', spellcheck: 'false' },
      handleDOMEvents: {
        dragstart: (_view, event) => event.target instanceof Element && Boolean(event.target.closest('.paragraph-drag-handle')),
        dragover: (_view, event) => {
          if (!event.dataTransfer?.types.includes(PARAGRAPH_DRAG) && !event.dataTransfer?.types.includes(AUDIO_DRAG)) return false;
          event.preventDefault();
          return true;
        },
        drop: (_view, event) => {
          if (!event.dataTransfer?.types.includes(PARAGRAPH_DRAG) && !event.dataTransfer?.types.includes(AUDIO_DRAG)) return false;
          event.preventDefault();
          return true;
        },
      },
    },
  }, [project.id, chapter.id, editorEpoch]);

  const currentPlan = plan;
  useEffect(() => {
    if (!editor) return;
    /* 章节切换会重建编辑器实例，这里等视图就绪再恢复光标与滚动，
       否则这段初始化会在视图还没挂上时被静默跳过。 */
    let frame = 0;
    const cancel = onEditorViewMount(editor, () => {
      playerRef.current?.stop();
      mediaSessionRef.current?.stop();
      musicSessionRef.current?.stop();
      if (editor.state.doc.attrs.chapterId !== chapter.id) return;
      currentReviewTokenRef.current = editor.state.doc.attrs.reviewToken ?? null;
      const savedCursor = chapterCursorRef.current.get(chapter.id);
      if (savedCursor) {
        const max = Math.max(1, editor.state.doc.content.size - 1);
        editor.commands.setTextSelection({ from: Math.max(1, Math.min(max, savedCursor.from)), to: Math.max(1, Math.min(max, savedCursor.to)) });
        setSelectedCueId(savedCursor.cueId && findCueRange(editor, savedCursor.cueId) ? savedCursor.cueId : selectedStoryId(editor));
      } else {
        const firstCue = compileDocument(chapter.document)[0];
        setSelectedCueId(firstCue?.id ?? null);
      }
      paragraphAnchorRef.current = null;
      setDropHint(null);
      setSelectedLayerId(null);
      setSelectedGroupId(null);
      setSelectedGroupIds([]);
      setSelectedParagraphs([]);
      const savedScroll = chapterScrollRef.current.get(chapter.id) ?? 0;
      frame = requestAnimationFrame(() => {
        if (editorChapterIdRef.current === chapter.id && editorScrollRef.current) editorScrollRef.current.scrollTop = savedScroll;
      });
      /* 切章后编辑器就绪了，才执行定位或章节级动作。
         两者都跟着挂载事件走，不用延时去猜挂载完成。 */
      const pendingLocate = pendingLocateRef.current;
      if (pendingLocate && pendingLocate.chapterId === chapter.id && pendingLocate.token === locateTokenRef.current) {
        pendingLocateRef.current = null;
        runLocate(pendingLocate);
      }
      const pendingAction = pendingChapterActionRef.current;
      if (pendingAction && pendingAction.chapterId === chapter.id) {
        pendingChapterActionRef.current = null;
        pendingAction.run();
      }
    });
    return () => { cancel(); if (frame) cancelAnimationFrame(frame); };
  }, [editor, chapter.id]);
  const paragraphIndexes = useMemo(() => new Map<string, number>(document.blocks.map((block: any, index: number) => [block.id, index])), [document]);
  const orderedGroups = useMemo(() => [...chapter.groups].sort((a: any, b: any) => (paragraphIndexes.get(a.paragraphIds[0]) ?? -1) - (paragraphIndexes.get(b.paragraphIds[0]) ?? -1)), [chapter.groups, paragraphIndexes]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const choose = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const ids = activeChapter(projectRef.current).document.blocks.map((block: any) => block.id);
      if (!ids.includes(detail.paragraphId)) return;
      playerRef.current?.stop();
      setSelectedGroupId(null);
      setSelectedGroupIds([]);
      setSelectedParagraphs((current) => {
        if (detail.shiftKey && paragraphAnchorRef.current && ids.includes(paragraphAnchorRef.current)) {
          const from = ids.indexOf(paragraphAnchorRef.current), to = ids.indexOf(detail.paragraphId);
          return ids.slice(Math.min(from, to), Math.max(from, to) + 1);
        }
        paragraphAnchorRef.current = detail.paragraphId;
        return current.includes(detail.paragraphId) ? current.filter((id) => id !== detail.paragraphId) : ids.filter((id: string) => id === detail.paragraphId || current.includes(id));
      });
    };
    const chooseGroup = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const groupId = String(detail.groupId ?? '');
      selectGroup(groupId, detail);
    };
    const openGroupMusic = (event: Event) => {
      const groupId = String((event as CustomEvent).detail.groupId ?? '');
      if (!orderedGroups.some((group: any) => group.id === groupId)) return;
      const groupIds = selectedGroupIds.includes(groupId) ? orderedGroups.filter((group: any) => selectedGroupIds.includes(group.id)).map((group: any) => group.id) : [groupId];
      setGroupMusicDialog({ chapterId: chapter.id, groupIds, assetId: '' });
    };
    return bindEditorViewListeners(editor, [
      ['story-paragraph-select', choose],
      ['story-group-select', chooseGroup],
      ['story-group-music', openGroupMusic],
    ]);
  }, [editor, chapter.id, orderedGroups, selectedGroupId, selectedGroupIds]);
  useEffect(() => onEditorViewMount(editor, (dom: HTMLElement) => projectParagraphDecorations(dom, readParagraphPresentation)), [editor, document, chapter, orderedGroups, assets, selectedParagraphs, selectedGroupIds, dropHint, readParagraphPresentation]);
  const selectedCue = currentPlan.find((cue: any) => cue.id === selectedCueId) ?? null;
  const scopeParagraphs = selectedGroupIds.length ? orderedGroups.filter((group: any) => selectedGroupIds.includes(group.id)).flatMap((group: any) => group.paragraphIds) : selectedParagraphs.length ? selectedParagraphs : selectedCue ? [selectedCue.paragraphId] : [];
  const scopeGroups = orderedGroups.filter((group: any) => group.paragraphIds.some((id: string) => scopeParagraphs.includes(id)));
  const currentGroup = scopeGroups.length === 1 && scopeParagraphs.every((id: string) => scopeGroups[0].paragraphIds.includes(id)) ? scopeGroups[0] : null;
  const groupSummary = currentGroup ? `第 ${orderedGroups.findIndex((group: any) => group.id === currentGroup.id) + 1} 组 · ${currentGroup.name}` : scopeGroups.length > 1 ? `跨 ${scopeGroups.length} 组 · 已选 ${scopeParagraphs.length} 段` : '未分组';
  const hasGroupingSelection = selectedParagraphs.length > 0 || selectedGroupIds.length > 0;
  /** F 区声音小节用当前句所属的组，不另外维护第二份选择状态 */
  const cueGroup = selectedCue ? (orderedGroups.find((group: any) => group.paragraphIds.includes(selectedCue.paragraphId)) ?? null) : null;
  const cueGroupIndex = cueGroup ? orderedGroups.findIndex((group: any) => group.id === cueGroup.id) : -1;
  const cueGroupMusic = cueGroup ? musicRangeAt(chapter, cueGroup.paragraphIds[0]) : null;
  const cueGroupAudio = cueGroupMusic ? (assets.find((asset) => asset.id === cueGroupMusic.assetId) ?? null) : null;
  const previewCue = playerState.status === 'stopped' ? selectedCue : playerState.cue;
  const previewScene = useMemo(() => previewCue ? resolveState(currentPlan, previewCue.id) : { backgroundId: null, sceneLayers: [] }, [currentPlan, previewCue?.id]);
  const backgroundAsset = assets.find((asset) => asset.id === previewScene.backgroundId && asset.kind === 'image');
  const visibleAssets = assets.filter((asset) => filter === 'all' || asset.kind === filter);
  const selectedScene = useMemo(() => selectedCue ? resolveState(currentPlan, selectedCue.id) : { sceneLayers: [] }, [currentPlan, selectedCue?.id]);
  const selectedLayers = selectedScene.sceneLayers ?? [];
  const displayLayers = previewScene.sceneLayers ?? [];
  const selectedLayer = selectedLayers.find((layer: any) => layer.id === selectedLayerId) ?? null;
  const cueIndex = Math.max(0, currentPlan.findIndex((cue: any) => cue.id === previewCue?.id));
  const selectedCueIndex = Math.max(0, currentPlan.findIndex((cue: any) => cue.id === selectedCue?.id));

  if (!playerRef.current) {
    const media = createChapterMediaController({
      getChapter: () => activeChapter(projectRef.current),
      getMusicSession: () => musicSessionRef.current,
      getEffectSession: () => mediaSessionRef.current,
    });
    playerRef.current = createPlayer({
      getPlan: () => planRef.current,
      onChange: (snapshot: PlayerSnapshot) => {
        const clock = playbackClockRef.current;
        const previous = clock.snapshot;
        clock.snapshot = snapshot;
        for (const listener of clock.listeners) listener();
        if (previous.status !== snapshot.status || previous.index !== snapshot.index || previous.cue !== snapshot.cue || previous.runMode !== snapshot.runMode) setPlayerState(snapshot);
      },
      onEnter: (cue: any) => media.enter(cue),
      onPauseMedia: () => media.pause(),
      onResumeMedia: () => media.resume(),
      onSeekMedia: (milliseconds: number) => media.seekEffects(milliseconds),
      onStopMedia: () => media.stop(),
    });
  }

  const saveNow = (asCopy = false): Promise<any> => {
    if (!asCopy && saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!asCopy && pendingSaveRef.current) return pendingSaveRef.current;
    /* 保存归属在调用时锁定：这一份保存永远写回它发起时所属的工程。
       切换工程后迟到的这一轮会发现「当前工程已经不是它」而放弃写入，
       不会把新工程的内容写进旧工程的文件。 */
    const targetKey = libraryKeyRef.current;
    const task = saveQueue.current.catch(() => {}).then(async () => {
      let result: any = null;
      do {
        if (libraryKeyRef.current !== targetKey) return result;
        const snapshot = { project: projectRef.current, assets: assetsRef.current };
        if (!asCopy && savedSnapshotRef.current?.key === targetKey && savedSnapshotRef.current?.project === snapshot.project && savedSnapshotRef.current?.assets === snapshot.assets) return result;
        const previousSaveLabel = saveLabelRef.current;
        updateSaveLabel('正在保存…');
        const bytes = await packBytes(snapshot.project, snapshot.assets);
        const textLength = chapterTextCounts(snapshot.project);
        const protectCurrent = isLargeTextDeletion(savedTextLengthRef.current, textLength);
        result = asCopy
          ? await window.storyWorkbench.library.saveAs(targetKey, bytes)
          : await window.storyWorkbench.library.save(targetKey, bytes, { protectCurrent });
        if (!result) { updateSaveLabel(previousSaveLabel); return null; }
        savedSnapshotRef.current = { key: targetKey, ...snapshot };
        savedTextLengthRef.current = textLength;
        if ('filePath' in result) setSaveTarget(result.filePath ?? null);
        if (result.warning) setNotice(result.warning);
        if (libraryKeyRef.current !== targetKey) return result;
        if (projectRef.current === snapshot.project && assetsRef.current === snapshot.assets) {
          updateSaveLabel('已保存 · ' + new Date(result.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
          return result;
        }
        updateSaveLabel('有新修改 · 正在继续保存…');
      } while (!asCopy);
      return result;
    }).catch((error) => {
      updateSaveLabel('保存失败');
      setNotice(error instanceof Error ? '保存失败：' + error.message : '保存失败，请检查磁盘空间后重试。');
      throw error;
    });
    saveQueue.current = task;
    if (!asCopy) {
      pendingSaveRef.current = task;
      void task.finally(() => { if (pendingSaveRef.current === task) pendingSaveRef.current = null; }).catch(() => {});
    }
    return task;
  };
  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;

  useEffect(() => {
    let active = true;
    window.storyWorkbench.library.saveTarget(libraryKeyRef.current).then((target) => { if (active) setSaveTarget(target); }).catch(() => {});
    /* 顶部「切换工程」列表：启动时先读一次工程库 */
    window.storyWorkbench.library.list().then((state) => { if (active) setLibraryProjects(state.projects); }).catch(() => {});
    const unsubscribe = window.storyWorkbench.onBeforeClose(async () => {
      try {
        await saveNowRef.current();
        await window.storyWorkbench.closeResult({ saved: true });
      } catch (error) {
        await window.storyWorkbench.closeResult({ saved: false, error: error instanceof Error ? error.message : '最后修改保存失败。' });
      }
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveNow().catch(() => {});
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [project, assets]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setNotice(''), 3600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (savedSnapshotRef.current?.key === libraryKey && savedSnapshotRef.current?.project === project && savedSnapshotRef.current?.assets === assets) return;
    updateSaveLabel('有未保存修改 · 自动保存中…');
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      if (autosaveSuppressed.current) return;
      void saveNow().catch(() => {});
    }, 650);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    };
  }, [project, assets, libraryKey]);

  useEffect(() => {
    revokeUnusedUrls(assets);
  }, [assets]);

  const urlDisposeTimer = useRef<number | null>(null);
  useEffect(() => {
    if (urlDisposeTimer.current !== null) window.clearTimeout(urlDisposeTimer.current);
    urlDisposeTimer.current = null;
    return () => {
      playerRef.current?.stop();
      urlDisposeTimer.current = window.setTimeout(() => {
        urlDisposeTimer.current = null;
        disposeUrls();
      }, 0);
    };
  }, []);

  const patchCue = (patch: Partial<CueSettings>) => {
    if (!editor || !selectedCue) {
      setNotice('请先选中一句正文。');
      return;
    }
    try {
      validateCueSettings(defaultSettings({ ...selectedCue.settings, ...patch }));
      const range = findCueRange(editor, selectedCue.id);
      if (applyCuePatch(editor, selectedCue.id, selectedCue.settings, patch)) {
      const id = range && editor.state.doc.nodeAt(range.from)?.marks.find((mark) => mark.type.name === 'cue')?.attrs.cueId;
      if (id) setSelectedCueId(id);
      return true;
      }
      return false;
    } catch (error) { setNotice(error instanceof Error ? error.message : '设置无效，修改未提交。'); return false; }
  };

  const patchMotionSettings = (patch: Record<string, any>) => {
    if (!selectedCue) return;
    return patchCue({ motionSettings: { ...defaultMotionSettings(selectedCue.settings.motion, selectedCue.text), ...(selectedCue.settings.motionSettings ?? {}), ...patch } });
  };

  const selectMotion = (motion: CueSettings['motion']) => {
    if (!selectedCue) return;
    patchCue({ motion, motionSettings: defaultMotionSettings(motion, selectedCue.text) });
  };

  const setMode = (mode: 'dialogue' | 'free') => {
    if (!editor) return;
    const current = selectedCue?.settings ?? defaultSettings();
    const result = applyMode(editor, selectedCueId, current, mode);
    if (!result.ok) setNotice(result.message ?? '未能应用演出模式。');
    else if (result.cueId) setSelectedCueId(result.cueId);
  };

  const setColor = (color: string) => {
    if (!editor) return;
    const selection = editor.state.selection;
    const range = !selection.empty ? selection : selectedCueId ? findCueRange(editor, selectedCueId) : null;
    if (!range || range.to <= range.from) return setNotice('请先选中要改色的文字或一句剧情。');
    if (!isEditorViewReady(editor)) return setNotice('正文还没准备好，请稍后再试。');
    editor.view.dispatch(editor.state.tr.addMark(range.from, range.to, editor.schema.marks.textStyle.create({ color })));
  };

  const appendAssets = (added: AssetRecord[], expectedProjectId = projectRef.current.id) => {
    const current = projectRef.current;
    if (current.id !== expectedProjectId) throw new Error('工程已切换，请在当前工程重新导入。');
    const next = { ...current, assets: [...current.assets, ...added.map(({ blob: _blob, ...asset }) => asset)], updatedAt: new Date().toISOString() };
    validateProject(next);
    assetsRef.current = [...assetsRef.current, ...added];
    setAssets(assetsRef.current);
    projectRef.current = next;
    setProject(next);
  };
  const importAssets = async (audioOnly = false) => {
    const projectId = projectRef.current.id;
    const chosen = await window.storyWorkbench.chooseAssets();
    if (chosen.cancelled || !chosen.items.length) return [];
    const valid = chosen.items.filter((item) => item.bytes && !item.error);
    const failed = chosen.items.filter((item) => item.error).map((item) => ({ name: item.name, status: 'error' as const, detail: item.error! }));
    const files = valid.map((item) => new File([item.bytes!.slice().buffer as ArrayBuffer], item.name, { type: item.mime }));
    const candidates = await measureAssets(recordsFromFiles(files));
    const added = candidates.filter((asset) => !audioOnly || asset.kind === 'audio');
    candidates.filter((asset) => audioOnly && asset.kind !== 'audio').forEach((asset) => failed.push({ name: asset.name, status: 'error', detail: '此入口只接受音频，请从素材库导入其他文件。' }));
    if (added.length) appendAssets(added, projectId);
    setImportReport([...added.map((asset) => ({ name: asset.name, status: 'success' as const, detail: '已加入当前工程素材库。' })), ...failed]);
    setNewAssetIds(added.map((asset) => asset.id));
    if (added.length) setFilter('all');
    setNotice('导入完成：成功 ' + added.length + ' 个，失败 ' + failed.length + ' 个。');
    return added;
  };
  const onImportAssets = async () => {
    try { await importAssets(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '素材读取失败。'); }
  };
  const previewArticle = async (asset: AssetRecord) => {
    const chapterId = projectRef.current.activeChapterId;
    try {
      const paragraphs = parseArticleText(asset.name, await asset.blob.text());
      if (projectRef.current.activeChapterId !== chapterId) throw new Error('章节已切换，请重新选择文章。');
      setArticlePreview({ chapterId, name: asset.name, paragraphs });
    } catch (error) { setNotice(error instanceof Error ? error.message : '文章读取失败。'); }
  };
  const appendArticle = () => {
    if (!articlePreview || !editor || articlePreview.chapterId !== projectRef.current.activeChapterId) return setNotice('章节已变化，请重新预览文章。');
    const blocks = activeChapter(projectRef.current).document.blocks;
    const placeholder = blocks.length === 1 && !plainText(blocks[0].children).trim();
    appendEditorParagraphs(editor, articlePreview.paragraphs.map((text) => ({ id: makeId('paragraph'), text })), placeholder);
    setArticlePreview(null);
    setNotice('文章已追加到当前章节，可用 Ctrl+Z 撤销。');
  };
  const deleteAsset = (asset: AssetRecord) => {
    const usages = assetUsages(projectRef.current, asset.id);
    if (usages.length) return setNotice('素材仍被使用：' + usages.slice(0,5).join('；') + '。请先解除引用。');
    setConfirmation({ title: '从工程移除素材？', detail: '将移除“' + asset.name + '”的工程副本，不删除磁盘原文件。', action: () => {
      const current = projectRef.current;
      if (assetUsages(current, asset.id).length) return setNotice('素材新增了引用，请先解除引用。');
      assetsRef.current = assetsRef.current.filter((item) => item.id !== asset.id);
      setAssets(assetsRef.current);
      commitProject({ ...current, assets: current.assets.filter((item: any) => item.id !== asset.id), updatedAt: new Date().toISOString() });
    } });
  };

  const scrollEditorTarget = (target: HTMLElement | null) => {
    if (!target) return;
    requestAnimationFrame(() => {
      const container = editorScrollRef.current;
      if (!container || !container.contains(target)) return;
      const viewport = container.getBoundingClientRect();
      const bounds = target.getBoundingClientRect();
      if (bounds.top < viewport.top) container.scrollTop -= viewport.top - bounds.top + 16;
      else if (bounds.bottom > viewport.bottom) container.scrollTop += bounds.bottom - viewport.bottom + 16;
    });
  };
  const selectCue = (cueId: string) => {
    if (!editor) return;
    playerRef.current.stop();
    mediaSessionRef.current?.stop();
    musicSessionRef.current?.stop();
    setSelectedCueId(cueId);
    setSelectedGroupId(null);
    setSelectedGroupIds([]);
    setSelectedParagraphs([]);
    const range = findCueRange(editor, cueId);
    if (range) editor.commands.setTextSelection(range.from);
    if (range) { const dom = editorViewDom(editor); if (dom) scrollEditorTarget(dom.querySelector(`[data-cue-id="${CSS.escape(cueId)}"]`)); }
  };

  const selectParagraph = (paragraphId: string) => {
    const cue = currentPlan.find((item: any) => item.paragraphId === paragraphId);
    if (cue) {
      selectCue(cue.id);
      return;
    }
    if (!editor) return;
    playerRef.current.stop();
    mediaSessionRef.current?.stop();
    musicSessionRef.current?.stop();
    setSelectedCueId(null);
    setSelectedGroupId(null);
    setSelectedGroupIds([]);
    let position: number | null = null;
    editor.state.doc.descendants((node: any, nodePosition: number) => {
      if (node.type.name === 'paragraph' && String(node.attrs.paragraphId ?? '') === paragraphId) {
        position = nodePosition + 1;
        return false;
      }
      return true;
    });
    if (position === null) {
      setNotice('这个正文段落已变化，请重新选择。');
      return;
    }
    editor.commands.setTextSelection(position);
    const selectCueDom: HTMLElement | null = editorViewDom(editor);
    if (selectCueDom) scrollEditorTarget([...selectCueDom.querySelectorAll<HTMLElement>('p')].find((paragraph) => paragraphTarget(paragraph)?.id === paragraphId) ?? null);
  };

  /* ── 左侧目录定位：章节 → 组 ──────────────────────────────────
     定位只是「看一眼」：不改正文、不改组成员、不改配乐、不启动播放，
     也不进结构事务（不往撤销历史里塞整份工程快照）。
     跨章时先切章，等编辑器视图就绪后再滚到组头；用令牌让旧定位自动失效。 */
  const runLocate = (pending: PendingLocate) => {
    if (pending.token !== locateTokenRef.current) return;
    const dom: HTMLElement | null = editor ? editorViewDom(editor) : null;
    if (!dom) { setNotice('正文还没准备好，请稍后再点一次。'); return; }
    const selector = pending.kind === 'group'
      ? `[data-group-header="${CSS.escape(pending.id)}"]`
      : `[data-paragraph-id="${CSS.escape(pending.id)}"]`;
    const target = dom.querySelector<HTMLElement>(selector);
    if (!target) { setNotice('没有找到要定位的位置，可能已经变化了。'); return; }
    scrollEditorTarget(target);
    if (pending.kind === 'group') {
      setLocatedGroupId(pending.id);
      setNotice('已定位到该组的组头；正文、分组和配乐都没有改动。');
    } else {
      setLocatedGroupId(null);
      setNotice('已定位到该段；正文和分组都没有改动。');
    }
  };

  const locateGroup = (chapterId: string, groupId: string) => {
    const token = ++locateTokenRef.current;
    const source = projectRef.current.chapters.find((item: any) => item.id === chapterId);
    const group = source?.groups.find((item: any) => item.id === groupId);
    if (!source || !group) { setNotice('这个段落组已经不存在，请刷新目录。'); return; }
    const pending: PendingLocate = { chapterId, kind: 'group', id: groupId, token };
    pendingLocateRef.current = pending;
    if (projectRef.current.activeChapterId !== chapterId) { switchChapter(chapterId); return; }
    pendingLocateRef.current = null;
    runLocate(pending);
  };

  const locateParagraph = (chapterId: string, paragraphId: string | null) => {
    if (!paragraphId) { setNotice('这一章没有可定位的段落。'); return; }
    const token = ++locateTokenRef.current;
    const source = projectRef.current.chapters.find((item: any) => item.id === chapterId);
    if (!source) { setNotice('这一章已经不存在。'); return; }
    if (!source.document.blocks.some((block: any) => block.id === paragraphId)) { setNotice('这一段已经变化，请重新选择。'); return; }
    const pending: PendingLocate = { chapterId, kind: 'paragraph', id: paragraphId, token };
    pendingLocateRef.current = pending;
    if (projectRef.current.activeChapterId !== chapterId) { switchChapter(chapterId); return; }
    pendingLocateRef.current = null;
    runLocate(pending);
  };

  /** 组操作先切到它所属的章，等编辑器就绪后再执行，保证正文与数据一致 */
  const runInChapter = (chapterId: string, action: () => void) => {
    if (projectRef.current.activeChapterId === chapterId) { action(); return; }
    pendingChapterActionRef.current = { chapterId, run: action };
    switchChapter(chapterId);
  };

  const renameGroupInChapter = (chapterId: string, groupId: string, currentName: string, trigger: HTMLElement | null) => {
    runInChapter(chapterId, () => openNameDialog(trigger, {
      title: '重命名段落组', fieldLabel: '段落组名称', confirmLabel: '保存组名称', initialValue: currentName, normalize: normalizeParagraphGroupName,
      onConfirm: (name) => {
        try {
          const current = projectRef.current;
          const target = current.chapters.find((item: any) => item.id === chapterId);
          if (!target || !target.groups.some((group: any) => group.id === groupId)) return '段落组已不存在，请重新选择。';
          commitChapterStructure(updateChapter(current, chapterId, (value: any) => renameParagraphGroup(value, groupId, name)));
          return undefined;
        } catch (error) { return error instanceof Error ? error.message : '段落组名称无效。'; }
      },
    }));
  };

  const moveGroupInChapter = (chapterId: string, groupId: string, direction: number) => {
    runInChapter(chapterId, () => {
      try {
        const current = projectRef.current;
        const next = updateChapter(current, current.activeChapterId, (value: any) => moveParagraphGroup(value, groupId, direction));
        validateProject(next);
        commitChapterStructure(next);
        playerRef.current.stop();
      } catch (error) { setNotice(error instanceof Error ? error.message : '段落组移动失败。'); }
    });
  };

  const removeGroupInChapter = (chapterId: string, groupId: string) => {
    runInChapter(chapterId, () => {
      try {
        const next = updateChapter(projectRef.current, projectRef.current.activeChapterId, (current: any) => removeParagraphGroup(current, groupId));
        commitChapterStructure(next);
      } catch (error) { setNotice(error instanceof Error ? error.message : '取消分组失败。'); }
    });
  };

  const toggleGroupCollapsedInChapter = (chapterId: string, groupId: string) => {
    runInChapter(chapterId, () => {
      try {
        const current = projectRef.current;
        const target = current.chapters.find((item: any) => item.id === chapterId);
        const group = target?.groups.find((item: any) => item.id === groupId);
        commitChapterStructure(updateChapter(current, chapterId, (value: any) => setGroupCollapsed(value, groupId, !group?.collapsed)));
      } catch (error) { setNotice(error instanceof Error ? error.message : '折叠未提交。'); }
    });
  };

  const setBackground = (id: string) => patchCue({ backgroundId: id || null });
  const setAudio = (id: string) => patchCue({ audioId: id || null });

  const addSceneLayer = (asset: AssetRecord) => {
    if (!selectedCue || !['image', 'video'].includes(asset.kind)) return;
    const inherited = resolveState(currentPlan, selectedCue.id).sceneLayers ?? [];
    const ratio = (asset as any).width && (asset as any).height ? (asset as any).width / (asset as any).height : 16 / 9;
    const width = Math.min(960, 900 * ratio);
    const height = width / ratio;
    const layer = { id: makeId('layer'), assetId: asset.id, x: 960, y: 540, width, height, opacity: 1, zIndex: inherited.length, rotation: 0, fit: 'contain', crop: { left: 0, top: 0, right: 0, bottom: 0 }, videoMuted: false, videoVolume: 1, videoStartMs: 0 };
    patchCue({ sceneLayers: [...inherited, layer] });
    setSelectedLayerId(layer.id);
    setNotice(`已将“${asset.name}”添加到当前句舞台。`);
  };

  const updateLayer = (patch: Record<string, any>, layerId = selectedLayer?.id) => {
    if (!selectedCue || !layerId) return;
    return patchCue({ sceneLayers: selectedLayers.map((layer: any) => layer.id === layerId ? { ...layer, ...patch } : layer) });
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!selectedLayer || playerState.status !== 'stopped' || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest('[contenteditable],[role="dialog"]'))) || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      const step = event.shiftKey ? 10 : 1;
      const delta = event.key === 'ArrowLeft' ? { x: -step } : event.key === 'ArrowRight' ? { x: step } : event.key === 'ArrowUp' ? { y: -step } : event.key === 'ArrowDown' ? { y: step } : null;
      if (!delta) return;
      event.preventDefault();
      updateLayer({ x: Math.max(0, Math.min(1920 - selectedLayer.width, selectedLayer.x + (delta.x ?? 0))), y: Math.max(0, Math.min(1080 - selectedLayer.height, selectedLayer.y + (delta.y ?? 0))) });
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [selectedLayer, playerState.status, selectedCue, selectedLayers]);

  const removeLayer = () => {
    if (!selectedCue || !selectedLayer) return;
    patchCue({ sceneLayers: selectedLayers.filter((layer: any) => layer.id !== selectedLayer.id).map((layer: any, index: number) => ({ ...layer, zIndex: index })) });
    setSelectedLayerId(null);
          setSelectedGroupId(null);
          setSelectedGroupIds([]);
  };

  const moveLayer = (direction: number) => {
    if (!selectedCue || !selectedLayer) return;
    const sorted = [...selectedLayers].sort((a: any, b: any) => a.zIndex - b.zIndex);
    const index = sorted.findIndex((layer: any) => layer.id === selectedLayer.id);
    const next = Math.max(0, Math.min(sorted.length - 1, index + direction));
    [sorted[index], sorted[next]] = [sorted[next], sorted[index]];
    patchCue({ sceneLayers: sorted.map((layer: any, zIndex: number) => ({ ...layer, zIndex })) });
  };

  const updateActiveChapter = (operation: (value: any) => any) => {
    commitChapterStructure(updateChapter(projectRef.current, projectRef.current.activeChapterId, operation));
  };

  const commitProject = (next: any) => {
    projectRef.current = next;
    setProject(next);
  };

  const commitChapterStructure = (next: any) => {
    validateProject(next);
    if (!editor || next.activeChapterId !== projectRef.current.activeChapterId) throw new Error('当前正文已变化，请重新操作。');
    const before = projectRef.current;
    const chapterId = editor.state.doc.attrs.chapterId;
    if (!chapterId || chapterId !== before.activeChapterId) throw new Error('正文编辑器已切换，请重新操作。');
    const token = makeId('structure');
    reviewHistoryRef.current.set(token, { before, after: next, chapterId });
    try {
      if (!moveEditorParagraphs(editor, activeChapter(next).document.blocks, token, chapterId)) throw new Error('正文内容已变化，结构操作未提交。');
    } catch (error) { reviewHistoryRef.current.delete(token); throw error; }
    commitProject(next);
  };

  const switchChapter = (chapterId: string) => {
    if (chapterId === project.activeChapterId) return;
    stopEdgeAutoscroll();
    cancelledDragRef.current = true;
    dragActiveRef.current = false;
    if (editorScrollRef.current) chapterScrollRef.current.set(project.activeChapterId, editorScrollRef.current.scrollTop);
    if (editor) {
      const selection = editor.state.selection;
      chapterCursorRef.current.set(project.activeChapterId, { from: selection.from, to: selection.to, cueId: selectedCueId });
    }
    playerRef.current.stop();
    commitProject({ ...projectRef.current, activeChapterId: chapterId, updatedAt: new Date().toISOString() });
  };

  const createNewChapter = (trigger: HTMLElement) => {
    const sourceChapterId = chapter.id;
    const selection = editor ? editor.state.selection : null;
    const cursor = selection ? { from: selection.from, to: selection.to, cueId: selectedCueId } : null;
    openNameDialog(trigger, {
      title: '新建章节',
      fieldLabel: '章节名称',
      confirmLabel: '新建章节',
      initialValue: `第${String(project.chapters.length + 1).padStart(2, '0')}章`,
      normalize: normalizeChapterName,
      onConfirm: (name) => {
        try {
          const current = projectRef.current;
          if (current.activeChapterId !== sourceChapterId || !current.chapters.some((item: any) => item.id === sourceChapterId)) return '当前章节已变化，请关闭后重试。';
          const next = addChapter(current, name);
          if (cursor) chapterCursorRef.current.set(sourceChapterId, cursor);
          playerRef.current.stop();
          commitProject(next);
          setSelectedCueId(null);
          setSelectedParagraphs([]);
          setSelectedGroupId(null);
          return undefined;
        } catch (error) { return error instanceof Error ? error.message : '无法新建章节。'; }
      },
    });
  };

  const renameActiveChapter = (trigger: HTMLElement) => {
    const chapterId = chapter.id;
    openNameDialog(trigger, {
      title: '重命名章节',
      fieldLabel: '章节名称',
      confirmLabel: '保存章节名',
      initialValue: chapter.name,
      normalize: normalizeChapterName,
      onConfirm: (name) => {
        try {
          const current = projectRef.current;
          if (!current.chapters.some((item: any) => item.id === chapterId)) return '章节已不存在，请重新选择。';
          commitProject(renameChapter(current, chapterId, name));
          return undefined;
        } catch (error) { return error instanceof Error ? error.message : '章节名称无效。'; }
      },
    });
  };

  const createGroupFromSelection = (trigger: HTMLElement) => {
    if (!selectedParagraphs.length) return setNotice('先在正文中选中要归组的连续段落。');
    const chapterId = chapter.id;
    const paragraphIds = [...selectedParagraphs];
    const blockIds = document.blocks.map((block: any) => block.id);
    const first = blockIds.indexOf(paragraphIds[0]);
    const last = blockIds.indexOf(paragraphIds[paragraphIds.length - 1]);
    openNameDialog(trigger, {
      title: '归入新组',
      fieldLabel: '段落组名称',
      confirmLabel: `创建并归入 ${paragraphIds.length} 段`,
      initialValue: '新段落组',
      description: `第 ${first + 1}–${last + 1} 段 · 共 ${paragraphIds.length} 段。取消不会修改正文。`,
      normalize: normalizeParagraphGroupName,
      onConfirm: (name) => {
        try {
          const current = projectRef.current;
          const currentChapter = current.chapters.find((item: any) => item.id === chapterId);
          if (!currentChapter || current.activeChapterId !== chapterId) return '当前章节已变化，请关闭后重试。';
          const existingIds = new Set(currentChapter.groups.map((group: any) => group.id));
          const next = updateChapter(current, chapterId, (value: any) => createParagraphGroup(value, paragraphIds, name));
          const nextChapter = next.chapters.find((item: any) => item.id === chapterId);
          const created = nextChapter.groups.find((group: any) => !existingIds.has(group.id));
          if (!created) return '未能创建段落组，请重新选择段落。';
          commitChapterStructure(next);
          setSelectedGroupId(created.id);
          setSelectedGroupIds([created.id]);
          setSelectedParagraphs([]);
          setNotice('选中的连续段落已归入新组。');
          return undefined;
        } catch (error) { return error instanceof Error ? error.message : '无法创建段落组。'; }
      },
    });
  };

  const createEmptyGroup = (trigger: HTMLElement) => {
    const chapterId = chapter.id;
    const afterGroupId = selectedGroupId;
    openNameDialog(trigger, {
      title: '新建空段落组',
      fieldLabel: '段落组名称',
      confirmLabel: '新建并开始写作',
      initialValue: '新段落组',
      normalize: normalizeParagraphGroupName,
      onConfirm: (name) => {
        try {
          const current = projectRef.current;
          if (current.activeChapterId !== chapterId) return '当前章节已变化，请关闭后重试。';
          const next = updateChapter(current, chapterId, (value: any) => createEmptyParagraphGroup(value, name, afterGroupId));
          validateProject(next);
          const nextChapter = next.chapters.find((item: any) => item.id === chapterId);
          const created = nextChapter.groups.find((group: any) => !current.chapters.find((item: any) => item.id === chapterId)?.groups.some((existing: any) => existing.id === group.id));
          if (!created) return '未能创建段落组，请重试。';
          commitChapterStructure(next);
          playerRef.current.stop();
          setSelectedGroupId(created.id);
          setSelectedGroupIds([created.id]);
          setSelectedParagraphs([]);
          selectParagraph(created.paragraphIds[0]);
          return undefined;
        } catch (error) { return error instanceof Error ? error.message : '无法创建空段落组。'; }
      },
    });
  };

  const distributeLayers = (axis: 'x' | 'y') => {
    if (!selectedCue || selectedLayers.length < 2) return;
    const sorted = [...selectedLayers].sort((a: any, b: any) => axis === 'x' ? a.x - b.x : a.y - b.y);
    const span = axis === 'x' ? 1920 : 1080;
    const sizeKey = axis === 'x' ? 'width' : 'height';
    const total = sorted.reduce((sum: number, layer: any) => sum + layer[sizeKey], 0);
    const gap = Math.max(0, (span - total) / (sorted.length - 1));
    let cursor = 0;
    const positions = new Map<string, number>();
    for (const layer of sorted) { positions.set(layer.id, cursor); cursor += layer[sizeKey] + gap; }
    patchCue({ sceneLayers: selectedLayers.map((layer: any) => ({ ...layer, [axis]: positions.get(layer.id) ?? layer[axis] })) });
  };

  const setGroupMusic = (assetId: string, paragraphIds: string[]) => {
    if (!assetsRef.current.some((asset) => asset.id === assetId && asset.kind === 'audio')) return setNotice('请选择当前工程中的有效音频。');
    if (!paragraphIds.length) return setNotice('先选一个组或连续多个组，再添加背景音乐。');
    const current = projectRef.current;
    const source = activeChapter(current);
    try {
      commitChapterStructure(updateChapter(current, source.id, (value: any) => setMusicRange(value, assetId, paragraphIds)));
      setNotice(`已设置 ${paragraphIds.length} 段的背景音乐；范围内换句保持连续。`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('重叠')) setPendingMusic({ chapterId: source.id, assetId, paragraphIds, base: current });
      else setNotice(error instanceof Error ? error.message : '配乐未提交。');
    }
  };
  const setMusicForSelection = (assetId: string) => {
    if (!assetId) return;
    const groups = selectedGroupIds.length ? orderedGroups.filter((group: any) => selectedGroupIds.includes(group.id)) : currentGroup ? [currentGroup] : [];
    const ids = groups.length ? document.blocks.filter((block: any) => groups.some((group: any) => group.paragraphIds.includes(block.id))).map((block: any) => block.id) : selectedParagraphs;
    setGroupMusic(assetId, ids);
  };
  const confirmGroupMusic = () => {
    if (!groupMusicDialog) return;
    const current = projectRef.current;
    const source = current.chapters.find((item: any) => item.id === groupMusicDialog.chapterId);
    if (!source || current.activeChapterId !== groupMusicDialog.chapterId) {
      setGroupMusicDialog(null);
      return setNotice('章节已变化，请重新选择目标组。');
    }
    const groups = source.groups.filter((group: any) => groupMusicDialog.groupIds.includes(group.id));
    const paragraphIds = source.document.blocks.filter((block: any) => groups.some((group: any) => group.paragraphIds.includes(block.id))).map((block: any) => block.id);
    setGroupMusic(groupMusicDialog.assetId, paragraphIds);
    setGroupMusicDialog(null);
  };
  const importGroupMusic = async () => {
    if (!groupMusicDialog) return;
    const target = groupMusicDialog;
    try {
      const added = await importAssets(true);
      if (!added.length) return;
      const current = projectRef.current;
      if (current.activeChapterId !== target.chapterId) throw new Error('章节已变化，请重新设置配乐。');
      const source = activeChapter(current);
      const ids = source.document.blocks.filter((block: any) => source.groups.some((group: any) => target.groupIds.includes(group.id) && group.paragraphIds.includes(block.id))).map((block: any) => block.id);
      setGroupMusic(added[0].id, ids);
      setGroupMusicDialog(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : '音乐导入失败。'); }
  };
  const confirmMusicReplacement = () => {
    if (!pendingMusic) return;
    try {
      if (projectRef.current !== pendingMusic.base) throw new Error('工程已变化，请关闭提示并重新选择音乐。');
      commitChapterStructure(updateChapter(projectRef.current, pendingMusic.chapterId, (value: any) => replaceMusicRange(value, pendingMusic.assetId, pendingMusic.paragraphIds)));
      setPendingMusic(null);
      setNotice('已替换目标范围的配乐，范围外的原音乐保持。');
    } catch (error) { setPendingMusic(null); setNotice(error instanceof Error ? error.message : '替换未提交。'); }
  };
  const moveSelectionToGroup = (groupId: string) => {
    if (!groupId || !selectedParagraphs.length) return;
    try {
      const current = projectRef.current;
      commitChapterStructure(updateChapter(current, current.activeChapterId, (value: any) => moveParagraphs(value, selectedParagraphs, { type: 'group', groupId })));
      setSelectedGroupId(groupId);
      setSelectedGroupIds([groupId]);
      setSelectedParagraphs([]);
      setNotice('已将所选段落移入目标组。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '未能移入组。'); }
  };

  function selectGroup(groupId: string, event?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) {
    const index = orderedGroups.findIndex((group: any) => group.id === groupId);
    if (index < 0) return;
    let next = [groupId];
    if (event?.shiftKey && selectedGroupId) {
      const from = orderedGroups.findIndex((group: any) => group.id === selectedGroupId);
      if (from >= 0) next = orderedGroups.slice(Math.min(from, index), Math.max(from, index) + 1).map((group: any) => group.id);
    } else if (event?.ctrlKey || event?.metaKey) {
      next = selectedGroupIds.includes(groupId) ? selectedGroupIds.filter((id) => id !== groupId) : [...selectedGroupIds, groupId];
    }
    setSelectedGroupId(next.includes(groupId) ? groupId : next.at(-1) ?? null);
    setSelectedGroupIds(next);
    setSelectedParagraphs([]);
  }

  const stopEdgeAutoscroll = () => {
    edgeScrollDirectionRef.current = 0;
    if (edgeScrollFrameRef.current !== null) cancelAnimationFrame(edgeScrollFrameRef.current);
    edgeScrollFrameRef.current = null;
  };
  const beginAudioDrag = () => {
    cancelledDragRef.current = false;
    dragActiveRef.current = true;
    stopEdgeAutoscroll();
  };
  const endAudioDrag = () => {
    cancelledDragRef.current = false;
    dragActiveRef.current = false;
    stopEdgeAutoscroll();
  };
  const updateEdgeAutoscroll = (list: HTMLElement, clientY: number) => {
    eventYRef.current = clientY;
    const bounds = list.getBoundingClientRect();
    const edge = Math.min(54, bounds.height * 0.18);
    const direction = clientY < bounds.top + edge ? -1 : clientY > bounds.bottom - edge ? 1 : 0;
    if (!direction) return stopEdgeAutoscroll();
    if (edgeScrollDirectionRef.current === direction && edgeScrollFrameRef.current !== null) return;
    stopEdgeAutoscroll();
    edgeScrollDirectionRef.current = direction;
    const step = () => {
      if (cancelledDragRef.current || !editorScrollRef.current || !edgeScrollDirectionRef.current) return stopEdgeAutoscroll();
      const scroll = editorScrollRef.current;
      const rect = scroll.getBoundingClientRect();
      const distance = edgeScrollDirectionRef.current < 0 ? Math.max(0, 54 - (eventYRef.current - rect.top)) : Math.max(0, 54 - (rect.bottom - eventYRef.current));
      scroll.scrollTop += edgeScrollDirectionRef.current * Math.min(22, 5 + distance * 0.28);
      edgeScrollFrameRef.current = requestAnimationFrame(step);
    };
    edgeScrollFrameRef.current = requestAnimationFrame(step);
  };
  const eventYRef = useRef(0);
  const beginParagraphDrag = (event: React.DragEvent, explicitId?: string) => {
    const element = event.target instanceof HTMLElement ? event.target : null;
    const paragraphId = explicitId ?? paragraphTarget(element)?.id;
    if (!paragraphId || !event.dataTransfer) return;
    cancelledDragRef.current = false;
    dragActiveRef.current = true;
    const paragraphIds = selectedParagraphs.includes(paragraphId) ? selectedParagraphs : [paragraphId];
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-story-workbench-paragraphs', JSON.stringify({ chapterId: chapter.id, paragraphIds }));
    event.dataTransfer.setData('text/plain', '剧情段落');
  };

  const acceptParagraphDrop = (event: React.DragEvent, target: { type: 'group'; groupId: string } | { type: 'paragraph'; paragraphId: string; position: 'before' | 'after' }) => {
    event.preventDefault();
    event.stopPropagation();
    setDropHint(null);
    try {
      const raw = event.dataTransfer?.getData('application/x-story-workbench-paragraphs');
      if (!raw) return;
      const payload = JSON.parse(raw);
      if (payload.chapterId !== chapter.id) throw new Error('段落只能在当前章节内移动。');
      if (!Array.isArray(payload.paragraphIds) || payload.paragraphIds.some((id: unknown) => typeof id !== 'string')) throw new Error('拖动内容无效，请重新拖动。');
      const current = projectRef.current;
      const currentChapter = activeChapter(current);
      const movedChapter = moveParagraphs(currentChapter, payload.paragraphIds, target);
      if (movedChapter === currentChapter) { setNotice('位置未变，正文顺序已保留。'); return; }
      const next = updateChapter(current, currentChapter.id, () => movedChapter);
      validateProject(next);
      commitChapterStructure(next);
      playerRef.current.stop();

      setSelectedParagraphs(payload.paragraphIds);
      setNotice(`已移动 ${payload.paragraphIds.length} 段正文；可用撤销恢复。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '段落移动失败，工程未更改。');
    }
  };

  const acceptGroupDrop = (event: React.DragEvent, groupId: string) => {
    if (event.dataTransfer.types.includes(AUDIO_DRAG)) {
      event.preventDefault(); event.stopPropagation(); setDropHint(null);
      try {
        const payload = JSON.parse(event.dataTransfer.getData(AUDIO_DRAG));
        const current = projectRef.current;
        if (payload.projectId !== current.id) throw new Error('音频必须来自当前工程。');
        const group = activeChapter(current).groups.find((item: any) => item.id === groupId);
        if (!group) throw new Error('目标组已不存在。');
        setGroupMusic(payload.assetId, group.paragraphIds);
      } catch (error) { setNotice(error instanceof Error ? error.message : '音频拖动无效。'); }
      return;
    }
    acceptParagraphDrop(event, { type: 'group', groupId });
  };

  /* ── 四区右键菜单：单一上下文入口、单一命令定义 ────────────── */
  type OpenMenu = {
    target: MenuTarget; x: number; y: number; commands: MenuCommand[];
    title: string; focus: HTMLElement | null; facts: MenuFacts;
  };
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const menuRef = useRef<OpenMenu | null>(null);
  menuRef.current = openMenu;
  const editorMenuRef = useRef<{ anchor: number; head: number } | null>(null);

  const readClipboard = async () => {
    const raw = await window.storyWorkbench.readClipboard();
    const payload = raw?.payload ? validateClipboard(raw.payload) : null;
    return { text: typeof raw?.text === 'string' ? raw.text : '', payload };
  };
  const writeClipboard = async (payload: StoryClipboard | null, text = '') => {
    await window.storyWorkbench.writeClipboard({ text, payload });
  };

  const paragraphOfCaret = () => {
    if (!editor) return null;
    const { selection } = editor.state;
    const id = selection.$from.parent?.attrs?.paragraphId;
    return id ? String(id) : null;
  };
  const groupIdOfParagraph = (paragraphId: string | undefined) => {
    if (!paragraphId) return null;
    const block = document.blocks.find((item: any) => item.id === paragraphId);
    const own = block?.groupId ?? null;
    if (own) return String(own);
    const group = chapter.groups.find((item: any) => item.paragraphIds.includes(paragraphId));
    return group ? group.id : null;
  };
  const indexOfParagraph = (paragraphId: string | undefined) => document.blocks.findIndex((block: any) => block.id === paragraphId);

  const collectFacts = (target: MenuTarget, hasTextSelection: boolean, canPaste: boolean): MenuFacts => {
    const paragraphIndex = indexOfParagraph(target.paragraphId);
    const layer = target.layerId ? selectedLayers.find((item: any) => item.id === target.layerId) : null;
    const sorted = [...selectedLayers].sort((a: any, b: any) => a.zIndex - b.zIndex);
    const layerOrder = layer ? sorted.findIndex((item: any) => item.id === layer.id) : -1;
    const asset = target.assetId ? assets.find((item: any) => item.id === target.assetId) : null;
    /* 段落组目录里的组可能属于别的章节，事实要按那一章来算 */
    const targetChapter = projectRef.current.chapters.find((item: any) => item.id === target.chapterId) ?? null;
    const targetGroup = target.groupId ? (targetChapter?.groups ?? []).find((item: any) => item.id === target.groupId) ?? null : null;
    const targetGroups = targetChapter
      ? [...targetChapter.groups].sort((a: any, b: any) => targetChapter.document.blocks.findIndex((block: any) => block.id === a.paragraphIds[0]) - targetChapter.document.blocks.findIndex((block: any) => block.id === b.paragraphIds[0]))
      : [];
    return {
      canUndo: !!editor?.can().undo(),
      canRedo: !!editor?.can().redo(),
      hasTextSelection,
      paragraphIndex,
      paragraphCount: document.blocks.length,
      groupCount: targetChapter?.groups.length ?? 0,
      collapsed: !!targetGroup?.collapsed,
      inGroup: !!groupIdOfParagraph(target.paragraphId ?? paragraphOfCaret() ?? undefined),
      groupAtTop: targetGroup ? targetGroups[0]?.id === targetGroup.id : false,
      groupAtBottom: targetGroup ? targetGroups.at(-1)?.id === targetGroup.id : false,
      hasAudioAsset: assets.some((item: any) => item.kind === 'audio'),
      mode: selectedCue?.settings.mode ?? null,
      hasSpeaker: !!selectedCue?.settings.speaker,
      layerLocked: !!layer?.locked,
      layerAtTop: layerOrder >= 0 && layerOrder === sorted.length - 1,
      layerAtBottom: layerOrder === 0,
      assetKind: asset?.kind ?? null,
      assetReferenced: asset ? assetUsages(projectRef.current, asset.id).length > 0 : false,
      canPaste,
    };
  };

  /** 把执行入口收敛到一处，菜单与 Ctrl+C/X/V 共用 */
  const runMenuAction = async (command: MenuCommand, focus: Element | null) => {
    const target = focus instanceof HTMLElement ? focus : null;
    setOpenMenu(null);
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
    try { await command.run?.(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '操作未完成。'); }
  };

  const openWorkspaceMenu = (target: MenuTarget, event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, focus: Element | null, hasTextSelection = false) => {
    event.preventDefault();
    event.stopPropagation();
    /* 菜单已打开时再点一次右键＝取消，不必按 ESC；关闭后把焦点还给原来的对象 */
    const current = menuRef.current;
    if (current) {
      setOpenMenu(null);
      const focus = current.focus;
      if (focus?.isConnected) requestAnimationFrame(() => focus.focus());
      return;
    }
    const live = projectRef.current;
    if (live.id !== target.projectId) return setNotice('工程已切换，请在当前对象上重新右键。');
    /* 段落组目录里的组可能属于别的章节：组级命令会自己切到那一章再执行。 */
    if (live.activeChapterId !== target.chapterId && target.kind !== 'group') return setNotice('工程或章节已切换，请在当前对象上重新右键。');
    const canPaste = true;
    const facts = collectFacts(target, hasTextSelection, canPaste);
    const commands = buildWorkspaceMenu(target, facts, menuActions(target), orderedGroups.map((group: any) => ({ id: group.id, name: group.name })));
    const focusElement = focus instanceof HTMLElement ? focus : null;
    setOpenMenu({ target, x: event.clientX, y: event.clientY, commands, title: menuTitle(target, facts), focus: focusElement, facts });
  };

  const menuActions = (target: MenuTarget): MenuActions => ({
    undo: () => editor?.chain().focus().undo().run(),
    redo: () => editor?.chain().focus().redo().run(),
    cut: () => copyOrCut(target, 'cut'),
    copy: () => copyOrCut(target, 'copy'),
    paste: () => pasteInto(target),
    deleteSelection: () => editor?.chain().focus().deleteSelection().run(),
    deleteParagraph: () => removeParagraphTarget(target),
    convert: (mode) => applyMenuMode(target, mode),
    moveToGroup: (groupId) => moveOneParagraphToGroup(target, groupId),
    moveParagraph: (direction) => moveOneParagraph(target, direction),
    toggleCollapse: () => toggleTargetGroup(target),
    locateGroup: () => { if (target.groupId) locateGroup(target.chapterId, target.groupId); },
    renameGroup: () => {
      const source = projectRef.current.chapters.find((item: any) => item.id === target.chapterId);
      const group = source?.groups.find((item: any) => item.id === target.groupId);
      if (!group || !target.groupId) return setNotice('这个段落组已经不存在。');
      renameGroupInChapter(target.chapterId, target.groupId, group.name, null);
    },
    moveGroup: (direction) => { if (target.groupId) moveGroupInChapter(target.chapterId, target.groupId, direction); },
    removeGroup: () => { if (target.groupId) removeGroupInChapter(target.chapterId, target.groupId); },
    openGroupMusic: () => {
      if (!target.groupId) return;
      runInChapter(target.chapterId, () => setGroupMusicDialog({ chapterId: target.chapterId, groupIds: [target.groupId!], assetId: '' }));
    },
    insertImage: () => insertMediaInto(target, 'image'),
    insertVideo: () => insertMediaInto(target, 'video'),
    insertAudio: (where) => insertMediaInto(target, 'audio', where),
    importAsset: () => onImportAssets(),
    applyAsset: (where) => applyAssetToTarget(target, where),
    copyAsset: () => copyTargetAsset(target),
    pasteAsset: () => pasteInto(target),
    removeAsset: () => { const asset = assets.find((item) => item.id === target.assetId); if (asset) deleteAsset(asset); },
    layerZ: (direction) => { if (target.layerId) { setSelectedLayerId(target.layerId); moveLayer(target.layerId === selectedLayer?.id ? direction : 0); } },
    toggleLayerLock: () => toggleLayerLock(target),
    duplicateLayer: () => duplicateTargetLayer(target),
    removeLayer: () => { setSelectedLayerId(target.layerId ?? null); removeLayer(); },
  });

  const copyOrCut = async (target: MenuTarget, mode: 'copy' | 'cut') => {
    if (!editor) return;
    const selection = editor.state.selection;
    const hasText = !selection.empty && target.kind !== 'paragraph' && target.kind !== 'assets';
    if (target.kind === 'text' || hasText) {
      if (selection.empty) return setNotice('没有选中文字。');
      const slice = selection.content();
      const payload: StoryClipboard = { version: 1, projectId: projectRef.current.id, kind: 'text', value: slice.toJSON() };
      await writeClipboard(payload, editor.state.doc.textBetween(selection.from, selection.to, '\n'));
      if (mode === 'cut') editor.chain().focus().deleteSelection().run();
      setNotice(mode === 'cut' ? '已剪切选中文字。' : '已复制选中文字。');
      return;
    }
    if (target.kind === 'asset') return copyTargetAsset(target);
    if (target.kind === 'layer') return duplicateTargetLayer(target);
    const paragraphId = target.paragraphId ?? paragraphOfCaret();
    if (!paragraphId) return setNotice('没有可复制的正文段落。');
    const block = document.blocks.find((item: any) => item.id === paragraphId);
    if (!block) return setNotice('这个正文段落已变化，请重新选择。');
    const payload: StoryClipboard = { version: 1, projectId: projectRef.current.id, kind: 'paragraph', value: JSON.parse(JSON.stringify(block)) };
    await writeClipboard(payload, clipboardText(payload));
    if (mode === 'cut') deleteEditorParagraph(editor, paragraphId);
    setNotice(mode === 'cut' ? '已剪切此段。' : '已复制此段（含演出信息）。');
  };

  const copyTargetAsset = async (target: MenuTarget) => {
    if (!target.assetId) return;
    const payload: StoryClipboard = { version: 1, projectId: projectRef.current.id, kind: 'asset', value: { assetId: target.assetId } };
    await writeClipboard(payload, '');
    setNotice('已复制素材；只能在同一工程内粘贴使用。');
  };

  const pasteInto = async (target: MenuTarget) => {
    if (!editor) return setNotice('正文尚未就绪。');
    const projectId = projectRef.current.id;
    const chapterId = projectRef.current.activeChapterId;
    let clip: { text: string; payload: StoryClipboard | null };
    try { clip = await readClipboard(); }
    catch (error) { return setNotice(error instanceof Error ? error.message : '剪贴板内容无效。'); }
    if (projectRef.current.id !== projectId || projectRef.current.activeChapterId !== chapterId) return setNotice('工程或章节已切换，粘贴已取消。');
    const paragraphId = target.paragraphId ?? paragraphOfCaret();
    if (!paragraphId || !paragraphPosition(editor, paragraphId)) return setNotice('粘贴目标已不存在，请重新右键选择。');
    if (clip.payload) checkClipboardReferences(clip.payload, projectRef.current);
    const selection = editorMenuRef.current ?? (target.kind === 'text' ? { anchor: editor.state.selection.anchor, head: editor.state.selection.head } : undefined);
    pasteEditorClipboard(editor, clip.payload, clip.text, paragraphId, selection);
    setNotice('已粘贴；可用撤销恢复。');
  };

  const removeParagraphTarget = (target: MenuTarget) => {
    if (!editor) return;
    const paragraphId = target.paragraphId ?? paragraphOfCaret();
    if (!paragraphId) return setNotice('没有可删除的正文段落。');
    deleteEditorParagraph(editor, paragraphId);
    setNotice('已删除此段；可用撤销恢复。');
  };

  const applyMenuMode = (target: MenuTarget, mode: 'dialogue' | 'free') => {
    if (!editor) return;
    const paragraphId = target.paragraphId ?? paragraphOfCaret();
    const cue = paragraphId ? currentPlan.find((item: any) => item.paragraphId === paragraphId) : null;
    const cueId = cue?.id ?? selectedCueId;
    if (!cueId) return setNotice('这一段还没有演出单元，请先输入正文文字。');
    const current = currentPlan.find((item: any) => item.id === cueId)?.settings ?? defaultSettings();
    const result = applyMode(editor, cueId, current, mode);
    if (!result.ok) return setNotice(result.message ?? '未能应用演出模式。');
    if (result.cueId) setSelectedCueId(result.cueId);
    setNotice(mode === 'free' ? '已转换为自由演出。' : '已转换为对话。');
  };

  const moveOneParagraphToGroup = (target: MenuTarget, groupId: string) => {
    const paragraphId = target.paragraphId;
    if (!paragraphId) return setNotice('没有可移动的正文段落。');
    try {
      const current = projectRef.current;
      commitChapterStructure(updateChapter(current, current.activeChapterId, (value: any) => moveParagraphs(value, [paragraphId], { type: 'group', groupId })));
      setSelectedGroupId(groupId);
      setSelectedGroupIds([groupId]);
      setSelectedParagraphs([]);
      setNotice('已把右键这一段移入目标组。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '未能移入组。'); }
  };

  const moveOneParagraph = (target: MenuTarget, direction: -1 | 1) => {
    const paragraphId = target.paragraphId;
    if (!paragraphId) return setNotice('没有可移动的正文段落。');
    try {
      const current = projectRef.current;
      const moved = moveParagraphs(activeChapter(current), [paragraphId], { type: 'paragraph', paragraphId, position: direction < 0 ? 'before' : 'after' });
      if (moved === activeChapter(current)) return setNotice('位置未变，正文顺序已保留。');
      commitChapterStructure(updateChapter(current, current.activeChapterId, () => moved));
      setNotice(direction < 0 ? '已上移此段。' : '已下移此段。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '段落移动失败，工程未更改。'); }
  };

  const toggleTargetGroup = (target: MenuTarget) => {
    const groupId = target.groupId ?? groupIdOfParagraph(target.paragraphId);
    if (!groupId) return setNotice('这一段还没有加入段落组。');
    const chapterId = target.chapterId;
    const source = projectRef.current.chapters.find((item: any) => item.id === chapterId);
    const group = source?.groups.find((item: any) => item.id === groupId);
    runInChapter(chapterId, () => {
      try {
        commitChapterStructure(updateChapter(projectRef.current, chapterId, (value: any) => setGroupCollapsed(value, groupId, !group?.collapsed)));
        setNotice(group?.collapsed ? '已展开此组。' : '已折叠此组，正文与播放不变。');
      } catch (error) { setNotice(error instanceof Error ? error.message : '折叠未提交。'); }
    });
  };

  const insertMediaInto = async (target: MenuTarget, kind: 'image' | 'video' | 'audio', where: 'cue' | 'bgm' = 'cue') => {
    const paragraphId = target.paragraphId ?? paragraphOfCaret();
    if (!paragraphId) return setNotice('请先选择要插入媒体的正文段落。');
    const projectId = projectRef.current.id;
    const chapterId = projectRef.current.activeChapterId;
    let added: AssetRecord[] = [];
    try { added = await importAssets(kind === 'audio'); }
    catch (error) { return setNotice(error instanceof Error ? error.message : '素材导入失败。'); }
    if (!added.length) return;
    if (projectRef.current.id !== projectId || projectRef.current.activeChapterId !== chapterId) return setNotice('工程或章节已切换，插入已取消。');
    const asset = added.find((item) => item.kind === kind) ?? added[0];
    if (kind === 'audio' && where === 'bgm') {
      const groupId = groupIdOfParagraph(paragraphId);
      if (!groupId) return setNotice('此段还没有加入段落组，请先加入组再设背景音乐。');
      const group = chapter.groups.find((item: any) => item.id === groupId);
      if (group) setGroupMusic(asset.id, group.paragraphIds);
      return;
    }
    const cue = currentPlan.find((item: any) => item.paragraphId === paragraphId);
    if (!cue) return setNotice('这一段还没有演出单元，请先输入正文文字。');
    setSelectedCueId(cue.id);
    if (kind === 'audio') patchCueFor(cue.id, { audioId: asset.id });
    else addSceneLayer(asset);
    setNotice(`已把“${asset.name}”插入这一段。`);
  };

  const patchCueFor = (cueId: string, patch: Partial<CueSettings>) => {
    const cue = currentPlan.find((item: any) => item.id === cueId);
    if (!cue || !editor) return;
    if (applyCuePatch(editor, cueId, cue.settings, patch)) setSelectedCueId(cueId);
  };

  const applyAssetToTarget = (target: MenuTarget, where: 'background' | 'audio' | 'layer' | 'article') => {
    const asset = assets.find((item) => item.id === target.assetId);
    if (!asset) return setNotice('素材已不存在。');
    if (where === 'background') setBackground(asset.id);
    else if (where === 'audio') setAudio(asset.id);
    else if (where === 'layer') addSceneLayer(asset);
    else previewArticle(asset);
  };

  const toggleLayerLock = (target: MenuTarget) => {
    const layer = selectedLayers.find((item: any) => item.id === target.layerId);
    if (!layer) return setNotice('图层已不存在。');
    setSelectedLayerId(target.layerId!);
    updateLayer({ locked: !layer.locked }, target.layerId!);
  };

  const duplicateTargetLayer = async (target: MenuTarget) => {
    const layer = selectedLayers.find((item: any) => item.id === target.layerId);
    if (!layer) return setNotice('图层已不存在。');
    const payload: StoryClipboard = { version: 1, projectId: projectRef.current.id, kind: 'layer', value: JSON.parse(JSON.stringify(layer)) };
    await writeClipboard(payload, '');
    const cue = selectedCue;
    if (!cue) return setNotice('请先选中一句正文。');
    const copy = { ...JSON.parse(JSON.stringify(layer)), id: makeId('layer'), zIndex: selectedLayers.length };
    patchCueFor(cue.id, { sceneLayers: [...selectedLayers, copy] });
    setSelectedLayerId(copy.id);
    setNotice('已复制图层，引用同一素材。');
  };

  /** 正文编辑器里的右键：先按 PM 语义更新选区并捕获，再决定菜单对象 */
  const onEditorContextMenu = (event: React.MouseEvent) => {
    const editorDOM = editorViewDom(editor);
    /* 视图尚未就绪时没有可操作的正文 DOM，交给浏览器默认右键，不崩也不假装菜单可用 */
    if (!editor || !editorDOM) return;
    const target = event.target instanceof Element ? event.target : null;
    /* 正文容器本身就是 contenteditable="true"，若不排除编辑器自身，
       在 C 区任何位置右键都会提前返回，菜单永远不弹。
       只有编辑器之外的输入控件才让出右键，保持文字语义。 */
    if (deferToNativeMenu(target, editorDOM)) return;
    const view = editor.view;
    const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (at && at.inside > -1) {
      const selection = view.state.selection;
      if (!selection.empty) {
        const from = Math.min(selection.from, at.pos);
        const to = Math.max(selection.to, at.pos);
        editorMenuRef.current = { anchor: from, head: to };
      } else {
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at.pos)));
        editorMenuRef.current = { anchor: at.pos, head: at.pos };
      }
    }
    const selection = editor.state.selection;
    const hasTextSelection = !selection.empty;
    const inParagraph = selection.$from.parent?.type?.name === 'paragraph';
    const paragraphId = inParagraph ? String(selection.$from.parent.attrs.paragraphId ?? '') : undefined;
    const kind: MenuTarget['kind'] = hasTextSelection ? 'text' : 'paragraph';
    openWorkspaceMenu({ kind, projectId: projectRef.current.id, chapterId: projectRef.current.activeChapterId, paragraphId: paragraphId || undefined, groupId: groupIdOfParagraph(paragraphId) ?? undefined }, event, editorDOM, hasTextSelection);
  };

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const groupId = detail?.groupId;
      if (!groupId) return;
      try {
        commitChapterStructure(updateChapter(projectRef.current, projectRef.current.activeChapterId, (value: any) => setGroupCollapsed(value, groupId, !chapter.groups.find((item: any) => item.id === groupId)?.collapsed)));
      } catch (error) { setNotice(error instanceof Error ? error.message : '折叠未提交。'); }
    };
    /* 折叠按钮在正文节点上，视图未挂载时没有可绑的 DOM；交给 bindEditorViewListeners 随挂载补绑 */
    return bindEditorViewListeners(editor, [['story-group-collapse', handler]]);
  }, [editor, chapter.groups]);

  /** 菜单与快捷键共用同一条命令入口 */
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const open = menuRef.current;
      if (!open) return;
      const context: MenuContext = { kind: open.target.kind, projectId: open.target.projectId, chapterId: open.target.chapterId, doc: editor?.state.doc ?? null, focus: open.focus };
      const flat = open.commands.flatMap((command) => [command, ...(command.children ?? [])]);
      const command = commandForKey(flat, event, context, true);
      if (!command) return;
      if (!open.commands.includes(command) && !open.commands.some((item) => item.children?.includes(command))) return;
      event.preventDefault();
      event.stopPropagation();
      executeMenuCommand(command, () => projectRef.current.id === open.target.projectId && (open.target.kind === 'group' || projectRef.current.activeChapterId === open.target.chapterId), setNotice).then((ok) => { if (ok) setOpenMenu(null); });
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [editor]);

  useEffect(() => {
    if (openMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const node = event.target;
      if (node instanceof HTMLElement && (node.isContentEditable || node.closest('input,textarea,select,[role="dialog"]'))) return;
      const paragraphId = editor ? paragraphOfCaret() : null;
      const selection = editor?.state.selection;
      const hasTextSelection = !!selection && !selection.empty;
      const kind: MenuTarget['kind'] = hasTextSelection ? 'text' : paragraphId ? 'paragraph' : 'stage';
      const target: MenuTarget = { kind, projectId: projectRef.current.id, chapterId: projectRef.current.activeChapterId, paragraphId: paragraphId ?? undefined, groupId: groupIdOfParagraph(paragraphId ?? undefined) ?? undefined, cueId: selectedCueId ?? undefined };
      const context: MenuContext = { kind, projectId: target.projectId, chapterId: target.chapterId, doc: editor?.state.doc ?? null, focus: null };
      const facts = collectFacts(target, hasTextSelection, true);
      const commands = buildWorkspaceMenu(target, facts, menuActions(target), orderedGroups.map((group: any) => ({ id: group.id, name: group.name })));
      const flat = commands.flatMap((command) => [command, ...(command.children ?? [])]);
      const command = commandForKey(flat, event, context, false);
      if (!command || command.reason) return;
      event.preventDefault();
      command.run?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, selectedCueId, orderedGroups, chapter, document]);

  const groupDragOver = (event: React.DragEvent, groupId: string) => {
    if (event.dataTransfer.types.includes(PARAGRAPH_DRAG) || event.dataTransfer.types.includes(AUDIO_DRAG)) {
      event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes(AUDIO_DRAG) ? 'copy' : 'move'; setDropHint({ groupId, intent: event.dataTransfer.types.includes(AUDIO_DRAG) ? 'audio' : 'paragraph' });
    }
  };
  const onEditorDragOver = (event: React.DragEvent) => {
    if (cancelledDragRef.current) { stopEdgeAutoscroll(); return; }
    const isParagraph = event.dataTransfer?.types.includes(PARAGRAPH_DRAG) ?? false;
    const isAudio = event.dataTransfer?.types.includes(AUDIO_DRAG) ?? false;
    if (!isParagraph && !isAudio) return;
    const target = resolveParagraphDropTarget(event.target, event.clientY, isAudio ? 'audio' : 'paragraph');
    if (!target) { setDropHint(null); stopEdgeAutoscroll(); return; }
    dragActiveRef.current = true;
    event.preventDefault();
    event.dataTransfer.dropEffect = isAudio ? 'copy' : 'move';
    const hint = target.type === 'group' ? { groupId: target.groupId, intent: isAudio ? 'audio' as const : 'paragraph' as const } : { paragraphId: target.paragraphId, position: target.position };
    setDropHint((current) => current?.groupId === hint.groupId && current?.paragraphId === hint.paragraphId && current?.position === hint.position && current?.intent === hint.intent ? current : hint);
    updateEdgeAutoscroll(event.currentTarget as HTMLElement, event.clientY);
  };
  const onEditorDrop = (event: React.DragEvent) => {
    if (!event.dataTransfer?.types.includes(PARAGRAPH_DRAG) && !event.dataTransfer?.types.includes(AUDIO_DRAG)) return;
    stopEdgeAutoscroll();
    dragActiveRef.current = false;
    if (cancelledDragRef.current) { event.preventDefault(); event.stopPropagation(); return; }
    const isAudio = event.dataTransfer.types.includes(AUDIO_DRAG);
    const target = resolveParagraphDropTarget(event.target, event.clientY, isAudio ? 'audio' : 'paragraph');
    if (target?.type === 'group') return acceptGroupDrop(event, target.groupId);
    if (target?.type === 'paragraph') return acceptParagraphDrop(event, target);
    event.preventDefault(); event.stopPropagation(); setDropHint(null);
    setNotice(isAudio ? '请将音频拖到正文中的段落组标题。' : '请将段落拖到正文上半、下半或组标题。');
  };

  const onOutlineDragOver = (event: React.DragEvent) => {
    if (!event.dataTransfer?.types.includes('application/x-story-workbench-paragraphs')) return;
    event.preventDefault();
    const list = event.currentTarget as HTMLElement;
    const rect = list.getBoundingClientRect();
    const edge = Math.min(36, rect.height * 0.2);
    if (event.clientY < rect.top + edge) list.scrollTop -= 14;
    else if (event.clientY > rect.bottom - edge) list.scrollTop += 14;
  };

  const updateMusicOptions = (range: any, patch: { volume?: number; loop?: boolean }) => {
    updateActiveChapter((current) => {
      const ids = musicRangeParagraphIds(current, range);
      return setMusicRange(current, range.assetId, ids, { volume: patch.volume ?? range.volume, loop: patch.loop ?? range.loop });
    });
  };

  const updateMusicAsset = (range: any, assetId: string) => {
    if (!assetId) return;
    try {
      updateActiveChapter((current) => setMusicRange(current, assetId, musicRangeParagraphIds(current, range), { volume: range.volume, loop: range.loop }));
      setNotice('已替换这段背景音乐。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '无法替换背景音乐。'); }
  };

  const addImportedAudio = (asset: AssetRecord) => {
    if (asset.kind !== 'video') return;
    const sourceProjectId = projectRef.current.id;
    const controller = new AbortController();
    mediaAbortRef.current = controller;
    setMediaProgress(`正在提取“${asset.name}”音轨…`);
    void extractAudioFromVideo(asset.blob, { signal: controller.signal, name: asset.name,
      onProgress: (label) => setMediaProgress(label),
    }).then((file) => {
      const audio = recordsFromFiles([file])[0];
      appendAssets([audio], sourceProjectId);
      setFilter('all');
      setNewAssetIds([audio.id]);
      setImportReport([{ name: asset.name, status: 'success', detail: `已提取为“${audio.name}”，可以试听或关联到句子。` }]);
      setNotice(`音轨已提取并加入素材库：${audio.name}`);
    }).catch((error) => {
      if (controller.signal.aborted) {
        setMediaProgress('音轨提取已取消，工程未更改。');
        return;
      }
      const message = error instanceof Error ? error.message : '音轨提取失败。';
      setImportReport([{ name: asset.name, status: 'error', detail: message }]);
      setNotice(message);
    }).finally(() => { if (mediaAbortRef.current === controller) mediaAbortRef.current = null; window.setTimeout(() => setMediaProgress(''), 900); });
  };

  const pauseAutosave = async () => {
    autosaveSuppressed.current = true;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    await saveQueue.current;
  };

  /** 刷新顶部「切换工程」列表 */
  const refreshLibrary = async () => {
    try {
      const state = await window.storyWorkbench.library.list();
      setLibraryProjects(state.projects);
      return state;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '工程库读取失败。');
      return null;
    }
  };

  /** 停掉旧工程还在跑的东西：播放、媒体、在途的音轨提取 */
  const stopActiveWork = () => {
    playerRef.current?.stop();
    mediaSessionRef.current?.stop();
    musicSessionRef.current?.stop();
    mediaAbortRef.current?.abort();
    mediaAbortRef.current = null;
    cancelledDragRef.current = true;
    dragActiveRef.current = false;
    stopEdgeAutoscroll();
  };

  /**
   * 切换到工程库里的另一份工程。
   * 顺序：先给旧工程落盘 → 停掉旧工程的动作 → 读并校验目标 → 一次性换到目标。
   * 任何一步失败都留在原工程，并说明原因；快速连点时只有最后一次生效。
   */
  const switchToProject = async (targetKey: string, options: { message?: string } = {}) => {
    if (targetKey === libraryKeyRef.current) { libraryMenuRef.current?.removeAttribute('open'); return true; }
    const token = ++switchTokenRef.current;
    setProjectOperation(true);
    try {
      await saveNow();
      if (token !== switchTokenRef.current) return false;
      await pauseAutosave();
      /* 旧工程的播放、媒体和在途操作先停下来，别让它们跨到新工程去 */
      stopActiveWork();
      const loaded = await openLibraryProject(targetKey);
      if (token !== switchTokenRef.current) return false;
      libraryKeyRef.current = targetKey;
      setLibraryKey(targetKey);
      assetsRef.current = loaded.assets;
      projectRef.current = loaded.project;
      setProject(loaded.project);
      setAssets(loaded.assets);
      currentReviewTokenRef.current = null;
      reviewHistoryRef.current.clear();
      reviewChangeHistoryRef.current.clear();
      chapterCursorRef.current.clear();
      chapterScrollRef.current.clear();
      savedTextLengthRef.current = chapterTextCounts(loaded.project);
      savedSnapshotRef.current = { key: targetKey, project: loaded.project, assets: loaded.assets };
      updateSaveLabel('已切换 · ' + loaded.project.name);
      setEditorEpoch((value) => value + 1);
      setSelectedLayerId(null);
      setSelectedGroupId(null);
      setSelectedGroupIds([]);
      setSelectedParagraphs([]);
      setSelectedCueId(compileDocument(activeChapter(loaded.project).document)[0]?.id ?? null);
      setArticlePreview(null);
      setGroupMusicDialog(null);
      setPendingMusic(null);
      setImportReport([]);
      setNewAssetIds([]);
      setRestoreVersions(null);
      await window.storyWorkbench.library.setActive(targetKey).catch(() => {});
      setSaveTarget(await window.storyWorkbench.library.saveTarget(targetKey).catch(() => null));
      await refreshLibrary();
      libraryMenuRef.current?.removeAttribute('open');
      setNotice(options.message ?? `已切换到“${loaded.project.name}”。`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? `切换未完成，仍在原工程：${error.message}` : '切换未完成，仍在原工程。');
      return false;
    } finally {
      /* 只有最后一次切换负责收尾，避免把还在进行的那次的状态提前清掉 */
      if (token === switchTokenRef.current) {
        autosaveSuppressed.current = false;
        setProjectOperation(false);
      }
    }
  };

  const createNewProject = (trigger: HTMLElement) => openNameDialog(trigger, {
    title: '新建工程', fieldLabel: '工程名称', confirmLabel: '保存当前并新建', initialValue: '新剧情作品', normalize: normalizeProjectName,
    description: '先保存当前工程，再新建一个空白工程。新工程会留在本地工程库里，下次打开还能找到。',
    onConfirm: (name) => {
      const next = renameProject(createBlankProject(), name);
      void (async () => {
        try {
          await saveNow();
          await pauseAutosave();
          /* 新工程立刻落盘成独立条目，不需要先另存 ZIP */
          const entry = await window.storyWorkbench.library.create(await packBytes(next, []), { name: next.name, projectId: next.id });
          await refreshLibrary();
          const ok = await switchToProject(entry.key, { message: `已新建工程“${next.name}”，它留在本地工程库里。` });
          if (!ok) setNotice('新建未完成，仍在原工程。');
        } catch (error) {
          setNotice(error instanceof Error ? '新建未完成：' + error.message : '新建未完成。');
        } finally {
          autosaveSuppressed.current = false;
          setProjectOperation(false);
        }
      })();
      return undefined;
    },
  });
  const renameCurrentProject = (trigger: HTMLElement) => openNameDialog(trigger, {
    title: '重命名工程', fieldLabel: '工程名称', confirmLabel: '保存名称', initialValue: projectRef.current.name, normalize: normalizeProjectName,
    onConfirm: (name) => {
      void (async () => {
        try {
          /* 只改工程库里的名字；磁盘目录名不变 */
          const entry = await window.storyWorkbench.library.rename(libraryKeyRef.current, name);
          commitProject(renameProject(projectRef.current, name));
          await refreshLibrary();
          setNotice(`工程已改名为“${entry.name}”。`);
        } catch (error) { setNotice(error instanceof Error ? error.message : '重命名未完成。'); }
      })();
      return undefined;
    },
  });
  const deleteCurrentChapter = () => {
    const current = projectRef.current;
    if (current.chapters.length <= 1) return setNotice('工程至少保留一个章节。');
    const chapterId = current.activeChapterId;
    const target = activeChapter(current);
    setConfirmation({ title: '删除当前章节？', detail: '将删除“' + target.name + '”的 ' + target.document.blocks.length + ' 段正文、' + target.groups.length + ' 个组和 ' + target.musicRanges.length + ' 段配乐设置。素材保留；需要时可从恢复历史找回。', action: () => {
      playerRef.current.stop();
      commitProject(removeChapter(projectRef.current, chapterId));
      setSelectedCueId(null);
      setSelectedGroupId(null);
      setSelectedGroupIds([]);
      setSelectedParagraphs([]);
    } });
  };

  /** 导入工程包：先校验，再判断是否与库里已有工程重复 */
  const importProject = async () => {
    try {
      const selected = await window.storyWorkbench.importProject();
      if (!selected) return;
      const incoming = await readPack(selected.bytes, selected.name);
      const conflict = libraryProjects.find((entry) => entry.projectId && entry.projectId === incoming.project.id) ?? null;
      if (conflict) {
        setImportCandidate({ name: selected.name, bytes: selected.bytes, project: incoming.project, assets: incoming.assets, existing: conflict });
        return;
      }
      const entry = await window.storyWorkbench.library.create(selected.bytes, { name: incoming.project.name, projectId: incoming.project.id });
      await refreshLibrary();
      await switchToProject(entry.key, { message: `已导入“${selected.name}”，现在是独立工程。` });
    } catch (error) {
      setNotice(error instanceof Error ? `导入失败，当前工程保持不变：${error.message}` : '导入失败，当前工程保持不变。');
    }
  };

  /** 导入冲突的四种处理：打开已有 / 导入副本 / 替换已有 / 取消 */
  const resolveImportConflict = async (choice: 'open' | 'copy' | 'replace' | 'cancel') => {
    const candidate = importCandidate;
    setImportCandidate(null);
    if (!candidate || choice === 'cancel') return;
    try {
      if (choice === 'open') {
        await switchToProject(candidate.existing.key, { message: `已打开库里已有的“${candidate.existing.name}”。` });
        return;
      }
      if (choice === 'copy') {
        /* 副本换一个新的作品 ID，避免与原工程互相覆盖 */
        const copy = { ...candidate.project, id: makeId('project'), name: `${candidate.project.name} 副本`, updatedAt: new Date().toISOString() };
        const bytes = await packBytes(copy, candidate.assets);
        const entry = await window.storyWorkbench.library.create(bytes, { name: copy.name, projectId: copy.id });
        await refreshLibrary();
        await switchToProject(entry.key, { message: `已导入为副本“${copy.name}”。` });
        return;
      }
      /* 替换：旧内容会先存成这一份工程自己的保护快照 */
      await window.storyWorkbench.library.importCommit(candidate.existing.key, candidate.bytes, { name: candidate.project.name, projectId: candidate.project.id });
      await refreshLibrary();
      await switchToProject(candidate.existing.key, { message: `已用“${candidate.name}”替换“${candidate.existing.name}”，替换前的内容留在了它的恢复历史里。` });
    } catch (error) {
      setNotice(error instanceof Error ? `导入未完成，当前工程保持不变：${error.message}` : '导入未完成，当前工程保持不变。');
    }
  };

  const restoreProject = async () => {
    try { setRestoreVersions(await window.storyWorkbench.library.historyList(libraryKeyRef.current)); }
    catch (error) { setNotice(error instanceof Error ? error.message : '恢复历史读取失败。'); }
  };
  const restoreVersion = async (version: RestoreVersion) => {
    try {
      const key = libraryKeyRef.current;
      const bytes = await window.storyWorkbench.library.historyLoad(key, version.id);
      if (!bytes) return setNotice('此历史版本已不存在，请刷新恢复历史。');
      const restored = await readPack(bytes, '历史恢复点');
      setProjectOperation(true);
      await pauseAutosave();
      await window.storyWorkbench.library.save(key, await packBytes(projectRef.current, assetsRef.current), { protectCurrent: true });
      await window.storyWorkbench.library.restoreApply(key, bytes);
      playerRef.current.stop();
      projectRef.current = restored.project;
      assetsRef.current = restored.assets;
      setProject(restored.project);
      setAssets(restored.assets);
      currentReviewTokenRef.current = null;
      setEditorEpoch((current) => current + 1);
      setSelectedLayerId(null);
      setSelectedCueId(compileDocument(activeChapter(restored.project).document)[0]?.id ?? null);
      savedTextLengthRef.current = chapterTextCounts(restored.project);
      savedSnapshotRef.current = { key, project: restored.project, assets: restored.assets };
      updateSaveLabel('已保存 · 恢复版本');
      setRestoreVersions(null);
      setNotice('已恢复所选历史版本；恢复前的工程也已保留为历史。');
    } catch (error) {
      setNotice(error instanceof Error ? `恢复失败：${error.message}` : '恢复失败。');
    } finally {
      autosaveSuppressed.current = false;
      setProjectOperation(false);
    }
  };

  const exportProject = async () => {
    try {
      const bytes = await packBytes(projectRef.current, assetsRef.current);
      const target = await window.storyWorkbench.exportProject(bytes);
      if (target) setNotice(`工程包已导出：${target}`);
    } catch (error) {
      setNotice(error instanceof Error ? `导出失败：${error.message}` : '导出失败。');
    }
  };

  const openAiReviewExport = () => setAiReviewState({ mode: 'export', scopeType: selectedGroupIds.length ? 'groups' : 'chapter', includeMedia: false, goal: '' });

  // 便读的作品说明：与审阅包共用同一份快照，不从界面 DOM 再抄一次正文。
  // 独立 .md 不附媒体，所以明确传 false，文档里会写清"未附带媒体"。
  const exportWorkDescription = async () => {
    setAiReviewBusy(true);
    try {
      const current = projectRef.current;
      const scope = selectedGroupIds.length ? { type: 'groups', chapterId: current.activeChapterId, groupIds: [...selectedGroupIds] } : { type: 'chapter', chapterId: current.activeChapterId };
      const snapshot = createReviewSnapshot(current, scope);
      const baseHash = await reviewHash(snapshot);
      const text = createWorkDescription(snapshot, baseHash, '', new Set(), false);
      const filePath = await window.storyWorkbench.exportDocument({ suggestedName: `${current.name}-作品说明`, text });
      if (!filePath) return;
      setNotice(`作品说明已导出：${filePath}。可直接拖进任意 AI 聊天使用。`);
    } catch (error) {
      setNotice(error instanceof Error ? `作品说明导出失败：${error.message}` : '作品说明导出失败。');
    } finally { setAiReviewBusy(false); }
  };

  const exportAiReview = async (options: { scopeType: 'project' | 'chapter' | 'groups'; includeMedia: boolean; goal: string }) => {
    setAiReviewBusy(true);
    try {
      const current = projectRef.current;
      const scope = options.scopeType === 'project' ? { type: 'project' } : options.scopeType === 'chapter' ? { type: 'chapter', chapterId: current.activeChapterId } : { type: 'groups', chapterId: current.activeChapterId, groupIds: [...selectedGroupIds] };
      const snapshot = createReviewSnapshot(current, scope);
      const baseHash = await reviewHash(snapshot);
      const { bytes, files } = await createReviewArchive(JSZip, snapshot, baseHash, options.goal, assetsRef.current, options.includeMedia);
      const filePath = await window.storyWorkbench.exportReviewPack(bytes);
      if (!filePath) {
        setAiReviewState(null);
        return;
      }
      setAiReviewState({ mode: 'prompt', filePath, prompt: files['改进提示词.md'] });
      setNotice(`AI 审阅包已导出：${filePath}`);
    } catch (error) {
      setNotice(error instanceof Error ? `AI 审阅包导出失败：${error.message}` : 'AI 审阅包导出失败。');
    } finally { setAiReviewBusy(false); }
  };

  const importAiReview = async () => {
    try {
      const selected = await window.storyWorkbench.importAiChanges();
      if (!selected) return;
      const proposal = await validateReviewChanges(projectRef.current, selected.text, projectRef.current.assets);
      setAiReviewState({ mode: 'import', fileName: selected.name, rawText: selected.text, proposal, checked: proposal.changes.map(() => true) });
      setNotice(proposal.changes.length ? `已校验 ${proposal.changes.length} 条建议；请选择要应用的项目。` : '建议文件通过基线校验，但没有可应用的变更。');
    } catch (error) {
      setNotice(error instanceof Error ? `导入建议失败，工程未更改：${error.message}` : '导入建议失败，工程未更改。');
    }
  };

  const applyAiReview = async (selectedIndexes: number[]) => {
    if (!editor || aiReviewState?.mode !== 'import' || !selectedIndexes.length) return;
    setAiReviewBusy(true);
    try {
      const current = projectRef.current;
      const verified = await validateReviewChanges(current, aiReviewState.rawText, current.assets);
      const selectedChanges = verified.changes.filter((_change: any, index: number) => selectedIndexes.includes(index));
      if (!selectedChanges.length) throw new Error('请至少勾选一条建议。');
      const proposal = { ...verified, changes: selectedChanges };
      const next = applyReviewChanges(current, proposal);
      const nextChapter = activeChapter(next);
      const historyToken = makeId('ai-review');
      reviewChangeHistoryRef.current.set(historyToken, { proposal, chapterId: current.activeChapterId });
      playerRef.current?.stop();
      mediaSessionRef.current?.stop();
      musicSessionRef.current?.stop();
      replaceEditorDocument(editor, nextChapter.document, nextChapter.groups, nextChapter.musicRanges, historyToken, current.activeChapterId);
      commitProject(next);
      setAiReviewState(null);
      setNotice(`已应用 ${selectedChanges.length} 条 AI 建议。可用 Ctrl+Z 一次撤销整批修改。`);
    } catch (error) {
      setNotice(error instanceof Error ? `应用失败，工程未更改：${error.message}` : '应用失败，工程未更改。');
    } finally { setAiReviewBusy(false); }
  };

  const startPlayback = (mode: string | null) => {
    const index = playbackStartIndex(currentPlan, selectedCueId, mode);
    setPlaySessionRevision((current) => current + 1);
    playerRef.current.playFrom(index, mode);
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dragActiveRef.current) {
        cancelledDragRef.current = true;
        dragActiveRef.current = false;
        stopEdgeAutoscroll();
        setDropHint(null);
        return;
      }
      if (!shouldHandlePlaybackSpace(event) || nameDialog || restoreVersions || pendingMusic || aiReviewState || articlePreview || confirmation || groupMusicDialog || projectOperation) return;
      event.preventDefault();
      const status = playerRef.current.snapshot?.().status ?? playerState.status;
      if (status === 'playing') playerRef.current.pause();
      else if (status === 'paused') playerRef.current.resume();
      else startPlayback(null);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [playerState.status, selectedCueId, chapter.id, nameDialog, restoreVersions, pendingMusic, aiReviewState, articlePreview, confirmation, groupMusicDialog, projectOperation]);

  const stageBackground = backgroundAsset ? {
    backgroundImage: `linear-gradient(90deg,rgba(14,18,17,.30),rgba(14,18,17,.08)),url("${objectUrl(backgroundAsset)}")`,
  } : {};
  /** 点完顶部「工程」菜单里的动作后收起菜单，避免挡住工作区 */
  const closeToolbarMenu = (event: React.MouseEvent<HTMLElement>) => {
    (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
  };
  /** 组目录右键：目标是被右键的那个组，不是某一段 */
  const openGroupMenu = (event: React.MouseEvent, groupId: string) => {
    event.preventDefault();
    event.stopPropagation();
    openWorkspaceMenu({ kind: 'group', projectId: project.id, chapterId: chapter.id, groupId }, event, event.currentTarget);
  };
  /** 左侧目录：章节 → 组。顺序按作品里的实际组顺序推导，不另存一份目录顺序。 */
  const outlineTree = useMemo<Array<{ chapter: any; groups: any[]; ungroupedCount: number; ungroupedFirstId: string | null }>>(() => project.chapters.map((source: any) => {
    const positions = new Map<string, number>(source.document.blocks.map((block: any, index: number) => [String(block.id), index] as const));
    const groups = [...source.groups].sort((a: any, b: any) => (positions.get(a.paragraphIds[0]) ?? -1) - (positions.get(b.paragraphIds[0]) ?? -1));
    const grouped = new Set(groups.flatMap((group: any) => group.paragraphIds));
    const ungrouped = source.document.blocks.filter((block: any) => !grouped.has(block.id));
    return {
      chapter: source,
      groups: groups.map((group: any) => {
        const range = musicRangeAt(source, group.paragraphIds[0]);
        return { ...group, count: group.paragraphIds.length, audioName: assets.find((asset) => asset.id === range?.assetId)?.name ?? null };
      }),
      ungroupedCount: ungrouped.length,
      ungroupedFirstId: ungrouped[0]?.id ?? null,
    };
  }), [project, assets]);
  /** 当前所在组：跟随选中的那一句，不另存一份状态 */
  const currentGroupId = selectedCue
    ? (chapter.groups.find((group: any) => group.paragraphIds.includes(selectedCue.paragraphId))?.id ?? null)
    : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">剧</span><div><strong>剧情创作工作台</strong><small>STORY WORKBENCH</small></div></div>
        <select className="chapter-button" aria-label="当前章节" value={project.activeChapterId} onChange={(event) => switchChapter(event.target.value)}>{project.chapters.map((item: any) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <button className="button quiet" title="重命名当前章节" onClick={(event) => renameActiveChapter(event.currentTarget)}>改名</button>
        <button className="button quiet" title="删除当前章节" disabled={project.chapters.length <= 1} onClick={deleteCurrentChapter}>删除章</button>
        <button className="button quiet" title="新建章节" onClick={(event) => createNewChapter(event.currentTarget)}>＋章节</button>
        <button className="button quiet" title={chapterIndex <= 0 ? '已是第一章' : '章节上移'} aria-label={chapterIndex <= 0 ? '章节上移（已是第一章）' : '章节上移'} disabled={chapterIndex <= 0} onClick={() => commitProject(reorderChapter(projectRef.current, chapter.id, -1))}>↑</button>
        <button className="button quiet" title={chapterIndex >= project.chapters.length - 1 ? '已是最后一章' : '章节下移'} aria-label={chapterIndex >= project.chapters.length - 1 ? '章节下移（已是最后一章）' : '章节下移'} disabled={chapterIndex >= project.chapters.length - 1} onClick={() => commitProject(reorderChapter(projectRef.current, chapter.id, 1))}>↓</button>
        <div className={`save-state ${saveLabel.includes('失败') ? 'error' : ''}`} title={saveTarget ?? '本机自动保存工程'}><i />{saveLabel}</div>
        <div className="top-actions">
          <button className="button quiet" onClick={() => void saveNow().catch(() => {})}>保存</button>
          <button className="button quiet" onClick={() => void saveNow(true).catch(() => {})}>另存为</button>
          <button className="button quiet" disabled={!editor?.can().undo()} onClick={() => editor?.chain().focus().undo().run()}>撤销</button>
          <button className="button quiet" disabled={!editor?.can().redo()} onClick={() => editor?.chain().focus().redo().run()}>重做</button>
          <button className="button quiet" onClick={() => startPlayback(null)}>从当前句预览</button>
          <button className="button primary" onClick={() => startPlayback('auto')}>播放本章 <small>自动</small></button>
          <details className="toolbar-menu" ref={libraryMenuRef}>
            <summary>切换工程</summary>
            <div className="toolbar-menu-panel library-panel">
              <p className="library-hint">本地工程库 · 共 {libraryProjects.length} 份。新建过的工程都会留在这里，关闭重开也能找到。</p>
              {libraryProjects.map((entry) => (
                <button key={entry.key} className={entry.key === libraryKey ? 'current' : ''} disabled={projectOperation} onClick={(event) => { closeToolbarMenu(event); void switchToProject(entry.key); }}>
                  <span>{entry.name}{entry.key === libraryKey ? <b>当前</b> : null}</span>
                  <small>{formatLibraryTime(entry.updatedAt)}</small>
                </button>
              ))}
              {!libraryProjects.length && <p className="library-hint">工程库还是空的。</p>}
              <hr />
              <button disabled={projectOperation} onClick={(event) => { closeToolbarMenu(event); void importProject(); }}>导入工程包<small>加入工程库</small></button>
              <button disabled={projectOperation} onClick={(event) => { closeToolbarMenu(event); createNewProject(event.currentTarget); }}>新建工程<small>加入工程库</small></button>
            </div>
          </details>
          <details className="toolbar-menu">
            <summary>工程</summary>
            <div className="toolbar-menu-panel">
              <button onClick={(event) => { closeToolbarMenu(event); void exportProject(); }}>导出工程包<small>ZIP + 素材</small></button>
              <button onClick={(event) => { closeToolbarMenu(event); void importProject(); }}>导入工程<small>打开已有工程包</small></button>
              <hr />
              <button disabled={aiReviewBusy} onClick={(event) => { closeToolbarMenu(event); void exportWorkDescription(); }}>导出作品说明<small>单份 Markdown，AI 可读</small></button>
              <button disabled={aiReviewBusy} onClick={(event) => { closeToolbarMenu(event); openAiReviewExport(); }}>导出完整审阅包<small>ZIP + 提示词，可选媒体</small></button>
              <button disabled={aiReviewBusy} onClick={(event) => { closeToolbarMenu(event); void importAiReview(); }}>导入改进建议<small>按差异应用</small></button>
            </div>
          </details>
          <button className="theme-toggle" title="蓝黑适合长时间创作与看画面，蓝白适合读长文" onClick={onToggleTheme}>配色<b>{theme === 'ink' ? '蓝黑' : '蓝白'}</b></button>
        </div>
      </header>

      <main className="workspace">
        <aside className="asset-panel">
          <div className="asset-project"><span className="eyebrow">B · 工程</span><strong>{project.name}</strong><small>{chapter.name} · 本机工程</small><div className="asset-actions"><button onClick={(event) => createNewProject(event.currentTarget)}>新建工程</button><button onClick={(event) => renameCurrentProject(event.currentTarget)}>重命名</button></div></div>
          <div className="panel-switch"><button className={panelMode === 'outline' ? 'active' : ''} onClick={() => setPanelMode('outline')}>剧情目录</button><button className={panelMode === 'assets' ? 'active' : ''} onClick={() => setPanelMode('assets')}>素材库</button></div>
          {panelMode === 'assets' ? <>
            <div className="asset-heading"><div><strong>素材库</strong><small>只显示当前工程中的文件</small></div><button className="button primary small" onClick={onImportAssets}>导入素材</button></div>
            <nav className="asset-categories" aria-label="素材分类">
              {[['all', '全部素材', '◈'], ['image', '图片', '▧'], ['audio', '音频', '♫'], ['video', '视频', '▶'], ['article', '文章', '文'], ['other', '其他', '··']].map(([key, label, icon]) => (
                <button key={key} className={`asset-category ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}><span className="category-icon">{icon}</span><span>{label}</span><i>{key === 'all' ? assets.length : assets.filter((asset) => asset.kind === key).length}</i></button>
              ))}
            </nav>
            {importReport.length > 0 && <details className="import-report" open><summary>最近导入 · {importReport.filter((item) => item.status === 'success').length} 成功 / {importReport.filter((item) => item.status === 'error').length} 失败</summary>{importReport.map((item, index) => <div key={`${item.name}-${index}`} className={item.status}><strong>{item.name}</strong><span>{item.detail}</span></div>)}</details>}
            <div className="asset-list" onContextMenu={(event) => { if (event.target instanceof Element && event.target.closest('.asset-card')) return; openWorkspaceMenu({ kind: 'assets', projectId: project.id, chapterId: chapter.id }, event, event.currentTarget); }}>
              {visibleAssets.length ? visibleAssets.map((asset) => <AssetCard key={asset.id} asset={asset} projectId={project.id} recent={newAssetIds.includes(asset.id)} onBackground={() => setBackground(asset.id)} onAudio={() => setAudio(asset.id)} onLayer={() => addSceneLayer(asset)} onAppendArticle={() => previewArticle(asset)} onDelete={() => deleteAsset(asset)} onExtractAudio={() => addImportedAudio(asset)} onNotice={setNotice} onBeginAudioDrag={beginAudioDrag} onEndAudioDrag={endAudioDrag} onContextMenu={(event) => openWorkspaceMenu({ kind: 'asset', projectId: project.id, chapterId: chapter.id, assetId: asset.id }, event, event.currentTarget)} />) : (
                <div className="asset-empty"><span className="empty-symbol">＋</span><strong>当前分类还没有素材</strong><p>导入后，可设为背景、添加本句音效或加入图片/视频图层。</p><button className="button primary" onClick={onImportAssets}>导入素材</button></div>
              )}
            </div>
            <div className="asset-foot">素材只属于当前工程<br />工程包会连同素材一起保存。</div>
          </> : <>
            <div className="outline-heading"><strong>剧情目录</strong><span>{project.chapters.length} 章 · {outlineTree.reduce((sum: number, item) => sum + item.groups.length, 0)} 组</span></div>
            <div className="outline-tools"><small>按章节和段落组定位。点组跳到正文组头；逐句演出顺序在右侧 E 区。</small><select aria-label="为所选组或段落设置背景音乐" value="" onChange={(event) => setMusicForSelection(event.target.value)}><option value="">设背景音乐…</option>{assets.filter((asset) => asset.kind === 'audio').map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></div>
            <div className="outline-list" onDragOver={onOutlineDragOver} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropHint(null); }}>
              {outlineTree.map((item) => (
                <section className="outline-chapter" key={item.chapter.id}>
                  <button className={`outline-chapter-head ${item.chapter.id === project.activeChapterId ? 'active' : ''}`} onClick={() => switchChapter(item.chapter.id)} title={`切到${item.chapter.name}`}>
                    <span>{item.chapter.name}</span>
                    <small>{item.chapter.document.blocks.length} 段 · {item.groups.length} 组</small>
                  </button>
                  <div className="outline-chapter-groups">
                    {item.groups.map((group: any, index: number) => (
                      <div className={`outline-group-row ${currentGroupId === group.id ? 'active' : ''} ${locatedGroupId === group.id ? 'located' : ''} ${dropHint?.groupId === group.id ? 'drop-target' : ''}`} key={group.id}
                        onDragOver={(event) => groupDragOver(event, group.id)}
                        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropHint(null); }}
                        onDrop={(event) => acceptGroupDrop(event, group.id)}>
                        <button className="outline-group-main" onClick={() => locateGroup(item.chapter.id, group.id)} onContextMenu={(event) => openGroupMenu(event, group.id)} title={`定位到“${group.name}”的组头`}>
                          <i>第 {index + 1} 组</i>
                          <span>{group.name}</span>
                          <small>{group.count} 段{group.collapsed ? ' · 已折叠' : ''}{group.audioName ? ` · ♫ ${group.audioName}` : ''}</small>
                        </button>
                        <div className="outline-group-actions">
                          <button title={group.collapsed ? '展开此组' : '折叠此组'} aria-label={`${group.collapsed ? '展开' : '折叠'}${group.name}`} onClick={() => toggleGroupCollapsedInChapter(item.chapter.id, group.id)}>{group.collapsed ? '▸' : '▾'}</button>
                          <button title="重命名" onClick={(event) => renameGroupInChapter(item.chapter.id, group.id, group.name, event.currentTarget)}>改</button>
                          <button title="上移段落组" aria-label={`${group.name}上移`} onClick={() => moveGroupInChapter(item.chapter.id, group.id, -1)}>↑</button>
                          <button title="下移段落组" aria-label={`${group.name}下移`} onClick={() => moveGroupInChapter(item.chapter.id, group.id, 1)}>↓</button>
                          <button title="取消分组，保留正文" onClick={() => removeGroupInChapter(item.chapter.id, group.id)}>×</button>
                        </div>
                      </div>
                    ))}
                    {item.ungroupedCount > 0 && <button className="outline-group-row ungrouped" onClick={() => locateParagraph(item.chapter.id, item.ungroupedFirstId)}>未分组（{item.ungroupedCount} 段）</button>}
                    {!item.groups.length && !item.ungroupedCount && <p className="outline-empty">这一章还没有段落。</p>}
                  </div>
                </section>
              ))}
              {!project.chapters.length && <p className="outline-empty">还没有章节，先在顶部新建一个。</p>}
            </div>
            <div className="music-range-list"><strong>背景音乐范围</strong>{chapter.musicRanges.length ? chapter.musicRanges.map((range: any) => { const memberIds = musicRangeParagraphIds(chapter, range); const start = document.blocks.findIndex((block: any) => block.id === memberIds[0]); const end = document.blocks.findIndex((block: any) => block.id === memberIds.at(-1)); const rangeLabel = range.groupIds?.length ? range.groupIds.map((id: string) => chapter.groups.find((group: any) => group.id === id)?.name).filter(Boolean).join('、') + ' 组' : `${start + 1}–${end + 1} 段`; return <div className="music-range-item" key={range.id}><span>{assets.find((asset) => asset.id === range.assetId)?.name ?? '缺失音频'} · {rangeLabel}</span><select aria-label="替换这段背景音乐" value="" onChange={(event) => updateMusicAsset(range, event.target.value)}><option value="">替换…</option>{assets.filter((asset) => asset.kind === 'audio').map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select><label>音量 <input type="range" min="0" max="100" value={Math.round(range.volume * 100)} onChange={(event) => updateMusicOptions(range, { volume: Number(event.target.value) / 100 })} /></label><label><input type="checkbox" checked={range.loop} onChange={(event) => updateMusicOptions(range, { loop: event.target.checked })} />循环</label><button title="移除范围" onClick={() => updateActiveChapter((current) => removeMusicRange(current, range.id))}>移除</button></div>; }) : <small>选择连续段落或段落组后，可在上方设置音乐。</small>}</div>
          </>}
        </aside>

        <section className="writing-panel">
          <div className="section-title"><div><span className="eyebrow">C · 写剧情</span><p>连续输入剧情，选中一句再设置效果。</p></div><div className="writing-count"><span className="count-pill">{document.blocks.length} 段剧情</span><span className="current-group" title={groupSummary}>{groupSummary}</span></div></div>
          <div className="editor-toolbar">
            <span className="tool selected" aria-label="当前写作模式">连续写作</span>
            <button className="tool" onMouseDown={(event) => event.preventDefault()} onClick={() => setMode('dialogue')}>设为对话框</button>
            <button className="tool" onMouseDown={(event) => event.preventDefault()} onClick={() => setMode('free')}>设为自由演出</button>
            <label className="color-tool" title="将颜色应用于选中文字"><input type="color" value={selectedCue?.settings.color ?? '#ef7565'} onChange={(event) => setColor(event.target.value)} /><span>设置文字颜色</span></label>
          </div>
          <div className="paragraph-selection-toolbar">
            {hasGroupingSelection ? <>
              <span>已选 {selectedParagraphs.length} 段{selectedGroupIds.length ? ` · ${selectedGroupIds.length} 个组` : ''}</span>
              <button className="primary" title={!selectedParagraphs.length ? '先勾选一段或多段正文' : '创建段落组并归入选中内容'} disabled={!selectedParagraphs.length} onClick={(event) => createGroupFromSelection(event.currentTarget)}>归入新组</button>
              <select aria-label="移入已有组" title={!selectedParagraphs.length ? '先勾选一段或多段正文' : undefined} value="" disabled={!selectedParagraphs.length || !orderedGroups.length} onChange={(event) => moveSelectionToGroup(event.target.value)}><option value="">移入已有组…</option>{orderedGroups.map((group: any, index: number) => <option key={group.id} value={group.id}>第 {index + 1} 组 · {group.name}</option>)}</select>
              <button onClick={() => { setSelectedParagraphs([]); setSelectedGroupIds([]); setSelectedGroupId(null); paragraphAnchorRef.current = null; }}>清除选择</button>
            </> : <>
              <span className="idle-hint">勾选正文段落左侧的方框，就能把多段归成一组；也可以先建一个空组再往里写。</span>
              <button onClick={(event) => createEmptyGroup(event.currentTarget)}>＋新建空组</button>
            </>}
          </div>
          <div className="editor-scroll" ref={editorScrollRef} onContextMenu={onEditorContextMenu} onDragStartCapture={(event) => beginParagraphDrag(event)} onDragEnd={() => { cancelledDragRef.current = false; dragActiveRef.current = false; stopEdgeAutoscroll(); setDropHint(null); }} onDragOver={onEditorDragOver} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) { dragActiveRef.current = false; stopEdgeAutoscroll(); setDropHint(null); } }} onDropCapture={onEditorDrop}><EditorContent editor={editor} /></div>
          <div className="editor-foot"><span>Enter 换段 · 选中一句设置效果 · Ctrl+Z 撤销</span><span>{document.blocks.length} 个正文段落</span></div>
        </section>

        <section className="stage-panel">
          <div className="stage-heading"><div><span className="eyebrow">D · 舞台预览</span><strong>{previewCue ? `${previewCue.settings.mode === 'dialogue' ? '对话框' : '自由文字'} · ${previewCue.text.slice(0, 28)}` : '选择正文中的一句'}</strong></div><span className="stage-hint">{playerState.status === 'playing' ? '播放中' : playerState.status === 'paused' ? '已暂停' : previewCue?.settings.mode === 'free' ? '可拖动舞台文字调整位置' : '选中正文即可预览'}</span></div>
          <div className={`stage-frame ${playerState.status !== 'stopped' ? 'is-playing' : ''}`}>
            <div className="stage-canvas" style={stageBackground} onContextMenu={(event) => { if (event.target instanceof Element && event.target.closest('.scene-layer-handle')) return; openWorkspaceMenu({ kind: 'stage', projectId: project.id, chapterId: chapter.id, cueId: previewCue?.id }, event, event.currentTarget); }} onClick={() => playerState.status === 'playing' && playerRef.current.advance()}>
              {displayLayers.filter((layer: any) => !layer.hidden).slice().sort((a: any, b: any) => a.zIndex - b.zIndex).map((layer: any) => {
                const media = assets.find((asset) => asset.id === layer.assetId);
                if (!media) return null;
                return <StageImageLayer key={layer.id} layer={layer} asset={media} selected={selectedLayerId === layer.id} editable={playerState.status === 'stopped'} status={playerState.status} cueId={previewCue?.id} playSessionRevision={playSessionRevision} seekRevision={seekRevision} elapsedMs={playbackClockRef.current.snapshot.elapsedMs} onNotice={setNotice} onSelect={() => setSelectedLayerId(layer.id)} onCommit={(patch) => updateLayer(patch, layer.id)} onContextMenu={(event) => openWorkspaceMenu({ kind: 'layer', projectId: project.id, chapterId: chapter.id, layerId: layer.id, cueId: previewCue?.id }, event, event.currentTarget)} />;
              })}
              {previewCue && <ClockedStageCue key={previewCue.id} cue={previewCue} clock={playbackClockRef.current} seekRevision={seekRevision} playSessionRevision={playSessionRevision} onAdvance={() => playerRef.current.advance()} onMove={(position) => patchCue(position)} />}
              {!backgroundAsset && !displayLayers.some((layer: any) => !layer.hidden) && <div className="stage-placeholder"><span>16:9</span><strong>舞台画面</strong><small>为当前句选择背景或添加图片图层</small></div>}
              {previewCue && <span className="stage-counter">{playerState.status === 'stopped' ? `编辑预览 · ${String(cueIndex + 1).padStart(2, '0')} / ${String(currentPlan.length).padStart(2, '0')}` : `${playerState.status === 'paused' ? '已暂停' : '演出中'} · ${String(playerState.index + 1).padStart(2, '0')} / ${String(currentPlan.length).padStart(2, '0')}`}</span>}
            </div>
          </div>

          <div className="transport-bar">
            <div className="transport-buttons">
              <button className="transport-play" title={playerState.status === 'playing' ? '暂停' : playerState.status === 'paused' ? '继续' : '播放当前句'} onClick={() => playerState.status === 'playing' ? playerRef.current.pause() : playerState.status === 'paused' ? playerRef.current.resume() : startPlayback(null)}>{playerState.status === 'playing' ? 'Ⅱ' : '▶'}</button>
              <button className="transport-stop" title="停止并重置" onClick={() => playerRef.current.stop()}>■</button>
              <button className="transport-replay" title="从当前句重播" onClick={() => startPlayback(null)}>重播</button>
            </div>
            <PlaybackProgress clock={playbackClockRef.current} onSeek={(fraction) => { playerRef.current.seek(fraction); setSeekRevision((value) => value + 1); }} />
          </div>

          <div className={`bottom-panels ${sequenceCollapsed ? 'sequence-collapsed' : ''}`}>
            <section className={`sequence-panel ${sequenceCollapsed ? 'is-collapsed' : ''}`}>
              <div className="panel-title"><strong>{sequenceCollapsed ? 'E' : 'E · 演出顺序'}</strong>{!sequenceCollapsed && <span>{currentPlan.length} 句</span>}<button title={sequenceCollapsed ? '展开演出列表' : '收起演出列表，把空间让给右侧设置'} onClick={() => setSequenceCollapsed((value) => !value)}>{sequenceCollapsed ? '展开' : '收起'}</button></div>
              {!sequenceCollapsed && <>
              <div className="sequence-list">
                {currentPlan.map((cue: any, index: number) => <button key={cue.id} className={`sequence-row ${cue.id === selectedCueId ? 'active' : ''}`} onClick={() => selectCue(cue.id)}><i>{String(index + 1).padStart(2, '0')}</i><span>{cue.text || '（空段落）'}</span><b>{cue.settings.mode === 'dialogue' ? '对白' : '自由'}</b></button>)}
                {!currentPlan.length && <p className="empty-sequence">写下正文后，演出顺序会出现在这里。</p>}
              </div>
              <div className="sequence-footer"><span>{previewCue?.settings.advance === 'timed' ? '自动推进' : '等待点击继续'}</span><button onClick={() => startPlayback('auto')}>本章自动播放</button></div>
              </>}
            </section>

            <section className="settings-panel">
              <div className="panel-title"><strong>F · 当前句设置</strong><span>{selectedCue ? `第 ${String(selectedCueIndex + 1).padStart(2, '0')} 句` : '未选择'}</span></div>
              <div className="settings-scroll">
                {!selectedCue ? <p className="settings-empty">选中正文中的一句后，可以设置演出、画面和声音。</p> : <>
                  <div className="scope-line">
                    <b>第 {String(selectedCueIndex + 1).padStart(2, '0')} 句</b>
                    <span>{selectedCue.settings.mode === 'dialogue' ? '对话框' : '自由文字'}</span>
                    <span className="scope-muted">{cueGroup ? `第 ${cueGroupIndex + 1} 组 · ${cueGroup.name}` : '未分组'}</span>
                    <span className="scope-muted">下面只改这一句</span>
                  </div>
                  <div className="mode-switch"><button className={selectedCue.settings.mode === 'dialogue' ? 'active' : ''} onClick={() => setMode('dialogue')}>对白</button><button className={selectedCue.settings.mode === 'free' ? 'active' : ''} onClick={() => setMode('free')}>自由演出</button></div>
                  <section className="settings-section">
                    <h4>文字</h4>
                    <div className="setting-grid">
                      <label>说话人<input value={selectedCue.settings.speaker} onChange={(event) => patchCue({ speaker: event.target.value })} placeholder="例如：应子汐" /></label>
                      <label>字号（px）<NumericField min="8" max="256" value={selectedCue.settings.fontSize} onCommit={(value) => patchCue({ fontSize: value })} /></label>
                      <label>文字颜色<div className="color-input"><input type="color" value={selectedCue.settings.color} onChange={(event) => patchCue({ color: event.target.value })} /><span>{selectedCue.settings.color.toUpperCase()}</span></div></label>
                      <label>文字对齐<select value={selectedCue.settings.align} onChange={(event) => patchCue({ align: event.target.value as CueSettings['align'] })}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
                    </div>
                  </section>
                  <section className="settings-section">
                    <h4>演出</h4>
                    <div className="setting-grid">
                      <label>文字动效<select value={selectedCue.settings.motion} onChange={(event) => selectMotion(event.target.value as CueSettings['motion'])}>{MOTION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
                      <label>下一句推进<select value={selectedCue.settings.advance} onChange={(event) => patchCue({ advance: event.target.value as CueSettings['advance'] })}><option value="click">等待点击</option><option value="timed">按时长自动</option></select></label>
                      <label>演出时长（ms）<NumericField min="500" max="600000" step="100" value={selectedCue.settings.durationMs} onCommit={(value) => patchCue({ durationMs: value })} /></label>
                      {selectedCue.settings.mode === 'free' && <>
                        <label>X（画布 px）<NumericField min="0" max="1920" value={selectedCue.settings.x} onCommit={(value) => patchCue({ x: value })} /></label>
                        <label>Y（画布 px）<NumericField min="0" max="1080" value={selectedCue.settings.y} onCommit={(value) => patchCue({ y: value })} /></label>
                      </>}
                    </div>
                    <MotionSettingsPanel cue={selectedCue} onPatch={patchMotionSettings} onDuration={(durationMs) => patchCue({ durationMs })} />
                  </section>
                  <section className="settings-section">
                    <h4>画面</h4>
                    <div className="setting-grid"><label>当前背景<select value={selectedCue.settings.backgroundId ?? ''} onChange={(event) => setBackground(event.target.value)}><option value="">沿用上一句</option><option value="__clear__">清除背景</option>{assets.filter((asset) => asset.kind === 'image').map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label></div>
                  <div className="layer-editor">
                    <div className="layer-head"><strong>舞台图层</strong><span>{selectedLayers.length} 层</span>{assets.some((asset) => ['image', 'video'].includes(asset.kind)) && <select aria-label="添加图片或视频图层" value="" onChange={(event) => { const asset = assets.find((item) => item.id === event.target.value); if (asset) addSceneLayer(asset); }}><option value="">添加图层…</option>{assets.filter((asset) => ['image', 'video'].includes(asset.kind)).map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>}</div>
                    {selectedLayers.map((layer: any) => <button key={layer.id} className={`layer-row ${selectedLayerId === layer.id ? 'active' : ''}`} onClick={() => setSelectedLayerId(layer.id)}><span>{assets.find((asset) => asset.id === layer.assetId)?.name ?? '缺失素材'}{layer.hidden ? ' · 已隐藏' : ''}{layer.locked ? ' · 已锁定' : ''}</span><small>Z{layer.zIndex + 1}</small></button>)}
                    {selectedLayer && <div className="layer-controls">
                      <label>X<NumericField min="0" max="1920" value={selectedLayer.x} onCommit={(value) => updateLayer({ x: value })} /></label>
                      <label>Y<NumericField min="0" max="1080" value={selectedLayer.y} onCommit={(value) => updateLayer({ y: value })} /></label>
                      <label>宽<NumericField min="1" max="3840" value={selectedLayer.width} onCommit={(value) => updateLayer({ width: value })} /></label>
                      <label>高<NumericField min="1" max="2160" value={selectedLayer.height} onCommit={(value) => updateLayer({ height: value })} /></label>
                      <label>透明度<NumericField min="0" max="100" value={Math.round(selectedLayer.opacity * 100)} onCommit={(value) => updateLayer({ opacity: value / 100 })} /></label>
                      <label>旋转<NumericField min="-3600" max="3600" value={selectedLayer.rotation ?? 0} onCommit={(value) => updateLayer({ rotation: value })} /></label>
                      <button title="下移一层" onClick={() => moveLayer(-1)}>↓</button><button title="上移一层" onClick={() => moveLayer(1)}>↑</button><button className="remove-layer" onClick={removeLayer}>移除图层</button>
                    </div>}
                    {selectedLayer && <div className="layer-extra-controls">
                      <button onClick={() => updateLayer({ locked: !selectedLayer.locked })}>{selectedLayer.locked ? '解锁' : '锁定'}</button><button onClick={() => updateLayer({ hidden: !selectedLayer.hidden })}>{selectedLayer.hidden ? '显示' : '隐藏'}</button>
                      <button onClick={() => updateLayer({ flipX: !selectedLayer.flipX })}>水平翻转</button><button onClick={() => updateLayer({ flipY: !selectedLayer.flipY })}>垂直翻转</button>
                      <button onClick={() => updateLayer({ x: 960 - selectedLayer.width / 2 })}>水平居中</button><button onClick={() => updateLayer({ y: 540 - selectedLayer.height / 2 })}>垂直居中</button><button onClick={() => updateLayer({ x: 0, y: 0, width: 1920, height: 1080, rotation: 0 })}>适配舞台</button>
                      {selectedLayers.length > 1 && <><button onClick={() => distributeLayers('x')}>水平分布</button><button onClick={() => distributeLayers('y')}>垂直分布</button></>}
                      <label>适配<select value={selectedLayer.fit ?? 'contain'} onChange={(event) => updateLayer({ fit: event.target.value })}><option value="contain">完整显示</option><option value="cover">铺满裁切</option><option value="fill">拉伸填满</option></select></label>
                      <label>左裁剪<input type="range" min="0" max="45" value={Math.round((selectedLayer.crop?.left ?? 0) * 100)} onChange={(event) => updateLayer({ crop: { left: Number(event.target.value) / 100, top: selectedLayer.crop?.top ?? 0, right: selectedLayer.crop?.right ?? 0, bottom: selectedLayer.crop?.bottom ?? 0 } })} /></label><label>上裁剪<input type="range" min="0" max="45" value={Math.round((selectedLayer.crop?.top ?? 0) * 100)} onChange={(event) => updateLayer({ crop: { left: selectedLayer.crop?.left ?? 0, top: Number(event.target.value) / 100, right: selectedLayer.crop?.right ?? 0, bottom: selectedLayer.crop?.bottom ?? 0 } })} /></label>
                      <label>右裁剪<input type="range" min="0" max="45" value={Math.round((selectedLayer.crop?.right ?? 0) * 100)} onChange={(event) => updateLayer({ crop: { left: selectedLayer.crop?.left ?? 0, top: selectedLayer.crop?.top ?? 0, right: Number(event.target.value) / 100, bottom: selectedLayer.crop?.bottom ?? 0 } })} /></label><label>下裁剪<input type="range" min="0" max="45" value={Math.round((selectedLayer.crop?.bottom ?? 0) * 100)} onChange={(event) => updateLayer({ crop: { left: selectedLayer.crop?.left ?? 0, top: selectedLayer.crop?.top ?? 0, right: selectedLayer.crop?.right ?? 0, bottom: Number(event.target.value) / 100 } })} /></label>
                      {assets.find((asset) => asset.id === selectedLayer.assetId)?.kind === 'video' && <><label>片段起点 ms<NumericField min="0" value={selectedLayer.videoStartMs ?? 0} onCommit={(value) => updateLayer({ videoStartMs: value })} /></label><label>片段终点 ms<NumericField min={(selectedLayer.videoStartMs ?? 0) + 1} value={selectedLayer.videoEndMs} onClear={() => updateLayer({ videoEndMs: undefined })} onCommit={(value) => updateLayer({ videoEndMs: value })} /></label><label>原声音量<input type="range" min="0" max="100" value={Math.round((selectedLayer.videoVolume ?? 1) * 100)} onChange={(event) => updateLayer({ videoVolume: Number(event.target.value) / 100 })} /></label><button onClick={() => updateLayer({ videoMuted: !selectedLayer.videoMuted })}>{selectedLayer.videoMuted ? '打开视频原声' : '静音视频原声'}</button><button onClick={() => updateLayer({ videoLoop: !selectedLayer.videoLoop })}>{selectedLayer.videoLoop ? '停止循环片段' : '循环播放片段'}</button></>}
                    </div>}
                  </div>
                  </section>
                  <section className="settings-section">
                    <h4>声音</h4>
                    <div className="sound-block">
                      <strong>本句音效</strong>
                      <div className="setting-grid">
                        <label>关联素材<select aria-label="本句音效" value={selectedCue.settings.audioId ?? ''} onChange={(event) => setAudio(event.target.value)}><option value="">不关联音效</option>{assets.filter((asset) => ['audio', 'music'].includes(asset.kind)).map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
                      </div>
                      <small>只在这一句触发，换到别的句不会跟着响。</small>
                    </div>
                    <div className="sound-block">
                      <strong>组背景音乐{cueGroup ? ` · 第 ${cueGroupIndex + 1} 组 ${cueGroup.name}` : ''}</strong>
                      {cueGroup ? <>
                        <div className="setting-grid">
                          <label>背景音乐<select aria-label="当前组的背景音乐" value={cueGroupMusic?.assetId ?? ''} onChange={(event) => { if (event.target.value) setGroupMusic(event.target.value, cueGroup.paragraphIds); }}><option value="">不设置</option>{assets.filter((asset) => asset.kind === 'audio').map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
                        </div>
                        <small>作用范围：{cueGroup.paragraphIds.length} 段{cueGroupMusic?.groupIds?.length ? ` · 连续 ${cueGroupMusic.groupIds.length} 组` : ''}。当前：{cueGroupAudio ? cueGroupAudio.name : '未设置'}。</small>
                        <div className="layer-extra-controls">
                          <button onClick={() => setGroupMusicDialog({ chapterId: chapter.id, groupIds: [cueGroup.id], assetId: cueGroupMusic?.assetId ?? '' })}>连续多个组…</button>
                          {cueGroupMusic && <button onClick={() => updateActiveChapter((current) => removeMusicRange(current, cueGroupMusic.id))}>移除本组配乐</button>}
                        </div>
                      </> : <small>这一句还没有归组。归组后才能设置贯穿多句的背景音乐。</small>}
                    </div>
                  </section>
                </>}
              </div>
            </section>
          </div>
        </section>
      </main>
      <div className="statusbar"><span title={saveTarget ?? '本机自动保存工程'}>工程：{project.name} · {chapter.name}</span><span>{saveTarget ?? '本机自动保存工程'}</span><button onClick={() => void window.storyWorkbench.library.openSaveFolder(libraryKeyRef.current).then((target) => setNotice(`保存位置：${target}`)).catch((error) => setNotice(error.message))}>打开保存位置</button><button onClick={restoreProject}>恢复历史</button><button onClick={() => void importProject()}>导入工程包</button></div>
      {projectOperation && <div className="operation-overlay"><span className="operation-spinner" />正在安全切换工程…</div>}
      {mediaProgress && <div className="operation-overlay"><span className="operation-spinner" />{mediaProgress}{mediaAbortRef.current && <button className="button quiet" onClick={() => { mediaAbortRef.current?.abort(); setMediaProgress('正在取消…解码结束后会丢弃结果。'); }}>取消并丢弃</button>}</div>}
      {restoreVersions && <div className="name-dialog-overlay"><section className="name-dialog restore-history-dialog" role="dialog" aria-modal="true" aria-label="恢复历史" onKeyDown={(event) => { if (event.key === 'Escape') setRestoreVersions(null); }}><h2>恢复历史</h2><p>保留最近 12 个定时快照及 8 个保护快照。大量删字前的版本单独保护；恢复前会保留当前工程。</p><div className="restore-history-list">{restoreVersions.length ? restoreVersions.map((version) => <button key={version.id} onClick={() => void restoreVersion(version)}><strong>{new Date(version.savedAt).toLocaleString('zh-CN')}</strong><span>{version.reason} · {formatSize(version.bytes)}</span></button>) : <p>暂无历史版本。</p>}</div><button className="button quiet" autoFocus onClick={() => setRestoreVersions(null)}>取消</button></section></div>}
      {groupMusicDialog && <div className="name-dialog-overlay"><section className="name-dialog group-music-dialog" role="dialog" aria-modal="true" aria-label="设置段落组背景音乐" onKeyDown={(event) => { if (event.key === 'Escape') setGroupMusicDialog(null); }}><h2>设置组背景音乐</h2><p>目标：{groupMusicDialog.groupIds.map((id) => orderedGroups.find((group: any) => group.id === id)?.name ?? '已删除的组').join('、')} · 覆盖连续所选组的正文范围。</p><label>背景音乐<select value={groupMusicDialog.assetId} onChange={(event) => setGroupMusicDialog((current) => current ? { ...current, assetId: event.target.value } : current)}><option value="">选择已导入的音频…</option>{assets.filter((asset) => asset.kind === 'audio').map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><div className="name-dialog-actions"><button className="button quiet" autoFocus onClick={() => setGroupMusicDialog(null)}>取消</button><button className="button quiet" onClick={importGroupMusic}>导入并使用音乐</button><button className="button primary" disabled={!groupMusicDialog.assetId} onClick={confirmGroupMusic}>应用背景音乐</button></div></section></div>}
      {pendingMusic && <div className="name-dialog-overlay"><section className="name-dialog" role="dialog" aria-modal="true" aria-label="确认替换背景音乐"><h2>目标范围已有背景音乐</h2><p>将替换所选 {pendingMusic.paragraphIds.length} 段的配乐。范围外仍沿用原音乐，提交后可撤销。</p><div className="name-dialog-actions"><button className="button quiet" autoFocus onClick={() => setPendingMusic(null)}>取消</button><button className="button primary" onClick={confirmMusicReplacement}>替换目标范围</button></div></section></div>}
      {articlePreview && <div className="name-dialog-overlay"><section className="name-dialog article-dialog" role="dialog" aria-modal="true" aria-label="文章正文预览"><h2>{articlePreview.name}</h2><p>将 {articlePreview.paragraphs.length} 段正文追加到当前章节，保留段内换行。</p><div className="article-preview">{articlePreview.paragraphs.map((text, index) => <p key={index}>{text}</p>)}</div><div className="name-dialog-actions"><button className="button quiet" onClick={() => setArticlePreview(null)}>取消</button><button className="button primary" onClick={appendArticle}>追加到当前章</button></div></section></div>}
      {confirmation && <div className="name-dialog-overlay"><section className="name-dialog" role="dialog" aria-modal="true" aria-label={confirmation.title}><h2>{confirmation.title}</h2><p>{confirmation.detail}</p><div className="name-dialog-actions"><button className="button quiet" autoFocus onClick={() => setConfirmation(null)}>取消</button><button className="button primary" onClick={() => { const action = confirmation.action; setConfirmation(null); try { action(); } catch (error) { setNotice(error instanceof Error ? error.message : '操作未提交。'); } }}>确认移除</button></div></section></div>}
      {nameDialog && <NameInputDialog dialog={nameDialog} onCancel={closeNameDialog} />}
      {importCandidate && <ImportConflictDialog candidate={importCandidate} onResolve={(choice) => void resolveImportConflict(choice)} onCancel={() => setImportCandidate(null)} />}
      {aiReviewState && <AiReviewDialog key={aiReviewState.mode} state={aiReviewState} busy={aiReviewBusy} selectedGroupCount={selectedGroupIds.length} onCancel={() => setAiReviewState(null)} onExport={exportAiReview} onApply={applyAiReview} onCopyPrompt={async (prompt) => { try { await navigator.clipboard.writeText(prompt); setNotice('改进提示词已复制。'); } catch { setNotice('复制失败，请在文本框中手动复制提示词。'); } }} onToggle={(index, checked) => setAiReviewState((current) => current?.mode === 'import' ? { ...current, checked: current.checked.map((value, i) => i === index ? checked : value) } : current)} />}
      {openMenu && <ContextMenu x={openMenu.x} y={openMenu.y} title={openMenu.title} commands={openMenu.commands} onExecute={(command) => runMenuAction(command, openMenu.focus)} onClose={() => { const focus = openMenu.focus; setOpenMenu(null); if (focus?.isConnected) requestAnimationFrame(() => focus.focus()); }} />}
      {notice && <div role="status" className="toast">{notice}</div>}
    </div>
  );
}

function StageImageLayer({ layer, asset, selected, editable, status, cueId, playSessionRevision, seekRevision, elapsedMs, onNotice, onSelect, onCommit, onContextMenu }: { layer: any; asset: AssetRecord; selected: boolean; editable: boolean; status: string; cueId?: string; playSessionRevision: number; seekRevision: number; elapsedMs: number; onNotice: (message: string) => void; onSelect: () => void; onCommit: (patch: Record<string, any>) => void; onContextMenu?: (event: React.MouseEvent) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const lastStatusRef = useRef(status);
  const lastSessionRef = useRef(playSessionRevision);
  const lastSeekRef = useRef(seekRevision);
  const lastCueRef = useRef(cueId);
  const lastVideoConfigRef = useRef('');
  useEffect(() => () => cleanupRef.current?.(), []);

  const percentStyle = (layout: { x: number; y: number; width: number; height: number }) => ({
    left: `${layout.x / 1920 * 100}%`, top: `${layout.y / 1080 * 100}%`,
    width: `${layout.width / 1920 * 100}%`, height: `${layout.height / 1080 * 100}%`,
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, layer.videoVolume ?? 1));
    video.muted = !!layer.videoMuted;
    const config = [asset.id, layer.videoStartMs, layer.videoEndMs, layer.videoLoop].join(':');
    const newSession = lastStatusRef.current === 'stopped' || lastSessionRef.current !== playSessionRevision || lastCueRef.current !== cueId;
    if (newSession || lastSeekRef.current !== seekRevision || lastVideoConfigRef.current !== config) {
      const desired = videoPositionSeconds(layer, status === 'stopped' || newSession ? 0 : elapsedMs, video.duration);
      if (Number.isFinite(video.duration)) video.currentTime = desired;
    }
    let active = true;
    if (status === 'playing') void video.play().catch((error) => { if (active && error.name !== 'AbortError') onNotice('视频播放失败：' + (error.message || asset.name)); });
    else video.pause();
    lastStatusRef.current = status;
    lastSessionRef.current = playSessionRevision;
    lastSeekRef.current = seekRevision;
    lastCueRef.current = cueId;
    lastVideoConfigRef.current = config;
    return () => { active = false; };
  }, [status, cueId, playSessionRevision, seekRevision, layer.videoMuted, layer.videoVolume, layer.videoStartMs, layer.videoEndMs, layer.videoLoop, asset.id]);



  const beginGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!editable || layer.locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    const target = event.currentTarget;
    const bounds = target.parentElement!.getBoundingClientRect();
    const start = { x: layer.x, y: layer.y, width: layer.width, height: layer.height, rotation: layer.rotation ?? 0 };
    const pointerId = event.pointerId;
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle ?? 'move';
    const centerClient = { x: bounds.left + (start.x + start.width / 2) / 1920 * bounds.width, y: bounds.top + (start.y + start.height / 2) / 1080 * bounds.height };
    const initialAngle = Math.atan2(event.clientY - centerClient.y, event.clientX - centerClient.x) * 180 / Math.PI;
    let current = { ...start };
    let moved = false;
    const render = () => {
      Object.assign(target.style, percentStyle(current));
      target.style.transform = `rotate(${current.rotation}deg)`;
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', keydown);
      cleanupRef.current = null;
    };
    const finish = (commit: boolean, pointer?: PointerEvent) => {
      if (commit && moved && pointer) move(pointer);
      cleanup();
      if (commit && moved) onCommit({ x: Math.round(current.x), y: Math.round(current.y), width: Math.round(current.width), height: Math.round(current.height), rotation: Math.round(current.rotation * 10) / 10 });
      else { Object.assign(target.style, percentStyle(start)); target.style.transform = `rotate(${start.rotation}deg)`; }
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = (moveEvent.clientX - event.clientX) / bounds.width * 1920;
      const dy = (moveEvent.clientY - event.clientY) / bounds.height * 1080;
      if (Math.abs(dx) < 0.75 && Math.abs(dy) < 0.75) return;
      moved = true;
      if (handle === 'move') {
        current = { ...start, x: Math.max(0, Math.min(1920 - start.width, start.x + dx)), y: Math.max(0, Math.min(1080 - start.height, start.y + dy)) };
      } else if (handle === 'rotate') {
        const angle = Math.atan2(moveEvent.clientY - centerClient.y, moveEvent.clientX - centerClient.x) * 180 / Math.PI;
        current = { ...start, rotation: start.rotation + angle - initialAngle };
      } else {
        current = { ...start, ...resizeLayer(start, handle, dx, dy) };
      }
      render();
    };
    const up = (upEvent: PointerEvent) => { if (upEvent.pointerId === pointerId) finish(true, upEvent); };
    const cancel = (cancelEvent: PointerEvent) => { if (cancelEvent.pointerId === pointerId) finish(false); };
    const keydown = (keyEvent: KeyboardEvent) => { if (keyEvent.key === 'Escape') finish(false); };
    cleanupRef.current = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', keydown);
  };

  const crop = layer.crop ?? {};
  const left = crop.left ?? 0; const right = crop.right ?? 0; const top = crop.top ?? 0; const bottom = crop.bottom ?? 0;
  const mediaStyle: React.CSSProperties = { left: `${-left / (1 - left - right) * 100}%`, top: `${-top / (1 - top - bottom) * 100}%`, width: `${100 / (1 - left - right)}%`, height: `${100 / (1 - top - bottom)}%`, objectFit: layer.fit ?? 'contain', transform: `scale(${layer.flipX ? -1 : 1}, ${layer.flipY ? -1 : 1})` };
  return <div ref={ref} className={`scene-layer-handle ${selected && editable ? 'selected' : ''} ${layer.locked ? 'locked' : ''}`} style={{ ...percentStyle(layer), opacity: layer.opacity, zIndex: layer.zIndex + 1, transform: `rotate(${layer.rotation ?? 0}deg)`, pointerEvents: editable ? 'auto' : 'none' }} onPointerDown={beginGesture} onContextMenu={onContextMenu}>
    <div className="scene-layer-viewport">{asset.kind === 'video' ? <video ref={videoRef} className="scene-layer-image" src={objectUrl(asset)} style={mediaStyle} muted={!!layer.videoMuted} playsInline preload="auto" onError={() => onNotice('视频无法解码：' + asset.name + '，请使用 H.264/AAC MP4。')} onLoadedMetadata={(event) => { event.currentTarget.currentTime = videoPositionSeconds(layer, status === 'stopped' ? 0 : elapsedMs, event.currentTarget.duration); }} onTimeUpdate={(event) => { const video = event.currentTarget; const end = layer.videoEndMs ? layer.videoEndMs / 1000 : video.duration; if (Number.isFinite(end) && video.currentTime >= end) { if (layer.videoLoop) video.currentTime = (layer.videoStartMs ?? 0) / 1000; else video.pause(); } }} /> : <img className="scene-layer-image" src={objectUrl(asset)} alt={asset.name} draggable={false} style={mediaStyle} />}</div>
    {selected && editable && !layer.locked && <><span className="scene-layer-rotate" data-handle="rotate" title="拖动旋转" /><span className="scene-resize-handle nw" data-handle="nw" title="角点等比缩放" /><span className="scene-resize-handle ne" data-handle="ne" title="角点等比缩放" /><span className="scene-resize-handle sw" data-handle="sw" title="角点等比缩放" /><span className="scene-resize-handle se" data-handle="se" title="角点等比缩放" /><span className="scene-edge-handle n" data-handle="n" /><span className="scene-edge-handle s" data-handle="s" /><span className="scene-edge-handle e" data-handle="e" /><span className="scene-edge-handle w" data-handle="w" /></>}
  </div>;
}

function StageCue({ cue, status, elapsedMs, seekRevision, playSessionRevision, onAdvance, onMove }: { cue: any; status: string; elapsedMs: number; seekRevision: number; playSessionRevision: number; onAdvance: () => void; onMove: (position: { x: number; y: number }) => void }) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const settings = cue.settings;

  void seekRevision;
  void playSessionRevision;

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const free = settings.mode === 'free';
  return <div ref={nodeRef} className={`stage-cue ${free ? 'free-cue' : 'dialogue-cue'} ${status === 'playing' ? 'playing' : ''} ${status === 'paused' ? 'paused' : ''}`} style={free ? { left: `${settings.x / 1920 * 100}%`, top: `${settings.y / 1080 * 100}%`, transform: 'translate(-50%, -50%)', '--cue-color': settings.color } as React.CSSProperties : undefined}
    onPointerDown={(event) => {
      if (!free || status !== 'stopped') return;
      event.preventDefault();
      const target = event.currentTarget;
      const bounds = target.parentElement!.getBoundingClientRect();
      const startX = event.clientX; const startY = event.clientY;
      const start = { x: settings.x, y: settings.y };
      const pointerId = event.pointerId;
      let position = { ...start };
      let moved = false;
      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        position = { x: Math.max(0, Math.min(1920, start.x + (moveEvent.clientX - startX) / bounds.width * 1920)), y: Math.max(0, Math.min(1080, start.y + (moveEvent.clientY - startY) / bounds.height * 1080)) };
        moved = Math.abs(position.x - start.x) + Math.abs(position.y - start.y) > 1;
        target.style.left = `${position.x / 1920 * 100}%`;
        target.style.top = `${position.y / 1080 * 100}%`;
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', keydown);
        dragCleanupRef.current = null;
      };
      const restore = () => { target.style.left = `${start.x / 1920 * 100}%`; target.style.top = `${start.y / 1080 * 100}%`; };
      const up = (upEvent: PointerEvent) => { if (upEvent.pointerId === pointerId) { move(upEvent); cleanup(); if (moved) onMove({ x: Math.round(position.x), y: Math.round(position.y) }); else restore(); } };
      const cancel = (cancelEvent: PointerEvent) => { if (cancelEvent.pointerId === pointerId) { cleanup(); restore(); } };
      const keydown = (keyEvent: KeyboardEvent) => { if (keyEvent.key === 'Escape') { cleanup(); restore(); } };
      dragCleanupRef.current = () => { cleanup(); restore(); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', keydown);
    }} onClick={(event) => { if (status === 'playing' && settings.advance === 'click') { event.stopPropagation(); onAdvance(); } }}>
    {settings.speaker && settings.mode === 'dialogue' && <span className="cue-speaker">{settings.speaker}</span>}
    <span className="cue-text" style={{ color: settings.color, fontSize: `min(${settings.fontSize / 1920 * 100}cqi, ${settings.fontSize}px)`, textAlign: settings.align }}><CueMotionText cue={cue} elapsedMs={elapsedMs} staticPreview={status === 'stopped'} /></span>
  </div>;
}

function MotionSettingsPanel({ cue, onPatch, onDuration }: { cue: any; onPatch: (patch: Record<string, any>) => unknown; onDuration: (durationMs: number) => void }) {
  const motion = cue.settings.motion;
  const parameters = { ...defaultMotionSettings(motion, cue.text), ...(cue.settings.motionSettings ?? {}) };
  const patch = (key: string, value: string | number | boolean) => onPatch({ [key]: value });
  const number = (label: string, key: string, min: number, max: number, step = 1) => <label key={key}>{label}<NumericField min={min} max={max} step={step} value={parameters[key]} onCommit={(value) => patch(key, value)} /></label>;
  const text = (label: string, key: string, multiline = false) => <label key={key}>{label}{multiline ? <textarea rows={2} value={parameters[key] ?? ''} onChange={(event) => patch(key, event.target.value)} /> : <input value={parameters[key] ?? ''} onChange={(event) => patch(key, event.target.value)} />}</label>;
  const minimum = Math.ceil(minimumMotionDuration(motion, cue.text, parameters));
  const fields = (() => {
    if (motion === 'typing') return <>{number('起始延迟 ms', 'startMs', 0, 10000)}{number('字间隔 ms', 'charStepMs', 10, 2000)}</>;
    if (motion === 'verticalReveal') return <>{number('开始时间 ms', 'startMs', 0, 600000)}{number('字间隔 ms', 'charStepMs', 1, 5000)}{number('每列字数', 'columnLength', 2, 16)}{number('阅读停留 ms', 'holdMs', 0, 600000)}{number('列退出间隔 ms', 'columnExitStepMs', 0, 5000)}{number('退出时长 ms', 'exitMs', 1, 60000)}<small>从上向下显字、从右向左分列。换行另起一列，适合短独白；长文建议拆成多句。</small></>;
    if (motion === 'ghostConverge') return <>{number('开始时间 ms', 'startMs', 0, 600000)}{number('淡入时长 ms', 'fadeMs', 1, 60000)}{number('错色开始 ms', 'changeAtMs', 0, 600000)}{number('分离停留 ms', 'splitMs', 1, 60000)}{number('回收时长 ms', 'returnMs', 1, 60000)}{number('残影距离（字宽）', 'offsetEm', 0, 1, 0.01)}<label>残影强度<input type="range" min="0" max="1" step="0.05" value={parameters.strength} onChange={(event) => patch('strength', Number(event.target.value))} /></label>{number('清晰阅读 ms', 'holdMs', 0, 600000)}{number('退出时长 ms', 'exitMs', 1, 60000)}<small>错色最早在淡入完成后开始；青紫残影收拢后保留清晰正文。</small></>;
    if (motion === 'blurSharp') return <>{number('清晰时长 ms', 'clearMs', 100, 6000)}<label>模糊强度 <input type="range" min="0" max="1" step="0.05" value={parameters.strength} onChange={(event) => patch('strength', Number(event.target.value))} /></label></>;
    if (motion === 'rise') return <><label>上移淡入强度 <input type="range" min="0" max="1" step="0.05" value={parameters.strength} onChange={(event) => patch('strength', Number(event.target.value))} /></label>{number('上移距离 px', 'risePx', 0, 120)}</>;
    if (motion === 'shake') return <><label>震动强度 <input type="range" min="0" max="1" step="0.05" value={parameters.strength} onChange={(event) => patch('strength', Number(event.target.value))} /><small>{Math.round(parameters.strength * 100)}%</small></label>{number('震动时长 ms', 'durationMs', 100, 5000)}</>;
    if (motion === 'decode') return <>{number('开始时间 ms', 'startMs', 0, 10000)}{number('字间隔 ms', 'charStepMs', 10, 1000)}{number('收敛时长 ms', 'settleMs', 20, 800)}{number('固定种子', 'seed', -2147483648, 2147483647)}{number('阅读停留 ms', 'holdMs', 0, 60000)}</>;
    if (motion === 'wordUnderline') return <>{text('词组（用 / 分隔，中文按语义分词）', 'wordsText', true)}{number('首词开始 ms', 'startMs', 0, 30000)}{number('每词时长 ms', 'wordDurationMs', 100, 10000)}{number('词内字间隔 ms', 'charStepMs', 10, 1000)}{number('扫线粗细 px', 'underlineThickness', 1, 12)}</>;
    if (motion === 'keywordChip') return <>{text('关键词（用 / 分隔）', 'keywordsText')}{number('显字间隔 ms', 'charStepMs', 10, 1000)}{number('色块内边距 px', 'chipPadding', 0, 40)}<label><input type="checkbox" checked={!!parameters.showIds} onChange={(event) => patch('showIds', event.target.checked)} />显示示意编号</label></>;
    if (motion === 'translationWires') return <>{text('英文词组（空格分词）', 'englishText')}{text('中文词块（用 / 分隔）', 'chineseText')}{text('对应关系（每行：中文词块:英文词组,英文词组）', 'mappingText', true)}{number('连线生长 ms', 'lineGrowMs', 50, 5000)}</>;
    if (motion === 'rewrite') return <>{text('犹豫草稿', 'draftText')}{text('最终改写', 'rewriteText')}{number('开始时间 ms', 'startMs', 0, 10000)}{number('停顿 ms', 'pauseMs', 0, 10000)}{number('退格字数', 'deleteCount', 0, 100)}{number('打字速度 字/秒', 'typeCps', 1, 60)}</>;
    if (motion === 'strikeRewrite') return <>{text('旧句', 'oldText')}{text('新句', 'newText')}{number('划线开始 ms', 'strikeAtMs', 0, 30000)}{number('划线生长 ms', 'strikeDrawMs', 10, 2000)}{number('旧句停留 ms', 'strikeHoldMs', 0, 10000)}{number('新句速度 字/秒', 'typeCps', 1, 60)}<label>划线颜色<input type="color" value={parameters.strikeColor} onChange={(event) => patch('strikeColor', event.target.value)} /></label></>;
    if (motion === 'evaporate') return <>{text('最后保留的短句', 'protectedText')}{number('固定种子', 'seed', -2147483648, 2147483647)}{number('蒸发开始 ms', 'evaporationStartMs', 0, 30000)}{number('蒸发结束 ms', 'evaporationEndMs', 100, 60000)}{number('保留停顿 ms', 'finalHoldMs', 0, 10000)}{number('末句退格 ms', 'backspaceDurationMs', 100, 10000)}</>;
    return null;
  })();
  if (!fields) return null;
  return <div className="motion-parameters"><div className="motion-parameters-head"><strong>动效参数</strong><small>{MOTION_PRESETS.find((preset) => preset.id === motion)?.summary}</small></div><div className="motion-parameter-grid">{fields}</div>{minimum > cue.settings.durationMs && <div className="motion-duration-warning">{minimum > 600000 ? '完整演出超过单句 10 分钟上限，请拆成多句或缩短动效参数。' : <>按当前文字和参数，建议演出至少 {minimum} ms，给完整文字留下阅读时间。<button onClick={() => onDuration(minimum)}>延长至建议时长</button></>}</div>}</div>;
}

function AssetCard({ asset, projectId, recent, onBackground, onAudio, onLayer, onAppendArticle, onDelete, onExtractAudio, onNotice, onBeginAudioDrag, onEndAudioDrag, onContextMenu }: { asset: AssetRecord; projectId: string; recent: boolean; onBackground: () => void; onAudio: () => void; onLayer: () => void; onAppendArticle: () => void; onDelete: () => void; onExtractAudio: () => void; onNotice: (message: string) => void; onBeginAudioDrag: () => void; onEndAudioDrag: () => void; onContextMenu?: (event: React.MouseEvent) => void }) {
  const [mediaState, setMediaState] = useState('idle');
  const mediaRef = useRef<MediaSession | null>(null);
  useEffect(() => {
    if (asset.kind !== 'audio') return;
    const session = new MediaSession(createHtmlAudioBackend((id) => id === asset.id ? asset : undefined), (snapshot) => {
      if (snapshot.status !== 'disposed') setMediaState(snapshot.status);
      if (snapshot.status === 'error' && snapshot.error) onNotice(`试听失败：${snapshot.error}`);
    });
    mediaRef.current = session;
    return () => {
      session.dispose();
      if (mediaRef.current === session) mediaRef.current = null;
    };
  }, [asset, onNotice]);
  const image = asset.kind === 'image';
  const video = asset.kind === 'video';
  const sound = asset.kind === 'audio';
  const kindName = image ? '图片' : video ? 'MP4 视频' : sound ? '音频' : asset.kind === 'article' ? '文章' : '其他';
  return <article className={`asset-card ${recent ? 'recent' : ''}`} draggable={sound} onContextMenu={onContextMenu} onDragStart={(event) => { if (!sound) return; onBeginAudioDrag(); event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(AUDIO_DRAG, JSON.stringify({ projectId, assetId: asset.id })); event.dataTransfer.setData('text/plain', '背景音乐'); }} onDragEnd={onEndAudioDrag} title={sound ? '拖到 C 区段落组设置背景音乐' : undefined}>
    <div className={`asset-preview ${image ? 'image' : ''}`}>
      {image ? <img src={objectUrl(asset)} alt="" /> : video ? <video src={objectUrl(asset)} muted playsInline preload="metadata" /> : <span>{sound ? '♫' : asset.kind === 'article' ? '文' : '··'}</span>}
    </div>
    <div className="asset-info"><strong title={asset.name}>{asset.name}</strong><small>{kindName} · {formatSize(asset.size)}</small>
      <div className="asset-actions">
        {asset.kind === 'article' && <button onClick={onAppendArticle}>预览并追加正文</button>}
        <button onClick={onDelete}>移除素材</button>
        {image && <><button onClick={onBackground}>设为背景</button><button onClick={onLayer}>添加图层</button></>}
        {video && <><button onClick={onLayer}>添加到舞台</button><button onClick={onExtractAudio}>提取声音</button></>}
        {sound && <button onClick={() => {
          const session = mediaRef.current;
          if (!session) return;
          const status = session.snapshot().status;
          if (status === 'playing' || status === 'loading') session.pause();
          else if (status === 'paused') session.resume();
          else void session.start(asset.id);
        }}>{mediaState === 'loading' ? '正在准备' : mediaState === 'playing' ? '暂停试听' : mediaState === 'paused' ? '继续试听' : '试听'}</button>}
        {sound && <><button onClick={onAudio}>本句音效</button><small className="audio-drag-hint">⠿ 拖到组设配乐</small></>}
      </div>
    </div>
  </article>;
}

function usePlaybackClock(clock: PlaybackClock) {
  const subscribe = useCallback((listener: () => void) => { clock.listeners.add(listener); return () => { clock.listeners.delete(listener); }; }, [clock]);
  const getSnapshot = useCallback(() => clock.snapshot, [clock]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

function ClockedStageCue({ clock, ...props }: { clock: PlaybackClock; cue: any; seekRevision: number; playSessionRevision: number; onAdvance: () => void; onMove: (position: { x: number; y: number }) => void }) {
  const snapshot = usePlaybackClock(clock);
  return <StageCue {...props} status={snapshot.status} elapsedMs={snapshot.elapsedMs} />;
}

function PlaybackProgress({ clock, onSeek }: { clock: PlaybackClock; onSeek: (fraction: number) => void }) {
  const snapshot = usePlaybackClock(clock);
  return <><input aria-label="当前句播放进度" className="seek-range" type="range" min="0" max="100" value={snapshot.durationMs ? snapshot.elapsedMs / snapshot.durationMs * 100 : 0} onChange={(event) => onSeek(Number(event.target.value) / 100)} /><span className="time-readout">{formatTime(snapshot.elapsedMs)} / {formatTime(snapshot.durationMs)}</span></>;
}

function formatTime(milliseconds: number) {
  const seconds = Math.max(0, milliseconds) / 1000;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.${Math.floor(seconds * 10) % 10}`;
}


function AiReviewDialog({ state, busy, selectedGroupCount, onCancel, onExport, onApply, onCopyPrompt, onToggle }: {
  state: AiReviewState;
  busy: boolean;
  selectedGroupCount: number;
  onCancel: () => void;
  onExport: (options: { scopeType: 'project' | 'chapter' | 'groups'; includeMedia: boolean; goal: string }) => void;
  onApply: (selectedIndexes: number[]) => void;
  onCopyPrompt: (prompt: string) => void;
  onToggle: (index: number, checked: boolean) => void;
}) {
  if (state.mode === 'export') return <AiReviewExportDialog state={state} busy={busy} selectedGroupCount={selectedGroupCount} onCancel={onCancel} onExport={onExport} />;
  if (state.mode === 'prompt') return <div className="name-dialog-overlay"><section className="ai-review-dialog prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-prompt-title"><h2 id="ai-prompt-title">审阅包已导出</h2><p>文件已保存到本机。复制下面提示词到你使用的 AI，再把返回的 JSON 建议文件导回软件。</p><small className="ai-review-path">{state.filePath}</small><textarea readOnly value={state.prompt} onFocus={(event) => event.currentTarget.select()} aria-label="可复制的 AI 改进提示词" /><div className="name-dialog-actions"><button className="button quiet" onClick={onCancel}>关闭</button><button className="button primary" onClick={() => onCopyPrompt(state.prompt)}>复制提示词</button></div></section></div>;
  const selectedIndexes = state.proposal.changes.map((_change: any, index: number) => state.checked[index] ? index : -1).filter((index: number) => index >= 0);
  return <div className="name-dialog-overlay"><section className="ai-review-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-review-title"><h2 id="ai-review-title">检查 AI 改进建议</h2><p className="ai-review-subtitle">{state.fileName} · 已通过工程 ID、基线哈希、目标 ID、参数和素材检查。只会应用勾选项目，整批可一次撤销。</p><div className="ai-review-change-list">{state.proposal.changes.length ? state.proposal.changes.map((change: any, index: number) => <AiReviewChangeCard key={`${change.op}-${change.chapterId}-${change.cueId ?? change.groupIds.join(',')}`} change={change} checked={state.checked[index]} onToggle={(checked) => onToggle(index, checked)} />) : <div className="ai-review-empty">文件基线有效，但没有改进建议可应用。</div>}</div><div className="name-dialog-actions"><button className="button quiet" disabled={busy} onClick={onCancel}>取消</button><button className="button primary" disabled={busy || !selectedIndexes.length} onClick={() => onApply(selectedIndexes)}>{busy ? '正在应用…' : `应用勾选项（${selectedIndexes.length}）`}</button></div></section></div>;
}

function AiReviewExportDialog({ state, busy, selectedGroupCount, onCancel, onExport }: {
  state: Extract<AiReviewState, { mode: 'export' }>;
  busy: boolean;
  selectedGroupCount: number;
  onCancel: () => void;
  onExport: (options: { scopeType: 'project' | 'chapter' | 'groups'; includeMedia: boolean; goal: string }) => void;
}) {
  const [scopeType, setScopeType] = useState(state.scopeType);
  const [includeMedia, setIncludeMedia] = useState(state.includeMedia);
  const [goal, setGoal] = useState(state.goal);
  return <div className="name-dialog-overlay"><form className="ai-review-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-export-title" onSubmit={(event) => { event.preventDefault(); onExport({ scopeType, includeMedia, goal }); }}><h2 id="ai-export-title">导出完整审阅包</h2><p className="ai-review-subtitle">导出为独立的 .storyreview.zip，内含可单独阅读的作品说明、提示词与可导回的建议格式；原工程自动保存与“导出工程包”保持独立。</p><strong className="ai-review-scope-label">审阅范围</strong><div className="ai-review-scope-options"><label><input type="radio" name="ai-review-scope" value="chapter" checked={scopeType === 'chapter'} onChange={() => setScopeType('chapter')} />当前章节</label><label><input type="radio" name="ai-review-scope" value="groups" disabled={!selectedGroupCount} checked={scopeType === 'groups'} onChange={() => setScopeType('groups')} />已选段落组（{selectedGroupCount}）</label><label><input type="radio" name="ai-review-scope" value="project" checked={scopeType === 'project'} onChange={() => setScopeType('project')} />全工程</label></div><label>希望 AI 改进的内容<textarea value={goal} maxLength={2000} placeholder="例如：加强循环感与末尾反转；为现有文字效果提出更贴合情绪的建议；只使用工程里已有的音频素材。" onChange={(event) => setGoal(event.target.value)} /></label><label className="ai-review-media"><input type="checkbox" checked={includeMedia} onChange={(event) => setIncludeMedia(event.target.checked)} />附带范围内引用的媒体文件（图片/音频/视频，文件可能较大）</label><small>不勾选时仅导出故事、演出参数与素材元数据；AI 不得声称看过或听过实际媒体。</small><div className="name-dialog-actions"><button type="button" className="button quiet" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className="button primary" disabled={busy || (scopeType === 'groups' && !selectedGroupCount)}>{busy ? '正在整理审阅包…' : '生成并保存'}</button></div></form></div>;
}

function AiReviewChangeCard({ change, checked, onToggle }: { change: any; checked: boolean; onToggle: (checked: boolean) => void }) {
  const title = change.op === 'replaceCueText' ? `正文改写 · ${change.cueId}` : change.op === 'updateCueSettings' ? `演出设置 · ${change.cueId}` : `段落组配乐 · ${change.groupIds.join('、')}`;
  const format = (value: any) => value === null ? '无' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <article className="ai-review-change"><label className="ai-review-change-title"><input type="checkbox" checked={checked} onChange={(event) => onToggle(event.target.checked)} /><strong>{title}</strong></label><div className="ai-review-diff"><section><small>当前</small><pre>{format(change.before)}</pre></section><span aria-hidden="true">→</span><section><small>建议</small><pre>{format(change.after)}</pre></section></div><small className="ai-review-reason">原因：{change.reason}</small></article>;
}

function NumericField({ value, min, max, step, onCommit, onClear }: { value: number | undefined; min?: number | string; max?: number | string; step?: number | string; onCommit: (value: number) => unknown; onClear?: () => unknown }) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(value === undefined ? '' : String(value)); setInvalid(false); }, [value]);
  const reset = () => setDraft(value === undefined ? '' : String(value));
  const commit = () => {
    const parsed = draft.trim() ? Number(draft) : NaN;
    if (!draft.trim() && onClear) { onClear(); setInvalid(false); return; }
    if (!Number.isFinite(parsed) || (min !== undefined && parsed < Number(min)) || (max !== undefined && parsed > Number(max))) {
      reset(); setInvalid(true); return;
    }
    const result = parsed === value ? true : onCommit(parsed);
    if (result === false) reset();
    setInvalid(result === false);
  };
  return <input className="numeric-field" type="number" value={draft} min={min} max={max} step={step} aria-invalid={invalid} title={invalid ? '数值无效，已保留原设置。' : '按 Enter 或离开输入框应用'} onChange={(event) => { setDraft(event.target.value); setInvalid(false); }} onBlur={commit} onKeyDown={(event) => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
    if (event.key === 'Escape') { event.preventDefault(); reset(); setInvalid(false); }
  }} />;
}

function NameInputDialog({ dialog, onCancel }: { dialog: NameDialogState; onCancel: () => void }) {
  const [value, setValue] = useState(dialog.initialValue);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    try {
      const name = dialog.normalize(value);
      const failure = dialog.onConfirm(name);
      if (failure) {
        setError(failure);
        return;
      }
      onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '名称无效，请检查后重试。');
    }
  };

  return <div className="name-dialog-overlay"><form className="name-dialog" role="dialog" aria-modal="true" aria-labelledby="name-dialog-title" onSubmit={submit} onKeyDown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  }}>
    <h2 id="name-dialog-title">{dialog.title}</h2>
    <label htmlFor="name-dialog-input">{dialog.fieldLabel}</label>
    <input ref={inputRef} id="name-dialog-input" value={value} maxLength={120} aria-invalid={!!error} aria-describedby={error ? 'name-dialog-error name-dialog-help' : 'name-dialog-help'} onChange={(event) => { setValue(event.target.value); setError(''); }} />
    <small id="name-dialog-help">{dialog.description ?? '最多 120 个字符，首尾空白会自动去除。'}</small>
    {error && <small id="name-dialog-error" className="name-dialog-error" role="alert">{error}</small>}
    <div className="name-dialog-actions"><button type="button" className="button quiet" onClick={onCancel}>取消</button><button type="submit" className="button primary">{dialog.confirmLabel}</button></div>
  </form></div>;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 工程库里显示的最近编辑时间 */
function formatLibraryTime(value: string) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 导入的工程和库里已有的是同一份作品时，让用户明确选择怎么处理 */
function ImportConflictDialog({ candidate, onResolve, onCancel }: { candidate: ImportCandidateState; onResolve: (choice: 'open' | 'copy' | 'replace' | 'cancel') => void; onCancel: () => void }) {
  const [confirmReplace, setConfirmReplace] = useState(false);
  return <div className="name-dialog-overlay"><section className="name-dialog" role="dialog" aria-modal="true" aria-label="工程已在工程库里" onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}>
    <h2>工程库里已经有同一份作品</h2>
    <p>“{candidate.existing.name}”和“{candidate.name}”用的是同一个作品标识。现在选什么都不会影响你正在编辑的工程。</p>
    <div className="name-dialog-actions">
      <button className="button quiet" autoFocus onClick={onCancel}>取消</button>
      <button className="button quiet" onClick={() => onResolve('open')}>打开已有的</button>
      <button className="button quiet" onClick={() => onResolve('copy')}>导入为副本</button>
      {confirmReplace
        ? <button className="button primary" onClick={() => onResolve('replace')}>确认替换</button>
        : <button className="button quiet" onClick={() => setConfirmReplace(true)}>替换已有的…</button>}
    </div>
    {confirmReplace && <p className="name-dialog-error" role="alert">替换会覆盖“{candidate.existing.name}”现在的内容（替换前的内容会留在它自己的恢复历史里）。再点一次“确认替换”才会执行。</p>}
  </section></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
