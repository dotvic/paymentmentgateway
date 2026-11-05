"use strict";
// Fintech Academy: courses, quizzes, lab-verified tasks and verifiable certificates of completion.
module.exports = function ({ html, notFound, ctx, UI, MD, esc }) {
  const COURSES = require("../content/academy");
  const { send, bad, readBody, rnd, DB, save, saveMaps } = ctx;
  const byId = Object.fromEntries(COURSES.map((c) => [c.id, c]));
  const PASS = 0.7;
  const certs = () => (DB.records.certificate = DB.records.certificate || {});

  const progOf = (acc, id) => {
    const a = acc.academy = acc.academy || { courses: {} };
    return a.courses[id] = a.courses[id] || { lessons: [], quiz: { attempts: 0, best: 0, passed: false }, tasks: {} };
  };
  const pubCourse = (c) => ({
    id: c.id, title: c.title, level: c.level, minutes: c.minutes, summary: c.summary,
    lessons: c.lessons.map((l) => ({ title: l.title, markdown: l.md })),
    quiz: c.quiz.map((q) => ({ question: q.q, options: q.options })),
    tasks: c.tasks.map((t) => ({ id: t.id, text: t.text, hint: t.hint })),
    pass_mark_percent: PASS * 100,
  });
  const status = (acc, c) => {
    const p = progOf(acc, c.id), done = p.lessons.length, tdone = c.tasks.filter((t) => p.tasks[t.id]).length;
    const complete = done === c.lessons.length && p.quiz.passed && tdone === c.tasks.length;
    return {
      course_id: c.id, lessons_done: [...p.lessons].sort((a, b) => a - b), lessons_total: c.lessons.length,
      quiz: { attempts: p.quiz.attempts, best_percent: p.quiz.best, passed: p.quiz.passed },
      tasks: Object.fromEntries(c.tasks.map((t) => [t.id, !!p.tasks[t.id]])), tasks_done: tdone, tasks_total: c.tasks.length,
      complete, certificate_id: p.certificate || null,
    };
  };
  const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  const certView = (r) => ({ id: r.id, valid: true, name: r.name, course_id: r.course_id, course: r.course, level: r.level, issued_at: r.issued_at, note: "Certificate of completion from the Zanboxx Academy. It is not an accredited qualification." });

  // ---- pages
  function catalogPage() {
    const body = `<div class="crumbs">Fintech Academy</div><h1>Fintech Academy</h1><p class="lede">Courses and certifications. Read short lessons, pass a quiz, then prove it in the Payment Labs: tasks are checked against what you really did in your sandbox account.</p>
<div class="grid">${COURSES.map((c) => `<a class="panel sec" style="--c:#6a3df0;border-top-width:4px;padding:16px 18px" href="/academy/${esc(c.id)}"><span class="tag">${esc(c.level)}</span><span class="tag">${c.minutes} min</span><h3 style="margin:6px 0 4px;font-size:19px">${esc(c.title)}</h3><p>${esc(c.summary)}</p><p class="hint" data-prog="${esc(c.id)}"></p></a>`).join("")}</div>
<div class="panel"><strong>Certificates</strong><p>Finish every lesson, pass the quiz (${PASS * 100}% or more) and complete the lab tasks to get a certificate with a public link anyone can verify. Certificates are proof of completion, not an accredited qualification. Verify one: <input class="f" id="vid" placeholder="cert_..." style="max-width:260px;display:inline-block"> <button class="primary" id="vgo" type="button">Check</button></p></div>`;
    const script = `document.getElementById("vgo").onclick=function(){var v=document.getElementById("vid").value.trim();if(/^cert_[a-f0-9]+$/.test(v))location.href="/academy/certificate/"+v;};
if(Z.hasKey())Z.api("GET","/v1/academy/progress").then(function(r){if(r.status!==200)return;(r.body.courses||[]).forEach(function(s){var e=document.querySelector('[data-prog="'+s.course_id+'"]');if(e)e.textContent=s.complete?"Completed":(s.lessons_done.length+"/"+s.lessons_total+" lessons, "+s.tasks_done+"/"+s.tasks_total+" tasks");});});`;
    return UI.shell({ title: "Fintech Academy – Zanboxx", description: "Short payments courses with quizzes, lab tasks and verifiable certificates of completion.", active: "academy", body, script });
  }
  function coursePage(c) {
    const lessons = c.lessons.map((l, i) => `<section class="panel" id="l${i}"><h2 style="margin-top:0">${i + 1}. ${esc(l.title)}</h2><div class="prose">${MD.render(l.md, { shift: 2 }).html}</div><button class="primary" type="button" data-lesson="${i}">Mark lesson as done</button></section>`).join("");
    const quiz = c.quiz.map((q, i) => `<fieldset class="panel"><legend><strong>${i + 1}. ${esc(q.q)}</strong></legend>${q.options.map((o, j) => `<label style="display:block;margin:6px 0"><input type="radio" name="q${i}" value="${j}"> ${esc(o)}</label>`).join("")}<p class="hint" id="qr${i}"></p></fieldset>`).join("");
    const tasks = c.tasks.map((t) => `<li id="t_${esc(t.id)}"><strong>${esc(t.text)}</strong> <span class="tag" data-tag>not yet</span><br><span class="hint">${esc(t.hint)}</span></li>`).join("");
    const body = `<div class="crumbs"><a href="/academy">Fintech Academy</a> / ${esc(c.level)}</div><h1>${esc(c.title)}</h1><p class="lede">${esc(c.summary)}</p>
<div class="panel" id="status" aria-live="polite">Loading your progress…</div>
<h2>Lessons</h2>${lessons}
<h2>Quiz</h2><p class="hint">Pass mark ${PASS * 100}%. You can retake it as often as you like.</p>${quiz}<button class="primary" id="qgo" type="button">Submit answers</button> <span id="qmsg" class="hint"></span>
<h2>Lab tasks</h2><p>Do these in the <a href="/labs" target="_blank" rel="noopener">Payment Labs</a> with your own sandbox account (the same browser), then check them.</p><ol>${tasks}</ol><button class="primary" id="tgo" type="button">Check my tasks</button> <span id="tmsg" class="hint"></span>
<h2>Certificate</h2><div class="panel" id="cert"><p>Complete everything above to unlock your certificate.</p></div>`;
    const script = `var CID=${JSON.stringify(c.id)},NQ=${c.quiz.length};
function show(s){document.getElementById("status").textContent="Lessons "+s.lessons_done.length+"/"+s.lessons_total+" · Quiz "+(s.quiz.passed?"passed ("+s.quiz.best_percent+"%)":s.quiz.attempts?"best "+s.quiz.best_percent+"%":"not taken")+" · Tasks "+s.tasks_done+"/"+s.tasks_total+(s.complete?" · Course complete":"");
document.querySelectorAll("[data-lesson]").forEach(function(b){var d=s.lessons_done.indexOf(+b.dataset.lesson)>=0;b.textContent=d?"Done":"Mark lesson as done";b.disabled=d;});
Object.keys(s.tasks).forEach(function(k){var e=document.querySelector("#t_"+k+" [data-tag]");if(e){e.textContent=s.tasks[k]?"verified":"not yet";e.className="tag"+(s.tasks[k]?" ok":"");}});
var c=document.getElementById("cert");
if(s.certificate_id)c.innerHTML='<p>Your certificate: <a href="/academy/certificate/'+s.certificate_id+'">'+s.certificate_id+'</a>. Share this link so others can verify it.</p>';
else if(s.complete)c.innerHTML='<label class="l" for="nm" style="margin-top:0">Name to print on the certificate (up to 80 characters; it will be public)</label><input class="f" id="nm" maxlength="80" autocomplete="name"><p><button class="primary" id="cgo" type="button">Get my certificate</button> <span id="cmsg" class="hint"></span></p>';}
async function load(){if(!Z.hasKey()){document.getElementById("status").textContent="Your progress is saved to a free sandbox account, created when you first use a button below.";return;}var r=await Z.api("GET","/v1/academy/courses/"+CID+"/progress");if(r.status===200)show(r.body);}
async function act(m,p,b){if(!(await Z.ensureKey()))return null;return Z.api(m,p,b);}
document.addEventListener("click",async function(e){var t=e.target;
if(t.dataset&&t.dataset.lesson!==undefined){var r=await act("POST","/v1/academy/courses/"+CID+"/lessons/"+t.dataset.lesson+"/complete");if(r&&r.status===200)show(r.body);}
if(t.id==="cgo"){var r2=await act("POST","/v1/academy/courses/"+CID+"/certificate",{name:document.getElementById("nm").value});if(r2&&r2.status===201)load();else document.getElementById("cmsg").textContent=r2?Z.msg(r2):"";}});
document.getElementById("qgo").onclick=async function(){var a=[];for(var i=0;i<NQ;i++){var x=document.querySelector('input[name="q'+i+'"]:checked');a.push(x?+x.value:-1);}
if(a.indexOf(-1)>=0){document.getElementById("qmsg").textContent="Answer every question first.";return;}
var r=await act("POST","/v1/academy/courses/"+CID+"/quiz",{answers:a});if(!r)return;if(r.status!==200){document.getElementById("qmsg").textContent=Z.msg(r);return;}
var q=r.body;document.getElementById("qmsg").textContent=q.passed?"Passed with "+q.percent+"%.":"You scored "+q.percent+"%. Review the lessons and try again.";
q.results.forEach(function(x,i){var el=document.getElementById("qr"+i);el.textContent=x.correct?("Correct. "+(x.explanation||"")):"Not correct."+(x.explanation?" "+x.explanation:"");});load();};
document.getElementById("tgo").onclick=async function(){var r=await act("POST","/v1/academy/courses/"+CID+"/tasks/check");if(!r)return;if(r.status!==200){document.getElementById("tmsg").textContent=Z.msg(r);return;}document.getElementById("tmsg").textContent=r.body.tasks_done+" of "+r.body.tasks_total+" verified.";show(r.body);};
load();`;
    return UI.shell({ title: `${c.title} – Zanboxx Academy`, description: c.summary, active: "academy", body, script });
  }
  function certPage(r) {
    const body = r ? `<div class="crumbs"><a href="/academy">Fintech Academy</a> / Certificate</div><div class="panel" style="text-align:center;padding:36px 20px"><p class="tag ok">Valid certificate of completion</p><p class="hint">This certifies that</p><h1 style="margin:6px auto;max-width:none">${esc(r.name)}</h1><p class="hint">completed the course</p><h2 style="margin:6px 0">${esc(r.course)}</h2><p>${esc(r.level)} · issued ${esc(r.issued_at.slice(0, 10))}</p><p class="hint">Certificate ${esc(r.id)}. Issued by the Zanboxx Academy as proof of completion. It is not an accredited qualification.</p></div>`
      : `<div class="crumbs"><a href="/academy">Fintech Academy</a> / Certificate</div><h1>Certificate not found</h1><p>No certificate has this ID, or it was withdrawn.</p>`;
    return UI.shell({ title: r ? `Certificate: ${r.course} – Zanboxx` : "Certificate not found – Zanboxx", description: "Certificate verification", active: "academy", body, noindex: !r });
  }

  return {
    async handle(req, res, path, m) {
      let mt;
      if (m === "GET" && (path === "/academy" || path === "/academy/")) { html(res, 200, catalogPage()); return true; }
      if (m === "GET" && (mt = path.match(/^\/academy\/certificate\/(cert_[a-f0-9]+)$/))) { const r = certs()[mt[1]]; html(res, r ? 200 : 404, certPage(r), false); return true; }
      if (m === "GET" && (mt = path.match(/^\/academy\/([a-z0-9-]+)$/))) { const c = byId[mt[1]]; if (!c) { notFound(res, "academy", "course"); return true; } html(res, 200, coursePage(c)); return true; }

      if (m === "GET" && path === "/v1/academy/courses") { send(res, 200, { courses: COURSES.map((c) => ({ id: c.id, title: c.title, level: c.level, minutes: c.minutes, summary: c.summary, lessons: c.lessons.length, tasks: c.tasks.length })) }); return true; }
      if (m === "GET" && (mt = path.match(/^\/v1\/academy\/certificates\/(cert_[a-f0-9]+)$/))) { const r = certs()[mt[1]]; if (!r) throw bad(404, "not_found", "No such certificate"); send(res, 200, certView(r)); return true; }
      if (m === "GET" && (mt = path.match(/^\/v1\/academy\/courses\/([a-z0-9-]+)$/))) { const c = byId[mt[1]]; if (!c) throw bad(404, "not_found", "Unknown course"); send(res, 200, pubCourse(c)); return true; }
      if (!path.startsWith("/v1/academy/")) return false;

      const acc = ctx.authed(req);
      if (m === "GET" && path === "/v1/academy/progress") { send(res, 200, { courses: COURSES.map((c) => status(acc, c)) }); return true; }
      if (!(mt = path.match(/^\/v1\/academy\/courses\/([a-z0-9-]+)\/(progress|lessons\/(\d+)\/complete|quiz|tasks\/check|certificate)$/))) return false;
      const c = byId[mt[1]]; if (!c) throw bad(404, "not_found", "Unknown course");
      const p = progOf(acc, c.id), what = mt[2].split("/")[0];

      if (m === "GET" && what === "progress") { send(res, 200, status(acc, c)); return true; }
      if (m === "POST" && what === "lessons") {
        const i = +mt[3]; if (!(i >= 0 && i < c.lessons.length)) throw bad(404, "not_found", "Unknown lesson");
        if (!p.lessons.includes(i)) { p.lessons.push(i); save(acc); }
        send(res, 200, status(acc, c)); return true;
      }
      if (m === "POST" && what === "quiz") {
        const b = await readBody(req), a = b && b.answers;
        if (!Array.isArray(a) || a.length !== c.quiz.length || !a.every((x) => Number.isInteger(x) && x >= 0 && x < 8)) throw bad(400, "invalid_request", `answers must be a list of ${c.quiz.length} option numbers`);
        const results = c.quiz.map((q, i) => ({ correct: a[i] === q.answer, explanation: a[i] === q.answer ? q.why : "" }));
        const right = results.filter((r) => r.correct).length, percent = Math.round(right / c.quiz.length * 100), passed = right / c.quiz.length >= PASS;
        p.quiz.attempts++; p.quiz.best = Math.max(p.quiz.best, percent); if (passed) p.quiz.passed = true; save(acc);
        send(res, 200, { score: right, total: c.quiz.length, percent, passed, results }); return true;
      }
      if (m === "POST" && what === "tasks") {
        let changed = false;
        for (const t of c.tasks) if (!p.tasks[t.id]) { let ok = false; try { ok = !!t.check(acc); } catch {} if (ok) { p.tasks[t.id] = new Date().toISOString(); changed = true; } }
        if (changed) save(acc);
        send(res, 200, status(acc, c)); return true;
      }
      if (m === "POST" && what === "certificate") {
        if (p.certificate) { send(res, 200, certView(certs()[p.certificate])); return true; }
        if (!status(acc, c).complete) throw bad(409, "not_complete", "Finish every lesson, pass the quiz and verify every lab task first");
        const b = await readBody(req), name = cleanName(b && b.name);
        if (name.length < 2) throw bad(400, "invalid_request", "Enter the name to print on the certificate (2 to 80 characters)");
        const id = "cert_" + rnd(10);
        certs()[id] = { id, name, course_id: c.id, course: c.title, level: c.level, issued_at: new Date().toISOString(), account: acc.id };
        p.certificate = id; save(acc); saveMaps();
        send(res, 201, certView(certs()[id])); return true;
      }
      return false;
    },
    async admin(req, res, path, m) {
      let mt;
      if (m === "GET" && path === "/admin/certificates") { send(res, 200, { data: Object.values(certs()).map((r) => ({ ...certView(r), account: r.account })) }); return true; }
      if (m === "DELETE" && (mt = path.match(/^\/admin\/certificates\/(cert_[a-f0-9]+)$/))) { if (!certs()[mt[1]]) throw bad(404, "not_found", "No such certificate"); delete certs()[mt[1]]; saveMaps(); send(res, 200, { deleted: true }); return true; }
      return false;
    },
  };
};
