// Optional sound alarm: while the page is open, a strong new earthquake plays a short
// chime and, if allowed, shows a system notification. Off until the visitor turns it
// on (browsers only allow sound after a tap or click). The choice is remembered.

const KEY = 'sismo-alarm';

export class Alarm {
  constructor({ minMag = 4 } = {}) {
    this.minMag = minMag;
    this.ctx = null;
    try { this.on = localStorage.getItem(KEY) === 'on'; } catch { this.on = false; }
    if (this.on) {
      // Sound needs a gesture after each page load: unlock it on the first one.
      const unlock = () => { this.audio(); document.removeEventListener('pointerdown', unlock); };
      document.addEventListener('pointerdown', unlock);
    }
  }

  audio() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    if (!this.ctx) this.ctx = new AC();
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Turns it on or off; on, plays the chime once so people know how it sounds. */
  async toggle() {
    this.on = !this.on;
    try { localStorage.setItem(KEY, this.on ? 'on' : 'off'); } catch { /* storage off */ }
    if (this.on) {
      this.chime(1);
      if (globalThis.Notification?.permission === 'default') {
        try { await Notification.requestPermission(); } catch { /* not allowed here */ }
      }
    }
    return this.on;
  }

  /** Three rising tones (or one, for the test). */
  chime(times = 3) {
    const ctx = this.audio();
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.05;
    for (let i = 0; i < times; i++) {
      for (const [f, dt] of [[660, 0], [880, 0.18]]) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        const s = t0 + i * 0.7 + dt;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.3, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.4);
        o.connect(g).connect(ctx.destination);
        o.start(s);
        o.stop(s + 0.45);
      }
    }
  }

  /** A new earthquake arrived: ring if it is strong enough. Returns whether it rang. */
  ring(ev, { title, body } = {}) {
    if (!this.on || ev.mag < this.minMag) return false;
    this.chime(3);
    if (globalThis.Notification?.permission === 'granted' && document.hidden) {
      try { new Notification(title, { body, tag: `sismo-${ev.id}` }); } catch { /* some browsers need a service worker */ }
    }
    return true;
  }
}
