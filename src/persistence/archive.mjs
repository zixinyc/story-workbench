import { validateProject } from '../domain/model/project.mjs';
import { migrateProject } from '../domain/model/chapters.mjs';

export async function createProjectArchive(project, assetRecords) {
  if (!globalThis.JSZip) throw new Error('工程包组件未载入。');
  validateProject(project);
  const zip = new globalThis.JSZip();
  zip.file('project.json', JSON.stringify(project, null, 2));
  for (const asset of project.assets) {
    const record = assetRecords.find((item) => item.id === asset.id);
    if (!record?.blob) throw new Error(`素材“${asset.name}”当前不可用，工程包未导出。`);
    zip.file(`assets/${asset.id}`, record.blob);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } });
}

export async function readProjectArchive(file) {
  if (!globalThis.JSZip) throw new Error('工程包组件未载入。');
  let zip;
  try {
    zip = await globalThis.JSZip.loadAsync(file, { checkCRC32: true });
  } catch {
    throw new Error('工程包无法读取，文件可能已损坏。');
  }

  const zipEntries = Object.values(zip.files).filter((entry) => !entry.dir);
  const projectEntry = zipEntries.find((entry) => entry.name === 'project.json');
  const expandedBytes = zipEntries.reduce((sum, entry) => sum + (entry._data?.uncompressedSize ?? 0), 0);
  if (zipEntries.length > 10002 || expandedBytes > 512 * 1024 * 1024 || (projectEntry?._data?.uncompressedSize ?? 0) > 32 * 1024 * 1024) throw new Error('工程包展开后超过安全限制。');

  const projectFile = zip.file('project.json');
  if (!projectFile) throw new Error('工程包缺少 project.json。');
  let project;
  try {
    project = migrateProject(JSON.parse(await projectFile.async('string')));
    validateProject(project);
  } catch (error) {
    throw new Error(error.message || '工程文件格式无效。');
  }

  const records = [];
  for (const asset of project.assets) {
    const fileEntry = zip.file(`assets/${asset.id}`);
    if (!fileEntry) throw new Error(`工程包缺少素材“${asset.name}”，原工程保持不变。`);
    const blob = await fileEntry.async('blob');
    if (blob.size !== asset.size) throw new Error(`素材“${asset.name}”大小与工程清单不一致。`);
    const typedBlob = blob.type === asset.mime ? blob : new Blob([await blob.arrayBuffer()], { type: asset.mime });
    records.push({ ...asset, blob: typedBlob });
  }
  return { project, assets: records };
}
