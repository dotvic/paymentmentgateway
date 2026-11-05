"use strict";
// Fintech Careers: a moderated job board and career paths that point at Academy courses and labs.
module.exports = function ({ html, notFound, ctx, UI, MD, esc }) {
  const PATHS = require("../content/careers"), ACAD = require("../content/academy");
  const crypto = require("crypto");
  const { send, bad, readBody, rnd, DB, save, saveMaps, limited, clientIp } = ctx;
  const jobs = () => (DB.records.job = DB.records.job || {});
  const TYPES = ["full-time", "part-time", "contract", "internship"];
  const DAY = 864e5, LIFE = 60 * DAY, HIDE_AT = 3, MAX_LIVE = 3, MAX_PER_MONTH = 5, MAX_JOBS = 2000;
  const postHits = new Map(), reportHits = new Map();
  const live = (j) => j.status === "approved" && Date.parse(j.expires_at) > Date.now() && j.reports.length < HIDE_AT;
  const pub = (j, full) => ({ id: j.id, title: j.title, company: j.company, location: j.location, remote: j.remote, type: j.type, salary: j.salary || null, posted_at: j.approved_at || j.created_at, expires_at: j.expires_at, apply_url: j.apply_url, ...(full ? { description: j.description } : {}) });
  const own = (j) => ({ ...pub(j, true), status: j.status, reports: j.reports.length, reject_reason: j.reject_reason || null });
  const oneLine = (v, max, name, min = 2) => { const s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim(); if (s.length < min || s.length > max) throw bad(400, "invalid_request", `${name} must be ${min} to ${max} characters`); return s; };
  function validate(b) {
    if (!b || typeof b !== "object") throw bad(400, "invalid_request", "Send a JSON body");
    const title = oneLine(b.title, 100, "title", 3), company = oneLine(b.company, 80, "company"), location = oneLine(b.location || "Remote", 80, "location");
    const type = TYPES.includes(b.type) ? b.type : (() => { throw bad(400, "invalid_request", "type must be one of " + TYPES.join(", ")); })();
    const description = String(b.description || "").replace(/\r/g, "").trim();
    if (description.length < 80 || description.length > 6000) throw bad(400, "invalid_request", "description must be 80 to 6000 characters");
    let u; try { u = new URL(String(b.apply_url || "")); } catch { throw bad(400, "invalid_request", "apply_url must be a valid https link"); }
    if (u.protocol !== "https:" || u.username || u.password || String(b.apply_url).length > 400) throw bad(400, "invalid_request", "apply_url must be an https link without credentials");
    const salary = b.salary ? oneLine(b.salary, 60, "salary", 1) : "";
    return { title, company, location, type, description, apply_url: u.href, salary, remote: b.remote === true || /remote/i.test(location) };
  }

  const jobCard = (j) => `<article class="panel" data-t="${esc((j.title + " " + j.company + " " + j.location + " " + j.type).toLowerCase())}"><h3 style="margin:0"><a href="/careers/jobs/${esc(j.id)}">${esc(j.title)}</a></h3><p style="margin:2px 0">${esc(j.company)} · ${esc(j.location)}${j.remote ? ' <span class="tag">remote</span>' : ""} <span class="tag">${esc(j.type)}</span>${j.salary ? ` <span class="tag">${esc(j.salary)}</span>` : ""}</p><p class="hint" style="margin:0">Posted ${esc(String(j.approved_at || j.created_at).slice(0, 10))}</p></article>`;
  function indexPage() {
    const list = Object.values(jobs()).filter(live).sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at))).slice(0, 200);
    const body = `<div class="crumbs">Fintech Careers</div><h1>Fintech Careers</h1><p class="lede">Jobs and professional growth. A moderated board for payments and fintech roles, and career paths that show what to learn.</p>
<p><a href="/careers/paths">Explore career paths</a> · <a href="/careers/post">Post a job</a> · <a href="/careers/profile">My skills profile</a></p>
<h2>Open roles</h2><input class="f" id="q" type="search" placeholder="Search title, company, location" aria-label="Search jobs" autocomplete="off"><p class="hint" id="n"></p>
<div id="list">${list.length ? list.map(jobCard).join("") : '<p class="panel">No open roles yet. Be the first to <a href="/careers/post">post one</a>.</p>'}</div>
<p class="hint">Listings are posted by third parties and checked for basic rules only. Zanboxx does not employ, recommend or vouch for the employers. Never pay to apply. Spot a problem? Use “Report” on the listing.</p>`;
    const script = `var q=document.getElementById("q");q.addEventListener("input",function(){var t=q.value.trim().toLowerCase(),n=0;document.querySelectorAll("[data-t]").forEach(function(a){var ok=!t||a.dataset.t.indexOf(t)>=0;a.style.display=ok?"":"none";if(ok)n++;});document.getElementById("n").textContent=t?n+" matching role"+(n===1?"":"s"):"";});`;
    return UI.shell({ title: "Fintech Careers – Zanboxx", description: "Payments and fintech jobs, career paths and skills profile.", active: "careers", body, script });
  }
  function jobPage(j) {
    const body = `<div class="crumbs"><a href="/careers">Fintech Careers</a> / Job</div><h1>${esc(j.title)}</h1><p class="lede">${esc(j.company)} · ${esc(j.location)} <span class="tag">${esc(j.type)}</span>${j.remote ? ' <span class="tag">remote</span>' : ""}${j.salary ? ` <span class="tag">${esc(j.salary)}</span>` : ""}</p>
<article class="prose">${MD.render(j.description, { shift: 1 }).html}</article>
<p><a href="${esc(j.apply_url)}" rel="noopener noreferrer nofollow ugc" target="_blank">Apply on the employer's site</a></p>
<p class="hint">Posted ${esc(String(j.approved_at || j.created_at).slice(0, 10))}, listed until ${esc(j.expires_at.slice(0, 10))}. You leave Zanboxx when you apply. Never pay to apply. <button type="button" id="rep" class="small">Report this listing</button> <span id="rm"></span></p>`;
    const script = `document.getElementById("rep").onclick=async function(){var r=await Z.api("POST","/v1/careers/jobs/${j.id}/report");document.getElementById("rm").textContent=r.status===200?"Thanks, we will look at it.":Z.msg(r);};`;
    return UI.shell({ title: `${j.title} at ${j.company} – Zanboxx Careers`, description: `${j.title} at ${j.company}, ${j.location}`, active: "careers", body, script });
  }
  function postPage() {
    const body = `<div class="crumbs"><a href="/careers">Fintech Careers</a> / Post a job</div><h1>Post a job</h1><p class="lede">Free. You need a sandbox account with a verified email (verify it in the <a href="/labs">Payment Labs</a>). New listings are reviewed before they appear and stay up for 60 days.</p>
<form class="panel" id="f" autocomplete="off">
<label class="l" for="title">Job title</label><input class="f" id="title" maxlength="100" required>
<label class="l" for="company">Company</label><input class="f" id="company" maxlength="80" required>
<label class="l" for="location">Location</label><input class="f" id="location" maxlength="80" placeholder="Warsaw, or Remote (EU)" required>
<label class="l" for="type">Type</label><select id="type">${TYPES.map((t) => `<option>${t}</option>`).join("")}</select>
<label class="l" for="salary">Pay range (optional)</label><input class="f" id="salary" maxlength="60" placeholder="EUR 60-80k">
<label class="l" for="apply">Apply link (https)</label><input class="f" id="apply" type="url" maxlength="400" required>
<label class="l" for="desc">Description (80 to 6000 characters, basic Markdown)</label><textarea class="f" id="desc" rows="10" maxlength="6000" required></textarea>
<p class="hint">Rules: real roles only, no fees from applicants, no discrimination, no personal data of others. We may reject or remove any listing. Limits: ${MAX_LIVE} listings open at once.</p>
<button class="primary" type="submit">Submit for review</button> <span id="m" class="hint"></span></form>
<h2>Your listings</h2><div id="mine" class="hint">Loading…</div>`;
    const script = `async function mine(){if(!Z.hasKey()){document.getElementById("mine").textContent="None yet.";return;}var r=await Z.api("GET","/v1/careers/mine");var d=r.body.data||[];document.getElementById("mine").innerHTML=d.length?d.map(function(j){return '<div class="panel"><strong>'+Z.esc(j.title)+'</strong> <span class="tag">'+Z.esc(j.status)+'</span>'+(j.reject_reason?' <span class="hint">'+Z.esc(j.reject_reason)+'</span>':'')+' <button type="button" class="small" data-del="'+Z.esc(j.id)+'">Remove</button></div>';}).join(""):"None yet.";}
document.getElementById("f").onsubmit=async function(e){e.preventDefault();var m=document.getElementById("m");if(!(await Z.ensureKey())){m.textContent="Could not create your account.";return;}
var v=function(i){return document.getElementById(i).value;};var r=await Z.api("POST","/v1/careers/jobs",{title:v("title"),company:v("company"),location:v("location"),type:v("type"),salary:v("salary"),apply_url:v("apply"),description:v("desc")});
m.textContent=r.status===201?"Submitted. It will appear once approved.":Z.msg(r);if(r.status===201)document.getElementById("f").reset();mine();};
document.addEventListener("click",async function(e){var id=e.target.dataset&&e.target.dataset.del;if(id){await Z.api("DELETE","/v1/careers/jobs/"+id);mine();}});mine();`;
    return UI.shell({ title: "Post a job – Zanboxx Careers", description: "Post a fintech job for review.", active: "careers", body, script });
  }
  const courseTitle = (id) => (ACAD.find((c) => c.id === id) || {}).title || id;
  function pathsPage() {
    const body = `<div class="crumbs"><a href="/careers">Fintech Careers</a> / Career paths</div><h1>Career paths</h1><p class="lede">What each role does, the skills it needs, and where to learn them here.</p><div class="grid">${PATHS.map((p) => `<a class="panel sec" style="--c:#e0457b;border-top-width:4px;padding:16px 18px" href="/careers/paths/${esc(p.id)}"><h3 style="margin:0 0 4px;font-size:19px">${esc(p.title)}</h3><p>${esc(p.summary)}</p></a>`).join("")}</div>`;
    return UI.shell({ title: "Career paths – Zanboxx Careers", description: "Fintech career paths and the skills behind them.", active: "careers", body });
  }
  function pathPage(p) {
    const body = `<div class="crumbs"><a href="/careers/paths">Career paths</a></div><h1>${esc(p.title)}</h1><p class="lede">${esc(p.summary)}</p><h2>A typical day</h2><p>${esc(p.day)}</p><h2>Skills and where to learn them</h2>
<ul>${p.skills.map(([s, c]) => `<li><strong>${esc(s)}</strong> — course: <a href="/academy/${esc(c)}">${esc(courseTitle(c))}</a> <span class="tag" data-c="${esc(c)}"></span></li>`).join("")}</ul>
<h2>Practise</h2><p>${esc(p.labs)} Open the <a href="/labs">Payment Labs</a>.</p><h2>Read next</h2><ul>${p.learn.map((l) => `<li><a href="/${esc(l)}">${esc(l)}</a></li>`).join("")}</ul>
<p><a href="/careers">See open roles</a></p>`;
    const script = `if(Z.hasKey())Z.api("GET","/v1/academy/progress").then(function(r){(r.body.courses||[]).forEach(function(s){document.querySelectorAll('[data-c="'+s.course_id+'"]').forEach(function(e){e.textContent=s.complete?"completed":"";e.className=s.complete?"tag ok":"tag";});});});`;
    return UI.shell({ title: `${p.title} career path – Zanboxx`, description: p.summary, active: "careers", body, script });
  }
  function profilePage() {
    const body = `<div class="crumbs"><a href="/careers">Fintech Careers</a> / Skills profile</div><h1>My skills profile</h1><p class="lede">Built from the Academy courses you have completed with your sandbox account. Nothing is shared unless you share a certificate link.</p><div id="out" class="hint">Loading…</div>`;
    const script = `(async function(){var o=document.getElementById("out");if(!Z.hasKey()){o.innerHTML='You have not started yet. Try a <a href="/academy">course</a>.';return;}var r=await Z.api("GET","/v1/careers/profile");if(r.status!==200){o.textContent=Z.msg(r);return;}
o.innerHTML='<p><strong>Completed courses:</strong> '+(r.body.completed.length?r.body.completed.map(Z.esc).join(", "):"none yet")+'</p>'+r.body.paths.map(function(p){return '<div class="panel"><strong><a href="/careers/paths/'+Z.esc(p.id)+'">'+Z.esc(p.title)+'</a></strong> — '+p.percent+'% of the listed skills covered'+(p.missing.length?'<br><span class="hint">Next: '+p.missing.map(function(m){return '<a href="/academy/'+Z.esc(m.course_id)+'">'+Z.esc(m.skill)+'</a>';}).join(", ")+'</span>':'')+'</div>';}).join("");})();`;
    return UI.shell({ title: "Skills profile – Zanboxx Careers", description: "Your skills across fintech career paths.", active: "careers", body, script, noindex: true });
  }

  const verified = (acc) => { if (!acc.email_verified) throw bad(403, "email_not_verified", "Verify your email in the Payment Labs before posting a job"); };
  const find = (id) => jobs()[id];
  return {
    async handle(req, res, path, m) {
      let mt;
      if (m === "GET" && (path === "/careers" || path === "/careers/")) { html(res, 200, indexPage()); return true; }
      if (m === "GET" && path === "/careers/post") { html(res, 200, postPage()); return true; }
      if (m === "GET" && path === "/careers/paths") { html(res, 200, pathsPage(), false); return true; }
      if (m === "GET" && path === "/careers/profile") { html(res, 200, profilePage()); return true; }
      if (m === "GET" && (mt = path.match(/^\/careers\/paths\/([a-z-]+)$/))) { const p = PATHS.find((x) => x.id === mt[1]); if (!p) { notFound(res, "careers", "career path"); return true; } html(res, 200, pathPage(p)); return true; }
      if (m === "GET" && (mt = path.match(/^\/careers\/jobs\/(job_[a-f0-9]+)$/))) { const j = find(mt[1]); if (!j || !live(j)) { notFound(res, "careers", "job"); return true; } html(res, 200, jobPage(j)); return true; }

      if (m === "GET" && path === "/v1/careers/paths") { send(res, 200, { data: PATHS.map((p) => ({ id: p.id, title: p.title, summary: p.summary, skills: p.skills.map(([skill, course_id]) => ({ skill, course_id })) })) }); return true; }
      if (m === "GET" && path === "/v1/careers/jobs") {
        const q = (new URL(req.url, "http://x").searchParams.get("q") || "").toLowerCase().slice(0, 60);
        send(res, 200, { data: Object.values(jobs()).filter(live).filter((j) => !q || (j.title + " " + j.company + " " + j.location).toLowerCase().includes(q)).sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at))).slice(0, 100).map((j) => pub(j)) }); return true;
      }
      if (m === "GET" && (mt = path.match(/^\/v1\/careers\/jobs\/(job_[a-f0-9]+)$/))) { const j = find(mt[1]); if (!j || !live(j)) throw bad(404, "not_found", "No such job"); send(res, 200, pub(j, true)); return true; }
      if (m === "POST" && (mt = path.match(/^\/v1\/careers\/jobs\/(job_[a-f0-9]+)\/report$/))) {
        const j = find(mt[1]); if (!j || !live(j)) throw bad(404, "not_found", "No such job");
        const ip = clientIp(req); if (limited(reportHits, ip, 10, 3600e3)) throw bad(429, "rate_limited", "Too many reports");
        const who = crypto.createHash("sha256").update("rep:" + ip).digest("hex").slice(0, 16);
        if (!j.reports.includes(who)) { j.reports.push(who); saveMaps(); }
        send(res, 200, { reported: true }); return true;
      }
      if (!path.startsWith("/v1/careers/")) return false;

      const acc = ctx.authed(req);
      if (m === "GET" && path === "/v1/careers/mine") { send(res, 200, { data: Object.values(jobs()).filter((j) => j.account === acc.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(own) }); return true; }
      if (m === "GET" && path === "/v1/careers/profile") {
        const done = new Set(ACAD.filter((c) => { const p = acc.academy && acc.academy.courses[c.id]; return p && p.lessons.length === c.lessons.length && p.quiz.passed && c.tasks.every((t) => p.tasks[t.id]); }).map((c) => c.id));
        send(res, 200, { completed: [...done].map(courseTitle), paths: PATHS.map((p) => { const have = p.skills.filter(([, c]) => done.has(c)).length; return { id: p.id, title: p.title, percent: Math.round(have / p.skills.length * 100), missing: p.skills.filter(([, c]) => !done.has(c)).map(([skill, course_id]) => ({ skill, course_id })) }; }) }); return true;
      }
      if (m === "POST" && path === "/v1/careers/jobs") {
        verified(acc);
        if (limited(postHits, acc.id, 10, 3600e3)) throw bad(429, "rate_limited", "Slow down");
        const mine = Object.values(jobs()).filter((j) => j.account === acc.id);
        if (mine.filter((j) => j.status === "pending" || live(j)).length >= MAX_LIVE) throw bad(409, "limit", `You can have ${MAX_LIVE} open or pending listings at a time`);
        if (mine.filter((j) => Date.parse(j.created_at) > Date.now() - 30 * DAY).length >= MAX_PER_MONTH) throw bad(409, "limit", `At most ${MAX_PER_MONTH} listings per 30 days`);
        if (Object.keys(jobs()).length >= MAX_JOBS) throw bad(409, "limit", "The board is full; try again later");
        const v = validate(await readBody(req)), id = "job_" + rnd(8), now = new Date().toISOString();
        jobs()[id] = { id, ...v, status: "pending", created_at: now, approved_at: null, expires_at: new Date(Date.now() + LIFE).toISOString(), reports: [], account: acc.id };
        saveMaps(); send(res, 201, own(jobs()[id])); return true;
      }
      if (m === "DELETE" && (mt = path.match(/^\/v1\/careers\/jobs\/(job_[a-f0-9]+)$/))) {
        const j = find(mt[1]); if (!j || j.account !== acc.id) throw bad(404, "not_found", "No such job");
        delete jobs()[j.id]; saveMaps(); send(res, 200, { deleted: true }); return true;
      }
      return false;
    },
    async admin(req, res, path, m) {
      let mt;
      if (m === "GET" && path === "/admin/jobs") {
        const st = new URL(req.url, "http://x").searchParams.get("status");
        send(res, 200, { data: Object.values(jobs()).filter((j) => !st || j.status === st).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 200).map((j) => ({ ...own(j), account: j.account, description: j.description })) }); return true;
      }
      if (m === "POST" && (mt = path.match(/^\/admin\/jobs\/(job_[a-f0-9]+)\/(approve|reject)$/))) {
        const j = find(mt[1]); if (!j) throw bad(404, "not_found", "No such job");
        if (mt[2] === "approve") { j.status = "approved"; j.approved_at = new Date().toISOString(); j.expires_at = new Date(Date.now() + LIFE).toISOString(); j.reports = []; j.reject_reason = null; }
        else { const b = await readBody(req); j.status = "rejected"; j.reject_reason = String((b && b.reason) || "Does not meet the posting rules").slice(0, 200); }
        saveMaps(); send(res, 200, own(j)); return true;
      }
      if (m === "DELETE" && (mt = path.match(/^\/admin\/jobs\/(job_[a-f0-9]+)$/))) { if (!find(mt[1])) throw bad(404, "not_found", "No such job"); delete jobs()[mt[1]]; saveMaps(); send(res, 200, { deleted: true }); return true; }
      return false;
    },
  };
};
