'use strict';

const doc = document.getElementById('doc');
const caret = document.getElementById('caret');
const overlay = document.getElementById('overlay');
const placeholder = document.getElementById('placeholder');
const clearBtn = document.getElementById('clear');
const kb = document.getElementById('kb');
const page = document.getElementById('page');

const keymodal = document.getElementById('keymodal');
const keymodalForm = document.getElementById('keymodal-form');
const keymodalInput = document.getElementById('keymodal-input');
const keymodalError = document.getElementById('keymodal-error');
const keymodalClose = document.getElementById('keymodal-close');

const fillmodal = document.getElementById('fillmodal');
const fillmodalClose = document.getElementById('fillmodal-close');
const fillmodalClear = document.getElementById('fillmodal-clear');

const MAX_LIVE = 40;
const BLEND_MS = 450; // plain text -> first animation frame cross-fade
const WORD_RE = /^[A-Za-z]{1,24}$/;

// Placeholder suggestions; one is picked at random each load and on clear.
const SUGGESTIONS = [
  'fire', 'water', 'blackhole', 'snow', 'gravity',
  'blossom', 'thunder', 'fall', 'bomb',
];

const worker = new Worker('worker.js');
const active = new Map(); // id -> sim
const liveOrder = []; // ids, oldest first, for the live-word cap
let nextId = 1;
let currentWord = null; // { el, text }

// The visitor's own Anthropic key, once supplied (persisted locally so they
// only enter it once). Sent with generation requests to bypass the host cap.
let userKey = localStorage.getItem('tnte_api_key') || '';

// Stable per-browser device id, sent with every generation request so the
// server can count the host-key allowance against this device durably —
// surviving IP changes (mobile networks rotate them) and server restarts.
let deviceId = localStorage.getItem('tnte_device') || '';
if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) {
  deviceId =
    window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : 'd-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem('tnte_device', deviceId);
}
// Words that turned red because the host allowance ran out — retried if/when a
// working key is provided.
const blockedWords = []; // { el, text }

// ---------------------------------------------------------------------------
// Typing surface (append-only; no editing/deletion by design)
// ---------------------------------------------------------------------------

function pickSuggestion() {
  const word = SUGGESTIONS[Math.floor(Math.random() * SUGGESTIONS.length)];
  placeholder.textContent = `Try "${word}"...`;
}

// ---------------------------------------------------------------------------
// Page-fill guard: the page never scrolls, so once the caret is one line away
// from the bottom of the viewport, no new line may be created — typing that
// would wrap (or Enter) is refused and the "page is filled" popup appears.
// ---------------------------------------------------------------------------

const BOTTOM_GUARD = 72; // px kept clear above the viewport bottom (footer area)

function lineHeightPx() {
  return parseFloat(getComputedStyle(doc).lineHeight) || 38;
}

// Would adding one more line put the caret into the no-scroll danger zone?
function newLineWouldOverflow() {
  const r = caret.getBoundingClientRect();
  return r.bottom + lineHeightPx() > window.innerHeight - BOTTOM_GUARD;
}

// Has the caret itself been pushed into the danger zone (by a text wrap)?
function caretOverflowed() {
  return caret.getBoundingClientRect().bottom > window.innerHeight - BOTTOM_GUARD;
}

function openFillModal() {
  fillmodal.hidden = false;
}
function closeFillModal() {
  fillmodal.hidden = true;
  kb.focus({ preventScroll: true });
}

function updatePlaceholder() {
  placeholder.style.display = doc.childNodes.length > 1 ? 'none' : '';
}

function ensureWordEl() {
  if (!currentWord) {
    const el = document.createElement('span');
    el.className = 'word';
    doc.insertBefore(el, caret);
    currentWord = { el, text: '' };
  }
}

function typeChar(ch) {
  ensureWordEl();
  const l = document.createElement('span');
  l.className = 'ltr';
  l.textContent = ch;
  currentWord.el.appendChild(l);
  currentWord.text += ch;
  // If this character wrapped the caret into the no-scroll zone, take it back
  // and tell the visitor the page is full.
  if (caretOverflowed()) {
    l.remove();
    currentWord.text = currentWord.text.slice(0, -1);
    if (!currentWord.el.childNodes.length) {
      currentWord.el.remove();
      currentWord = null;
    }
    openFillModal();
    return;
  }
  updatePlaceholder();
}

function finalizeWord() {
  if (!currentWord) return;
  const { el, text } = currentWord;
  currentWord = null;
  // Easter egg: typing the word "clear" wipes everything, same as the button.
  if (text.toLowerCase() === 'clear') {
    clearAll();
    return;
  }
  // Easter egg: "reachlimit" instantly exhausts the host allowance.
  if (text.toLowerCase() === 'reachlimit') {
    reachLimit();
    return;
  }
  if (WORD_RE.test(text)) requestSim(el, text);
}

