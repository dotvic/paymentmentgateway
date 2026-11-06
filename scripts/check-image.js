#!/usr/bin/env node
"use strict";
// Pre-deploy check: rebuild the file layout that the Dockerfile COPY lines produce, start the server from it, and request key pages.
// This catches "a new file is missing from the image" before it reaches production, which is what crashed a deploy once.
const fs = require("fs"), path = require("path"), os = require("os"), { spawn } = require("child_process");
const ROOT = path.join(__dirname, ".."), PORT = 18900 + Math.floor(Math.random() * 90);
const PAGES = ["/health", "/", "/labs", "/academy", "/knowledge", "/intelligence", "/careers", "/startups", "/developers", "/labs/risk", "/labs/controls", "/labs/tokens", "/labs/agents", "/labs/kpis", "/privacy", "/terms"];
const fail = (m) => { console.error("IMAGE CHECK FAILED: " + m); process.exit(1); };

const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
const dest = fs.mkdtempSync(path.join(os.tmpdir(), "zanboxx-image-"));
let copied = 0;
for (const line of dockerfile.split("\n")) {
  const m = line.match(/^COPY\s+(.+)\s+(\.\/?\S*)\s*$/); if (!m) continue;
  const target = m[2];
  for (const src of m[1].trim().split(/\s+/)) {
    const from = path.join(ROOT, src);
    if (!fs.existsSync(from)) fail(`Dockerfile copies "${src}" but it does not exist`);
    const to = target === "./" || target === "." ? path.join(dest, path.basename(src)) : path.join(dest, target, path.basename(src));
    fs.cpSync(from, fs.statSync(from).isDirectory() && target !== "./" && target !== "." ? path.join(dest, target.replace(/^\.\//, "")) : to, { recursive: true }); copied++;
  }
}
if (!fs.existsSync(path.join(dest, "server.js"))) fail("server.js is not in the image");

// Every relative require in the staged code must resolve inside the staged folder.
const missing = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    if (!f.endsWith(".js") || p.includes(path.join(dest, "public"))) continue;
    for (const r of fs.readFileSync(p, "utf8").matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      const t = path.resolve(path.dirname(p), r[1]);
      if (![t, t + ".js", t + ".json", path.join(t, "index.js")].some((c) => fs.existsSync(c) && fs.statSync(c).isFile())) missing.push(`${path.relative(dest, p)} requires ${r[1]}`);
    }
  }
})(dest);
if (missing.length) fail("files the code needs are not in the image:\n  " + missing.join("\n  "));

const data = path.join(dest, "..", path.basename(dest) + "-data.json");
const srv = spawn("node", ["server.js"], { cwd: dest, env: { ...process.env, PORT: String(PORT), DATA_FILE: data }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
let exited = false; srv.on("exit", () => (exited = true));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let up = false;
  for (let i = 0; i < 80 && !exited; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) { up = true; break; } } catch {} await sleep(150); }
  if (!up) { srv.kill(); fail("the server did not start from the image layout:\n" + log.split("\n").filter((l) => !/Warning|trace-warnings/.test(l)).slice(-15).join("\n")); }
  const bad = [];
  for (const p of PAGES) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.status !== 200) bad.push(`${p} -> ${r.status}`); }
  srv.kill(); fs.rmSync(dest, { recursive: true, force: true }); try { fs.rmSync(data, { force: true }); } catch {}
  if (bad.length) fail("pages did not return 200:\n  " + bad.join("\n  "));
  console.log(`Image check passed: ${copied} COPY sources staged, server started, ${PAGES.length} pages returned 200.`);
})();
