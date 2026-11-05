"use strict";
// A small, safe Markdown renderer (headings, paragraphs, lists, code, tables, quotes, links, bold, italics).
// Everything is escaped first; only https/http/relative links are kept; no raw HTML ever passes through.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugify = (s) => String(s).toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";
function inline(t) {
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const u = url.replace(/&amp;/g, "&");
    return /^(https?:\/\/|\/|#)/.test(u) ? `<a href="${esc(u)}"${u.startsWith("http") ? ' rel="noopener noreferrer" target="_blank"' : ""}>${text}</a>` : text;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}
function render(md, opts = {}) {
  const lines = String(md).replace(/\r/g, "").split("\n"), out = [], toc = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { const lv = Math.min(4, m[1].length + (opts.shift || 0)), id = slugify(m[2]); if (lv <= 3 && m[1].length >= 2) toc.push({ id, text: m[2].replace(/`/g, ""), level: lv }); out.push(`<h${lv} id="${id}">${inline(m[2])}</h${lv}>`); i++; continue; }
    if (/^\s*$/.test(l)) { i++; continue; }
    if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")), head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push("<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" + rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table>"); continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l), items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { let t = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""); i++; while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) t += " " + lines[i++].trim(); items.push(t); }
      out.push(`<${ordered ? "ol" : "ul"}>` + items.map((t) => `<li>${inline(t)}</li>`).join("") + `</${ordered ? "ol" : "ul"}>`); continue;
    }
    if (/^>\s?/.test(l)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue; }
    const buf = [l]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s+|>\s?|\|.*\|\s*$)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return { html: out.join("\n"), toc };
}
module.exports = { render, esc, slugify, inline };
