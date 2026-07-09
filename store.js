'use strict';

// Durable, shared word -> simulate() code store.
//
// This is the "generate once, keep forever, serve to everyone" layer. The
// first visitor to type a given word pays for the Claude generation; the
// result is written here and every future visitor (on any later request, even
// after a server restart) gets it instantly with no API call.
//
// Backed by a single JSON file for now — zero dependencies, trivial to inspect
// and back up, and correct for a single server instance (which is all a shared
// server-side cache needs to be shared across all users). The interface is
// async on purpose: to scale a public site across MULTIPLE instances or
// serverless functions, swap this one file for a Postgres/Redis/SQLite-backed
// implementation with the same get/set/size surface — nothing in server.js
// changes.
//
// NOTE: this store is NOT a security boundary. It holds already-generated,
// already-regex-checked function source; safety comes entirely from the
// client-side Web Worker sandbox that executes it. Persisting it to disk
// changes nothing about that.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'words.json');
const TMP = FILE + '.tmp';

const map = new Map(); // word -> code (loaded fully into memory)
let writeChain = Promise.resolve(); // serialize writes so renames never race

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [word, code] of Object.entries(obj)) {
      if (typeof code === 'string') map.set(word, code);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Corrupt file: keep the bad copy for inspection, start fresh rather
      // than crash. A truncated write should be rare given atomic renames.
      console.warn(`[store] could not read ${FILE}: ${err.message} — starting empty`);
      try {
        fs.renameSync(FILE, FILE + '.corrupt-' + Date.now());
      } catch {}
    }
  }
}

function persist() {
  // Whole-file atomic rewrite. Only happens when a genuinely NEW word is
  // added (human-paced), never on cache hits, so the cost is a non-issue at
  // this scale. Serialized through writeChain to avoid concurrent renames.
  const snapshot = JSON.stringify(Object.fromEntries(map));
  writeChain = writeChain.then(async () => {
    await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
    await fs.promises.writeFile(TMP, snapshot);
    await fs.promises.rename(TMP, FILE);
  });
  return writeChain;
}

load();

module.exports = {
  async get(word) {
    return map.get(word);
  },
  async set(word, code) {
    if (map.get(word) === code) return; // already stored, skip the write
    map.set(word, code);
    await persist();
  },
  get size() {
    return map.size;
  },
};
