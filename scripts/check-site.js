#!/usr/bin/env node
// Static check for the Hedwig site. No dependencies. Usage: node check-site.js <web-dir>
"use strict";
const fs = require("fs");
const path = require("path");

const web = path.resolve(process.argv[2] || "web");
const fails = [];
const ok = (cond, msg) => cond || fails.push(msg);
const PROMPT =
  "Help me install Hedwig. Open this exact link and follow its instructions: https://usehedwig.xyz/agents.md";
const YT = "https://www.youtube-nocookie.com";
const CSP = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-src ${YT}; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'`;
const HOSTS = ["github.com", "x.com", "www.youtube-nocookie.com", "youtu.be"];
const BANNED = new RegExp(
  "\\b(not public yet|aren't public|in development|under development|pending|prototype|concept|synthetic|offline tests?|unreleased|candidate|limitations?|remains to be|recorded run)\\b",
  "i"
);
const CLIENTS = new RegExp("Cl" + "aude Code|Co" + "dex", "i"); // built from parts
const DASH = String.fromCharCode(0x2014);
const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
const files = walk(web).map((f) => path.relative(web, f));
const has = (f) => files.includes(f);
const size = (f) => (has(f) ? fs.statSync(path.join(web, f)).size : 0);
const read = (f) => (has(f) ? fs.readFileSync(path.join(web, f), "utf8") : "");
const readme = path.join(web, "..", "README.md");
const all = files
  .filter((f) => /\.(html|md|txt|js|css|json|svg)$/.test(f))
  .map((f) => [f, read(f)]);
if (fs.existsSync(readme))
  all.push(["README.md", fs.readFileSync(readme, "utf8")]);
const pages = all.filter(([f]) => f.endsWith(".html"));
// Visible page text: no scripts, styles, svg, code or menu.
const text = (h) =>
  h
    .replace(
      /<!--[\s\S]*?-->|<(script|style|svg|pre|code|nav)\b[\s\S]*?<\/\1>/gi,
      " "
    )
    .replace(/<a class="skip-link"[\s\S]*?<\/a>|<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
// Markdown prose: no code, no link targets.
const prose = (s) =>
  s.replace(/```[\s\S]*?```|`[^`\n]*`|\]\([^)]*\)/g, " ").replace(/’/g, "'");
const human = all
  .filter(([f]) => /^(README\.md|llms\.txt|agents\.md|agentskill\.md)$/.test(f))
  .map(([f, s]) => [f, prose(s)])
  .concat(pages.map(([f, h]) => [f, text(h).replace(/’/g, "'")]));

// vercel.json
let vercel = {};
try {
  vercel = JSON.parse(read("vercel.json"));
} catch (e) {
  fails.push("vercel.json is not valid JSON");
}
const csp = (vercel.headers || [])
  .flatMap((h) => h.headers)
  .find((h) => h.key === "Content-Security-Policy");
ok(csp && csp.value === CSP, "CSP changed: edit CSP in check-site.js too");
ok(vercel.cleanUrls === true && vercel.trailingSlash === false, "cleanUrls");
// A rewrite names a page without .html under cleanUrls, or Vercel 404s.
const rewrites = new Map(
  (vercel.rewrites || []).map((r) => [r.source, r.destination])
);
for (const [s, d] of rewrites)
  ok(has(d.slice(1) + ".html"), `rewrite ${s} -> ${d}: name a page, no .html`);
const moved = new Set((vercel.redirects || []).map((r) => r.source));

// Links and fragments
for (const [f, src] of all.filter(
  ([f]) => has(f) && /\.(html|md|txt)$/.test(f)
)) {
  const re = f.endsWith(".html")
    ? /\b(?:href|src)="([^"]*)"/g
    : /\]\(([^)\s]+)\)/g;
  for (const [, raw] of src.matchAll(re)) {
    const u = new URL(
      raw.startsWith("#") ? "/" + f + raw : raw,
      "https://usehedwig.xyz/" + f
    );
    if (!/^https?:$/.test(u.protocol) || moved.has(u.pathname)) continue;
    if (u.hostname !== "usehedwig.xyz") {
      ok(HOSTS.includes(u.hostname), `${f}: external host ${u.hostname}`);
      continue;
    }
    const p = (rewrites.get(u.pathname) || u.pathname).slice(1);
    const hit = [p || "index.html", p + ".html", p].find(has);
    ok(hit, `${f}: dead link ${raw}`);
    if (hit && u.hash && hit.endsWith(".html"))
      ok(
        read(hit).includes(`id="${u.hash.slice(1)}"`),
        `${f}: dead fragment ${raw}`
      );
  }
}

// Pages
for (const [p, h] of pages) {
  for (const [, src] of h.matchAll(/<iframe\b[^>]*\bsrc="([^"]*)"/g))
    ok(src.startsWith(YT + "/embed/"), `${p}: iframe src ${src}`);
  ok(
    !/<script>\s*[^<\s]|<style\b|\sstyle="/.test(h),
    `${p}: inline script or style`
  );
  ok((h.match(/<h1\b/g) || []).length === 1, `${p}: needs exactly one <h1>`);
  const cap = { "index.html": 120, "agents.html": 240 }[p] || 120;
  ok(text(h).split(" ").length <= cap, `${p}: more than ${cap} words`);
  ok(size(p) <= (p === "index.html" ? 65536 : 16384), `${p}: too big`);
}
ok(files.reduce((n, f) => n + size(f), 0) <= 225280, "web/ is over 220 KB");
ok(size("style.css") <= 12288, "style.css is over 12 KB");
ok(size("og-image.png") <= 204800, "og-image.png is over 200 KB");

// Copy rules
for (const [f, s] of all) ok(!s.includes(DASH), `${f}: em dash`);
for (const [f, t] of human) {
  ok(!BANNED.test(t), `${f}: banned word "${(t.match(BANNED) || [])[0]}"`);
  if (!/^agent.*\.md$/.test(f))
    ok(!/\bv\d+\.\d+/.test(t), `${f}: version number`);
}
for (const [f, s] of all.filter(([f]) => /html$|llms/.test(f)))
  ok(!CLIENTS.test(s), `${f}: client name`);

// Structure the scripts and agents read
const home = read("index.html");
const agents = read("agents.html");
ok(
  /<div class="art">\s*<svg class="owl-svg"/.test(home),
  "index: .art > svg.owl-svg"
);
for (const id of ["field-row", "field-sound", "field-motion", "field-hint"])
  ok(home.includes(`id="${id}"`), `index: missing #${id}`);
ok(home.includes('property="og:image"'), "index: needs og:image");
ok(
  agents.includes(`id="install-prompt" tabindex="0">${PROMPT}</pre>`) &&
    agents.includes('id="copy-prompt"') &&
    agents.includes('id="copy-status"') &&
    agents.includes('href="https://github.com/gabchess/hedwig/releases"'),
  "agents.html: prompt, copy button, status or releases link changed"
);
for (const f of ["agents.md", "agentskill.md", "llms.txt"])
  ok(has(f), `${f} must exist`);
ok(read("llms.txt").split("\n").length <= 15, "llms.txt: over 14 lines");

if (fails.length) {
  console.log(`FAIL ${fails.length}`);
  for (const f of fails) console.log(" - " + f);
  process.exit(1);
}
console.log("PASS all site checks");
