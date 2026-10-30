import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceStore } from '../electron/workspace-store.mjs';

test('导入前备份与自动保存恢复点分开，后续自动保存不会覆盖导入前备份', async () => {
  const root = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.workspace-store-'));
  try {
    const store = createWorkspaceStore(root);
    const projectA = Uint8Array.from([1, 2, 3]);
    const importedB = Uint8Array.from([4, 5, 6]);
    const editedB = Uint8Array.from([7, 8, 9]);
    await store.save(projectA);
    await store.commitImport(importedB);
    await store.save(editedB);
    assert.deepEqual(store.loadImportBackup && await store.loadImportBackup(), projectA);
    assert.deepEqual(await store.load(), editedB);
    assert.deepEqual(await store.loadRestore(), importedB);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('误删后连续保存不会挤掉保护快照，能列出并读取早期有效版本', async () => {
  const root = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.workspace-store-'));
  try {
    const store = createWorkspaceStore(root);
    const valid = Uint8Array.from([21, 22, 23]);
    await store.save(valid);
    await store.save(Uint8Array.from([0]), { protectCurrent: true });
    for (let i = 0; i < 30; i++) await store.save(Uint8Array.from([0, i]));
    const versions = await store.listRestoreVersions();
    const protectedVersion = versions.find((item) => item.id.includes('-protected-'));
    assert.ok(protectedVersion);
    assert.deepEqual(await store.loadRestoreVersion(protectedVersion.id), valid);
    assert.ok(versions.length <= 21);
    assert.throws(() => store.loadRestoreVersion('../workspace.storypack.zip'), /标识无效/);
    await store.applyRestore(valid);
    assert.deepEqual(await store.load(), valid);
    assert.ok((await store.listRestoreVersions()).filter((item) => item.id.includes('-protected-')).length >= 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
