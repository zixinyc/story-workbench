const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storyWorkbench', {
  readClipboard: () => ipcRenderer.invoke('editing:clipboard-read'),
  writeClipboard: (value) => ipcRenderer.invoke('editing:clipboard-write', value),
  /* 本地工程库：每个 key 一份独立内容、恢复历史和外部保存位置 */
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    loadLegacy: () => ipcRenderer.invoke('library:load-legacy'),
    adoptLegacy: (bytes, meta) => ipcRenderer.invoke('library:adopt-legacy', bytes, meta),
    load: (key) => ipcRenderer.invoke('library:load', key),
    create: (bytes, meta) => ipcRenderer.invoke('library:create', bytes, meta),
    rename: (key, name) => ipcRenderer.invoke('library:rename', key, name),
    save: (key, bytes, options) => ipcRenderer.invoke('library:save', key, bytes, options),
    saveAs: (key, bytes) => ipcRenderer.invoke('library:save-as', key, bytes),
    saveTarget: (key) => ipcRenderer.invoke('library:save-target', key),
    openSaveFolder: (key) => ipcRenderer.invoke('library:open-save-folder', key),
    historyList: (key) => ipcRenderer.invoke('library:history-list', key),
    historyLoad: (key, id) => ipcRenderer.invoke('library:history-load', key, id),
    restorePoint: (key) => ipcRenderer.invoke('library:restore-point', key),
    restoreApply: (key, bytes) => ipcRenderer.invoke('library:restore-apply', key, bytes),
    importBackup: (key) => ipcRenderer.invoke('library:import-backup', key),
    importBackupApply: (key, bytes) => ipcRenderer.invoke('library:import-backup-apply', key, bytes),
    importCommit: (key, bytes, meta) => ipcRenderer.invoke('library:import-commit', key, bytes, meta),
    setActive: (key) => ipcRenderer.invoke('library:set-active', key),
  },
  exportProject: (bytes) => ipcRenderer.invoke('workspace:export', bytes),
  exportReviewPack: (bytes) => ipcRenderer.invoke('workspace:review-export', bytes),
  exportDocument: (value) => ipcRenderer.invoke('workspace:export-document', value),
  importAiChanges: () => ipcRenderer.invoke('workspace:ai-changes-import'),
  importProject: () => ipcRenderer.invoke('workspace:import'),
  chooseAssets: () => ipcRenderer.invoke('assets:choose'),
  onBeforeClose: (callback) => {
    const listener = (_event, requestId) => callback(requestId);
    ipcRenderer.on('workspace:before-close', listener);
    ipcRenderer.send('workspace:close-handler-ready', true);
    return () => {
      ipcRenderer.removeListener('workspace:before-close', listener);
      ipcRenderer.send('workspace:close-handler-ready', false);
    };
  },
  closeResult: (result) => ipcRenderer.invoke('workspace:close-result', result),
});
