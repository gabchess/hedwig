#!/usr/bin/env node
// Static acceptance check for the Hedwig site, v2 (landing + /agents). No dependencies.
// Usage: node check-site.js <path-to-web> [--no-client-names] [--pinned]
// --pinned also demands owl.js, sound.js, field.js and connect.js stay byte-identical to origin/main b9c97f8.
// Exit 0 = all checks pass. Exit 1 = prints every failure.
"use strict";
const NO_NAMES = process.argv.includes("--no-client-names");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const web = path.resolve(process.argv[2] || "web");
const PINNED = process.argv.includes("--pinned"); // build-time guard; CI runs without it
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const HOOK = "If AI is making it easier to transact onchain, we need to make it dramatically safer for everyone to use it.";
const H1 = "Know before it pays.";
const PRODUCT = "an eval gate that makes onchain payments safer";
const CTA = "Try Hedwig today";
const PROMPT = "Help me install Hedwig. Open this exact link and follow its instructions: https://usehedwig.xyz/agents.md";
const RELEASE = "e85049bc7087f434fd732bb02e0e87ca57acd82c";
const OLD_OG_SHA = "af6e8f9d92a482f63b01b9d6ca051262edb55652cfb6d39fc8d0920d119fd3f5";
const PAGES = ["agents.html", "index.html"];
// Files restored from origin/main b9c97f8 and kept byte for byte.
const SHA = {
  "owl.js": "7f7bb46d40e4127c17755906b17a9d8d023725b92187efb254865d7325012fa0",
  "sound.js": "ed752b0b5b93271dd257e0ee27831e4d35709a5d4be397f28c6c2d5198586b52",
  "field.js": "c2367a66b9c699a659dfb85ba97bd66f59f5e20c9d23d379e67dcfae7c941379",
  "connect.js": "0a11ae019607d4eec94a5b84ef7cfe4a5b20c87b6d581041169c6cdd418e24b0",
};
const GONE = ["about.html", "how-it-works.html", "proof.html", "roadmap.html", "team.html", "docs.html",
  "sync-copy.js", "page-copy.json", "gabriel.png", "robots.txt", "sitemap.xml", "owl.svg",
  "hedwig-ad.mp4", "hedwig-ad.webm", "hedwig-ad-poster.jpg"];
const REDIRECTS = { "/about": "/", "/how-it-works": "/", "/roadmap": "/", "/team": "/", "/proof": "/", "/docs": "/agents" };
const MENU_HREFS = ["/", "/agents", "https://github.com/gabchess/hedwig",
  "https://x.com/usehedwig", "https://github.com/gabchess/hedwig/blob/main/THREAT-MODEL.md"];
const WORD_CAPS = { index: 100, indexHero: 60, agents: 240 };
// Human-facing words. Code blocks and inline code are exempt (env var names, API fields).
const BANNED = ["not public yet", "aren't public", "in development", "under development", "pending", "prototype",
  "concept", "synthetic", "offline test", "offline tests", "unreleased", "candidate", "limitation", "limitations",
  "remains to be", "recorded run", "j" + "ev", "paybox", "monad", "roadmap"];
const REJECTED = [
  /check before your agent pays/i,
  /start with a free local (policy )?check/i,
  /free local (policy )?check/i,
  /local policy check/i,
  /(wallet|application|payment agent|agent)s? controls? (the )?(signing|signature)/i,
];
// The 27 September run and every result card. Past work: repo only.
const RUN_ANY_FILE = [/ALLOW_UNDER_POLICY/, /\bDENY\b/, /\bROLE_/, /\bv\d+\.\d+/i, /27 September/i, /27 Sep\b/i, /2026-09-27/, /revoke-demo/i, /recorded run/i, /no payment was sent/i];
const RUN_WEB_ONLY = [/ALLOW_UNDER_POLICY/, /AMOUNT_EXCEEDS_CAP/, /ROLE_FACT_MISSING/, /ROLE_MEMBER_MISSING/,
  /within your rules/i, /over the limit/i, /role fact missing/i, /role revoked/i];
