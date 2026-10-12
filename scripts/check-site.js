#!/usr/bin/env node
// Static acceptance check for the Hedwig site. No dependencies.
// Usage: node check-site.js <path-to-web> [--no-client-names] [--no-film]
// Exit 0 = all checks pass. Exit 1 = prints every failure.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const web = path.resolve(process.argv[2] || "web");
const NO_NAMES = process.argv.includes("--no-client-names");
const NO_FILM = process.argv.includes("--no-film");
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const HOOK = "If AI is making it easier to transact onchain, we need to make it dramatically safer for everyone to use it.";
const CLIENTS = ["cla" + "ude code", "co" + "dex"];
const H1 = "Ask Hedwig before your agent pays.";
const PROMPT = "Help me install Hedwig. Open this exact link and follow its instructions: https://usehedwig.xyz/agents.md";
const OLD_OG_SHA = "af6e8f9d92a482f63b01b9d6ca051262edb55652cfb6d39fc8d0920d119fd3f5";
const RELEASE = "e85049bc7087f434fd732bb02e0e87ca57acd82c";
const PAGES = ["docs.html", "index.html"];
const BLOCK_CAPS = { header: 12, hero: 130, steps: 55, film: 15, footer: 10 };
const HOME_TOTAL_CAP = 200;
const DOCS_WORD_CAP = 420; // visible words outside <pre>; the live page has 493
const BANNED = [
  "safe", "safely", "safer", "safety", "secure", "security", "protect", "protects", "protection",
  "guarantee", "guarantees", "trust", "trusted", "verified", "cleared", "score", "scores",
  "report", "reports", "assessment", "assessments", "j" + "ev", "eval gate", "second opinion",
  "hosted", "any chain", "paybox", "monad", "vision", "prototype", "in development",
];
const REJECTED = [
  /start with a free local (policy )?check/i,
  /free local (policy )?check/i,
  /local policy check/i,
  /wallet (controls|keeps control of) (the )?sign/i,
  /(wallet|application|payment agent|agent)s? controls? (the )?(signing|signature)/i,
  /controls (the )?signature/i,
];
const EXTERNAL_OK = new Set(["github.com", "x.com", "www.youtube.com", "youtube.com", "youtu.be", "explorer.solana.com"]);
const GONE = ["about.html", "how-it-works.html", "proof.html", "roadmap.html", "team.html", "agents.html",
  "field.js", "sound.js", "owl.js", "sync-copy.js", "page-copy.json", "gabriel.png", "robots.txt", "sitemap.xml"];
const REDIRECTS = { "/about": "/", "/how-it-works": "/", "/roadmap": "/", "/team": "/", "/proof": "/#recorded-run", "/agents": "/#try" };

