"use strict";
// Fintech Intelligence: our own explainers, articles published by the operator, and an optional headline feed.
// External feeds only ever show title, link, source and a short snippet; the reader follows the link to the publisher.
module.exports = function ({ html, text, notFound, ctx, UI, MD, esc }) {
  const SEED = require("../content/research");
  const { send, bad, readBody, DB, saveMaps } = ctx;
  const arts = () => (DB.records.article = DB.records.article || {});
  const all = () => [...SEED.map((a) => ({ ...a, seed: true })), ...Object.values(arts())].sort((a, b) => b.published_at.localeCompare(a.published_at));
  const find = (slug) => all().find((a) => a.slug === slug);
  const day = (s) => String(s).slice(0, 10);

  // ---- headline feed
  const FEEDS = (process.env.INTEL_FEEDS || "").split(",").map((s) => s.trim()).filter((u) => /^https:\/\/[^\s]+$/.test(u)).slice(0, 8);
  const feed = { items: [], at: 0, busy: false, errors: {} };
  const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ").replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[e.toLowerCase()] || (e[0] === "#" ? String.fromCodePoint(Math.min(0x10ffff, e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) || 32) : m))).replace(/\s+/g, " ").trim();
  const tag = (blk, n) => { const r = blk.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i")); return r ? r[1] : ""; };
  function parseFeed(xml, url) {
    const out = [], host = new URL(url).hostname;
    const src = decode(tag(xml.replace(/<(item|entry)[\s\S]*?<\/\1>/gi, ""), "title")) || host;
    for (const mt of xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
      const b = mt[2], title = decode(tag(b, "title")).slice(0, 200);
      let link = decode(tag(b, "link")); if (!link) { const l = b.match(/<link[^>]*href=["']([^"']+)["']/i); link = l ? decode(l[1]) : ""; }
      if (!title || !/^https?:\/\/[^\s]+$/.test(link)) continue;
      const d = new Date(decode(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date")));
      out.push({ title, link, source: src.slice(0, 80), snippet: decode(tag(b, "description") || tag(b, "summary")).slice(0, 240), at: isNaN(d) ? 0 : d.getTime() });
      if (out.length >= 20) break;
    }
    return out;
  }
  async function refresh() {
    if (!FEEDS.length || feed.busy) return; feed.busy = true;
    try {
      const items = [];
      for (const u of FEEDS) {
        try {
          const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
          const r = await fetch(u, { signal: ctl.signal, redirect: "error", headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.1", "user-agent": "ZanboxxFeedReader/1.0" } });
          if (!r.ok) throw new Error("HTTP " + r.status);
          const len = +r.headers.get("content-length") || 0; if (len > 2e6) throw new Error("too large");
          const buf = Buffer.from(await r.arrayBuffer()); clearTimeout(t); if (buf.length > 2e6) throw new Error("too large");
          items.push(...parseFeed(buf.toString("utf8"), u)); delete feed.errors[u];
        } catch (e) { feed.errors[u] = String(e.message || e).slice(0, 80); }
      }
      const seen = new Set(); feed.items = items.filter((i) => !seen.has(i.link) && seen.add(i.link)).sort((a, b) => b.at - a.at).slice(0, 40); feed.at = Date.now();
    } finally { feed.busy = false; }
  }
  if (FEEDS.length) { setTimeout(refresh, 5000).unref(); setInterval(refresh, 3 * 3600e3).unref(); }

  // ---- pages
  const rows = (items) => items.map((a) => `<article class="panel"><p class="hint" style="margin:0">${esc(day(a.published_at))}${a.seed ? " · Zanboxx team" : ""} ${(a.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</p><h3 style="margin:4px 0"><a href="/intelligence/${esc(a.slug)}">${esc(a.title)}</a></h3><p style="margin:0">${esc(a.summary)}</p></article>`).join("");
  function indexPage() {
    const heads = FEEDS.length ? (feed.items.length ? feed.items.slice(0, 20).map((i) => `<li><a href="${esc(i.link)}" rel="noopener noreferrer nofollow" target="_blank">${esc(i.title)}</a> <span class="hint">${esc(i.source)}${i.at ? " · " + esc(new Date(i.at).toISOString().slice(0, 10)) : ""}</span>${i.snippet ? `<br><span class="hint">${esc(i.snippet)}</span>` : ""}</li>`).join("") : "<li>Headlines are loading. Check back in a minute.</li>") : "";
    const body = `<div class="crumbs">Fintech Intelligence</div><h1>Fintech Intelligence</h1><p class="lede">News and research. Research notes from the Zanboxx team, plus headlines from sources we follow.</p>
<h2>Research notes</h2>${rows(all())}
<h2>Headlines</h2>${FEEDS.length ? `<p class="hint">Headlines are links to the original publishers; we show only the title and a short excerpt. Refreshed every few hours.</p><ul class="prose">${heads}</ul>` : `<p class="panel">No headline feeds are configured on this site yet.</p>`}
<p class="hint"><a href="/intelligence/feed.xml">Subscribe with RSS</a></p>`;
    return UI.shell({ title: "Fintech Intelligence – Zanboxx", description: "Research notes on payments and fintech, with a headline feed.", active: "intelligence", body });
  }
  function articlePage(a) {
    const r = MD.render(a.markdown, { shift: 0 });
    const body = `<div class="crumbs"><a href="/intelligence">Fintech Intelligence</a></div><h1>${esc(a.title)}</h1><p class="hint">${esc(day(a.published_at))} ${(a.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</p><p class="lede">${esc(a.summary)}</p><article class="prose">${r.html}</article><p class="hint">General information, not financial or legal advice.</p>`;
    return UI.shell({ title: `${a.title} – Zanboxx`, description: a.summary, active: "intelligence", body });
  }
  const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
  function rss() {
    const base = ctx.publicUrl || "";
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Zanboxx Fintech Intelligence</title><link>${xmlEsc(base)}/intelligence</link><description>Research notes on payments and fintech</description>${all().slice(0, 30).map((a) => `<item><title>${xmlEsc(a.title)}</title><link>${xmlEsc(base)}/intelligence/${xmlEsc(a.slug)}</link><guid>${xmlEsc(base)}/intelligence/${xmlEsc(a.slug)}</guid><pubDate>${new Date(a.published_at).toUTCString()}</pubDate><description>${xmlEsc(a.summary)}</description></item>`).join("")}</channel></rss>`;
  }
  const slugOk = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,78}$/.test(s);
  const clean = (b, slug) => {
    const title = String(b.title || "").trim(), summary = String(b.summary || "").trim(), markdown = String(b.markdown || "");
    if (title.length < 3 || title.length > 140) throw bad(400, "invalid_request", "title must be 3 to 140 characters");
    if (summary.length < 3 || summary.length > 300) throw bad(400, "invalid_request", "summary must be 3 to 300 characters");
    if (markdown.length < 20 || markdown.length > 60000) throw bad(400, "invalid_request", "markdown must be 20 to 60000 characters");
    const tags = (Array.isArray(b.tags) ? b.tags : []).map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24)).filter(Boolean).slice(0, 6);
    const pa = b.published_at ? new Date(b.published_at) : new Date(); if (isNaN(pa)) throw bad(400, "invalid_request", "published_at is not a date");
    return { slug, title, summary, markdown, tags, published_at: pa.toISOString() };
  };

  return {
    async handle(req, res, path, m) {
      let mt;
      if (m === "GET" && (path === "/intelligence" || path === "/intelligence/")) { html(res, 200, indexPage(), false); return true; }
      if (m === "GET" && path === "/intelligence/feed.xml") { text(res, 200, rss(), "application/rss+xml; charset=utf-8"); return true; }
      if (m === "GET" && (mt = path.match(/^\/intelligence\/([a-z0-9-]+)$/))) { const a = find(mt[1]); if (!a) { notFound(res, "intelligence", "article"); return true; } html(res, 200, articlePage(a), false); return true; }
      if (m === "GET" && path === "/v1/intelligence/articles") { send(res, 200, { data: all().map(({ slug, title, summary, tags, published_at }) => ({ slug, title, summary, tags, published_at })) }); return true; }
      if (m === "GET" && path === "/v1/intelligence/headlines") { send(res, 200, { configured: FEEDS.length > 0, updated_at: feed.at ? new Date(feed.at).toISOString() : null, data: feed.items.map(({ title, link, source, snippet, at }) => ({ title, link, source, snippet, published_at: at ? new Date(at).toISOString() : null })) }); return true; }
      return false;
    },
    async admin(req, res, path, m) {
      let mt;
      if (m === "GET" && path === "/admin/articles") { send(res, 200, { data: Object.values(arts()), feeds: FEEDS.map((u) => ({ url: u, error: feed.errors[u] || null })) }); return true; }
      if (m === "POST" && path === "/admin/feeds/refresh") { await refresh(); send(res, 200, { items: feed.items.length, errors: feed.errors }); return true; }
      if (m === "PUT" && (mt = path.match(/^\/admin\/articles\/([a-z0-9-]+)$/))) {
        if (!slugOk(mt[1])) throw bad(400, "invalid_request", "slug must be lowercase letters, digits and dashes");
        if (SEED.some((s) => s.slug === mt[1])) throw bad(409, "reserved", "That slug belongs to a built-in article");
        if (!arts()[mt[1]] && Object.keys(arts()).length >= 500) throw bad(409, "limit", "Too many articles");
        const a = clean(await readBody(req), mt[1]); arts()[a.slug] = a; saveMaps(); send(res, 200, a); return true;
      }
      if (m === "DELETE" && (mt = path.match(/^\/admin\/articles\/([a-z0-9-]+)$/))) { if (!arts()[mt[1]]) throw bad(404, "not_found", "No such article"); delete arts()[mt[1]]; saveMaps(); send(res, 200, { deleted: true }); return true; }
      return false;
    },
  };
};