function addSpace() {
  finalizeWord();
  const sp = document.createTextNode(' ');
  doc.insertBefore(sp, caret);
  // A space can wrap the caret too; the finalized word stays, the space goes.
  if (caretOverflowed()) {
    sp.remove();
    openFillModal();
    return;
  }
  updatePlaceholder();
}

function addNewline() {
  // Refuse the line break outright if the new line would land in the
  // no-scroll zone; the word already typed is still finalized as normal.
  if (newLineWouldOverflow()) {
    finalizeWord();
    openFillModal();
    return;
  }
  finalizeWord();
  doc.insertBefore(document.createElement('br'), caret);
  updatePlaceholder();
}

window.addEventListener('keydown', (e) => {
  // While the key popup is open, let keystrokes reach its input instead of the
  // editor (Escape dismisses it).
  if (!keymodal.hidden) {
    if (e.key === 'Escape') closeKeyModal();
    return;
  }
  // While the page-filled popup is open, swallow typing (Escape dismisses it).
  if (!fillmodal.hidden) {
    if (e.key === 'Escape') closeFillModal();
    e.preventDefault();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault(); // no editing, ever
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    addNewline();
    return;
  }
  if (e.key === ' ') {
    e.preventDefault(); // also stops page scroll
    addSpace();
    return;
  }
  if (e.key.length === 1) {
    e.preventDefault();
    typeChar(e.key);
  }
});

// Mobile virtual keyboards often send unidentified keydowns and deliver the
// character via an input event on the focused field instead.
kb.addEventListener('input', () => {
  const v = kb.value;
  kb.value = '';
  for (const ch of v) {
    if (ch === ' ') addSpace();
    else if (ch === '\n') addNewline();
    else typeChar(ch);
  }
});

page.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  kb.focus({ preventScroll: true });
});
kb.focus({ preventScroll: true });

// Belt-and-suspenders for mobile: block touch panning entirely (the fixed
// body already prevents most of it; this stops the stragglers like iOS
// rubber-banding). Modals are small enough to never need scrolling.
document.addEventListener(
  'touchmove',
  (e) => {
    e.preventDefault();
  },
  { passive: false }
);

// ---------------------------------------------------------------------------
// Word promotion: plain text -> free-floating animated letters
// ---------------------------------------------------------------------------

async function requestSim(wordEl, text) {
  let resp, data;
  try {
    resp = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ word: text, apiKey: userKey || undefined, deviceId }),
    });
    data = await resp.json().catch(() => ({}));
  } catch {
    return; // network hiccup: word silently stays plain text
  }

  // Host allowance spent: lock the word in red and offer the key popup.
  if (resp.status === 429 && data.error === 'host_limit') {
    // If we were already sending a key/code and still hit the cap, what the
    // visitor entered wasn't valid — drop it and flag the rejection.
    const rejected = !!userKey;
    if (rejected) {
      userKey = '';
      localStorage.removeItem('tnte_api_key');
    }
    blockWord(wordEl, text);
    openKeyModal(rejected);
    return;
  }
  // The visitor's own key was rejected: keep it red and tell them in the popup.
  if (data.error === 'bad_key') {
    userKey = ''; // stop reusing a key we know is bad
    localStorage.removeItem('tnte_api_key');
    blockWord(wordEl, text);
    openKeyModal(true);
    return;
  }
  if (!resp.ok) return; // other errors (rate limit, generation failure): stay plain

  // code === null means stopword / gibberish / unrecognized: stays plain text.
  if (typeof data.code === 'string' && data.code) promote(wordEl, data.code);
}

// ---------------------------------------------------------------------------
// Host-limit handling: red "blocked" words + bring-your-own-key popup
// ---------------------------------------------------------------------------

function blockWord(wordEl, text) {
  if (!doc.contains(wordEl) || wordEl.classList.contains('blocked')) return;
  wordEl.classList.add('blocked');
  blockedWords.push({ el: wordEl, text });
  // Clicking a red word reopens the popup (in case it was dismissed).
  wordEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openKeyModal();
  });
}

function openKeyModal(showError) {
  keymodalError.hidden = !showError;
  keymodal.hidden = false;
  keymodalInput.focus();
}

function closeKeyModal() {
  keymodal.hidden = true;
  kb.focus({ preventScroll: true });
}

