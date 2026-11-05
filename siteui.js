"use strict";
// Shared page shell for the Zanboxx sections (landing, Academy, Knowledge, Intelligence, Careers, Startups).
// Pages carry their own inline CSS and script because the content security policy allows no external files.
const fs = require("fs"), path = require("path");
const PUBLIC_DIR = path.join(__dirname, "public");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SECTIONS = [
  { id: "academy", href: "/academy", name: "Fintech Academy", short: "Academy", sub: "Courses and certifications", blurb: "Short courses on cards, 3-D Secure, disputes, settlement and chip payments. Tasks are checked against what you really did in the labs, and a finished course earns a certificate anyone can verify.", color: "#6a3df0" },
  { id: "labs", href: "/labs", name: "Payment Labs", short: "Labs", sub: "Interactive simulations", blurb: "A sandbox payment gateway with a real API: declines, 3-D Secure, webhooks, disputes, card on file, settlement, and POS and ATM labs with chip and stripe.", color: "#ff6b57" },
  { id: "knowledge", href: "/knowledge", name: "Knowledge Centre", short: "Knowledge", sub: "Guides and documentation", blurb: "API reference, how-to guides and a glossary of payments terms, written for people who build and test payment flows.", color: "#2fd1a4" },
  { id: "intelligence", href: "/intelligence", name: "Fintech Intelligence", short: "Intelligence", sub: "News and research", blurb: "Research notes from the Zanboxx team and a headline feed from the public sources we follow, always linked back to the original.", color: "#38b6ff" },
  { id: "careers", href: "/careers", name: "Fintech Careers", short: "Careers", sub: "Jobs and professional growth", blurb: "A moderated job board for payments and fintech roles, career paths that tell you what to learn, and a skills profile built from your Academy progress.", color: "#ff4fa3" },
  { id: "startups", href: "/startups", name: "Startup Hub", short: "Startups", sub: "Build fintech businesses", blurb: "A launch roadmap from idea to go-live, practical guides on licensing, risk and unit economics, and a directory where founders list their companies.", color: "#ffc23d" },
];

