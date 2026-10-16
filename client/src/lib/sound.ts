/**
 * Best-effort Web Audio chimes. They never throw and are a no-op when the
 * browser has no AudioContext (or the user never interacted with the page yet).
 */
function tone(freqs: number[], duration = 0.5, volume = 0.16) {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    freqs.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = now + index * 0.15;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(volume, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    });
  } catch {
    /* audio is best-effort */
  }
}

/** Two-note chime for a new incoming message. */
export const playChime = () => tone([659.25, 880]);
/** Rising three-note chime for a finished task. */
export const playDone = () => tone([523.25, 783.99, 1046.5]);
/** Sharper two-note alert for something needing attention. */
export const playAlert = () => tone([880, 1174.66]);
