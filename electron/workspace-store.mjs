import { readFile, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { replaceSafely } from './atomic-write.mjs';

const maxPackBytes = 512 * 1024 * 1024;

export function createWorkspaceStore(userDataPath) {
  const currentPath = path.join(userDataPath, 'workspace.storypack.zip');
  const restorePath = path.join(userDataPath, 'restore.storypack.zip');
  const importBackupPath = path.join(userDataPath, 'before-import.storypack.zip');
  const historyPath = path.join(userDataPath, 'history');
  const listHistory = async () => {
    let names;
    try { names = await readdir(historyPath); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const rows = await Promise.all(names.filter((name) => /^\d{13}-(regular|protected)-[a-f0-9-]+\.storypack\.zip$/.test(name)).map(async (id) => {
      const info = await stat(path.join(historyPath, id));
      return { id, savedAt: new Date(Number(id.slice(0, 13))).toISOString(), bytes: info.size, reason: id.includes('-protected-') ? '大量删字 / 切换工程前保护' : '定时快照' };
    }));
    return rows.sort((a, b) => b.id.localeCompare(a.id));
  };
  const archiveCurrent = async (protect = false) => {
    const current = await readOptional(currentPath);
    if (!current) return;
    const rows = await listHistory();
    const category = protect ? 'protected' : 'regular';
    const sameCategory = rows.filter((row) => row.id.includes(`-${category}-`));
    if (!protect && sameCategory[0] && Date.now() - Number(sameCategory[0].id.slice(0, 13)) < 5 * 60 * 1000) return;
    const hash = createHash('sha256').update(current).digest('hex');
    if (sameCategory[0]) {
      const latest = await readFile(path.join(historyPath, sameCategory[0].id));
      if (createHash('sha256').update(latest).digest('hex') === hash) return;
    }
    await replaceSafely(path.join(historyPath, `${Date.now()}-${category}-${randomUUID()}.storypack.zip`), current);
  };
  const pruneHistory = async () => {
    const rows = await listHistory();
    for (const [category, limit] of [['regular', 12], ['protected', 8]]) {
      for (const row of rows.filter((item) => item.id.includes(`-${category}-`)).slice(limit)) await rm(path.join(historyPath, row.id), { force: true });
    }
  };
  const applySavedPack = async (value) => {
      const bytes = checkedBytes(value);
      await archiveCurrent(true);
      await replaceSafely(currentPath, bytes);
      await pruneHistory();
      return { savedAt: new Date().toISOString(), bytes: bytes.byteLength };
    };
  return {
    listRestoreVersions: async () => {
      const rows = await listHistory();
      try { const info = await stat(restorePath); rows.unshift({ id: 'legacy-restore', savedAt: info.mtime.toISOString(), bytes: info.size, reason: '上一次保存' }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return rows;
    },
    loadRestoreVersion: (id) => {
      if (id === 'legacy-restore') return readOptional(restorePath);
      if (typeof id !== 'string' || !/^\d{13}-(regular|protected)-[a-f0-9-]+\.storypack\.zip$/.test(id)) throw new Error('恢复版本标识无效。');
      return readOptional(path.join(historyPath, id));
    },
    load: () => readOptional(currentPath),
    loadRestore: () => readOptional(restorePath),
    loadImportBackup: () => readOptional(importBackupPath),
    save: async (value, options = {}) => {
      const bytes = checkedBytes(value);
      await archiveCurrent(Boolean(options.protectCurrent));
      try {
        const current = await readFile(currentPath);
        await replaceSafely(restorePath, current);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await replaceSafely(currentPath, bytes);
      await pruneHistory();
      return { savedAt: new Date().toISOString(), bytes: bytes.byteLength };
    },
    applyRestore: applySavedPack,
    commitImport: async function (value) {
      const bytes = checkedBytes(value);
      try {
        const current = await readFile(currentPath);
        await replaceSafely(importBackupPath, current);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return this.save(bytes, { protectCurrent: true });
    },
    applyImportBackup: applySavedPack,
  };
}

function checkedBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
  if (!bytes.byteLength || bytes.byteLength > maxPackBytes) throw new Error('工程包大小无效或超过 512 MB。');
  return Buffer.from(bytes);
}

async function readOptional(target) {
  try { return new Uint8Array(await readFile(target)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

