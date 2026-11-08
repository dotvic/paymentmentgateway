"use strict";
// Routes for the six sections. server.js hands every request here first; a section returns true when it answered.
const UI = require("./siteui"), MD = require("./md");
const { esc } = UI;

module.exports = function createSite(ctx) {
  const { send, bad } = ctx;
  const html = (res, status, body, script = true, headers = {}) => {
    const buf = Buffer.from(body);
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": buf.length, "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "strict-transport-security": "max-age=31536000", "content-security-policy": script ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" : "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", ...headers });
    res.end(buf);
  };
  const text = (res, status, body, type) => { const buf = Buffer.from(body); res.writeHead(status, { "content-type": type, "content-length": buf.length, "cache-control": "no-cache", "x-content-type-options": "nosniff" }); res.end(buf); };
  const notFound = (res, section, what = "page") => html(res, 404, UI.shell({ title: "Not found – Zanboxx", active: section, noindex: true, body: `<h1>Not found</h1><p>We could not find that ${what}. <a href="/${section || ""}">Go back</a>.</p>` }), false);
  const h = { html, text, notFound, ctx, UI, MD, esc };
  const sections = [require("./sections/knowledge")(h), require("./sections/labsx")(h), require("./sections/controls")(h), require("./sections/tokens")(h), require("./sections/issuer")(h), require("./sections/terminal")(h), require("./sections/fees")(h), require("./sections/clearing")(h), require("./sections/qr")(h), require("./sections/agents")(h), require("./sections/acquiring")(h), require("./sections/academy")(h), require("./sections/intelligence")(h), require("./sections/careers")(h), require("./sections/startups")(h)].filter(Boolean);
  async function handle(req, res, path, m) {
    for (const s of sections) if (await s.handle(req, res, path, m)) return true;
    return false;
  }
  return { handle, admin: async (req, res, path, m) => { for (const s of sections) if (s.admin && await s.admin(req, res, path, m)) return true; return false; }, sections };
};