const EXTERNAL_OK = new Set(["github.com", "x.com"]);

const read = (f) => fs.readFileSync(path.join(web, f), "utf8");
const exists = (f) => fs.existsSync(path.join(web, f));
const size = (f) => fs.statSync(path.join(web, f)).size;
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(web, f))).digest("hex");
const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#8599;/g, "↗");
const strip = (html, dropCode) => {
  let h = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, " ");
  if (dropCode) h = h.replace(/<pre[\s\S]*?<\/pre>/gi, " ").replace(/<code[\s\S]*?<\/code>/gi, " ");
  return decode(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
};
const words = (s) => (s ? s.split(/\s+/).filter(Boolean).length : 0);
const metaText = (html) => {
  const out = [];
  const t = html.match(/<title>([\s\S]*?)<\/title>/i); if (t) out.push(t[1]);
  for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/gi)) out.push(m[1]);
  return decode(out.join(" "));
};
const block = (html, name) => {
  const m = html.match(new RegExp(`<(header|section|footer|main|div)\\b[^>]*\\bdata-block="${name}"[^>]*>([\\s\\S]*?)</\\1>`));
  return m ? m[2] : "";
};

// 1. Pages and removed files
const htmlFiles = fs.readdirSync(web).filter((f) => f.endsWith(".html")).sort();
ok(JSON.stringify(htmlFiles) === JSON.stringify(PAGES), `page list is ${JSON.stringify(htmlFiles)}, want ${JSON.stringify(PAGES)}`);
for (const g of GONE) ok(!exists(g), `file should be deleted: ${g}`);
for (const p of PAGES) if (!exists(p)) { console.log(`FAIL missing ${p}`); process.exit(1); }
const home = read("index.html");
const agents = read("agents.html");

// 2. Redirects and CSP
let vercel = {};
try { vercel = JSON.parse(read("vercel.json")); } catch (e) { fails.push("vercel.json is not valid JSON"); }
const redirects = {};
for (const r of vercel.redirects || []) { redirects[r.source] = r.destination; ok(r.permanent === false, `redirect ${r.source} must set "permanent": false`); }
for (const [src, dst] of Object.entries(REDIRECTS)) ok(redirects[src] === dst, `redirect ${src} -> want ${dst}, got ${redirects[src]}`);
ok(!("/agents" in redirects), "/agents is a real page now and must not redirect");
const csp = JSON.stringify(vercel.headers || []);
ok(/default-src 'self'/.test(csp) && /script-src 'self'/.test(csp) && /style-src 'self'/.test(csp), "CSP with self-only script and style must stay in vercel.json");
ok(vercel.cleanUrls === true && vercel.trailingSlash === false, "cleanUrls and trailingSlash must stay as shipped");

// 3. Byte-identical code that carries the owl and the sound (only with --pinned)
for (const f of Object.keys(SHA)) ok(exists(f), `${f} must exist`);
for (const [f, h] of Object.entries(SHA)) if (PINNED) ok(exists(f) && sha(f) === h, `${f} must be byte-identical to origin/main b9c97f8`);

