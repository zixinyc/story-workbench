import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, chmod, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectLibrary } from '../electron/project-library.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
async function tempRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test('工程库：两份工程的内容、恢复历史和外部保存位置互相隔离', async () => {
  const root = await tempRoot('swb-library-isolate-');
  try {
    const library = createProjectLibrary(root);
    const a = await library.create(Buffer.from('project-A'), { name: '工程甲', projectId: 'project-a' });
    const b = await library.create(Buffer.from('project-B'), { name: '工程乙', projectId: 'project-b' });

    /* A 另存到一个外部文件；B 不设外部目标 */
    const external = path.join(root, 'external-A.storypack.zip');
    await library.saveAsTo(a.key, Buffer.from('A-v1'), external);

    /* B 只做本机自动保存 */
    await library.save(b.key, Buffer.from('B-v1'));

    assert.deepEqual(await library.load(a.key), new Uint8Array(Buffer.from('A-v1')));
    assert.deepEqual(await library.load(b.key), new Uint8Array(Buffer.from('B-v1')));
    assert.equal(await library.saveTarget(a.key), external, 'A 的外部保存位置应绑定在 A 自己身上');
    assert.equal(await library.saveTarget(b.key), null, 'B 不应继承 A 的外部保存位置');
    assert.deepEqual(await readFile(external), Buffer.from('A-v1'), 'B 的自动保存不应改动 A 的外部文件');

    /* A 再保存一次，仍然只写自己的外部文件 */
    await library.save(a.key, Buffer.from('A-v2'));
    assert.deepEqual(await readFile(external), Buffer.from('A-v2'));
    assert.deepEqual(await library.load(b.key), new Uint8Array(Buffer.from('B-v1')), 'A 的保存不应影响 B 的本机内容');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('工程库：外部保存位置按工程绑定，目录键不是工程名', async () => {
  const root = await tempRoot('swb-library-key-');
  try {
    const library = createProjectLibrary(root);
    const entry = await library.create(Buffer.from('x'), { name: '会被改掉的名字', projectId: 'project-x' });
    assert.match(entry.key, /^p-[0-9a-f-]{36}$/);
    assert.notEqual(entry.key, entry.name);

    /* 改名只改目录元数据，磁盘目录不动 */
    const renamed = await library.rename(entry.key, '新名字');
    assert.equal(renamed.name, '新名字');
    assert.equal(renamed.key, entry.key);
    const state = await library.list();
    assert.equal(state.projects.length, 1);
    assert.equal(state.projects[0].name, '新名字');
    assert.deepEqual(await library.load(entry.key), new Uint8Array(Buffer.from('x')), '改名不应动内容');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('工程库：旧单工程首次迁移后内容一致，原文件与恢复证据保留，重复启动不重复复制', async () => {
  const root = await tempRoot('swb-library-migrate-');
  try {
    const legacy = path.join(root, 'workspace.storypack.zip');
    const legacyRestore = path.join(root, 'restore.storypack.zip');
    const legacyHistory = path.join(root, 'history', '1700000000000-regular-1111.storypack.zip');
    const legacyTarget = path.join(root, 'save-target.json');
    await mkdir(path.dirname(legacyHistory), { recursive: true });
    await writeFile(legacy, Buffer.from('legacy project'));
    await writeFile(legacyRestore, Buffer.from('legacy restore point'));
    await writeFile(legacyHistory, Buffer.from('legacy snapshot'));
    await writeFile(legacyTarget, JSON.stringify({ path: path.join(root, 'external.storypack.zip') }));

    const library = createProjectLibrary(root);
    const before = await library.list();
    assert.equal(before.legacyPending, true, '旧文件存在时必须提示待迁移');
    assert.equal(before.projects.length, 0);

    const bytes = await library.loadLegacy();
    assert.deepEqual(bytes, new Uint8Array(Buffer.from('legacy project')));
    const entry = await library.adoptLegacy(bytes, { name: '旧工程', projectId: 'project-legacy' });

    assert.deepEqual(await library.load(entry.key), new Uint8Array(Buffer.from('legacy project')), '迁移后内容必须一致');
    assert.deepEqual(await readFile(legacy), Buffer.from('legacy project'), '旧文件必须原样保留');
    assert.deepEqual(await readFile(legacyRestore), Buffer.from('legacy restore point'), '旧恢复点必须原样保留');
    assert.deepEqual(await readFile(legacyHistory), Buffer.from('legacy snapshot'), '旧历史版本必须原样保留');
    assert.equal(await readFile(legacyTarget, 'utf8'), JSON.stringify({ path: path.join(root, 'external.storypack.zip') }), '旧保存位置设置必须原样保留');

    /* 迁移出来的工程带着自己的恢复证据和外部保存位置 */
    assert.deepEqual(await library.restorePoint(entry.key), new Uint8Array(Buffer.from('legacy restore point')));
    assert.equal(await library.saveTarget(entry.key), path.join(root, 'external.storypack.zip'));
    const versions = await library.historyList(entry.key);
    assert.ok(versions.some((item) => item.id === 'legacy-restore'), '迁移后应保留上一份内容作为恢复点');
    assert.ok(versions.some((item) => item.id.includes('1700000000000-regular-')), '迁移后应保留旧的历史快照');

    /* 重复启动：不再提示待迁移，也不会再复制一份 */
    const again = createProjectLibrary(root);
    const after = await again.list();
    assert.equal(after.legacyPending, false, '迁移过就不应反复提示');
    assert.equal(after.projects.length, 1, '重复启动不应多出一份工程');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('工程库：状态文件坏掉不会把空库写回覆盖原库', async () => {
  const root = await tempRoot('swb-library-state-');
  try {
    const library = createProjectLibrary(root);
    const entry = await library.create(Buffer.from('keep me'), { name: '别丢我', projectId: 'project-keep' });
    await library.setActive(entry.key);

    /* 状态文件损坏 */
    await writeFile(path.join(root, 'library', 'state.json'), '{ this is not json');

    const reopened = createProjectLibrary(root);
    await assert.rejects(() => reopened.list(), /状态文件已损坏/);

    /* 工程目录和内容都还在，没有被清空 */
    const statePath = path.join(root, 'library', 'projects', entry.key, 'workspace.storypack.zip');
    assert.deepEqual(await readFile(statePath), Buffer.from('keep me'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('工程库：工程目录里的元数据坏了不会连带丢掉其它工程', async () => {
  const root = await tempRoot('swb-library-meta-');
  try {
    const library = createProjectLibrary(root);
    await library.create(Buffer.from('A'), { name: '甲', projectId: 'project-a' });
    const broken = await library.create(Buffer.from('B'), { name: '乙', projectId: 'project-b' });
    await writeFile(path.join(root, 'library', 'projects', broken.key, 'meta.json'), 'not json');

    const state = await createProjectLibrary(root).list();
    assert.equal(state.projects.length, 1, '坏掉的元数据应被跳过，但目录不能被删');
    assert.equal(state.projects[0].name, '甲');
    assert.deepEqual(await readFile(path.join(root, 'library', 'projects', broken.key, 'workspace.storypack.zip')), Buffer.from('B'), '坏掉的工程内容仍保留在磁盘上');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('工程库：旧文件读不出来时不能当成「没有旧数据」', async () => {
  const root = await tempRoot('swb-library-unreadable-');
  try {
    const legacy = path.join(root, 'workspace.storypack.zip');
    await writeFile(legacy, Buffer.from('legacy project'));
    /* 目录存在但文件读不出来：用一个目录顶替同名路径，读取会失败 */
    await rm(legacy);
    await mkdir(legacy);
    const library = createProjectLibrary(root);
    await assert.rejects(() => library.loadLegacy(), /EISDIR|illegal operation|EPERM|EACCES/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('工程库：导入提交会先留一份保护快照，替换后旧内容仍可找回', async () => {
  const root = await tempRoot('swb-library-replace-');
  try {
    const library = createProjectLibrary(root);
    const entry = await library.create(Buffer.from('old content'), { name: '会被替换的', projectId: 'project-old' });
    await library.importCommit(entry.key, Buffer.from('new content'), { name: '替换来的', projectId: 'project-old' });
    assert.deepEqual(await library.load(entry.key), new Uint8Array(Buffer.from('new content')));
    const versions = await library.historyList(entry.key);
    assert.ok(versions.some((item) => item.id.includes('-protected-')), '替换前应留下保护快照');
    const state = await library.list();
    assert.equal(state.projects[0].name, '替换来的');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('工程库：存储键必须是受校验的内部标识', async () => {
  const root = await tempRoot('swb-library-guard-');
  try {
    const library = createProjectLibrary(root);
    await assert.rejects(() => library.load('../escape'), /工程标识无效/);
    await assert.rejects(() => library.load('p-not-a-uuid'), /工程标识无效/);
    await assert.rejects(() => library.load(''), /工程标识无效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
