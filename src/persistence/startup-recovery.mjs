/**
 * 启动时的工程来源判定。
 *
 * 问题背景：保存过程被打断时，当前工程文件可能整块缺失，而恢复副本其实还在。
 * 旧逻辑只看"当前文件在不在"，缺失就直接新建示例工程，用户会以为自己的工程凭空消失。
 *
 * 这里只做判定与候选排序，不读盘、不写盘：取值交给 bridge，校验交给 readPack。
 * 三种结果必须分开：
 *   - 返回数据：确实有可用恢复来源，正常打开；
 *   - 返回 null：一个恢复来源都读不到、也都没有内容，这才是首次使用；
 *   - 抛错：来源读不出来（有内容但取不到），或有来源校验不过，必须让用户知道，
 *           绝不能静默新建示例工程——那会让用户在示例工程上写作并覆盖磁盘上的原工程。
 *
 * 「读不出来」与「确实没有」的区别在于 bridge 是否抛错：
 * workspace-store 对文件不存在（ENOENT）返回空值，只有权限、占用等真实故障才抛错。
 */
export async function recoverMissingWorkspace(bridge, readPack, limit = 6) {
  const candidates = [];
  const unreadable = [];
  const push = (label, bytes) => { if (bytes && bytes.byteLength) candidates.push({ label, bytes }); };
  /* 读取失败不能当成"没有备份"：记下来，终态判定时据此抛错。 */
  const attempt = async (label, read) => {
    try { push(label, await read()); }
    catch (error) { unreadable.push(`${label}：${error instanceof Error ? error.message : '读取失败'}`); }
  };

  await attempt('恢复点', () => bridge.loadRestore());
  await attempt('导入前备份', () => bridge.loadImportBackup());
  await attempt('历史版本列表', async () => {
    const versions = await bridge.listRestoreVersions();
    /* 单个历史版本读不到不阻断其他候选。 */
    for (const version of versions.slice(0, limit)) {
      await attempt(`历史版本 ${version.reason || version.id}`, () => bridge.loadRestoreVersion(version.id));
    }
  });

  if (!candidates.length) {
    if (!unreadable.length) return null;
    throw new Error([
      '当前工程文件读取不到，而且磁盘上的恢复副本也读不出来。此时新建示例工程会让你误以为自己的工程从未保存过，',
      '一旦在这里保存还会覆盖磁盘上可能仍在的工程，所以已经停在这里。请先处理下面的问题再重试。',
      unreadable.join('\n'),
    ].join('\n'));
  }

  const invalid = [];
  for (const candidate of candidates) {
    try {
      const data = await readPack(candidate.bytes, candidate.label);
      return { ...data, recoveredFrom: candidate.label, sourceBytes: candidate.bytes, unreadable };
    } catch (error) {
      invalid.push(`${candidate.label}：${error instanceof Error ? error.message : '校验失败'}`);
    }
  }
  throw new Error(`当前工程文件缺失，且找到的备份都未能通过校验。请不要清空数据目录，可稍后从恢复页选择可用版本。\n${invalid.join('\n')}`);
}