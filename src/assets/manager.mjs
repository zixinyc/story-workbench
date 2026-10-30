import { makeId } from '../domain/model/document.mjs';

const urls = new Map();

export function describeFile(file) {
  const type = file.type || '';
  const kind = type.startsWith('image/') ? 'image'
    : type.startsWith('audio/') ? 'audio'
      : type === 'video/mp4' || /\.mp4$/i.test(file.name) ? 'video'
      : type.startsWith('text/') || /\.(md|txt|pdf)$/i.test(file.name) ? 'article'
        : 'other';
  return { id: makeId('asset'), name: file.name, kind, mime: type || 'application/octet-stream', size: file.size };
}

export function recordsFromFiles(files) {
  return [...files].map((file) => ({ ...describeFile(file), blob: file }));
}

export function objectUrl(asset) {
  const existing = urls.get(asset.id);
  if (existing?.blob === asset.blob) return existing.url;
  if (existing) URL.revokeObjectURL(existing.url);
  const url = URL.createObjectURL(asset.blob);
  urls.set(asset.id, { blob: asset.blob, url });
  return url;
}

export function revokeUnusedUrls(assets) {
  const ids = new Set(assets.map((asset) => asset.id));
  for (const [id, entry] of urls) {
    if (!ids.has(id)) {
      URL.revokeObjectURL(entry.url);
      urls.delete(id);
    }
  }
}

export function disposeUrls() {
  for (const entry of urls.values()) URL.revokeObjectURL(entry.url);
  urls.clear();
}
