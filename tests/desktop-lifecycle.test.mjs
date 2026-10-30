import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createProjectLibrary } from '../electron/project-library.mjs';
import { replaceSafely } from '../electron/atomic-write.mjs';

async function desktopHarness(root, env = {}) {
  const userDataPaths = [];
  const handlers = new Map();
  const ipc = new EventEmitter();
  ipc.handle = (name, handler) => handlers.set(name, handler);
  const windows = [];
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.send = (...args) => { this.sent = args; };
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    async loadFile() {}
    async loadURL() {}
    close() { this.closeCalled = true; }
    static getAllWindows() { return windows; }
  }
  const app = { getPath: (kind) => kind === 'exe' ? path.join(root, '剧情创作工作台.exe') : root, getAppPath: () => root, setPath(name, value) { userDataPaths.push({name, value}); }, isPackaged: true, whenReady: () => ({ then() {} }), on() {}, quit() {} };
  const context = vm.createContext({
    app, BrowserWindow: Window, dialog: {}, ipcMain: ipc, shell: {},
    Buffer, Uint8Array, path, readFile, writeFile, existsSync, createProjectLibrary, replaceSafely,
    process: { env, resourcesPath: root, platform: 'win32' },
  });
  const source = (await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source + '\nglobalThis.testApi = {registerIpc,createWindow};', context);
  context.testApi.registerIpc();
  return { ...context.testApi, handlers, ipc, windows, userDataPaths };
}

test('每个工程一份内容与外部保存位置：新工程的保存不覆盖旧工程的外部文件', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'swb-native-library-'));
  try {
    const h = await desktopHarness(root);
    const library = createProjectLibrary(root);
    const a = await h.handlers.get('library:create')({}, Buffer.from('self-generated A'), { name: '工程甲', projectId: 'project-a' });
    const b = await h.handlers.get('library:create')({}, Buffer.from('self-generated B'), { name: '工程乙', projectId: 'project-b' });

    const external = path.join(root, 'A.storypack.zip');
    await library.saveAsTo(a.key, Buffer.from('A v1'), external);

    await h.handlers.get('library:save')( {}, b.key, Buffer.from('B v1'), {});

    assert.deepEqual(await readFile(external), Buffer.from('A v1'), 'B 的自动保存不应改动 A 的外部文件');
    assert.deepEqual(await library.load(a.key), new Uint8Array(Buffer.from('A v1')));
    assert.deepEqual(await library.load(b.key), new Uint8Array(Buffer.from('B v1')));
    assert.equal(await h.handlers.get('library:save-target')({}, a.key), external);
    assert.equal(await h.handlers.get('library:save-target')({}, b.key), null, '新工程不应继承旧工程的保存位置');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('导入提交失败时工程的外部保存位置保持不变，不会被静默清空', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'swb-native-library-fail-'));
  try {
    const h = await desktopHarness(root);
    const library = createProjectLibrary(root);
    const entry = await h.handlers.get('library:create')({}, Buffer.from('self-generated original'), { name: '工程甲', projectId: 'project-a' });
    const target = path.join(root, 'old-project.storypack.zip');
    await writeFile(target, Buffer.from('external original'));
    await library.saveAsTo(entry.key, Buffer.from('self-generated original'), target);

    // 用超过体积上限的内容触发导入失败
    await assert.rejects(
      () => h.handlers.get('library:import-commit')({}, entry.key, Buffer.alloc(0), {}),
      /大小无效/,
    );
    assert.equal(await h.handlers.get('library:save-target')({}, entry.key), target, '导入失败后保存位置必须还是原位置');
    assert.deepEqual(await readFile(target), Buffer.from('self-generated original'), '原外部工程文件不应被失败的导入改动');
    assert.deepEqual(await library.load(entry.key), new Uint8Array(Buffer.from('self-generated original')), '本机工程不应被失败的导入改动');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('工程库清单按目录推导，重命名不改磁盘目录', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'swb-native-library-list-'));
  try {
    const h = await desktopHarness(root);
    const created = await h.handlers.get('library:create')({}, Buffer.from('x'), { name: '旧名字', projectId: 'project-x' });
    const renamed = await h.handlers.get('library:rename')({}, created.key, '新名字');
    assert.equal(renamed.name, '新名字');
    const state = await h.handlers.get('library:list')();
    assert.equal(state.projects.length, 1);
    assert.equal(state.projects[0].name, '新名字');
    assert.ok(existsSync(path.join(root, 'library', 'projects', created.key, 'workspace.storypack.zip')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('启动和恢复页可关闭，编辑器登记保存处理器后须等待保存结果', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'swb-native-close-'));
  try {
    const h = await desktopHarness(root);
    await h.createWindow();
    const window = h.windows[0];
    let prevented = false;
    const close = () => { prevented = false; window.emit('close', { preventDefault() { prevented = true; } }); return prevented; };
    assert.equal(close(), false);
    h.ipc.emit('workspace:close-handler-ready', { sender: {} }, true);
    assert.equal(close(), false, '其他页面不能登记当前窗口关闭处理器');
    h.ipc.emit('workspace:close-handler-ready', { sender: window.webContents }, true);
    assert.equal(close(), true);
    assert.equal(window.sent[0], 'workspace:before-close');
    h.ipc.emit('workspace:close-handler-ready', { sender: window.webContents }, false);
    assert.equal(close(), false, '进入恢复页并清理编辑器处理器后可关闭');
    h.ipc.emit('workspace:close-handler-ready', { sender: window.webContents }, true);
    window.webContents.emit('render-process-gone');
    assert.equal(close(), false, '渲染进程崩溃时不应锁死窗口');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('便携包直开EXE使用包内数据，显式隔离路径优先且不改默认安装模式', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'swb-native-portable-'));
  try {
    const regular = await desktopHarness(root);
    assert.deepEqual(regular.userDataPaths, []);
    await writeFile(path.join(root, 'portable-mode'), 'local fixture');
    const portable = await desktopHarness(root);
    assert.deepEqual(portable.userDataPaths, [{ name: 'userData', value: path.join(root, '验收数据') }]);
    const isolatedPath = path.join(root, 'different-isolated-data');
    const isolated = await desktopHarness(root, { STORY_WORKBENCH_USER_DATA: isolatedPath });
    assert.deepEqual(isolated.userDataPaths, [{ name: 'userData', value: isolatedPath }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
