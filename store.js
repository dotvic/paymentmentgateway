"use strict";
// Durable storage on SQLite (built into Node 22, no npm packages).
//
// The app keeps its working data in one in-memory object, DB = { accounts, keys, emails, tokens, trials }.
// This module loads that object from a SQLite file at start-up and writes changes back in small
// transactions: only accounts that changed are rewritten, and a crash can never leave a half-written file.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const h1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS keys    (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS emails  (email TEXT PRIMARY KEY, account_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tokens  (hash TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS trials  (hash TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kind, id));
  CREATE TABLE IF NOT EXISTS meta    (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
const TABLES = ["accounts", "keys", "emails", "tokens", "trials"];

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

// A file counts as a usable Zanboxx database only if it opens, passes SQLite's own check and has our tables.
function validateDbFile(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const chk = db.prepare("PRAGMA quick_check").get();
    if (!chk || Object.values(chk)[0] !== "ok") throw new Error("SQLite integrity check failed");
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const t of TABLES) if (!names.includes(t)) throw new Error(`table "${t}" is missing`);
    return { accounts: db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n };
  } finally { try { db && db.close(); } catch {} }
}

class Store {
  constructor(file, opts = {}) {
    this.file = file;
    this.dir = path.dirname(file);
    fs.mkdirSync(this.dir, { recursive: true });
    this.applyPendingRestore();
    this.db = openDb(file);
    const chk = this.db.prepare("PRAGMA quick_check").get();
    if (!chk || Object.values(chk)[0] !== "ok") {
      throw new Error(`The database file ${file} is damaged (SQLite quick_check failed). Restore a backup: node backup.js list`);
    }
    this.legacy = opts.legacyJson || null;
    this.shadow = { accounts: new Map(), keys: new Map(), emails: new Map(), tokens: new Map(), trials: new Map(), records: new Map() };
    this.log = opts.log || console.log;
  }