function reachLimit() {
  // Drop any active key so the cap is genuinely enforced from here on.
  userKey = '';
  localStorage.removeItem('tnte_api_key');
  // Open the popup immediately; tell the server in the background.
  openKeyModal();
  fetch('/api/reachlimit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  }).catch(() => {});
}

keymodalForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const key = keymodalInput.value.trim();
  if (!key) return;
  userKey = key;
  localStorage.setItem('tnte_api_key', key);
  keymodalInput.value = '';
  closeKeyModal();
  // Retry every word that was blocked; if the key is bad, requestSim will
  // re-block them and reopen the popup with the error.
  const toRetry = blockedWords.splice(0);
  for (const { el, text } of toRetry) {
    if (!doc.contains(el)) continue;
    el.classList.remove('blocked');
    requestSim(el, text);
  }
});

keymodalClose.addEventListener('click', closeKeyModal);
keymodal.addEventListener('pointerdown', (e) => {
  if (e.target === keymodal) closeKeyModal(); // click backdrop to dismiss
});

function promote(wordEl, code) {
  if (!doc.contains(wordEl)) return; // document was cleared meanwhile
  const letters = Array.from(wordEl.children);
  if (!letters.length) return;

  // Capture each letter's viewport position at this exact moment, then ghost
  // the in-flow word (identical footprint, invisible) so nothing reflows.
  const rects = letters.map((l) => {
    const r = l.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  wordEl.classList.add('ghost');

  // Overlay doubles start exactly where the source letters were, looking
  // identical, so the handoff is invisible until the first frame blends in.
  const els = letters.map((l, i) => {
    const d = document.createElement('span');
    d.className = 'fly';
    d.textContent = l.textContent;
    d.style.transform = `translate3d(${rects[i].left}px, ${rects[i].top}px, 0)`;
    overlay.appendChild(d);
    return d;
  });

  const id = nextId++;
  active.set(id, {
    id,
    wordEl,
    els,
    rects,
    last: null,
    lastP: null,
    pEls: [], // pooled particle elements, grown on demand
    firstAt: 0,
    frozen: false,
    settledFinal: false,
  });
  liveOrder.push(id);

  worker.postMessage({
    type: 'add',
    id,
    src: code,
    letterCount: els.length,
    params: {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      startX: rects.map((r) => r.left),
      startY: rects.map((r) => r.top),
      seed: Math.floor(Math.random() * 1e6),
    },
  });

  // Performance ceiling: freeze the oldest live word in place (its letters
  // keep their last transform; we just stop simulating it).
  while (liveOrder.length > MAX_LIVE) {
    freeze(liveOrder.shift());
  }
}

function freeze(id) {
  const sim = active.get(id);
  if (!sim || sim.frozen) return;
  sim.frozen = true;
  worker.postMessage({ type: 'remove', id });
  // Letters hold their last pose, but ephemeral particles are removed —
  // a frozen ember cloud hanging mid-air looks broken, not calm.
  for (const p of sim.pEls) p.remove();
  sim.pEls = [];
  sim.lastP = null;
}

function revert(sim) {
  // Generated code failed before producing a single frame: put the word back
  // as plain static text, no visible error.
  for (const el of sim.els) el.remove();
  for (const p of sim.pEls) p.remove();
  sim.wordEl.classList.remove('ghost');
  active.delete(sim.id);
  const idx = liveOrder.indexOf(sim.id);
  if (idx !== -1) liveOrder.splice(idx, 1);
}

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'frames') {
    const now = performance.now();
    for (const [id, frame, pFrame] of msg.frames) {
      const sim = active.get(id);
      if (!sim || sim.frozen) continue;
      if (!sim.last) sim.firstAt = now;
      sim.last = frame;
      sim.lastP = pFrame;
    }
  } else if (msg.type === 'dead') {
    const sim = active.get(msg.id);
    if (!sim) return;
    if (sim.last) freeze(msg.id); // died mid-flight: hold last pose
    else revert(sim);
  }
};

// ---------------------------------------------------------------------------
// Render loop: apply sanitized worker frames as transforms/colors
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// Baseline color the cross-fade starts from = the document's current text
// color, so words ease out of plain text correctly in either theme. Recomputed
// whenever the theme changes.
function readInkRgb() {
  const c = getComputedStyle(document.documentElement)
    .getPropertyValue('--ink')
    .trim();
  return /^#[0-9a-f]{6}$/i.test(c) ? hexToRgb(c) : [28, 28, 28];
}
let inkRgb = readInkRgb();

function lerp(a, b, k) {
  return a + (b - a) * k;
}

