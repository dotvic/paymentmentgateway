"use strict";
// Knowledge Centre: guides, reference and glossary.
module.exports = function ({ html, notFound, ctx, UI, MD, esc }) {
  const K = require("../content/knowledge");
  const { send, bad } = ctx;
  const cats = ["Start here", "Concepts", "Guides", "Reference"];
  const index = K.pages.map((p) => ({ slug: p.slug, title: p.title, category: p.category, summary: p.summary }));
  const searchText = Object.fromEntries(K.pages.map((p) => [p.slug, (p.title + " " + p.summary + " " + p.markdown).toLowerCase().replace(/[`*#|]/g, " ")]));
  function indexPage() {
    const body = `<div class="crumbs">Knowledge Centre</div><h1>Knowledge Centre</h1><p class="lede">Guides and documentation for building and testing payment flows.</p>
<div class="panel"><label class="l" for="q" style="margin-top:0">Search the guides and the glossary</label><input class="f" id="q" type="search" placeholder="for example: chargeback, ARQC, settlement" autocomplete="off"><p class="hint" id="count"></p></div>
<div id="list">${cats.map((c) => { const items = index.filter((p) => p.category === c); return items.length ? `<section data-cat><h2>${esc(c)}</h2><div class="grid">${items.map((p) => `<a class="panel sec" style="--c:#2fd1a4;border-top-width:4px;padding:14px 16px" data-slug="${esc(p.slug)}" href="/knowledge/${esc(p.slug)}"><h3 style="margin:0 0 4px;font-size:18px">${esc(p.title)}</h3><p>${esc(p.summary)}</p></a>`).join("")}</div></section>` : ""; }).join("")}</div>`;
    const script = `var TEXT=${JSON.stringify(searchText).replace(/</g, "\\u003c")};var q=document.getElementById("q");function run(){var t=q.value.trim().toLowerCase(),n=0;document.querySelectorAll("[data-slug]").forEach(function(a){var ok=!t||TEXT[a.dataset.slug].indexOf(t)>=0;a.style.display=ok?"":"none";if(ok)n++;});document.querySelectorAll("[data-cat]").forEach(function(s){s.style.display=s.querySelector("[data-slug]:not([style*='none'])")?"":"none";});document.getElementById("count").textContent=t?n+" matching page"+(n===1?"":"s"):"";}q.addEventListener("input",run);`;
    return UI.shell({ title: "Knowledge Centre – Zanboxx", description: "Guides, API reference and a payments glossary.", active: "knowledge", body, script });
  }
  function articlePage(p) {
    const r = MD.render(p.markdown, { shift: 0 }), toc = r.toc.filter((t) => t.level === 2);
    const pos = K.pages.findIndex((x) => x.slug === p.slug), next = K.pages[pos + 1], prev = K.pages[pos - 1];
    const body = `<div class="crumbs"><a href="/knowledge">Knowledge Centre</a> / ${esc(p.category)}</div><h1>${esc(p.title)}</h1><p class="lede">${esc(p.summary)}</p>
${toc.length > 2 && p.slug !== "glossary" ? `<nav class="panel" style="display:block;max-width:760px" aria-label="On this page"><strong>On this page</strong><ul style="margin:6px 0 0;padding-left:18px">${toc.map((t) => `<li><a href="#${esc(t.id)}">${esc(t.text)}</a></li>`).join("")}</ul></nav>` : ""}
<article class="prose">${r.html}</article>
<div class="row sp panel">${prev ? `<a href="/knowledge/${esc(prev.slug)}">&larr; ${esc(prev.title)}</a>` : "<span></span>"}${next ? `<a href="/knowledge/${esc(next.slug)}">${esc(next.title)} &rarr;</a>` : ""}</div>
<p class="hint">Want to practise this? Open the <a href="/labs">Payment Labs</a> or find a course in the <a href="/academy">Academy</a>.</p>`;
    return UI.shell({ title: `${p.title} – Zanboxx Knowledge Centre`, description: p.summary, active: "knowledge", body });
  }
  return {
    async handle(req, res, path, m) {
      if (m === "GET" && (path === "/knowledge" || path === "/knowledge/")) { html(res, 200, indexPage()); return true; }
      let mt;
      if (m === "GET" && (mt = path.match(/^\/knowledge\/([a-z0-9-]+)$/))) { const p = K.bySlug[mt[1]]; if (!p) { notFound(res, "knowledge", "guide"); return true; } html(res, 200, articlePage(p), false); return true; }
      if (m === "GET" && path === "/v1/knowledge") { send(res, 200, { pages: index }); return true; }
      if (m === "GET" && (mt = path.match(/^\/v1\/knowledge\/([a-z0-9-]+)$/))) { const p = K.bySlug[mt[1]]; if (!p) throw bad(404, "not_found", "Unknown page"); send(res, 200, { slug: p.slug, title: p.title, category: p.category, summary: p.summary, markdown: p.markdown }); return true; }
      if (m === "GET" && path === "/v1/glossary") { send(res, 200, { terms: K.TERMS.map(([term, definition]) => ({ term, definition })) }); return true; }
      return false;
    },
  };
};