let BASE_CSS = "";
try { const t = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8"), a = t.indexOf("<style>"), b = t.indexOf("</style>"); BASE_CSS = a >= 0 ? t.slice(a + 7, b) : ""; } catch {}
const LOGO = '<svg viewBox="0 0 40 40" aria-hidden="true" width="26" height="26"><rect x="2" y="26" width="36" height="10" rx="5" fill="#ffc23d"/><path d="M8 26V15h4v-3h4v3h2V9h4v6h2v-3h4v3h4v11z" fill="#ff6b57"/><path d="M17 26v-6a3 3 0 0 1 6 0v6z" fill="#fff"/></svg>';

const SITE_CSS = `
.sitebar{background:var(--term);color:var(--term-ink);font-size:14px}
.sitebar .wrap{display:flex;flex-wrap:wrap;gap:2px 18px;align-items:center;padding-top:8px;padding-bottom:8px}
.sitebar a{color:var(--term-mute);text-decoration:none;padding:2px 0}.sitebar a:hover,.sitebar a[aria-current]{color:#fff}
.sitebar a[aria-current]{border-bottom:2px solid var(--sun)}
.sitebar .sb-brand{color:#fff;font-weight:700;display:flex;gap:6px;align-items:center;margin-right:8px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px;margin:8px 0 28px}
.sec{display:block;background:var(--panel);border:2px solid var(--line);border-radius:18px;padding:20px;text-decoration:none;color:var(--ink);border-top:8px solid var(--c,#6a3df0)}
.sec:hover{border-color:var(--c,#6a3df0)}.sec h2{margin:0 0 2px;font-size:22px;letter-spacing:-.02em}.sec .sub{color:var(--c,#6a3df0);font-weight:600;margin:0 0 10px}.sec p{margin:0;color:var(--mute)}
.page{padding-top:12px;padding-bottom:56px}.page h1{max-width:none;font-size:clamp(30px,5vw,48px)}
.panel{background:var(--panel);border:2px solid var(--line);border-radius:16px;padding:16px 18px;margin:14px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:14px}
.tag{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:99px;border:1px solid var(--line);color:var(--mute);margin:0 6px 4px 0;background:var(--paper)}
.tag.ok{color:var(--ok);border-color:var(--ok)}.tag.wait{color:var(--wait);border-color:var(--wait)}.tag.bad{color:var(--bad);border-color:var(--bad)}
.prose{max-width:760px;line-height:1.65}.prose h2{margin:28px 0 8px;font-size:24px;letter-spacing:-.02em}.prose h3{margin:20px 0 6px;font-size:19px}
.prose pre{background:var(--term);color:var(--term-ink);padding:14px;border-radius:12px;overflow:auto;font-size:14px}.prose code{font-size:.92em}
.prose :not(pre)>code{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:1px 5px}
.prose table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}.prose th,.prose td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
.prose blockquote{border-left:4px solid var(--sun);margin:14px 0;padding:2px 14px;color:var(--mute)}
.crumbs{font-size:14px;color:var(--mute);margin:6px 0 10px}.crumbs a{color:var(--mute)}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.row.sp{justify-content:space-between}
input.f,select.f,textarea.f{width:100%;padding:10px 12px;border:2px solid var(--line);border-radius:12px;background:var(--panel);color:var(--ink);font:inherit}
label.l{display:block;font-weight:600;margin:12px 0 4px;font-size:14px}.hint{color:var(--mute);font-size:13px;margin:4px 0 0}
button.b{font:inherit;font-weight:600;border:2px solid var(--line);background:var(--panel);color:var(--ink);padding:9px 16px;border-radius:12px;cursor:pointer}
button.b.p{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}button.b:disabled{opacity:.5;cursor:default}
.err{color:var(--bad);margin:8px 0}.okmsg{color:var(--ok);margin:8px 0}
.bar{height:8px;border-radius:99px;background:var(--line);overflow:hidden}.bar>i{display:block;height:100%;background:var(--mint)}
.foot{border-top:1px solid var(--line);padding:22px 0 40px;color:var(--mute);font-size:14px}.foot a{color:var(--mute);margin-right:14px}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:#fff;padding:6px 10px;z-index:9}
`;

const CLIENT = `
var Z = (function () {
  var key = null; try { key = localStorage.getItem("dryrun_key"); } catch (e) {}
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  async function api(m, p, b) {
    var h = { "content-type": "application/json" }; if (key) h.authorization = "Bearer " + key;
    var r = await fetch(p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) }), j = null; try { j = await r.json(); } catch (e) {}
    if (r.status === 401 && key && p.indexOf("/v1/accounts") !== 0) { /* stale key */ }
    return { status: r.status, body: j || {} };
  }
  async function ensureKey() { if (key) return true; var r = await api("POST", "/v1/accounts"); if (r.status === 201 && r.body.api_key) { key = r.body.api_key; try { localStorage.setItem("dryrun_key", key); } catch (e) {} return true; } return false; }
  function msg(r) { return (r.body && r.body.error && r.body.error.message) || "Something went wrong (" + r.status + ")"; }
  return { esc: esc, api: api, ensureKey: ensureKey, msg: msg, hasKey: function () { return !!key; }, forget: function () { key = null; try { localStorage.removeItem("dryrun_key"); } catch (e) {} } };
})();
`;

function nav(active) {
  return '<div class="sitebar"><div class="wrap"><a class="sb-brand" href="/">' + LOGO + "Zanboxx</a>" +
    SECTIONS.map((s) => `<a href="${s.href}"${s.id === active ? ' aria-current="page"' : ""}>${esc(s.short)}</a>`).join("") + "</div></div>";
}
function shell({ title, description, active, body, script = "", canonical = "", noindex = false }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(description || "")}">${noindex ? '<meta name="robots" content="noindex">' : ""}
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.png" type="image/png" sizes="48x48"><meta name="theme-color" content="#6a3df0">
<style>${BASE_CSS}${SITE_CSS}</style></head><body><a class="skip" href="#main">Skip to content</a>${nav(active)}<main id="main" class="wrap page">${body}</main>
<footer class="wrap foot"><div>${SECTIONS.map((s) => `<a href="${s.href}">${esc(s.short)}</a>`).join("")}</div><p>Zanboxx is an independent learning and testing platform. Test cards and fictional money only: never enter real card data. Nothing here is legal, financial or regulatory advice.</p>
<div><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/impressum">Impressum</a></div></footer>
${script ? "<script>" + CLIENT + script + "</script>" : ""}</body></html>`;
}

function landing() {
  const body = `<section class="hero" style="padding-bottom:8px"><h1>Learn payments. Build with them. Launch in fintech.</h1>
<p class="lede">One place to study how money moves, practise on a safe sandbox, read what you need, follow the industry, find a job and start a company. No real money, no real cards.</p></section>
<div class="cards">${SECTIONS.map((s) => `<a class="sec" style="--c:${s.color}" href="${s.href}"><h2>${esc(s.name)}</h2><p class="sub">${esc(s.sub)}</p><p>${esc(s.blurb)}</p></a>`).join("")}</div>`;
  const script = `(function(){var q=location.search,h=location.hash;if(/[?&](login|verify|billing)=/.test(q)||/dryrun|login=|verify=/.test(h)){location.replace("/labs"+q+h);}})();`;
  return shell({ title: "Zanboxx – learn payments, build with them, launch in fintech", description: "Fintech Academy, Payment Labs, Knowledge Centre, Fintech Intelligence, Fintech Careers and Startup Hub in one place.", active: "", body, script });
}

module.exports = { shell, esc, SECTIONS, landing, nav, SITE_CSS };
