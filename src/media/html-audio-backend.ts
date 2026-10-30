import type { MediaBackend, MediaEvents, MediaHandle } from './media-session';

export type AudioAsset = { id: string; mime: string; blob: Blob };

export function createHtmlAudioBackend(getAsset: (id: string) => AudioAsset | undefined): MediaBackend {
  return {
    async prepare(assetId: string, signal: AbortSignal, events: MediaEvents): Promise<MediaHandle> {
      const asset = getAsset(assetId);
      if (!asset || !asset.mime.startsWith('audio/')) throw new Error('找不到可播放的音频素材。');
      if (signal.aborted) throw new DOMException('音频准备已取消。', 'AbortError');

      const typedBlob = asset.blob.type === asset.mime
        ? asset.blob
        : new Blob([await asset.blob.arrayBuffer()], { type: asset.mime });
      if (signal.aborted) throw new DOMException('音频准备已取消。', 'AbortError');
      const url = URL.createObjectURL(typedBlob);
      const audio = new Audio();
      audio.preload = 'auto';
      let disposed = false;
      let prepared = false;
      let timer: number | null = null;
      let resolveReady: (() => void) | null = null;
      let rejectReady: ((error: Error) => void) | null = null;

      const cleanup = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        signal.removeEventListener('abort', cancel);
        audio.removeEventListener('loadedmetadata', onReady);
      };
      const onReady = () => {
        prepared = true;
        cleanup();
        audio.removeEventListener('error', onLoadError);
        audio.addEventListener('error', onPlaybackError);
        audio.addEventListener('ended', onEnded);
        resolveReady?.();
      };
      const onLoadError = () => {
        const error = new Error(audio.error?.message || `音频“${assetId}”无法读取。`);
        events.error(error);
        if (!prepared) {
          cleanup();
          audio.removeEventListener('error', onLoadError);
          rejectReady?.(error);
        }
      };
      const cancel = () => {
        disposed = true;
        cleanup();
        audio.removeEventListener('error', onLoadError);
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        URL.revokeObjectURL(url);
        rejectReady?.(new DOMException('音频准备已取消。', 'AbortError'));
      };

      audio.addEventListener('loadedmetadata', onReady, { once: true });
      audio.addEventListener('error', onLoadError);
      signal.addEventListener('abort', cancel, { once: true });
      audio.src = url;

      try {
        await new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
          timer = window.setTimeout(() => reject(new Error(`等待音频“${assetId}”读取超时。`)), 20000);
          audio.load();
        });
      } catch (error) {
        if (!disposed) {
          disposed = true;
          cleanup();
          audio.removeEventListener('error', onLoadError);
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
          URL.revokeObjectURL(url);
        }
        throw error;
      }

      return {
        play(soundId) {
          if (disposed) throw new Error('音频资源已释放。');
          const id = soundId ?? 1;
          const request = audio.play();
          void request.catch((error) => events.error(error));
          return id;
        },
        pause(soundId) {
          if (soundId !== 1) return;
          audio.pause();
        },
        stop(soundId) {
          if (soundId !== undefined && soundId !== 1) return;
          audio.pause();
          try { audio.currentTime = 0; } catch {}
        },
        seekMs(milliseconds, soundId) {
          if (soundId !== 1) return;
          audio.currentTime = milliseconds / 1000;
        },
        setVolume(volume) { audio.volume = volume; },
        setLoop(loop) { audio.loop = loop; },
        dispose() {
          if (disposed) return;
          disposed = true;
          cleanup();
          audio.pause();
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('error', onPlaybackError);
          audio.removeAttribute('src');
          audio.load();
          URL.revokeObjectURL(url);
        },
      };

      function onEnded() { events.ended(); }
      function onPlaybackError() { events.error(new Error(audio.error?.message || `音频“${assetId}”播放失败。`)); }
    },
  };
}
