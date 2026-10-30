/**
 * 图层缩放的几何计算。
 *
 * 单独成模块是为了让"旋转后锚点不动"和"上限不破坏比例"这两条规则可被直接验证，
 * 避免规则散落在事件处理里，改了一处忘了另一处。
 * 本模块是纯计算：不碰 DOM、不读事件、不修改传入的 start。
 */

export const minLayerWidth = 24;
export const minLayerHeight = 24;
export const maxLayerWidth = 3840;
export const maxLayerHeight = 2160;

/**
 * 按一次指针增量求出新的图层矩形。
 * @param {{x:number,y:number,width:number,height:number,rotation:number}} start 起始矩形（舞台坐标）
 * @param {string} handle 'move' 之外的手柄名：se / nw / ne / sw 或边手柄 e / w / n / s
 * @param {number} dx 舞台坐标下的横向指针增量
 * @param {number} dy 舞台坐标下的纵向指针增量
 */
export function resizeLayer(start, handle, dx, dy) {
  const radians = start.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // 指针增量先转进图层的旋转局部坐标，才能判断"相对固定边有多远"
  const localDx = dx * cos + dy * sin;
  const localDy = -dx * sin + dy * cos;
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  let width = start.width;
  let height = start.height;
  if (west || east) width = start.width + localDx * (west ? -1 : 1);
  if (north || handle.includes('s')) height = start.height + localDy * (north ? -1 : 1);
  if (handle.length === 2) {
    // 角点：先求一个统一比例，再按宽高共同允许的范围限幅。
    // 不能事后分别截断宽和高，那会把等比缩放的比例改掉。
    const sx = width / start.width;
    const sy = height / start.height;
    const raw = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
    const lower = Math.max(0.04, minLayerWidth / start.width, minLayerHeight / start.height);
    const upper = Math.min(5, maxLayerWidth / start.width, maxLayerHeight / start.height);
    const factor = Math.max(lower, Math.min(upper, raw));
    width = start.width * factor;
    height = start.height * factor;
  } else {
    width = Math.max(minLayerWidth, Math.min(maxLayerWidth, width));
    height = Math.max(minLayerHeight, Math.min(maxLayerHeight, height));
  }
  // 锚点：把"固定那一侧/角"相对中心的位移按旋转换算回舞台坐标，
  // 旋转后反向手柄才能真正钉在原地，而不是跟着未旋转的左上角走。
  const offsetX = (start.width - width) / 2 * (east ? -1 : 1);
  const offsetY = (start.height - height) / 2 * (north ? 1 : -1);
  return {
    rotation: start.rotation,
    width,
    height,
    x: start.x + start.width / 2 + offsetX * cos - offsetY * sin - width / 2,
    y: start.y + start.height / 2 + offsetX * sin + offsetY * cos - height / 2,
  };
}

/** 某个角在舞台坐标里的实际位置（图层绕自身中心旋转之后） */
export function layerCorner(rect, corner) {
  const radians = rect.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const localX = corner.includes('e') ? rect.width / 2 : -rect.width / 2;
  const localY = corner.includes('s') ? rect.height / 2 : -rect.height / 2;
  return { x: centerX + localX * cos - localY * sin, y: centerY + localX * sin + localY * cos };
}