function mixColor(hex, k) {
  if (k >= 1) return hex;
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${Math.round(lerp(inkRgb[0], r, k))}, ${Math.round(
    lerp(inkRgb[1], g, k)
  )}, ${Math.round(lerp(inkRgb[2], b, k))})`;
}

function renderParticles(sim, k) {
  const particles = sim.lastP;
  const count = particles ? particles.length : 0;
  // Grow the pool on demand; hide (don't destroy) extras, since particle
  // counts fluctuate frame to frame.
  while (sim.pEls.length < count) {
    const d = document.createElement('div');
    d.className = 'p';
    overlay.appendChild(d);
    sim.pEls.push(d);
  }
  for (let j = 0; j < sim.pEls.length; j++) {
    const el = sim.pEls[j];
    if (j >= count) {
      if (el.style.display !== 'none') el.style.display = 'none';
      continue;
    }
    const [x, y, size, opacity, color, rot, square] = particles[j];
    if (el.style.display) el.style.display = '';
    el.classList.toggle('sq', square === 1);
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.background = color;
    el.style.opacity = opacity * k;
    el.style.transform = `translate3d(${x - size / 2}px, ${y - size / 2}px, 0) rotate(${rot}deg)`;
  }
}

function render(now) {
  for (const sim of active.values()) {
    if (!sim.last || sim.settledFinal) continue;

    // Ease from "sitting in the document as plain text" into the live frame.
    const raw = Math.min(1, (now - sim.firstAt) / BLEND_MS);
    const k = 1 - Math.pow(1 - raw, 3);

    for (let i = 0; i < sim.els.length; i++) {
      const [x, y, rot, scaleX, scaleY, skew, opacity, color, glow] = sim.last[i];
      const el = sim.els[i];
      el.style.transform = `translate3d(${sim.rects[i].left + x * k}px, ${
        sim.rects[i].top + y * k
      }px, 0) rotate(${rot * k}deg) skew(${skew * k}deg) scale(${lerp(
        1,
        scaleX,
        k
      )}, ${lerp(1, scaleY, k)})`;
      el.style.opacity = lerp(1, opacity, k);
      el.style.color = mixColor(color, k);
      el.style.textShadow = glow > 0.5 ? `0 0 ${glow * k}px ${color}` : '';
    }

    renderParticles(sim, k);

    // A frozen word gets one final paint of its last frame, then costs nothing.
    if (sim.frozen && raw >= 1) sim.settledFinal = true;
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// ---------------------------------------------------------------------------
// Clear (the only "editing" the product has) — with a little sweep animation
// ---------------------------------------------------------------------------

let clearing = false;

function clearAll() {
  if (clearing) return;
  clearing = true;

  // Stop every simulation first so the render loop stops overwriting the
  // transforms we're about to animate.
  worker.postMessage({ type: 'clear' });
  active.clear();
  liveOrder.length = 0;
  currentWord = null;
  blockedWords.length = 0;

  // Overlay letters and particles scatter upward and fade; the document text
  // lifts, blurs and fades as one block (see #doc.clearing in the CSS).
  overlay.querySelectorAll('.fly, .p').forEach((el) => {
    el.classList.add('sweep');
    const base = getComputedStyle(el).transform;
    const dx = (Math.random() - 0.5) * 260;
    const dy = -130 - Math.random() * 220;
    const rot = (Math.random() - 0.5) * 240;
    el.style.transform =
      `${base && base !== 'none' ? base + ' ' : ''}translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
    el.style.opacity = '0';
  });
  doc.classList.add('clearing');

  setTimeout(() => {
    overlay.textContent = '';
    doc.classList.remove('clearing');
    doc.textContent = '';
    doc.appendChild(caret);
    pickSuggestion(); // fresh suggestion after each clear
    updatePlaceholder();
    kb.focus({ preventScroll: true });
    clearing = false;
  }, 560);
}

clearBtn.addEventListener('click', clearAll);

fillmodalClear.addEventListener('click', () => {
  closeFillModal();
  clearAll();
});
fillmodalClose.addEventListener('click', closeFillModal);
fillmodal.addEventListener('pointerdown', (e) => {
  if (e.target === fillmodal) closeFillModal(); // click backdrop to dismiss
});

// ---------------------------------------------------------------------------
// Dark-mode toggle (initial theme already applied by the inline <head> script)
// ---------------------------------------------------------------------------

const themeToggle = document.getElementById('theme-toggle');
themeToggle.addEventListener('click', () => {
  const next =
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('tnte_theme', next);
  } catch {}
  inkRgb = readInkRgb(); // keep the cross-fade baseline in sync with the theme
  kb.focus({ preventScroll: true });
});

pickSuggestion();
updatePlaceholder();
