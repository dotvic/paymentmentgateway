"use strict";
// Privacy-friendly visitor counting. No cookies, no third party, no stored identifiers.
// - Counts HTML page views that answered 200, by UTC day, page, referring site and device class.
// - "Visitors" are approximate: a one-way hash of IP + browser string + a secret that is random per process and per day.
//   The hashes live only in memory (never written to the database) and are dropped when the day changes or the server restarts.
// - Visitors who send Do Not Track or Global Privacy Control are not counted. Bots are counted separately, without detail.
const crypto = require("crypto");

const KEEP_DAYS = 120, MAX_PAGES = 150, MAX_REFS = 40, MAX_HASHES = 50000, SAVE_EVERY_MS = 30e3;
const BOT = /bot|crawl|spider|slurp|curl|wget|python|node-fetch|undici|go-http|java\/|headless|monitor|uptime|preview|facebookexternalhit|lighthouse|pingdom|scan/i;
const MOBILE = /mobile|android|iphone|ipad/i;

module.exports = function ({ DB, saveMaps, clientIp }) {
  const store = () => ((DB.records = DB.records || {}).traffic = DB.records.traffic || {});
  let hashDay = "", salt = null, seen = new Set(), lastSave = 0, saveTimer = null;
  const day = (d = new Date()) => d.toISOString().slice(0, 10);
  const blank = () => ({ views: 0, visitors: 0, bots: 0, mobile: 0, desktop: 0, pages: {}, refs: {} });
  const bump = (o, k, cap) => { if (!(k in o) && Object.keys(o).length >= cap) k = "(other)"; o[k] = (o[k] || 0) + 1; };

  function persist() {
    const now = Date.now();
    if (now - lastSave >= SAVE_EVERY_MS) { lastSave = now; saveMaps(); return; }
    if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; lastSave = Date.now(); saveMaps(); }, SAVE_EVERY_MS - (now - lastSave)).unref();
  }
  function prune(today) {
    const cut = new Date(Date.parse(today) - KEEP_DAYS * 864e5).toISOString().slice(0, 10), t = store();
    for (const d of Object.keys(t)) if (d < cut) delete t[d];
  }
  function refHost(req) {
    const r = req.headers.referer; if (!r) return "(direct)";
    try { const h = new URL(r).hostname.replace(/^www\./, ""); const own = String(req.headers.host || "").split(":")[0].replace(/^www\./, ""); return h === own ? null : h.slice(0, 80); } catch { return "(direct)"; }
  }

  // Call once per request. It records when the response has finished and was an HTML page with status 200.
  function track(req, res, path) {
    if (req.method !== "GET" || path.startsWith("/v1/") || path.startsWith("/admin") || path === "/stats" || path === "/health") return;
    if (req.headers.dnt === "1" || req.headers["sec-gpc"] === "1") return;
    let ctype = "";
    const wh = res.writeHead;
    res.writeHead = function (status, a, b) {
      const h = typeof a === "object" && a ? a : b;
      if (h && typeof h === "object") for (const k of Object.keys(h)) if (k.toLowerCase() === "content-type") ctype = String(h[k]);
      return wh.apply(this, arguments);
    };
    res.on("finish", () => {
      try {
        if (!ctype) ctype = String(res.getHeader("content-type") || "");
        if (res.statusCode !== 200 || !/^text\/html/.test(ctype)) return;
        const today = day(), t = store(), d = t[today] || (t[today] = blank()), ua = String(req.headers["user-agent"] || "");
        if (hashDay !== today) { hashDay = today; salt = crypto.randomBytes(16); seen = new Set(); prune(today); }
        if (!ua || BOT.test(ua)) { d.bots++; persist(); return; }
        const ref = refHost(req);
        d.views++;
        (MOBILE.test(ua) ? (d.mobile++) : (d.desktop++));
        bump(d.pages, path.length > 1 ? path.replace(/\/+$/, "") : path, MAX_PAGES);
        if (ref) bump(d.refs, ref, MAX_REFS);
        const h = crypto.createHash("sha256").update(salt).update(clientIp(req)).update("|").update(ua).digest("base64").slice(0, 16);
        if (!seen.has(h) && seen.size < MAX_HASHES) { seen.add(h); d.visitors++; }
        persist();
      } catch (e) { console.error("traffic:", e.message); }
    });
  }

  function report(days) {
    days = Math.min(Math.max(parseInt(days, 10) || 30, 1), KEEP_DAYS);
    const t = store(), out = [], pages = {}, refs = {};
    let views = 0, visitors = 0, bots = 0, mobile = 0, desktop = 0;
    for (let i = days - 1; i >= 0; i--) {
      const k = day(new Date(Date.now() - i * 864e5)), d = t[k] || blank();
      out.push({ day: k, views: d.views, visitors: d.visitors, bots: d.bots });
      views += d.views; visitors += d.visitors; bots += d.bots; mobile += d.mobile; desktop += d.desktop;
      for (const [p, n] of Object.entries(d.pages)) pages[p] = (pages[p] || 0) + n;
      for (const [r, n] of Object.entries(d.refs)) refs[r] = (refs[r] || 0) + n;
    }
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
    return {
      days, timezone: "UTC", note: "Visitors are counted once per day per browser from a hash kept only in memory, so a server restart or a changed IP can count someone twice. Treat the numbers as approximate.",
      totals: { views, visitors_sum_of_daily: visitors, bot_requests: bots, mobile, desktop }, by_day: out, top_pages: top(pages, 15), top_referrers: top(refs, 10),
    };
  }
  function summary() { const r = report(7), td = r.by_day[r.by_day.length - 1]; return { today_views: td.views, today_visitors: td.visitors, last7_views: r.totals.views, last7_visitors_sum_of_daily: r.totals.visitors_sum_of_daily }; }

  const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Traffic – Zanboxx</title>
