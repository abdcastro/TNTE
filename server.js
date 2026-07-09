const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const store = require('./store');
const { STOPWORDS, looksLikeGibberish } = require('./words');

const app = express();
// Behind a reverse proxy (Fly/Render/nginx/...), set TRUST_PROXY (e.g. to "1")
// so req.ip reflects the real client via X-Forwarded-For rather than the proxy.
// Leave unset in local/dev so clients can't spoof the header.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MODEL = 'claude-sonnet-4-6';

// Sentinel stored in place of code for words Claude doesn't recognize. It is
// never a valid function (real values contain "function simulate"), so it is
// safe to distinguish. Storing it means an unrecognized word costs one Claude
// call EVER — the refusal is cached like any other result, and the client is
// told to leave the word as plain text (code: null). This is what keeps
// gibberish from filling the store with unique generated functions.
const NOOP = '__unknown__';

// Defense-in-depth #2 only. The real security boundary is the client-side
// Web Worker sandbox; this regex exists to cheaply reject obviously bad
// output before it is cached or sent anywhere. Do not treat passing this
// check as proof the code is safe.
const FORBIDDEN =
  /\b(fetch|XMLHttpRequest|WebSocket|importScripts|document|window|localStorage|indexedDB|eval)\b|self\s*\.|Function\s*\(/;

const SYSTEM_PROMPT = `You write ONE JavaScript function named exactly "simulate" for a generative-typography
sandbox, given a single word. The function decides how that word's letters move and
what color they are, forever (the page may stay open a long time).

Signature: function simulate(letters, t, params) { ... }
- letters: array, length = number of letters (content unused, only .length matters)
- t: seconds elapsed since animation start, always increasing, unbounded
- params: { viewportWidth, viewportHeight, startX, startY, seed }
  startX/startY are arrays (per-letter captured screen origin), same length as letters.
  viewportWidth/viewportHeight are the current browser window size in pixels.

Return EITHER an array of per-letter objects (same length as letters), OR an object
with both letters and particles:
{ letters: [per-letter objects], particles: [particle objects] }

Per-letter object:
{ x, y, rot, scale, scaleX, scaleY, skew, opacity, color, glow }
x/y = pixel OFFSET from that letter's own startX[i]/startY[i] (not absolute position).
+y is downward. rot = degrees. scale = multiplier around 1 (or use scaleX/scaleY
independently for stretching/squashing). skew = degrees of horizontal shear.
opacity = 0..1. color = a "#rrggbb" string appropriate to the word's meaning.
glow = 0..30, a soft luminous halo radius in px in the letter's own color (use for
fire, neon, ghosts, magic... leave at 0 for most words). Everything except x and y
is optional.

particles: up to 48 small decorative shapes, one object each:
{ x, y, size, opacity, color, rot, shape }
Particle x/y are ABSOLUTE viewport pixel coordinates (compute from params.startX/
startY and the viewport size). size = 1..60 px. shape = "circle" (default) or
"square". Particles are stateless and re-emitted every call: derive each particle's
current position purely from t, its index, and params.seed (e.g. cycle particles on
a loop: age = (t * rate + phase) % lifetime). Use them for embers, sparks, smoke,
rain, snow, dust, bubbles, confetti, crumbs shaken loose by an earthquake... but
ONLY when they genuinely suit the word; most words should return no particles.

Give letters physically or emotionally appropriate behavior AND color for what the
word MEANS — not its spelling. Examples of the range expected: gravity/weight/falling,
floating, vibrating/electric, scattering like grains, orbiting, melting, growing,
shrinking, color words or moods (assign per-letter color variation for words implying
multiplicity or spectrum, e.g. "rainbow" → cycle each letter through a different hue;
most words should keep one consistent color or a narrow related palette instead).
Vary motion slightly per letter using its index and params.seed so groups of letters
don't move as one rigid block, unless deliberate unison suits the word.

CRITICAL — settling behavior: because t grows without bound, your function (letters
AND particles) must reach a stable resting state (or a bounded loop, like a gentle
periodic bob or a repeating particle cycle) and NOT diverge,
accelerate indefinitely, or grow unbounded as t keeps increasing. A falling letter must
stop at the ground (use params.viewportHeight as the floor) and stay there, not fall
through it forever. Use clamping (Math.min/Math.max) or an explicit "landed" branch
once a physical letter would have reached a natural resting point.

Also keep letters reasonably on-screen: don't return offsets that would permanently
push a letter far outside params.viewportWidth/viewportHeight.

If the given word is NOT a real, recognizable word — random keyboard mashing or
nonsense like "sfjkghsdf" or "aduvnirfudjaifj" — do NOT invent a function. Output
exactly the single word UNKNOWN (nothing else). Real words in any language, proper
names, and common slang are all fine and should get a real function; only reject
genuine gibberish.

Hard rules:
- Define ONLY the simulate function. No other top-level statements.
- Never reference fetch, XMLHttpRequest, WebSocket, importScripts, document, window,
  self, localStorage, indexedDB, eval, or Function. Pure arithmetic and Math.* only.
- No unbounded loops — simulate() must return quickly every single call; it is called
  roughly 30 times per second, indefinitely, for as long as the word stays on screen.
- Output ONLY the raw function source. No markdown fences, no JSON, no explanation.`;

// Durable shared store (word -> code) lives in ./store. `pending` holds only
// in-flight generations, so if two visitors type the same brand-new word at
// once we still call Claude exactly once. Sharing generated code across all
// visitors is safe ONLY because the client-side Worker sandbox is what
// actually contains it — neither the store nor this map is a security boundary.
const pending = new Map(); // word -> Promise<string>

// Basic per-IP sliding-window burst guard (in-memory; fine to start). Applies
// to any request that would actually hit the Anthropic API, regardless of whose
// key is used — cheap protection against hammering.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 40;
const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

// Per-IP cap on how many brand-NEW words a visitor may generate with the HOST
// key. Cached words (already in the shared store) never count and keep working
// for everyone forever. Once a visitor exceeds this, they're asked to supply
// their own Anthropic key (which bypasses the cap and bills them, not us).
// In-memory for now — move to Redis alongside the store to persist across
// restarts / share across instances.
const HOST_LIMIT = Number(process.env.HOST_WORD_LIMIT || 10);
const hostGen = new Map(); // ip -> count of host-key generations
function hostLimitReached(ip) {
  return (hostGen.get(ip) || 0) >= HOST_LIMIT;
}
function noteHostGeneration(ip) {
  hostGen.set(ip, (hostGen.get(ip) || 0) + 1);
}

// Unlock code entered in the client's API-key box to lift the host limit for a
// visitor (uses the host key with no cap). Kept ONLY here on the server so it
// never ships in the client bundle — intentionally a weak, memorable code.
const UNLOCK_CODE = 'leo';
const unlimited = new Set(); // IPs that have entered the unlock code

// `code: null` tells the client to leave the word as plain static text.
const NO_ANIMATION = { code: null };

app.post('/api/simulate', async (req, res) => {
  const word = typeof req.body?.word === 'string' ? req.body.word.trim() : '';
  if (!/^[A-Za-z]{1,24}$/.test(word)) {
    return res.status(400).json({ error: 'bad_word' });
  }
  const key = word.toLowerCase();

  // A visitor may bring their own Anthropic key (entered in the client once the
  // host limit is hit). It's used only for this request's generation, never
  // stored or logged.
  const userKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  const usingUserKey = /^sk-ant-\S+$/.test(userKey);
  // Unlock code lifts the host cap for this IP (still uses the host key).
  if (userKey === UNLOCK_CODE) unlimited.add(req.ip);
  const bypassLimit = unlimited.has(req.ip);

  // Common function words and obvious keyboard-mash never animate and never
  // reach Claude. These checks are cheap and deterministic, so they cost no
  // API call, no storage, and don't count against any limit.
  if (STOPWORDS.has(key) || looksLikeGibberish(key)) {
    return res.json(NO_ANIMATION);
  }

  try {
    // Fast path: already generated (or already known-unrecognized) — no API
    // call, so it's free and never counts against the host limit. A previously
    // refused word is stored as NOOP and served instantly.
    const stored = await store.get(key);
    if (stored !== undefined) {
      return res.json(stored === NOOP ? NO_ANIMATION : { code: stored });
    }

    // Burst guard on any real generation, whichever key is used.
    if (rateLimited(req.ip)) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    // Host-key budget: an uncached new word costs the host an API call. Once a
    // visitor has spent their allowance (and hasn't unlocked or brought their
    // own key), they must supply one. The client turns the word red and offers
    // a key-entry popup.
    if (!usingUserKey && !bypassLimit && hostLimitReached(req.ip)) {
      return res.status(429).json({ error: 'host_limit' });
    }

    // First time anyone has typed this word: generate once, share forever.
    let entry = pending.get(key);
    if (!entry) {
      const apiKey = usingUserKey ? userKey : process.env.ANTHROPIC_API_KEY;
      entry = generate(key, apiKey).then(async (result) => {
        await store.set(key, result); // real code, or the NOOP sentinel
        // Unlocked visitors use the host key freely — don't count them.
        if (!usingUserKey && !bypassLimit) noteHostGeneration(req.ip);
        console.log(
          result === NOOP
            ? `[unknown] "${key}" not recognized — cached as no-op (store ${store.size})`
            : `[generate] "${key}"${usingUserKey ? ' (user key)' : ''} (store now ${store.size} words)`
        );
        return result;
      });
      pending.set(key, entry);
      // Whether it succeeds or fails, stop tracking it as in-flight. On
      // failure this makes the word retryable on a later request.
      entry.finally(() => pending.delete(key)).catch(() => {});
    }
    const result = await entry;
    res.json(result === NOOP ? NO_ANIMATION : { code: result });
  } catch (err) {
    // A rejected user-supplied key gets a distinct signal so the client can
    // tell the visitor their key was bad (rather than a silent skip).
    if (err && err.code === 'bad_key') {
      return res.status(400).json({ error: 'bad_key' });
    }
    // Otherwise the client silently skips animating this word; it stays plain.
    res.status(502).json({ error: 'generation_failed' });
  }
});

// Easter egg: instantly max out this visitor's host allowance (and clear any
// prior unlock) so the limit flow can be demoed on demand. Only affects the
// caller's own IP, so it's harmless to expose.
app.post('/api/reachlimit', (req, res) => {
  hostGen.set(req.ip, HOST_LIMIT);
  unlimited.delete(req.ip);
  res.json({ ok: true });
});

async function generate(word, apiKey) {
  if (!apiKey) throw new Error('no API key available');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `The word: "${word}"` }],
    }),
  });
  if (resp.status === 401 || resp.status === 403) {
    const e = new Error('api key rejected');
    e.code = 'bad_key';
    throw e;
  }
  if (!resp.ok) throw new Error(`anthropic ${resp.status}`);
  const data = await resp.json();
  if (data.stop_reason === 'max_tokens') throw new Error('output truncated');
  let code = (data.content?.[0]?.text || '').trim();

  // Strip markdown fences if the model ignored the raw-output instruction.
  code = code.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();

  // Claude refuses unrecognized / gibberish words with the UNKNOWN sentinel.
  // Any refusal (mentions UNKNOWN, no function body) maps to the shared no-op.
  if (!/function\s+simulate\s*\(/.test(code) && /\bUNKNOWN\b/i.test(code)) {
    return NOOP;
  }

  if (!/function\s+simulate\s*\(/.test(code)) throw new Error('no simulate function');
  if (FORBIDDEN.test(code)) throw new Error('forbidden token');
  // Parse-only syntax check so truncated/malformed output is never cached.
  // Constructing the function does not execute any of the untrusted body.
  new Function(code);
  return code;
}

app.listen(PORT, () => {
  console.log(
    `Totally Normal Text Editor listening on http://localhost:${PORT} ` +
      `(${store.size} words already in the shared store)`
  );
});