// 4. Menu: one top-right button, no visible link row, same items on both pages
const menuOf = (html) => {
  const nav = html.match(/<nav[^>]*\bid="menu"[^>]*\bpopover\b[^>]*>([\s\S]*?)<\/nav>/);
  return nav ? [...nav[1].matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1])) : null;
};
for (const [name, html] of [["index.html", home], ["agents.html", agents]]) {
  const m = menuOf(html);
  ok(m !== null, `${name}: nav#menu[popover] missing`);
  ok(m && JSON.stringify(m) === JSON.stringify(MENU_HREFS), `${name}: menu items are ${JSON.stringify(m)}, want ${JSON.stringify(MENU_HREFS)}`);
  ok(/<button[^>]*\bpopovertarget="menu"[^>]*aria-label="Menu"|<button[^>]*aria-label="Menu"[^>]*\bpopovertarget="menu"/.test(html), `${name}: menu button needs popovertarget="menu" and aria-label="Menu"`);
  const header = block(html, "header").replace(/<nav[^>]*\bpopover\b[\s\S]*?<\/nav>/, "");
  const links = [...header.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((x) => x[1]);
  ok(JSON.stringify(links) === JSON.stringify(["/"]), `${name}: header shows links ${JSON.stringify(links)} outside the menu, want only the wordmark`);
  ok(!/<footer\b/.test(html), `${name}: no footer link row; subpages live in the menu`);
}

// 5. Landing contract
const homeMain = (home.match(/<main[\s\S]*?<\/main>/) || [""])[0];
const homeText = strip(home.replace(/<head[\s\S]*?<\/head>/i, ""));
const h1s = [...home.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => strip(m[1]));
ok(h1s.length === 1 && h1s[0] === H1, `index h1 must be exactly "${H1}", got ${JSON.stringify(h1s)}`);
ok(homeText.split(HOOK).length === 2, "hook line must appear exactly once in index.html, verbatim");
ok(homeText.toLowerCase().includes(PRODUCT.toLowerCase()), `index must say "${PRODUCT}"`);
const mainLinks = [...homeMain.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)];
ok(mainLinks.length === 1 && /class="button"/.test(mainLinks[0][0]) && /href="\/agents"/.test(mainLinks[0][0]) && strip(mainLinks[0][1]) === CTA,
  `index main must hold exactly one link: the "${CTA}" button to /agents (found ${mainLinks.length})`);
ok(!/<button\b/.test(homeMain.replace(/<div class="field-row"[\s\S]*?<\/ul>/, "")), "index main has a second button outside the owl controls");
ok(["hero", "why", "how"].every((n) => block(home, n)), "index needs data-block hero, why and how");
ok([...home.matchAll(/data-block="(\w+)"/g)].map((m) => m[1]).join() === "header,hero,why,how", "index data-block order must be header, hero, why, how");
ok(!/<video\b|<audio\b|autoplay/i.test(home + agents), "no video, audio element or autoplay on either page (the ad is not embedded)");
const CC = "Cl" + "aude Code", CX = "Co" + "dex"; // built from parts so the public-boundary hook does not match this file
if (NO_NAMES) ok(!new RegExp(CC + "|" + CX, "i").test(home + agents + read("llms.txt")), "client names must not appear with --no-client-names");
else ok([homeMain, agents].every((t) => t.includes(CC) && t.includes(CX)), "both pages must name both clients");

