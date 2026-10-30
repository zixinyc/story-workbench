import { musicRangeAt } from '../domain/model/chapters.mjs';

export function createChapterMediaController({ getChapter, getMusicSession, getEffectSession }) {
  let activeRangeId = null;

  return {
    enter(cue) {
      const range = musicRangeAt(getChapter(), cue.paragraphId);
      if (range?.id !== activeRangeId) {
        const hadActiveRange = activeRangeId !== null;
        activeRangeId = range?.id ?? null;
        const music = getMusicSession();
        if (range) {
          music?.setVolume(range.volume);
          music?.setLoop(range.loop);
          void music?.start(range.assetId);
        } else if (hadActiveRange) music?.stop();
      }
      const effects = getEffectSession();
      if (cue.settings.audioId) void effects?.start(cue.settings.audioId);
      else effects?.stop();
    },
    pause() { getMusicSession()?.pause(); getEffectSession()?.pause(); },
    resume() { getMusicSession()?.resume(); getEffectSession()?.resume(); },
    seekEffects(milliseconds) { getEffectSession()?.seekMs(milliseconds); },
    stop() {
      activeRangeId = null;
      getMusicSession()?.stop();
      getEffectSession()?.stop();
    },
  };
}
