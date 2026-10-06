// Keep the static pages and discovery files aligned with page-copy.json.
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const origin = "https://usehedwig.xyz";
const routes = {
  "index.html": "/",
  "about.html": "/about",
  "how-it-works.html": "/how-it-works",
  "proof.html": "/proof",
  "roadmap.html": "/roadmap",
  "team.html": "/team",
  "docs.html": "/docs",
  "agents.html": "/agents",
};
const fail = (message) => {
  throw new Error(message);
};
const escape = (value) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c])
  );
const decode = (value) =>
  value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (m, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1].toLowerCase() === "x"
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[
      entity.toLowerCase()
    ];
  });
const attrs = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [
      m[1].toLowerCase(),
      decode(m[2] ?? m[3]),
    ])
  );
const tags = (html, name) =>
  [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => m[0]);
const clean = (html) =>
  html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
const mainPattern = /<main\b[^>]*>[\s\S]*?<\/main>/gi;

function replaceOne(html, pattern, replacement, label) {
  if ([...html.matchAll(pattern)].length !== 1) fail(`Expected one ${label}`);
  return html.replace(pattern, () => replacement);
}
function replaceMeta(html, key, name, value) {
  const matching = tags(html, "meta").filter((tag) => attrs(tag)[key] === name);
  if (matching.length !== 1) fail(`Expected one meta ${name}`);
  return html.replace(
    matching[0],
    () => `<meta ${key}="${name}" content="${escape(value)}">`
  );
}
function run() {
  if (process.argv.slice(2).some((arg) => arg !== "--check"))
    fail("Usage: node web/sync-copy.js [--check]");
  const { pages } = JSON.parse(
    fs.readFileSync(path.join(root, "page-copy.json"), "utf8")
  );
  if (!Array.isArray(pages) || pages.length !== Object.keys(routes).length)
    fail("Expected the eight public pages");
  const seen = new Set();
  for (const page of pages) {
    if (
      !page ||
      !Object.hasOwn(routes, page.file) ||
      routes[page.file] !== page.path ||
      seen.has(page.file)
    )
      fail("Invalid or duplicate page route");
    seen.add(page.file);
    for (const field of ["title", "description", "main"]) {
      if (typeof page[field] !== "string" || !page[field].trim())
        fail(`${page.file}: missing ${field}`);
    }
    if (/[\r\n]/.test(page.title + page.description))
      fail(`${page.file}: metadata must fit on one line`);
    if (
      !/^<main\b[^>]*>[\s\S]*<\/main>$/.test(page.main.trim()) ||
      tags(page.main, "main").length !== 1
    )
      fail(`${page.file}: expected one main element`);
  }
  const output = new Map();
  for (const page of pages) {
    let html = fs.readFileSync(path.join(root, page.file), "utf8");
    html = replaceOne(html, mainPattern, page.main.trim(), `${page.file} main`);
    html = replaceOne(
      html,
      /<title>[^<]*<\/title>/gi,
      `<title>${escape(page.title)}</title>`,
      `${page.file} title`
    );
    html = replaceMeta(html, "name", "description", page.description);
    html = replaceMeta(html, "property", "og:title", page.title);
    html = replaceMeta(html, "property", "og:description", page.description);
    const canonicals = tags(html, "link")
      .map(attrs)
      .filter((a) => a.rel === "canonical");
    const ogUrls = tags(html, "meta")
      .map(attrs)
      .filter((a) => a.property === "og:url");
    if (
      canonicals.length !== 1 ||
      canonicals[0].href !== origin + page.path ||
      ogUrls.length !== 1 ||
      ogUrls[0].content !== origin + page.path
    )
      fail(`${page.file}: incorrect canonical or og:url`);
    const robots = tags(html, "meta")
      .map(attrs)
      .filter((a) => /^(robots|googlebot)$/i.test(a.name || ""));
    if (robots.some((a) => /\b(noindex|none)\b/i.test(a.content || "")))
      fail(`${page.file}: indexed page is marked noindex`);
    output.set(page.file, html);
  }
  const home = pages.find((page) => page.path === "/");
  const markdown = (value) => value.replace(/[\\[\]]/g, "\\$&");
  output.set(
    "llms.txt",
    `# Hedwig\n\n> ${home.description}\n\n## Pages\n\n${pages
      .map(
        (page) =>
          `- [${markdown(page.title)}](${origin}${page.path}): ${
            page.description
          }`
      )
      .join(
        "\n"
      )}\n\n## Setup\n\nThese guides install v0.4.2. Newer changes on main may use different configuration.\n\n- [Consult Hedwig](${origin}/agents.md): local setup and owner approval.\n- [When to consult Hedwig](${origin}/agentskill.md): payment checks through MCP.\n- [Source](https://github.com/gabchess/hedwig)\n`
  );
  output.set(
    "robots.txt",
    `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`
  );
  output.set(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
      .map((page) => `  <url><loc>${origin}${page.path}</loc></url>`)
      .join("\n")}\n</urlset>\n`
  );
  const byPath = new Map(pages.map((page) => [page.path, page.file]));
  const reachable = new Set();
  for (const page of pages) {
    const html = clean(output.get(page.file));
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || "";
    const chromeLinks = new Set(
      tags(body.replace(mainPattern, ""), "a").map((tag) => attrs(tag).href)
    );
    for (const tag of tags(html, "(?:a|link)")) {
      const href = attrs(tag).href;
      if (!href) continue;
      const url = new URL(href, origin + page.path);
      if (url.origin !== origin) continue;
      if (/^https?:\/\//i.test(href) && /^<a\b/i.test(tag))
        fail(`${page.file}: use a path for internal link ${href}`);
      const pathname = decodeURIComponent(url.pathname);
      const file = byPath.get(pathname) || pathname.replace(/^\//, "");
      const resolved = path.resolve(root, file);
      if (
        !resolved.startsWith(root + path.sep) ||
        (!output.has(file) &&
          (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()))
      )
        fail(`${page.file}: broken link ${href}`);
      if (url.hash && file.endsWith(".html")) {
        const target = output.get(file) ?? fs.readFileSync(resolved, "utf8");
        const ids = tags(clean(target), "[a-z][\\w:-]*")
          .map(attrs)
          .map((a) => a.id);
        if (!ids.includes(decodeURIComponent(url.hash.slice(1))))
          fail(`${page.file}: missing fragment ${href}`);
      }
      if (
        !href.startsWith("#") &&
        chromeLinks.has(href) &&
        byPath.has(pathname)
      )
        reachable.add(pathname);
    }
  }
  for (const page of pages)
    if (!reachable.has(page.path))
      fail(`${page.file}: no link from site navigation`);
  const changed = [...output].filter(([file, contents]) => {
    const target = path.join(root, file);
    return (
      !fs.existsSync(target) || fs.readFileSync(target, "utf8") !== contents
    );
  });
  if (process.argv.includes("--check") && changed.length)
    fail(`Copy drift: ${changed.map(([file]) => file).join(", ")}`);
  if (!process.argv.includes("--check"))
    for (const [file, contents] of changed)
      fs.writeFileSync(path.join(root, file), contents);
  console.log(
    `Site copy verified: ${pages.length} pages${
      changed.length ? `; updated ${changed.length} files` : ""
    }`
  );
}
try {
  run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