const read = (f) => fs.readFileSync(path.join(web, f), "utf8");
const exists = (f) => fs.existsSync(path.join(web, f));
const size = (f) => fs.statSync(path.join(web, f)).size;
const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, "·").replace(/&#8599;/g, "↗");
const strip = (html) => decode(html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, " ")
  .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const words = (s) => (s ? s.split(/\s+/).filter(Boolean).length : 0);
const metaText = (html) => {
  const out = [];
  const t = html.match(/<title>([\s\S]*?)<\/title>/i); if (t) out.push(t[1]);
  for (const m of html.matchAll(/<meta[^>]+(?:content)="([^"]*)"/gi)) out.push(m[1]);
  return decode(out.join(" "));
};

// 1. Page list
const htmlFiles = fs.readdirSync(web).filter((f) => f.endsWith(".html")).sort();
ok(JSON.stringify(htmlFiles) === JSON.stringify(PAGES), `page list is ${JSON.stringify(htmlFiles)}, want ${JSON.stringify(PAGES)}`);
for (const g of GONE) ok(!exists(g), `file should be deleted: ${g}`);
for (const p of PAGES) if (!exists(p)) { console.log(`FAIL missing ${p}`); process.exit(1); }

const home = read("index.html");
const docs = read("docs.html");

// 2. Redirects
let vercel = {};
try { vercel = JSON.parse(read("vercel.json")); } catch (e) { fails.push("vercel.json is not valid JSON"); }
const redirects = {};
for (const r of vercel.redirects || []) {
  redirects[r.source] = r.destination;
  ok(r.permanent === false, `redirect ${r.source} must set "permanent": false`);
}
for (const [src, dst] of Object.entries(REDIRECTS)) ok(redirects[src] === dst, `redirect ${src} -> want ${dst}, got ${redirects[src]}`);
ok(/default-src 'self'/.test(JSON.stringify(vercel.headers || [])), "CSP header with default-src 'self' must stay in vercel.json");

// 3. Word caps per block (blocks are sibling elements marked data-block, never nested)
const blocks = [...home.matchAll(/<(header|section|footer|main|aside|div)\b[^>]*\bdata-block="(\w+)"[^>]*>([\s\S]*?)<\/\1>/g)];
const names = blocks.map((m) => m[2]);
ok(blocks.length >= 3 && blocks.length <= 6, `home has ${blocks.length} data-block elements, want 3 to 6`);
for (const m of blocks) {
  const cap = BLOCK_CAPS[m[2]];
  ok(cap !== undefined, `unknown block name ${m[2]}`);
  if (cap !== undefined) ok(words(strip(m[3])) <= cap, `block ${m[2]} has ${words(strip(m[3]))} words, cap ${cap}`);
}
const homeText = strip(home.replace(/<head[\s\S]*?<\/head>/i, ""));
ok(words(homeText) <= HOME_TOTAL_CAP, `home has ${words(homeText)} visible words, cap ${HOME_TOTAL_CAP}`);
const docsText = strip(docs.replace(/<head[\s\S]*?<\/head>/i, "").replace(/<pre[\s\S]*?<\/pre>/gi, " "));
ok(words(docsText) <= DOCS_WORD_CAP, `docs has ${words(docsText)} visible words outside code, cap ${DOCS_WORD_CAP}`);
ok(!NO_FILM ? names.includes("film") : !names.includes("film"), NO_FILM ? "film block present with --no-film" : "film block missing");

// 4. Banned phrases: visible text, title, meta (home, docs) and llms.txt
const scrub = (s) => s.split(HOOK).join(" ");
const banRe = new RegExp(`\\b(${BANNED.map((b) => b.replace(/ /g, "\\s+")).join("|")})\\b`, "gi");
const surfaces = {
  "index visible": scrub(homeText), "index meta": scrub(metaText(home)),
  "docs visible": docsText, "docs meta": metaText(docs), "llms.txt": scrub(exists("llms.txt") ? read("llms.txt") : ""),
};
for (const [k, v] of Object.entries(surfaces)) {
  const hit = [...new Set((v.match(banRe) || []).map((x) => x.toLowerCase()))];
  ok(hit.length === 0, `banned words in ${k}: ${hit.join(", ")}`);
}
ok(strip(home).split(HOOK).length === 2, "hook line must appear exactly once in index.html, verbatim");
ok((strip(home).match(/\bsafer\b/gi) || []).length === 1, "the word safer may appear only inside the hook line");

// 5. Rejected lines, everywhere public (raw text of every html, md, txt, json)
const publicFiles = fs.readdirSync(web).filter((f) => /\.(html|md|txt|json|svg|js|css)$/.test(f));
for (const f of publicFiles) {
  const raw = decode(read(f));
  for (const re of REJECTED) ok(!re.test(raw), `rejected phrasing ${re} in ${f}`);
}

// 6. No em dashes, anywhere public
for (const f of publicFiles) ok(!new RegExp("\\u2014|&mdash;|&#8212;|&#x2014;", "i").test(read(f)), `em dash in ${f}`);

// 7. Links and asset references resolve
const isId = (html, id) => new RegExp(`\\sid="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(html);
function resolveLocal(ref, from) {
  let u = ref.trim();
  u = u.replace(/^https?:\/\/usehedwig\.xyz/, "");
  if (/^(mailto:|tel:|data:|javascript:)/.test(u)) return;
  if (/^https?:\/\//.test(u)) {
    const host = new URL(u).hostname;
    ok(EXTERNAL_OK.has(host), `external host not on the allowlist (${host}) in ${from}`);
    return;
  }
  if (u === "") return;
  let [p, hash] = u.split("#");
  if (p === "") p = "/" + (from === "index.html" ? "" : from.replace(/\.html$/, ""));
  if (!p.startsWith("/")) p = "/" + p;
  p = p.split("?")[0];
  const full = hash ? `${p}#${hash}` : p;
  if (redirects[p] !== undefined && p !== "/") {
    const d = redirects[p]; const [dp, dh] = d.split("#");
    ok(!dh || isId(dp === "/" ? home : read(dp.replace(/^\//, "") + ".html"), dh), `redirect target missing id: ${d}`);
    return;
  }
  const file = p === "/" ? "index.html" : exists(p.slice(1)) ? p.slice(1) : exists(p.slice(1) + ".html") ? p.slice(1) + ".html" : null;
  ok(file !== null, `dead internal link ${full} in ${from}`);
  if (file && hash && file.endsWith(".html")) ok(isId(read(file), hash), `missing #${hash} in ${file} (linked from ${from})`);
}
for (const f of publicFiles.filter((x) => /\.(html|md|txt)$/.test(x))) {
  const raw = read(f);
  const refs = [];
  if (f.endsWith(".html")) for (const m of raw.matchAll(/\b(?:href|src|poster)="([^"]+)"/g)) refs.push(m[1]);
  else for (const m of raw.matchAll(/\]\(([^)\s]+)\)/g)) refs.push(m[1]);
  for (const r of refs) resolveLocal(decode(r), f);
}

// 8. Home content contract
const h1s = [...home.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => strip(m[1]));
ok(h1s.length === 1 && h1s[0] === H1, `h1 must be exactly "${H1}", got ${JSON.stringify(h1s)}`);
const promptEl = home.match(/id="install-prompt"[^>]*>([\s\S]*?)<\/(pre|code|p|div)>/);
ok(promptEl && strip(promptEl[1]) === PROMPT, "element #install-prompt must hold the exact install prompt");
ok(/id="copy-prompt"/.test(home), "button #copy-prompt missing");
ok(/id="try"/.test(home), "anchor #try missing (the /agents redirect lands there)");
ok(/id="recorded-run"/.test(home), "anchor #recorded-run missing (the /proof redirect lands there)");
const hero = (blocks.find((m) => m[2] === "hero") || [])[3] || "";
const heroText = strip(hero);
if (NO_NAMES) ok(!new RegExp(CLIENTS.join("|"), "i").test(homeText), "client names must not appear with --no-client-names");
else ok(CLIENTS.every((c) => heroText.toLowerCase().includes(c)), "hero must name both coding agents");
ok(heroText.indexOf(H1) !== -1 && heroText.indexOf(H1) < heroText.indexOf("Help me install Hedwig") , "H1 must come before the prompt inside the hero block");
ok(/Hedwig never signs or sends/.test(homeText), 'line "Hedwig never signs or sends." missing');
ok(!/<a[^>]*class="[^"]*(action-secondary)/.test(home), "home must not carry a second button");
ok((home.match(/<script\b/g) || []).length <= 1 && !/<script>[\s\S]*?\S[\s\S]*?<\/script>/.test(home), "at most one script tag, external, no inline code");
ok(!/\sstyle="/.test(home + docs), "inline style attributes are blocked by the CSP");
const anchors = (home.match(/<a\b/g) || []).length;
ok(anchors <= 12, `home has ${anchors} links, cap 12`);

// 9. Film
if (!NO_FILM) {
  const v = home.match(/<video\b[^>]*>/);
  ok(!!v, "video element missing");
  if (v) {
    ok(/\bcontrols\b/.test(v[0]) && /preload="none"/.test(v[0]) && /\bposter="/.test(v[0]), "video needs controls, preload=none and a poster");
    ok(!/\bautoplay\b/.test(v[0]), "video must not autoplay");
  }
  ok(exists("hedwig-ad.mp4") && size("hedwig-ad.mp4") <= 3 * 1024 * 1024, "hedwig-ad.mp4 missing or over 3 MB");
  ok(!exists("hedwig-ad.webm"), "webm copy is not needed, delete it");
  const poster = (home.match(/\bposter="([^"]+)"/) || [])[1];
  ok(poster && exists(poster.replace(/^\//, "")) && size(poster.replace(/^\//, "")) <= 150 * 1024, "poster missing or over 150 KB");
} else ok(!/<video\b/.test(home), "video element present with --no-film");

// 10. Weight and leftovers
ok(size("index.html") <= 40 * 1024, `index.html is ${size("index.html")} bytes, cap 40960 (owl SVG must be a file, not inline)`);
ok(size("docs.html") <= 45 * 1024, `docs.html is ${size("docs.html")} bytes, cap 46080`);
const total = fs.readdirSync(web).filter((f) => !/\.(mp4)$/.test(f)).reduce((a, f) => a + size(f), 0);
ok(total <= 450 * 1024, `web/ without the film is ${total} bytes, cap 460800`);
const og = crypto.createHash("sha256").update(fs.readFileSync(path.join(web, "og-image.png"))).digest("hex");
ok(og !== OLD_OG_SHA, "og-image.png is still the old card (it says eval gate and reports in development)");
ok(size("og-image.png") <= 200 * 1024, "og-image.png over 200 KB");

// 11. Agent-facing files
ok(exists("agents.md") && exists("agentskill.md") && exists("llms.txt"), "agents.md, agentskill.md and llms.txt must stay");
ok(exists("llms.txt") && read("llms.txt").split("\n").length <= 14, "llms.txt over 14 lines");
ok(docs.includes(RELEASE) && docs.includes("yarn mcp:build"), "docs install block lost the pinned release or build command");
ok(read("agents.md").includes(RELEASE), "agents.md lost the pinned release");
ok(read("agentskill.md").includes("When to consult Hedwig"), "agentskill.md must keep its title and path");

if (fails.length) { console.log(`FAIL ${fails.length}`); for (const f of fails) console.log(" - " + f); process.exit(1); }
console.log("PASS all site checks");
