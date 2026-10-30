interface Window {
  storyWorkbench: {
    readClipboard(): Promise<{ text: string; payload: unknown }>;
    writeClipboard(value: { text: string; payload: unknown }): Promise<boolean>;
    /** 本地工程库：每个 key 一份独立内容、恢复历史和外部保存位置 */
    library: {
      list(): Promise<{ projects: LibraryEntry[]; activeKey: string | null; legacyPending: boolean }>;
      loadLegacy(): Promise<Uint8Array | null>;
      adoptLegacy(bytes: Uint8Array, meta: { name?: string; projectId?: string }): Promise<LibraryEntry>;
      load(key: string): Promise<Uint8Array | null>;
      create(bytes: Uint8Array, meta: { name?: string; projectId?: string }): Promise<LibraryEntry>;
      rename(key: string, name: string): Promise<LibraryEntry>;
      save(key: string, bytes: Uint8Array, options?: { protectCurrent?: boolean }): Promise<{ savedAt: string; bytes: number; filePath?: string | null; warning?: string }>;
      saveAs(key: string, bytes: Uint8Array): Promise<{ filePath: string; savedAt: string } | null>;
      saveTarget(key: string): Promise<string | null>;
      openSaveFolder(key: string): Promise<string>;
      historyList(key: string): Promise<Array<{ id: string; savedAt: string; bytes: number; reason: string }>>;
      historyLoad(key: string, id: string): Promise<Uint8Array | null>;
      restorePoint(key: string): Promise<Uint8Array | null>;
      restoreApply(key: string, bytes: Uint8Array): Promise<{ savedAt: string; bytes: number }>;
      importBackup(key: string): Promise<Uint8Array | null>;
      importBackupApply(key: string, bytes: Uint8Array): Promise<{ savedAt: string; bytes: number }>;
      importCommit(key: string, bytes: Uint8Array, meta?: { name?: string; projectId?: string }): Promise<{ savedAt: string; bytes: number; filePath?: string | null }>;
      setActive(key: string): Promise<string>;
    };
    exportProject(bytes: Uint8Array): Promise<string | null>;
    exportReviewPack(bytes: Uint8Array): Promise<string | null>;
    exportDocument(value: { suggestedName: string; text: string }): Promise<string | null>;
    importAiChanges(): Promise<{ name: string; text: string } | null>;
    importProject(): Promise<{ name: string; bytes: Uint8Array } | null>;
    chooseAssets(): Promise<{ cancelled: boolean; items: Array<{ name: string; mime?: string; bytes?: Uint8Array; error?: string }> }>;
    onBeforeClose(callback: (requestId: number) => void): () => void;
    closeResult(result: { saved: boolean; error?: string }): Promise<void>;
  };
}

interface LibraryEntry {
  key: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
