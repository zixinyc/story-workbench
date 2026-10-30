export function playbackStartIndex(plan, selectedCueId, mode) {
  if (mode === 'auto') return 0;
  return Math.max(0, plan.findIndex((cue) => cue.id === selectedCueId));
}

export function createPlayer({ getPlan, onChange, onEnter, onPauseMedia, onResumeMedia, onSeekMedia, onStopMedia }) {
  let status = 'stopped';
  let index = 0;
  let elapsedMs = 0;
  let startedAt = 0;
  let runMode = null;
  let timer = null;
  let token = 0;

  const current = () => getPlan()[index] ?? null;
  const duration = () => Math.max(500, current()?.settings.durationMs ?? 3500);
  const snapshot = () => ({ status, index, cue: current(), elapsedMs, durationMs: duration(), runMode });
  const publish = () => onChange(snapshot());

  function clearLoop() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function shouldAutoAdvance(cue) {
    if (runMode === 'auto') return true;
    if (runMode === 'click') return false;
    return cue?.settings.advance === 'timed';
  }

  function stop() {
    token += 1;
    clearLoop();
    status = 'stopped';
    elapsedMs = 0;
    runMode = null;
    onStopMedia();
    publish();
  }

  function enter(nextIndex) {
    const plan = getPlan();
    if (nextIndex < 0 || nextIndex >= plan.length) return stop();
    index = nextIndex;
    elapsedMs = 0;
    startedAt = performance.now();
    onEnter(plan[index], index);
    publish();
  }

  function loop(currentToken) {
    clearLoop();
    if (status !== 'playing' || currentToken !== token) return;
    timer = setTimeout(() => {
      if (status !== 'playing' || currentToken !== token) return;
      const now = performance.now();
      elapsedMs = Math.min(duration(), now - startedAt);
      const cue = current();
      if (shouldAutoAdvance(cue) && elapsedMs >= duration()) {
        enter(index + 1);
      } else {
        publish();
      }
      loop(currentToken);
    }, 80);
  }

  function playFrom(startIndex, mode = null) {
    const plan = getPlan();
    if (!plan.length) return;
    token += 1;
    clearLoop();
    onStopMedia();
    runMode = mode;
    status = 'playing';
    enter(Math.max(0, Math.min(startIndex, plan.length - 1)));
    loop(token);
  }

  function pause() {
    if (status !== 'playing') return;
    elapsedMs = Math.min(duration(), performance.now() - startedAt);
    status = 'paused';
    clearLoop();
    onPauseMedia();
    publish();
  }

  function resume() {
    if (status !== 'paused') return;
    status = 'playing';
    startedAt = performance.now() - elapsedMs;
    onResumeMedia();
    publish();
    loop(token);
  }

  function advance() {
    if (status !== 'playing' || shouldAutoAdvance(current())) return false;
    enter(index + 1);
    return true;
  }

  function seek(fraction) {
    if (!['playing', 'paused'].includes(status)) return;
    elapsedMs = duration() * Math.max(0, Math.min(1, fraction));
    startedAt = performance.now() - elapsedMs;
    onSeekMedia(elapsedMs);
    if (status === 'playing' && shouldAutoAdvance(current()) && elapsedMs >= duration()) enter(index + 1);
    publish();
  }

  return {
    playFrom,
    pause,
    resume,
    stop,
    advance,
    seek,
    snapshot,
    getPlan,
    isWaitingForInput: () => status === 'playing' && !shouldAutoAdvance(current()),
  };
}
