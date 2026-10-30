import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function replaceSafely(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const temp = `${target}.tmp.${suffix}`;
  const previous = `${target}.previous.${suffix}`;
  await writeFile(temp, bytes);
  try {
    await rename(target, previous);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await rm(temp, { force: true });
      throw error;
    }
  }
  try {
    await rename(temp, target);
  } catch (error) {
    try { await rename(previous, target); } catch {}
    await rm(temp, { force: true });
    throw error;
  }
  await rm(previous, { force: true }).catch(() => {});
}
