'use strict';

// THIS WORKER IS THE SECURITY BOUNDARY for generated code. It has no DOM by
// nature of being a Worker; on top of that we strip every reachable I/O
// capability at startup as defense in depth. Generated simulate() functions
// run here and can only ever return plain numbers back to the main thread.
(function stripCapabilities() {
  const banned = [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'importScripts',
    'indexedDB',
    'caches',
    'EventSource',
    'Notification',
    'BroadcastChannel',
    'SharedArrayBuffer',
    'WebTransport',
    'RTCPeerConnection',
  ];
  for (const name of banned) {
    try {
      self[name] = undefined;
    } catch {}
    try {
      delete self[name];
    } catch {}
  }
})();

const TICK_MS = 33; // ~30fps
const MAX_PARTICLES = 48; // per word per frame
const MAX_EXTRA = 32; // extra text glyphs per word per frame
const sims = new Map(); // id -> { fn, letterCount, params, start }
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function compile(src) {
  // Shadow anything the generated code might try to reach, even though the
  // globals above are already stripped. The parameters are deliberately
  // undefined at call time.
  const factory = new Function(
    'self',
    'window',
    'document',
    'globalThis',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'importScripts',
    'localStorage',
    'indexedDB',
    'postMessage',
    'onmessage',
    '"use strict";\n' + src + '\nreturn simulate;'
  );
  const fn = factory();
  if (typeof fn !== 'function') throw new Error('no simulate function');
  return fn;
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'add') {
    try {
      const fn = compile(msg.src);
      sims.set(msg.id, {
        fn,
        letterCount: msg.letterCount,
        params: msg.params,
        start: performance.now(),
      });
    } catch {
      postMessage({ type: 'dead', id: msg.id });
    }
  } else if (msg.type === 'remove') {
    sims.delete(msg.id);
  } else if (msg.type === 'clear') {
    sims.clear();
  }
};

setInterval(() => {
  if (sims.size === 0) return;
  const now = performance.now();
  const frames = [];
  const dead = [];
  for (const [id, sim] of sims) {
    const t = (now - sim.start) / 1000;
    let out;
    try {
      out = sim.fn(new Array(sim.letterCount).fill(0), t, sim.params);
    } catch {
      dead.push(id);
      continue;
    }
    // Contract: either an array of per-letter objects, or
    // { letters: [...], particles: [...] }.
    let lettersOut = out;
    let particlesOut = null;
    let extraOut = null;
    if (out && !Array.isArray(out) && typeof out === 'object') {
      lettersOut = out.letters;
      particlesOut = out.particles;
      extraOut = out.extra;
    }
    if (!Array.isArray(lettersOut) || lettersOut.length !== sim.letterCount) {
      dead.push(id);
      continue;
    }
    // Sanitize: only plain finite numbers and validated color strings ever
    // leave this worker.
    const frame = new Array(lettersOut.length);
    for (let i = 0; i < lettersOut.length; i++) {
      const o = lettersOut[i] || {};
      const scale = num(o.scale, 1);
      frame[i] = [
        num(o.x, 0),
        num(o.y, 0),
        num(o.rot, 0),
        num(o.scaleX, scale),
        num(o.scaleY, scale),
        num(o.skew, 0),
        Math.max(0, Math.min(1, num(o.opacity, 1))),
        typeof o.color === 'string' && COLOR_RE.test(o.color) ? o.color : '#1c1c1c',
        Math.max(0, Math.min(30, num(o.glow, 0))),
      ];
    }
    let pFrame = null;
    if (Array.isArray(particlesOut) && particlesOut.length) {
      const n = Math.min(particlesOut.length, MAX_PARTICLES);
      pFrame = new Array(n);
      for (let j = 0; j < n; j++) {
        const p = particlesOut[j] || {};
        pFrame[j] = [
          num(p.x, 0),
          num(p.y, 0),
          Math.max(1, Math.min(60, num(p.size, 4))),
          Math.max(0, Math.min(1, num(p.opacity, 1))),
          typeof p.color === 'string' && COLOR_RE.test(p.color) ? p.color : '#1c1c1c',
          num(p.rot, 0),
          p.shape === 'square' ? 1 : 0,
        ];
      }
    }
    // Extra text glyphs (clones / appended letters / spawned words): sanitize
    // to a single visible character plus plain finite numbers, capped.
    let xFrame = null;
    if (Array.isArray(extraOut) && extraOut.length) {
      const n = Math.min(extraOut.length, MAX_EXTRA);
      xFrame = [];
      for (let j = 0; j < n; j++) {
        const g = extraOut[j] || {};
        const ch = typeof g.char === 'string' ? [...g.char.trim()][0] : undefined;
        if (!ch || ch.charCodeAt(0) < 33) continue; // no empties/controls/spaces
        const scale = num(g.scale, 1);
        xFrame.push([
          ch,
          num(g.x, 0),
          num(g.y, 0),
          num(g.rot, 0),
          num(g.scaleX, scale),
          num(g.scaleY, scale),
          num(g.skew, 0),
          Math.max(0, Math.min(1, num(g.opacity, 1))),
          typeof g.color === 'string' && COLOR_RE.test(g.color) ? g.color : '#1c1c1c',
          Math.max(0, Math.min(30, num(g.glow, 0))),
        ]);
      }
      if (!xFrame.length) xFrame = null;
    }
    frames.push([id, frame, pFrame, xFrame]);
  }
  for (const id of dead) {
    sims.delete(id);
    postMessage({ type: 'dead', id });
  }
  if (frames.length) postMessage({ type: 'frames', frames });
}, TICK_MS);
