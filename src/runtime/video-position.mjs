export function videoPositionSeconds(layer, elapsedMs, durationSeconds) {
  const start = Math.max(0, (layer.videoStartMs ?? 0) / 1000);
  const limit = Number.isFinite(durationSeconds) ? durationSeconds : Infinity;
  const end = Math.min(limit, layer.videoEndMs === undefined ? limit : layer.videoEndMs / 1000);
  const span = Math.max(0, end - start);
  const offset = Math.max(0, elapsedMs / 1000);
  const position = layer.videoLoop && Number.isFinite(span) && span > 0 ? start + offset % span : start + offset;
  return Math.max(0, Math.min(position, end, limit));
}
