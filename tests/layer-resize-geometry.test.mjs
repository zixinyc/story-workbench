import test from 'node:test';
import assert from 'node:assert/strict';
import { layerCorner, maxLayerHeight, maxLayerWidth, resizeLayer } from '../src/editor/layer-resize.mjs';

const oppositeCorner = { se: 'nw', nw: 'se', ne: 'sw', sw: 'ne' };

test('未旋转时角点缩放保持对角点不动', () => {
  const start = { x: 400, y: 300, width: 600, height: 300, rotation: 0 };
  const next = resizeLayer(start, 'se', 120, 60);
  const before = layerCorner(start, 'nw');
  const after = layerCorner(next, 'nw');
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6);
});

test('旋转 45 度后缩放，对角点不再漂移（原 I-01）', () => {
  const start = { x: 400, y: 300, width: 600, height: 300, rotation: 45 };
  const next = resizeLayer(start, 'se', 150, 75);
  const before = layerCorner(start, 'nw');
  const after = layerCorner(next, 'nw');
  assert.ok(Math.abs(before.x - after.x) < 1e-6, `对角点横向漂移 ${Math.abs(before.x - after.x).toFixed(2)}px`);
  assert.ok(Math.abs(before.y - after.y) < 1e-6, `对角点纵向漂移 ${Math.abs(before.y - after.y).toFixed(2)}px`);
});

test('多个角度与四个角都保持固定角不动', () => {
  for (const rotation of [0, 45, 90, 180, -45, 137]) {
    const start = { x: 400, y: 300, width: 600, height: 300, rotation };
    for (const [handle, anchor] of Object.entries(oppositeCorner)) {
      const next = resizeLayer(start, handle, 130, 80);
      const before = layerCorner(start, anchor);
      const after = layerCorner(next, anchor);
      assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6, `${rotation}度拖${handle}时 ${anchor} 漂移`);
    }
  }
});

test('尺寸上限下等比缩放不破坏比例（原 I-02）', () => {
  const start = { x: 100, y: 100, width: 1500, height: 100, rotation: 0 };
  const next = resizeLayer(start, 'se', 9000, 9000);
  assert.equal(next.width, maxLayerWidth);
  assert.equal(next.height, 256, '高度应按同一比例缩放，而不是被单独截断');
  assert.ok(Math.abs(next.width / next.height - 15) < 1e-6, `宽高比应为 15，实际 ${next.width / next.height}`);
  assert.ok(next.height <= maxLayerHeight);
});

test('被上限截断时锚点仍然不动', () => {
  const start = { x: 100, y: 100, width: 1500, height: 100, rotation: 30 };
  const next = resizeLayer(start, 'se', 9000, 9000);
  const before = layerCorner(start, 'nw');
  const after = layerCorner(next, 'nw');
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6);
});

test('最小尺寸同样按比例收缩，不会只压一边', () => {
  const start = { x: 100, y: 100, width: 1500, height: 100, rotation: 0 };
  const next = resizeLayer(start, 'nw', 9000, 9000);
  assert.equal(next.width, 360);
  assert.equal(next.height, 24);
  assert.ok(Math.abs(next.width / next.height - 15) < 1e-6);
});

test('超宽图缩小时仍按比例，不会因下限把比例改掉', () => {
  const start = { x: 100, y: 100, width: 3840, height: 100, rotation: 0 };
  const next = resizeLayer(start, 'se', 0, 0);
  assert.ok(Math.abs(next.width / next.height - 38.4) < 1e-6, `宽高比应为 38.4，实际 ${next.width / next.height}`);
});

test('边手柄仍允许非等比缩放', () => {
  const start = { x: 400, y: 300, width: 600, height: 300, rotation: 0 };
  const next = resizeLayer(start, 'e', 200, 999);
  assert.equal(next.height, 300, '拖边手柄时另一维不变');
  assert.equal(next.width, 800);
});

test('边手柄在旋转后保持固定边线不动', () => {
  const start = { x: 400, y: 300, width: 600, height: 300, rotation: 45 };
  const next = resizeLayer(start, 'e', 150, 75);
  // 拖东侧手柄时，西侧的 nw 与 sw 两个角都必须钉在原地
  for (const anchor of ['nw', 'sw']) {
    const before = layerCorner(start, anchor);
    const after = layerCorner(next, anchor);
    assert.ok(Math.abs(before.x - after.x) < 1e-6, `${anchor} 横向移动了 ${Math.abs(before.x - after.x)}`);
    assert.ok(Math.abs(before.y - after.y) < 1e-6, `${anchor} 纵向移动了 ${Math.abs(before.y - after.y)}`);
  }
});

test('拖到对侧之外不会产生负尺寸或翻转', () => {
  const start = { x: 400, y: 300, width: 600, height: 300, rotation: 0 };
  const next = resizeLayer(start, 'e', -5000, 0);
  assert.ok(next.width > 0 && next.height > 0, '宽高必须保持为正');
  assert.ok(next.width >= 24 && next.height >= 24);
});
