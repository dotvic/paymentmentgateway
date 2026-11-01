"use strict";
// Backups for the SQLite database: local snapshots, optional encrypted off-site copies to any S3-compatible
// storage (Fly's Tigris, Backblaze B2, Cloudflare R2, AWS S3), and a restore command. No npm packages.
//
//   node backup.js list                       show local snapshots and off-site copies
//   node backup.js restore <file|s3-key>      stage a backup; it replaces the database at the next start
//   node backup.js verify <file>              check a backup file without restoring it
const fs = require("fs"), path = require("path"), crypto = require("crypto"), zlib = require("zlib");

const MAGIC = Buffer.from("ZBX1");
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();

// ---------- AWS Signature Version 4 (what every S3-compatible service accepts) ----------
const encSeg = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
function signV4({ method, url, headers = {}, payloadHash, region, service = "s3", accessKey, secretKey, date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ""), day = amzDate.slice(0, 8);
  const h = { ...headers, host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const canonUri = url.pathname.split("/").map((s) => encSeg(decodeURIComponent(s))).join("/") || "/";
  const canonQuery = [...url.searchParams.entries()].map(([k, v]) => [encSeg(k), encSeg(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonHeaders = names.map((n) => `${n}:${lower[n]}\n`).join(""), signed = names.join(";");
  const canonical = [method, canonUri, canonQuery, canonHeaders, signed, payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + secretKey, day), region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}

function s3Config(env = process.env) {
  const endpoint = env.AWS_ENDPOINT_URL_S3 || env.BACKUP_S3_ENDPOINT || "", bucket = env.BUCKET_NAME || env.BACKUP_S3_BUCKET || "";
  const accessKey = env.AWS_ACCESS_KEY_ID || env.BACKUP_S3_KEY_ID || "", secretKey = env.AWS_SECRET_ACCESS_KEY || env.BACKUP_S3_SECRET || "";
  if (!(endpoint && bucket && accessKey && secretKey)) return null;
  return { endpoint: endpoint.replace(/\/$/, ""), bucket, accessKey, secretKey, region: env.AWS_REGION || "auto", prefix: (env.BACKUP_PREFIX || "zanboxx").replace(/^\/+|\/+$/g, "") };
}
async function s3Request(cfg, method, key, { query = "", body = null } = {}) {
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}${key ? "/" + key.split("/").map(encSeg).join("/") : ""}${query ? "?" + query : ""}`);
  const payload = body || Buffer.alloc(0);
  const headers = signV4({ method, url, payloadHash: sha256hex(payload), region: cfg.region, accessKey: cfg.accessKey, secretKey: cfg.secretKey });
  delete headers.host; // fetch sets Host itself, to the same value that was signed
  const res = await fetch(url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`storage answered ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res;
}
async function s3List(cfg) {
  const res = await s3Request(cfg, "GET", "", { query: `list-type=2&prefix=${encodeURIComponent(cfg.prefix + "/")}` });
  const xml = await res.text(), out = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const g = (t) => (m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1];
    out.push({ key: g("Key"), size: +g("Size"), modified: g("LastModified") });
  }
  return out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
}

// ---------- optional client-side encryption (AES-256-GCM, key from a passphrase) ----------
function encrypt(buf, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = crypto.scryptSync(pass, salt, 32);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv), ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, ct, c.getAuthTag()]);
}
function decrypt(buf, pass) {
  if (!pass) throw new Error("this backup is encrypted: set BACKUP_PASSPHRASE to the passphrase that was used when it was made");
  const salt = buf.subarray(4, 20), iv = buf.subarray(20, 32), tag = buf.subarray(buf.length - 16), ct = buf.subarray(32, buf.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", crypto.scryptSync(pass, salt, 32), iv); d.setAuthTag(tag);
  try { return Buffer.concat([d.update(ct), d.final()]); } catch { throw new Error("could not decrypt: wrong passphrase, or the file is damaged"); }
}
const isEncrypted = (b) => b.length > 36 && b.subarray(0, 4).equals(MAGIC);
const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
// Turns a downloaded or local backup file back into plain SQLite bytes.
function unpack(buf, pass) {
  if (isEncrypted(buf)) buf = decrypt(buf, pass);
  if (isGzip(buf)) buf = zlib.gunzipSync(buf);
  if (buf.subarray(0, 15).toString() !== "SQLite format 3") throw new Error("this file is not a SQLite database");
  return buf;
}

// ---------- the running service: scheduled snapshots ----------
function settings(env = process.env, store) {
  return {
    everyHours: env.BACKUP_EVERY_HOURS === undefined ? 6 : Math.max(0, +env.BACKUP_EVERY_HOURS || 0),
    keep: Math.max(1, +env.BACKUP_KEEP || 8),
    dir: env.BACKUP_DIR || path.join(store.dir, "backups"),
    pass: env.BACKUP_PASSPHRASE || "",
    s3: s3Config(env),
  };
}

function createBackupService(store, env, hooks = {}) {
  const cfg = settings(env, store), log = hooks.log || console.log;
  const state = { running: false, last_local_at: store.getMeta("last_local_at"), last_offsite_at: store.getMeta("last_offsite_at"), last_error: store.getMeta("last_error") || null, last_file: null };
  let timer = null;

  async function run(reason = "scheduled") {
    if (state.running) throw new Error("a backup is already running");
    state.running = true;
    const started = new Date();
    try {
      if (hooks.beforeSnapshot) hooks.beforeSnapshot();
      fs.mkdirSync(cfg.dir, { recursive: true });
      const stamp = started.toISOString().replace(/[-:.]/g, "");
      const file = path.join(cfg.dir, `zanboxx-${stamp}.db`);
      store.snapshotTo(file);
      state.last_file = file;
      state.last_local_at = started.toISOString(); store.setMeta("last_local_at", state.last_local_at);
      const old = fs.readdirSync(cfg.dir).filter((f) => /^zanboxx-.*\.db$/.test(f)).sort().reverse().slice(cfg.keep);
      for (const f of old) fs.unlinkSync(path.join(cfg.dir, f));
      let offsite = null, err = null;
      if (cfg.s3) {
        try {
          let body = zlib.gzipSync(fs.readFileSync(file));
          if (cfg.pass) body = encrypt(body, cfg.pass);
          const slots = Math.max(1, Math.round(168 / (cfg.everyHours || 6)));
          const slot = Math.floor(started.getTime() / ((cfg.everyHours || 6) * 3600e3)) % slots;
          offsite = `${cfg.s3.prefix}/slot-${String(slot).padStart(2, "0")}.db.gz${cfg.pass ? ".enc" : ""}`;
          await s3Request(cfg.s3, "PUT", offsite, { body });
          state.last_offsite_at = new Date().toISOString(); store.setMeta("last_offsite_at", state.last_offsite_at);
        } catch (e) { err = "off-site upload failed: " + e.message; }
      }
      state.last_error = err; store.setMeta("last_error", err || "");
      if (err) log("BACKUP WARNING: " + err); else log(`Backup done (${reason}): ${path.basename(file)}${offsite ? " and " + offsite : ""}`);
      return { file, offsite, error: err };
    } catch (e) {
      state.last_error = "backup failed: " + e.message; store.setMeta("last_error", state.last_error);
      log("BACKUP FAILED: " + e.message);
      throw e;
    } finally { state.running = false; }
  }

  function due() {
    if (!cfg.everyHours) return false;
    const last = state.last_local_at ? Date.parse(state.last_local_at) : 0;
    return Date.now() - last >= cfg.everyHours * 3600e3;
  }
  function start() {
    if (!cfg.everyHours) { log("Scheduled backups are off (BACKUP_EVERY_HOURS=0)."); return; }
    const tick = () => { if (due() && !state.running) run().catch(() => {}); };
    setTimeout(tick, +env.BACKUP_FIRST_DELAY_MS || 45000).unref();
    timer = setInterval(tick, 60000); timer.unref();
  }
  const status = () => ({
    schedule_hours: cfg.everyHours, keep_local: cfg.keep, local_dir: cfg.dir, offsite: !!cfg.s3, encrypted: !!cfg.pass, running: state.running,
    last_local_backup: state.last_local_at, last_offsite_backup: state.last_offsite_at, last_error: state.last_error || null,
    local_files: fs.existsSync(cfg.dir) ? fs.readdirSync(cfg.dir).filter((f) => /^zanboxx-.*\.db$/.test(f)).length : 0,
  });
  return { run, start, status, cfg };
}

// ---------- command line: list, verify, restore ----------
async function cli(argv, env = process.env, out = console.log) {
  const { validateDbFile } = require("./store");
  const dataFile = env.DB_FILE || env.DATA_FILE || "./data.json";
  const dir = path.dirname(dataFile), backupDir = env.BACKUP_DIR || path.join(dir, "backups"), pass = env.BACKUP_PASSPHRASE || "", s3 = s3Config(env);
  const [cmd, arg] = argv;
  if (cmd === "list") {
    out("Local snapshots (" + backupDir + "):");
    const local = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => /\.db$/.test(f)).sort().reverse() : [];
    if (!local.length) out("  none");
    for (const f of local) out(`  ${path.join(backupDir, f)}  ${(fs.statSync(path.join(backupDir, f)).size / 1024).toFixed(0)} KB`);
    out("Off-site copies:");
    if (!s3) out("  not configured (set AWS_ENDPOINT_URL_S3, BUCKET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)");
    else { const l = await s3List(s3); if (!l.length) out("  none"); for (const o of l) out(`  ${o.key}  ${o.modified}  ${(o.size / 1024).toFixed(0)} KB`); }
    return 0;
  }
  if (cmd === "verify" || cmd === "restore") {
    if (!arg) { out(`Usage: node backup.js ${cmd} <local file or off-site key>`); return 2; }
    let buf;
    if (fs.existsSync(arg)) buf = fs.readFileSync(arg);
    else if (s3) buf = Buffer.from(await (await s3Request(s3, "GET", arg)).arrayBuffer());
    else { out(`File not found: ${arg}`); return 2; }
    const db = unpack(buf, pass);
    const tmp = path.join(dir, `verify-${process.pid}.db`);
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(tmp, db);
    let info;
    try { info = validateDbFile(tmp); } finally { try { fs.unlinkSync(tmp); } catch {} }
    out(`OK: a valid Zanboxx database with ${info.accounts} accounts.`);
    if (cmd === "verify") return 0;
    fs.writeFileSync(path.join(dir, "restore.db"), db);
    out("Staged as " + path.join(dir, "restore.db") + ".");
    out("Now restart the app (Fly: fly machine restart <id> --app <app>). At start-up it moves the current database aside and uses this one.");
    return 0;
  }
  out("Usage: node backup.js list | verify <file|key> | restore <file|key>");
  return 2;
}

module.exports = { signV4, s3Config, s3Request, s3List, encrypt, decrypt, unpack, createBackupService, cli };
if (require.main === module) cli(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error("Error: " + e.message); process.exit(1); });