  // A file called restore.db next to the database replaces it at the next start (see backup.js restore).
  applyPendingRestore() {
    const pending = path.join(this.dir, "restore.db");
    if (!fs.existsSync(pending)) return;
    const info = validateDbFile(pending); // throws if the file is not a usable database
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.before-restore-${stamp}`);
    for (const ext of ["-wal", "-shm"]) if (fs.existsSync(this.file + ext)) fs.renameSync(this.file + ext, `${this.file}${ext}.before-restore-${stamp}`);
    fs.renameSync(pending, this.file);
    console.log(`Restored database from restore.db (${info.accounts} accounts). The previous database was kept as ${path.basename(this.file)}.before-restore-${stamp}`);
  }

  isEmpty() { return this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n === 0 && this.db.prepare("SELECT COUNT(*) AS n FROM keys").get().n === 0; }

  // Reads everything into the in-memory object. On the first start after the upgrade it imports the old JSON file.
  load() {
    let DB;
    if (this.isEmpty() && this.legacy && fs.existsSync(this.legacy)) {
      let old;
      try { old = JSON.parse(fs.readFileSync(this.legacy, "utf8")); } catch (e) { throw new Error(`Could not read the old data file ${this.legacy}: ${e.message}`); }
      DB = { accounts: old.accounts || {}, keys: old.keys || {}, emails: old.emails || {}, tokens: old.tokens || {}, trials: old.trials || {}, records: {} };
      this.flush(DB, null);
      const moved = `${this.legacy}.migrated`;
      fs.renameSync(this.legacy, moved);
      this.log(`Imported ${Object.keys(DB.accounts).length} accounts from ${path.basename(this.legacy)} into SQLite. The old file was kept as ${path.basename(moved)}.`);
      return DB;
    }
    DB = { accounts: {}, keys: {}, emails: {}, tokens: {}, trials: {}, records: {} };
    for (const r of this.db.prepare("SELECT kind, id, json FROM records").all()) { (DB.records[r.kind] = DB.records[r.kind] || {})[r.id] = JSON.parse(r.json); this.shadow.records.set(r.kind + "/" + r.id, h1(r.json)); }
    for (const r of this.db.prepare("SELECT id, json FROM accounts").all()) { DB.accounts[r.id] = JSON.parse(r.json); this.shadow.accounts.set(r.id, h1(r.json)); }
    for (const r of this.db.prepare("SELECT hash, account_id FROM keys").all()) { DB.keys[r.hash] = r.account_id; this.shadow.keys.set(r.hash, r.account_id); }
    for (const r of this.db.prepare("SELECT email, account_id FROM emails").all()) { DB.emails[r.email] = r.account_id; this.shadow.emails.set(r.email, r.account_id); }
    for (const r of this.db.prepare("SELECT hash, json FROM tokens").all()) { DB.tokens[r.hash] = JSON.parse(r.json); this.shadow.tokens.set(r.hash, r.json); }
    for (const r of this.db.prepare("SELECT hash, started_at FROM trials").all()) { DB.trials[r.hash] = r.started_at; this.shadow.trials.set(r.hash, r.started_at); }
    return DB;
  }

  // Writes what changed since the last flush. dirtyIds = a Set of account ids that changed, or null to check every account.
  flush(DB, dirtyIds) {
    const q = (sql) => this.db.prepare(sql), sh = this.shadow;
    const upAcc = q("INSERT INTO accounts (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at");
    const delAcc = q("DELETE FROM accounts WHERE id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const ids = dirtyIds ? [...dirtyIds] : [...new Set([...Object.keys(DB.accounts), ...sh.accounts.keys()])];
      for (const id of ids) {
        const a = DB.accounts[id];
        if (!a) { if (sh.accounts.has(id)) { delAcc.run(id); sh.accounts.delete(id); } continue; }
        const json = JSON.stringify(a), hash = h1(json);
        if (sh.accounts.get(id) !== hash) { upAcc.run(id, json, now); sh.accounts.set(id, hash); }
      }
      const syncMap = (name, cur, sql, delSql, enc) => {
        const ins = q(sql), del = q(delSql), shadow = sh[name];
        for (const k of Object.keys(cur)) {
          const v = enc ? enc(cur[k]) : cur[k];
          if (shadow.get(k) !== v) { ins.run(k, v); shadow.set(k, v); }
        }
        for (const k of [...shadow.keys()]) if (!(k in cur)) { del.run(k); shadow.delete(k); }
      };
      syncMap("keys", DB.keys, "INSERT OR REPLACE INTO keys (hash, account_id) VALUES (?, ?)", "DELETE FROM keys WHERE hash = ?");
      syncMap("emails", DB.emails, "INSERT OR REPLACE INTO emails (email, account_id) VALUES (?, ?)", "DELETE FROM emails WHERE email = ?");
      syncMap("tokens", DB.tokens, "INSERT OR REPLACE INTO tokens (hash, json) VALUES (?, ?)", "DELETE FROM tokens WHERE hash = ?", JSON.stringify);
      syncMap("trials", DB.trials, "INSERT OR REPLACE INTO trials (hash, started_at) VALUES (?, ?)", "DELETE FROM trials WHERE hash = ?");
      {
        const insR = q("INSERT OR REPLACE INTO records (kind, id, json) VALUES (?, ?, ?)"), delR = q("DELETE FROM records WHERE kind = ? AND id = ?"), seen = new Set();
        for (const [kind, items] of Object.entries(DB.records || {})) for (const [id, v] of Object.entries(items)) {
          const k = kind + "/" + id, json = JSON.stringify(v), hh = h1(json); seen.add(k);
          if (sh.records.get(k) !== hh) { insR.run(kind, id, json); sh.records.set(k, hh); }
        }
        for (const k of [...sh.records.keys()]) if (!seen.has(k)) { const i = k.indexOf("/"); delR.run(k.slice(0, i), k.slice(i + 1)); sh.records.delete(k); }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }

  getMeta(key) { const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key); return r ? r.value : null; }
  setMeta(key, value) { this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, String(value)); }

  // Consistent copy of the whole database into a new file (compacted, no WAL needed to read it).
  snapshotTo(dest) {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  }

  sizeBytes() { try { return fs.statSync(this.file).size; } catch { return 0; } }
  close() { try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} try { this.db.close(); } catch {} }
}

module.exports = { Store, validateDbFile };
