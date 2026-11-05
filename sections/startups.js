"use strict";
// Startup Hub: launch roadmap with saved progress, practical guides, and a moderated startup directory.
module.exports = function ({ html, notFound, ctx, UI, MD, esc }) {
  const S = require("../content/startups"), crypto = require("crypto");
  const { send, bad, readBody, rnd, DB, save, saveMaps, limited, clientIp } = ctx;
  const dir = () => (DB.records.startup = DB.records.startup || {});
  const STAGES = ["idea", "prototype", "launched", "growing"], HIDE_AT = 3, MAX_PER_ACC = 2, MAX_ALL = 1000;
  const reportHits = new Map(), postHits = new Map();
  const live = (s) => s.status === "approved" && s.reports.length < HIDE_AT;
  const pub = (s) => ({ id: s.id, name: s.name, tagline: s.tagline, description: s.description, website: s.website, stage: s.stage, country: s.country, listed_at: s.approved_at || s.created_at });
  const own = (s) => ({ ...pub(s), status: s.status, reject_reason: s.reject_reason || null });
  const line = (v, max, name, min = 2) => { const t = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim(); if (t.length < min || t.length > max) throw bad(400, "invalid_request", `${name} must be ${min} to ${max} characters`); return t; };
  function validate(b) {
    if (!b || typeof b !== "object") throw bad(400, "invalid_request", "Send a JSON body");
    const name = line(b.name, 60, "name"), tagline = line(b.tagline, 120, "tagline", 5), description = line(b.description, 1000, "description", 20), country = line(b.country, 40, "country");
    const stage = STAGES.includes(b.stage) ? b.stage : (() => { throw bad(400, "invalid_request", "stage must be one of " + STAGES.join(", ")); })();
    let u; try { u = new URL(String(b.website || "")); } catch { throw bad(400, "invalid_request", "website must be a valid https link"); }
    if (u.protocol !== "https:" || u.username || u.password || String(b.website).length > 300) throw bad(400, "invalid_request", "website must be an https link without credentials");
    return { name, tagline, description, country, stage, website: u.href };
  }

  function indexPage() {
    const body = `<div class="crumbs">Startup Hub</div><h1>Startup Hub</h1><p class="lede">Build fintech businesses. A launch roadmap from idea to growth with progress saved to your account, practical guides, and a directory of startups.</p>
<p class="panel"><strong>General education only.</strong> Nothing here is legal, regulatory, tax or financial advice. Rules differ by country. Check licensing and compliance questions with a qualified professional.</p>
<h2>Launch roadmap</h2><p class="hint" id="pg">Your progress is saved to your sandbox account.</p>
${S.ROADMAP.map((st) => `<section class="panel"><h3 style="margin-top:0">${esc(st.title)}</h3>${st.items.map((i) => `<label style="display:block;margin:7px 0"><input type="checkbox" data-item="${esc(i.id)}"> ${esc(i.text)}${i.link ? ` <a href="${esc(i.link)}">learn more</a>` : ""}</label>`).join("")}</section>`).join("")}
<h2>Guides</h2><div class="grid">${S.GUIDES.map((g) => `<a class="panel sec" style="--c:#f08a24;border-top-width:4px;padding:14px 16px" href="/startups/guides/${esc(g.slug)}"><h3 style="margin:0 0 4px;font-size:18px">${esc(g.title)}</h3><p>${esc(g.summary)}</p></a>`).join("")}</div>
<h2>Startup directory</h2><p><a href="/startups/directory">Browse the directory</a> · <a href="/startups/directory#add">List your startup</a></p>`;
    const script = `var total=document.querySelectorAll("[data-item]").length;
function count(){var n=document.querySelectorAll("[data-item]:checked").length;document.getElementById("pg").textContent=n+" of "+total+" steps done. Your progress is saved to your sandbox account.";}
if(Z.hasKey())Z.api("GET","/v1/startups/progress").then(function(r){if(r.status!==200)return;document.querySelectorAll("[data-item]").forEach(function(c){c.checked=!!r.body.done[c.dataset.item];});count();});
document.addEventListener("change",async function(e){var c=e.target;if(!c.dataset||!c.dataset.item)return;if(!(await Z.ensureKey())){c.checked=!c.checked;return;}var r=await Z.api("PUT","/v1/startups/progress/"+c.dataset.item,{done:c.checked});if(r.status!==200)c.checked=!c.checked;count();});count();`;
    return UI.shell({ title: "Startup Hub – Zanboxx", description: "Launch roadmap, guides and a directory for fintech startups.", active: "startups", body, script });
  }
  function guidePage(g) {
    const body = `<div class="crumbs"><a href="/startups">Startup Hub</a> / Guides</div><h1>${esc(g.title)}</h1><p class="lede">${esc(g.summary)}</p><article class="prose">${MD.render(g.markdown, { shift: 0 }).html}</article>`;
    return UI.shell({ title: `${g.title} – Zanboxx Startup Hub`, description: g.summary, active: "startups", body });
  }
  function dirPage() {
    const list = Object.values(dir()).filter(live).sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at))).slice(0, 200);
    const body = `<div class="crumbs"><a href="/startups">Startup Hub</a> / Directory</div><h1>Startup directory</h1><p class="lede">Fintech startups listed by their founders. Listings are reviewed for basic rules only; Zanboxx does not endorse them.</p>
<div class="grid">${list.length ? list.map((s) => `<article class="panel"><h3 style="margin:0">${esc(s.name)}</h3><p class="hint" style="margin:2px 0"><span class="tag">${esc(s.stage)}</span><span class="tag">${esc(s.country)}</span></p><p style="margin:4px 0"><strong>${esc(s.tagline)}</strong></p><p style="margin:4px 0">${esc(s.description)}</p><p class="hint"><a href="${esc(s.website)}" rel="noopener noreferrer nofollow ugc" target="_blank">Website</a> · <button type="button" class="small" data-rep="${esc(s.id)}">Report</button></p></article>`).join("") : '<p class="panel">No startups listed yet.</p>'}</div>
<h2 id="add">List your startup</h2><p class="hint">Free. Needs a sandbox account with a verified email (verify it in the <a href="/labs">Payment Labs</a>). Listings are reviewed first. Your listing is public: do not include personal data. Up to ${MAX_PER_ACC} listings per account.</p>
<form class="panel" id="f" autocomplete="off"><label class="l" for="name">Name</label><input class="f" id="name" maxlength="60" required>
<label class="l" for="tag">Tagline</label><input class="f" id="tag" maxlength="120" required>
<label class="l" for="desc">Description (20 to 1000 characters, plain text)</label><textarea class="f" id="desc" rows="5" maxlength="1000" required></textarea>
<label class="l" for="web">Website (https)</label><input class="f" id="web" type="url" maxlength="300" required>
<label class="l" for="country">Country</label><input class="f" id="country" maxlength="40" required>
<label class="l" for="stage">Stage</label><select id="stage">${STAGES.map((t) => `<option>${t}</option>`).join("")}</select>
<p><button class="primary" type="submit">Submit for review</button> <span id="m" class="hint"></span></p></form>
<h2>Your listings</h2><div id="mine" class="hint">Loading…</div>`;
    const script = `async function mine(){if(!Z.hasKey()){document.getElementById("mine").textContent="None yet.";return;}var r=await Z.api("GET","/v1/startups/mine");var d=r.body.data||[];document.getElementById("mine").innerHTML=d.length?d.map(function(s){return '<div class="panel"><strong>'+Z.esc(s.name)+'</strong> <span class="tag">'+Z.esc(s.status)+'</span>'+(s.reject_reason?' <span class="hint">'+Z.esc(s.reject_reason)+'</span>':'')+' <button type="button" class="small" data-del="'+Z.esc(s.id)+'">Remove</button></div>';}).join(""):"None yet.";}
document.getElementById("f").onsubmit=async function(e){e.preventDefault();var m=document.getElementById("m");if(!(await Z.ensureKey())){m.textContent="Could not create your account.";return;}var v=function(i){return document.getElementById(i).value;};
var r=await Z.api("POST","/v1/startups/directory",{name:v("name"),tagline:v("tag"),description:v("desc"),website:v("web"),country:v("country"),stage:v("stage")});m.textContent=r.status===201?"Submitted. It will appear once approved.":Z.msg(r);if(r.status===201)document.getElementById("f").reset();mine();};
document.addEventListener("click",async function(e){var d=e.target.dataset||{};if(d.del){await Z.api("DELETE","/v1/startups/directory/"+d.del);mine();}if(d.rep){var r=await Z.api("POST","/v1/startups/directory/"+d.rep+"/report");e.target.textContent=r.status===200?"Reported":"Try later";}});mine();`;
    return UI.shell({ title: "Startup directory – Zanboxx", description: "Fintech startups listed by their founders.", active: "startups", body, script });
  }

  return {
    async handle(req, res, path, m) {
      let mt;
      if (m === "GET" && (path === "/startups" || path === "/startups/")) { html(res, 200, indexPage()); return true; }
      if (m === "GET" && path === "/startups/directory") { html(res, 200, dirPage()); return true; }
      if (m === "GET" && (mt = path.match(/^\/startups\/guides\/([a-z-]+)$/))) { const g = S.GUIDES.find((x) => x.slug === mt[1]); if (!g) { notFound(res, "startups", "guide"); return true; } html(res, 200, guidePage(g), false); return true; }
      if (m === "GET" && path === "/v1/startups/roadmap") { send(res, 200, { stages: S.ROADMAP, note: "General education, not legal advice." }); return true; }
      if (m === "GET" && path === "/v1/startups/directory") { send(res, 200, { data: Object.values(dir()).filter(live).sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at))).slice(0, 100).map(pub) }); return true; }
      if (m === "POST" && (mt = path.match(/^\/v1\/startups\/directory\/(stp_[a-f0-9]+)\/report$/))) {
        const s = dir()[mt[1]]; if (!s || !live(s)) throw bad(404, "not_found", "No such listing");
        const ip = clientIp(req); if (limited(reportHits, ip, 10, 3600e3)) throw bad(429, "rate_limited", "Too many reports");
        const who = crypto.createHash("sha256").update("rep:" + ip).digest("hex").slice(0, 16);
        if (!s.reports.includes(who)) { s.reports.push(who); saveMaps(); }
        send(res, 200, { reported: true }); return true;
      }
      if (!path.startsWith("/v1/startups/")) return false;

      const acc = ctx.authed(req);
      acc.startup = acc.startup || { done: {} };
      if (m === "GET" && path === "/v1/startups/progress") { send(res, 200, { done: acc.startup.done, done_count: Object.keys(acc.startup.done).length, total: S.itemIds.length }); return true; }
      if (m === "PUT" && (mt = path.match(/^\/v1\/startups\/progress\/([a-z]-[a-z]+)$/))) {
        if (!S.itemIds.includes(mt[1])) throw bad(404, "not_found", "Unknown roadmap step");
        const b = await readBody(req);
        if (b && b.done === false) delete acc.startup.done[mt[1]]; else acc.startup.done[mt[1]] = new Date().toISOString();
        save(acc); send(res, 200, { done: acc.startup.done, done_count: Object.keys(acc.startup.done).length, total: S.itemIds.length }); return true;
      }
      if (m === "GET" && path === "/v1/startups/mine") { send(res, 200, { data: Object.values(dir()).filter((s) => s.account === acc.id).map(own) }); return true; }
      if (m === "POST" && path === "/v1/startups/directory") {
        if (!acc.email_verified) throw bad(403, "email_not_verified", "Verify your email in the Payment Labs before listing a startup");
        if (limited(postHits, acc.id, 10, 3600e3)) throw bad(429, "rate_limited", "Slow down");
        if (Object.values(dir()).filter((s) => s.account === acc.id).length >= MAX_PER_ACC) throw bad(409, "limit", `At most ${MAX_PER_ACC} listings per account`);
        if (Object.keys(dir()).length >= MAX_ALL) throw bad(409, "limit", "The directory is full; try again later");
        const v = validate(await readBody(req)), id = "stp_" + rnd(8);
        dir()[id] = { id, ...v, status: "pending", created_at: new Date().toISOString(), approved_at: null, reports: [], account: acc.id };
        saveMaps(); send(res, 201, own(dir()[id])); return true;
      }
      if (m === "DELETE" && (mt = path.match(/^\/v1\/startups\/directory\/(stp_[a-f0-9]+)$/))) {
        const s = dir()[mt[1]]; if (!s || s.account !== acc.id) throw bad(404, "not_found", "No such listing");
        delete dir()[s.id]; saveMaps(); send(res, 200, { deleted: true }); return true;
      }
      return false;
    },
    async admin(req, res, path, m) {
      let mt;
      if (m === "GET" && path === "/admin/startups") { const st = new URL(req.url, "http://x").searchParams.get("status"); send(res, 200, { data: Object.values(dir()).filter((s) => !st || s.status === st).slice(0, 200).map((s) => ({ ...own(s), reports: s.reports.length, account: s.account })) }); return true; }
      if (m === "POST" && (mt = path.match(/^\/admin\/startups\/(stp_[a-f0-9]+)\/(approve|reject)$/))) {
        const s = dir()[mt[1]]; if (!s) throw bad(404, "not_found", "No such listing");
        if (mt[2] === "approve") { s.status = "approved"; s.approved_at = new Date().toISOString(); s.reports = []; s.reject_reason = null; }
        else { const b = await readBody(req); s.status = "rejected"; s.reject_reason = String((b && b.reason) || "Does not meet the listing rules").slice(0, 200); }
        saveMaps(); send(res, 200, own(s)); return true;
      }
      if (m === "DELETE" && (mt = path.match(/^\/admin\/startups\/(stp_[a-f0-9]+)$/))) { if (!dir()[mt[1]]) throw bad(404, "not_found", "No such listing"); delete dir()[mt[1]]; saveMaps(); send(res, 200, { deleted: true }); return true; }
      return false;
    },
  };
};
