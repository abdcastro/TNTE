'use strict';

// Durable per-visitor usage counters for the host-key word allowance.
//
// Keys are namespaced identifiers ("dev:<deviceId>", "ip:<addr>"); values are
// how many brand-new words that identity has generated on the HOST key. Stored
// in a single JSON file on the data/ volume (same atomic-rewrite pattern as
// store.js), so counts survive restarts and redeploys — the allowance is
// permanent, not per-session. Writes only happen on real host-key generations,
// which are human-paced and capped, so file churn is a non-issue.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'usage.json');
const TMP = FILE + '.tmp';

const map = new Map(); // key -> count
let writeChain = Promise.resolve(); // serialize writes so renames never race

function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [k, v] of Object.entries(obj)) {
      if (Number.isFinite(v)) map.set(k, v);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[usage] could not read ${FILE}: ${err.message} — starting empty`);
      try {
        fs.renameSync(FILE, FILE + '.corrupt-' + Date.now());
      } catch {}
    }
  }
}

function persist() {
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
  get(key) {
    return map.get(key) || 0;
  },
  async bump(key) {
    map.set(key, (map.get(key) || 0) + 1);
    await persist();
  },
};
