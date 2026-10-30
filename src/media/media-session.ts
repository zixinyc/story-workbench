export type MediaStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error' | 'disposed';

export interface MediaHandle {
  play(soundId?: number): number | null;
  pause(soundId: number): void;
  stop(soundId?: number): void;
  seekMs(milliseconds: number, soundId: number): void;
  setVolume?(volume: number): void;
  setLoop?(loop: boolean): void;
  dispose(): void;
}

export interface MediaBackend {
  prepare(assetId: string, signal: AbortSignal, events: MediaEvents): Promise<MediaHandle>;
}

export interface MediaEvents {
  ended(): void;
  error(cause: unknown): void;
}

export interface MediaSnapshot {
  status: MediaStatus;
  assetId: string | null;
  error: string | null;
}

export class MediaSession {
  private backend: MediaBackend;
  private onChange: (snapshot: MediaSnapshot) => void;
  private generation = 0;
  private controller: AbortController | null = null;
  private handle: MediaHandle | null = null;
  private soundId: number | null = null;
  private offsetMs = 0;
  private wantsPlayback = false;
  private volume = 1;
  private loop = false;
  private state: MediaSnapshot = { status: 'idle', assetId: null, error: null };

  constructor(backend: MediaBackend, onChange: (snapshot: MediaSnapshot) => void = () => {}) {
    this.backend = backend;
    this.onChange = onChange;
  }

  snapshot(): MediaSnapshot {
    return { ...this.state };
  }

  async start(assetId: string, offsetMs = 0): Promise<void> {
    if (this.state.status === 'disposed') throw new Error('媒体会话已释放。');
    if (!assetId.trim()) throw new Error('缺少音频素材 ID。');
    this.validateOffset(offsetMs);
    const cleanupError = this.invalidate();
    if (cleanupError) {
      this.state = { status: 'error', assetId: this.state.assetId, error: cleanupError };
      this.publish();
      return;
    }
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.offsetMs = offsetMs;
    this.wantsPlayback = true;
    this.state = { status: 'loading', assetId, error: null };
    this.publish();

    try {
      const handle = await this.backend.prepare(assetId, controller.signal, {
        ended: () => {
          if (generation === this.generation && this.state.status === 'playing') this.stop();
        },
        error: (cause) => {
          if (generation === this.generation) this.fail(cause);
        },
      });
      if (generation !== this.generation) {
        handle.dispose();
        return;
      }
      this.controller = null;
      this.handle = handle;
      if (this.volume !== 1) handle.setVolume?.(this.volume);
      if (this.loop) handle.setLoop?.(true);
      if (this.wantsPlayback) this.activate();
      else {
        this.state.status = 'paused';
        this.publish();
      }
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }

  pause(): void {
    if (!['loading', 'playing'].includes(this.state.status)) return;
    this.wantsPlayback = false;
    try {
      if (this.handle && this.soundId !== null) this.handle.pause(this.soundId);
      this.state.status = 'paused';
      this.publish();
    } catch (error) {
      this.fail(error);
    }
  }

  resume(): void {
    if (this.state.status !== 'paused') return;
    this.wantsPlayback = true;
    if (!this.handle) {
      this.state.status = 'loading';
      this.publish();
      return;
    }
    try {
      this.activate();
    } catch (error) {
      this.fail(error);
    }
  }

  seekMs(milliseconds: number): void {
    this.validateOffset(milliseconds);
    if (!['loading', 'playing', 'paused'].includes(this.state.status)) return;
    this.offsetMs = milliseconds;
    try {
      if (this.handle && this.soundId !== null) this.handle.seekMs(milliseconds, this.soundId);
    } catch (error) {
      this.fail(error);
    }
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new RangeError('音量必须在 0 到 1 之间。');
    this.volume = volume;
    this.handle?.setVolume?.(volume);
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    this.handle?.setLoop?.(loop);
  }

  stop(): void {
    if (this.state.status === 'disposed') return;
    const error = this.invalidate();
    this.state = { status: error ? 'error' : 'idle', assetId: null, error };
    this.publish();
  }

  dispose(): void {
    if (this.state.status === 'disposed') return;
    const error = this.invalidate();
    this.state = { status: 'disposed', assetId: null, error };
    this.publish();
  }

  private activate(): void {
    if (!this.handle) return;
    const handle = this.handle;
    const generation = this.generation;
    const firstPlay = this.soundId === null;
    const soundId = handle.play(this.soundId ?? undefined);
    if (generation !== this.generation) return;
    if (soundId === null || !Number.isFinite(soundId)) throw new Error('音频未能开始播放。');
    this.soundId = soundId;
    if (firstPlay && this.offsetMs > 0) handle.seekMs(this.offsetMs, soundId);
    if (generation !== this.generation) return;
    this.state.status = 'playing';
    this.publish();
  }

  private invalidate(): string | null {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    const handle = this.handle;
    const soundId = this.soundId;
    this.handle = null;
    this.soundId = null;
    this.wantsPlayback = false;
    if (!handle) return null;
    let error: string | null = null;
    try {
      if (soundId !== null) handle.stop(soundId);
    } catch (cause) {
      error = String(cause);
    }
    try {
      handle.dispose();
    } catch (cause) {
      error = [error, String(cause)].filter(Boolean).join('；');
    }
    return error;
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const cleanupError = this.invalidate();
    this.state = { status: 'error', assetId: this.state.assetId, error: [message, cleanupError].filter(Boolean).join('；') };
    this.publish();
  }

  private validateOffset(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('音频时间必须是非负有限毫秒数。');
  }

  private publish(): void {
    this.onChange(this.snapshot());
  }
}
