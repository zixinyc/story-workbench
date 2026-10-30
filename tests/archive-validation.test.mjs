import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createDemoProject } from '../src/domain/model/project.mjs';
import { createProjectArchive, readProjectArchive } from '../src/persistence/archive.mjs';

globalThis.JSZip = JSZip;

test('工程包素材完整往返，坏工程在提交前被拒绝', async () => {
  const project = createDemoProject();
  const asset = { id: 'audio-test', name: '序曲.wav', kind: 'audio', mime: 'audio/wav', size: 4 };
  project.assets.push(asset);
  const blob = new Blob(['WAVE'], { type: asset.mime });
  const archive = await createProjectArchive(project, [{ ...asset, blob }]);
  const loaded = await readProjectArchive(archive);
  assert.deepEqual(loaded.project, project);
  assert.equal(loaded.assets[0].blob.size, 4);
  assert.equal(loaded.assets[0].blob.type, 'audio/wav');

  const zip = await JSZip.loadAsync(archive);
  const data = JSON.parse(await zip.file('project.json').async('string'));
  data.chapters[0].document.blocks.find((block) => block.children[0]?.type === 'cue').children[0].settings.color = null;
  zip.file('project.json', JSON.stringify(data));
  const invalid = await zip.generateAsync({ type: 'blob' });
  await assert.rejects(readProjectArchive(invalid), /颜色/);
});

test('工程包素材缺失或尺寸不符时不返回半载入工程', async () => {
  const project = createDemoProject();
  const asset = { id: 'asset-1', name: 'image.png', kind: 'image', mime: 'image/png', size: 5 };
  project.assets.push(asset);
  const archive = await createProjectArchive(project, [{ ...asset, blob: new Blob(['12345'], { type: asset.mime }) }]);
  const zip = await JSZip.loadAsync(archive);
  zip.file('assets/asset-1', '1234');
  const bad = await zip.generateAsync({ type: 'blob' });
  await assert.rejects(readProjectArchive(bad), /大小/);
});