// 6. Owl: inline svg, the four control ids, scripts in order, token colors
ok(/<div class="art">\s*<svg class="owl-svg"[^>]*viewBox="0 0 1200 1200"[^>]*role="img"[^>]*aria-label="Hedwig, a pixel owl"/.test(home), "index needs .art > svg.owl-svg (60x60 cells, role=img, aria-label)");
for (const id of ["field-row", "field-sound", "field-motion", "field-hint"]) ok(new RegExp(`\\bid="${id}"`).test(home), `index missing #${id} (field.js and sound.js need it)`);
const scripts = [...home.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
ok(JSON.stringify(scripts) === JSON.stringify(['<script src="/owl.js">', '<script src="/sound.js">', '<script src="/field.js">']), `index scripts are ${JSON.stringify(scripts)}`);
ok(JSON.stringify([...agents.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])) === JSON.stringify(['<script src="/connect.js">']), "agents.html must load only /connect.js");
ok(!/<script>[\s\S]*?\S[\s\S]*?<\/script>/.test(home + agents) && !/\sstyle="/.test(home + agents) && !/<style\b/.test(home + agents), "no inline script, style tag or style attribute (CSP)");
ok(!/AudioContext/.test(home + agents), "no audio code in html; sound.js owns it");
const css = read("style.css");
for (const [n, v] of Object.entries({ ground: "#0d0b16", surface: "#1c1730", text: "#c9c5da", muted: "#8b85a3", purple: "#8b5cf6", blue: "#3b82f6" })) {
  ok(new RegExp(`--${n}:\\s*${v}`, "i").test(css), `style.css token --${n} must be ${v} (field.js reads it)`);
}
ok(/prefers-reduced-motion:\s*reduce/.test(css), "style.css needs a prefers-reduced-motion block");
ok(css.split("\n").length <= 200, `style.css has ${css.split("\n").length} lines, cap 200`);

// 7. /agents contract
const ah1 = [...agents.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => strip(m[1]));
ok(ah1.length === 1 && ah1[0] === "Call Hedwig", `agents h1 must be "Call Hedwig", got ${JSON.stringify(ah1)}`);
const pm = agents.match(/id="install-prompt"[^>]*>([\s\S]*?)<\/pre>/);
ok(pm && strip(pm[1]) === PROMPT, "#install-prompt must hold the exact install prompt");
ok(/id="copy-prompt"/.test(agents) && /id="copy-status"/.test(agents), "#copy-prompt and #copy-status missing");
ok(agents.includes(RELEASE) && agents.includes("yarn mcp:build"), "agents.html lost the pinned release or the build command");
ok(/href="\/agents\.md"/.test(agents) && /href="\/agentskill\.md"/.test(agents) && /href="\/llms\.txt"/.test(agents), "agents.html must link agents.md, agentskill.md and llms.txt");
ok(/\.mcp\.json/.test(agents) && /\[mcp_servers\.hedwig\]/.test(agents) && (NO_NAMES || /config\.toml/.test(agents)), "agents.html needs the .mcp.json and the config.toml blocks");
ok(/Confirm the commit/i.test(strip(agents)), "agents.html must tell the owner to confirm the commit on the release page");

// 8. Words: banned list, caps, 27 September run
const scrub = (s) => s.split(HOOK).join(" ");
const banRe = new RegExp(`\\b(${BANNED.map((b) => b.replace(/ /g, "\\s+")).join("|")})\\b`, "gi");
const surfaces = {
  "index visible": scrub(homeText), "index meta": scrub(metaText(home)),
  "agents visible": strip(agents.replace(/<head[\s\S]*?<\/head>/i, ""), true), "agents meta": metaText(agents),
  "llms.txt": exists("llms.txt") ? read("llms.txt") : "",
};
for (const [k, v] of Object.entries(surfaces)) {
  const hit = [...new Set((v.match(banRe) || []).map((x) => x.toLowerCase()))];
  ok(hit.length === 0, `banned words in ${k}: ${hit.join(", ")}`);
}
// Visible words: the menu popover is closed on load and the skip link is hidden until focus, so neither counts.
const homeVisible = strip(home.replace(/<head[\s\S]*?<\/head>/i, "").replace(/<nav[^>]*\bpopover\b[\s\S]*?<\/nav>/, " ").replace(/<a class="skip-link"[\s\S]*?<\/a>/, " "));
ok(words(homeVisible) <= WORD_CAPS.index, `index has ${words(homeVisible)} visible words, cap ${WORD_CAPS.index}`);
ok(words(strip(block(home, "hero"))) <= WORD_CAPS.indexHero, `hero has ${words(strip(block(home, "hero")))} words, cap ${WORD_CAPS.indexHero}`);
const agentsWords = words(strip(agents.replace(/<head[\s\S]*?<\/head>/i, ""), true));
ok(agentsWords <= WORD_CAPS.agents, `agents has ${agentsWords} visible words outside code, cap ${WORD_CAPS.agents}`);
const publicFiles = fs.readdirSync(web).filter((f) => /\.(html|md|txt|json|svg|js|css)$/.test(f));
for (const f of publicFiles) {
  const raw = decode(read(f));
  for (const re of REJECTED) ok(!re.test(raw), `retired phrasing ${re} in ${f}`);
  for (const re of RUN_ANY_FILE) ok(f.endsWith(".json") || !re.test(raw), `27 September run material ${re} in ${f}`);
  if (/\.(html|txt)$/.test(f)) {
    for (const re of RUN_WEB_ONLY) ok(!re.test(raw), `result-card material ${re} in ${f}`);
    ok(!/devnet/i.test(raw), `devnet in ${f}`);
  } else if (f.endsWith(".md")) {
    ok(!/devnet/i.test(raw.replace(/HEDWIG_SOLANA_RPC_URL_DEVNET/g, "")), `devnet outside the env var name in ${f}`);
  }
  ok(!/—|&mdash;|&#8212;|&#x2014;/i.test(read(f)), `em dash in ${f}`);
}

// 9. Links and assets resolve
const isId = (html, id) => new RegExp(`\\sid="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(html);
function resolveLocal(ref, from) {
  let u = ref.trim().replace(/^https?:\/\/usehedwig\.xyz/, "");
  if (/^(mailto:|tel:|data:|javascript:)/.test(u) || u === "") return;
  if (/^https?:\/\//.test(u)) { const host = new URL(u).hostname; ok(EXTERNAL_OK.has(host), `external host not on the allowlist (${host}) in ${from}`); return; }
  let [p, hash] = u.split("#");
  if (p === "") p = "/" + (from === "index.html" ? "" : from.replace(/\.html$/, ""));
  if (!p.startsWith("/")) p = "/" + p;
  p = p.split("?")[0];
  if (redirects[p] !== undefined && p !== "/") return;
  const file = p === "/" ? "index.html" : exists(p.slice(1)) ? p.slice(1) : exists(p.slice(1) + ".html") ? p.slice(1) + ".html" : null;
  ok(file !== null, `dead internal link ${p} in ${from}`);
  if (file && hash && file.endsWith(".html")) ok(isId(read(file), hash), `missing #${hash} in ${file} (linked from ${from})`);
}
for (const f of publicFiles.filter((x) => /\.(html|md|txt)$/.test(x))) {
  const raw = read(f); const refs = [];
  if (f.endsWith(".html")) for (const m of raw.matchAll(/\b(?:href|src)="([^"]+)"/g)) refs.push(m[1]);
  else for (const m of raw.matchAll(/\]\(([^)\s]+)\)/g)) refs.push(m[1]);
  for (const r of refs) resolveLocal(decode(r), f);
}
ok(!exists("og-image.png") || sha("og-image.png") !== OLD_OG_SHA, "og-image.png is still the old card");
ok(exists("og-image.png") && size("og-image.png") <= 200 * 1024, "og-image.png missing or over 200 KB");
ok(/og:image" content="https:\/\/usehedwig\.xyz\/og-image\.png"/.test(home) && /og:image/.test(agents), "og:image tag missing");

// 10. Weight
ok(size("index.html") <= 64 * 1024, `index.html is ${size("index.html")} bytes, cap 65536 (the owl is inline)`);
ok(size("agents.html") <= 16 * 1024, `agents.html is ${size("agents.html")} bytes, cap 16384`);
ok(size("style.css") <= 12 * 1024, `style.css is ${size("style.css")} bytes, cap 12288`);
const total = fs.readdirSync(web).reduce((a, f) => a + size(f), 0);
ok(total <= 220 * 1024, `web/ is ${total} bytes, cap 225280`);

// 11. Agent-facing files
ok(exists("agents.md") && exists("agentskill.md") && exists("llms.txt"), "agents.md, agentskill.md and llms.txt must stay");
ok(read("llms.txt").split("\n").filter(Boolean).length <= 14, "llms.txt over 14 lines");
ok(/eval gate/i.test(read("llms.txt")) && !/policy|check before/i.test(read("llms.txt")), "llms.txt must use the eval-gate line and no old vocabulary");
ok(read("agents.md").includes(RELEASE), "agents.md lost the pinned release");
ok(read("agentskill.md").includes("When to ask Hedwig"), "agentskill.md must keep its title and path");

if (fails.length) { console.log(`FAIL ${fails.length}`); for (const f of fails) console.log(" - " + f); process.exit(1); }
console.log("PASS all site checks");