<style>:root{--bg:#fff;--ink:#14213d;--mut:#5b6478;--bar:#3b82f6;--line:#e3e7ef}@media(prefers-color-scheme:dark){:root{--bg:#0f1624;--ink:#e6ebf5;--mut:#9aa6bd;--bar:#6aa3ff;--line:#26314a}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}main{max-width:820px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px}.m{color:var(--mut);font-size:14px}
input,select,button{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}button{cursor:pointer;background:var(--bar);color:#fff;border-color:var(--bar)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}.c{border:1px solid var(--line);border-radius:10px;padding:10px 12px}.c b{display:block;font-size:26px}
.bars{display:flex;align-items:flex-end;gap:2px;height:110px;margin:12px 0;border-bottom:1px solid var(--line)}.bars div{flex:1;background:var(--bar);min-height:1px;border-radius:2px 2px 0 0}
table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}td:last-child,th:last-child{text-align:right}</style></head><body><main>
<h1>Traffic</h1><p class="m">Page views and approximate daily visitors. No cookies, no stored identifiers. Times are UTC.</p>
<p><input id="t" type="password" placeholder="Admin token" autocomplete="off" size="26"> <select id="d"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select> <button id="go" type="button">Load</button> <span id="e" class="m"></span></p>
<div id="o"></div></main><script>
function $(i){return document.getElementById(i);}function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
try{var s=sessionStorage.getItem("zt");if(s)$("t").value=s;}catch(e){}
function tbl(h,a){return "<table><tr><th>"+h+"</th><th>Views</th></tr>"+(a.length?a.map(function(x){return "<tr><td>"+esc(x.name)+"</td><td>"+x.count+"</td></tr>";}).join(""):"<tr><td colspan=2 class=m>Nothing yet</td></tr>")+"</table>";}
async function load(){$("e").textContent="";var tok=$("t").value.trim();if(!tok){$("e").textContent="Enter the admin token.";return;}
var r=await fetch("/admin/traffic?days="+$("d").value,{headers:{authorization:"Bearer "+tok}});if(r.status!==200){$("e").textContent=r.status===404?"Admin access is not enabled on this server.":"Wrong token or too many attempts.";return;}
try{sessionStorage.setItem("zt",tok);}catch(e){}var j=await r.json(),t=j.totals,mx=Math.max.apply(null,j.by_day.map(function(x){return x.views;}).concat([1]));
$("o").innerHTML='<div class="cards"><div class="c"><span class="m">Page views</span><b>'+t.views+'</b></div><div class="c"><span class="m">Visitors (sum of daily)</span><b>'+t.visitors_sum_of_daily+'</b></div><div class="c"><span class="m">Mobile / desktop</span><b>'+t.mobile+' / '+t.desktop+'</b></div><div class="c"><span class="m">Bot requests</span><b>'+t.bot_requests+'</b></div></div>'
+'<div class="bars">'+j.by_day.map(function(x){return '<div title="'+esc(x.day)+': '+x.views+' views, '+x.visitors+' visitors" style="height:'+Math.round(x.views/mx*100)+'%"></div>';}).join("")+'</div><p class="m">Daily page views, oldest to newest.</p>'
+'<h2>Top pages</h2>'+tbl("Page",j.top_pages)+'<h2>Where visitors come from</h2>'+tbl("Site",j.top_referrers)+'<p class="m">'+esc(j.note)+'</p>';}
$("go").onclick=load;if($("t").value)load();</script></body></html>`;

  return { track, report, summary, page: () => PAGE };
};
