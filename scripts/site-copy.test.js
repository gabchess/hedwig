const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const source = path.resolve(__dirname, "../web");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hedwig-site-sync-"));

try {
  fs.cpSync(source, dir, { recursive: true });
  const discoveryFiles = ["llms.txt", "robots.txt", "sitemap.xml"];
  for (const file of discoveryFiles) {
    fs.rmSync(path.join(dir, file), { force: true });
  }
  const files = [
    "index",
    "about",
    "how-it-works",
    "proof",
    "roadmap",
    "team",
    "docs",
    "agents",
  ];
  const read = (file) => fs.readFileSync(path.join(dir, file), "utf8");
  const write = (file, contents) =>
    fs.writeFileSync(path.join(dir, file), contents);
  const original = new Map(
    files.map((file) => [file + ".html", read(file + ".html")])
  );
  const pages = files.map((file) => {
    const html = original.get(file + ".html");
    return {
      file: file + ".html",
      path: file === "index" ? "/" : "/" + file,
      title: html.match(/<title>([^<]+)<\/title>/)[1],
      description: 'Check "the proposal" & keep control.',
      main: html.match(/<main\b[^>]*>[\s\S]*?<\/main>/)[0],
    };
  });
  const save = () => write("page-copy.json", JSON.stringify({ pages }));
  // The generator must locate its input beside itself, regardless of cwd.
  const run = (...args) =>
    spawnSync(process.execPath, [path.join(dir, "sync-copy.js"), ...args], {
      cwd: os.tmpdir(),
      encoding: "utf8",
    });
  let cases = 0;
  const expect = (result, status, message) => {
    assert.equal(result.status, status, result.stderr || result.stdout);
    if (message) assert.match(result.stderr, message);
    cases++;
  };

  save();
  expect(run("--check"), 1, /Copy drift/);
  for (const file of discoveryFiles)
    assert.equal(fs.existsSync(path.join(dir, file)), false);
  expect(run(), 0);
  expect(run("--check"), 0);

  const snapshots = new Map(
    files.map((file) => [file + ".html", read(file + ".html")])
  );
  const withoutCopy = (html) =>
    html
      .replace(/<main\b[^>]*>[\s\S]*?<\/main>/g, "")
      .replace(/<title>[^<]*<\/title>/g, "")
      .replace(
        /<meta\b[^>]*(?:name="description"|property="og:(?:title|description)")[^>]*>/g,
        ""
      );
  for (const [file, before] of original) {
    assert.equal(withoutCopy(snapshots.get(file)), withoutCopy(before));
  }
  assert.match(
    read("about.html"),
    /Check &quot;the proposal&quot; &amp; keep control\./
  );
  assert.match(read("llms.txt"), /Check "the proposal" & keep control/);
  assert.equal((read("sitemap.xml").match(/<loc>/g) || []).length, 8);
  assert.doesNotMatch(read("sitemap.xml"), /lastmod/);

  const reset = () => {
    for (const [file, html] of snapshots) write(file, html);
    save();
  };
  const alter = (file, change) => {
    const before = snapshots.get(file);
    const after = change(before);
    assert.notEqual(after, before, `Fixture mutation did not change ${file}`);
    write(file, after);
  };

  alter("about.html", (html) => html.replace("</main>", "<p>Drift</p></main>"));
  expect(run("--check"), 1, /Copy drift/);
  reset();

  pages[1].file = "index.html";
  save();
  expect(run(), 1, /duplicate page route/);
  pages[1].file = "about.html";
  reset();

  const main = pages[1].main;
  pages[1].main = main.replace(
    "</main>",
    '<a href="/missing">Missing</a></main>'
  );
  save();
  expect(run(), 1, /broken link/);
  pages[1].main = main;
  reset();

  pages[1].main = main.replace(
    "</main>",
    '<a href="/docs#missing">Missing fragment</a></main>'
  );
  save();
  expect(run(), 1, /missing fragment/);
  pages[1].main = main;
  reset();

  pages[1].main = main.replace(
    "</main>",
    '<a href="/docs#main">Good fragment</a></main>'
  );
  save();
  expect(run(), 0);
  pages[1].main = main;
  reset();

  alter("about.html", (html) =>
    html.replace(
      'rel="canonical" href="https://usehedwig.xyz/about"',
      'rel="canonical" href="https://usehedwig.xyz/wrong"'
    )
  );
  expect(run(), 1, /canonical/);
  reset();

  alter("about.html", (html) =>
    html.replace(
      'property="og:url" content="https://usehedwig.xyz/about"',
      'property="og:url" content="https://usehedwig.xyz/wrong"'
    )
  );
  expect(run(), 1, /canonical/);
  reset();

  alter("about.html", (html) =>
    html.replace(
      "</head>",
      '<meta name="robots" content="noindex,follow"></head>'
    )
  );
  expect(run(), 1, /noindex/);
  reset();

  for (const [file, html] of snapshots) {
    write(file, html.replace(/<a\b[^>]*href="\/team"[^>]*>[\s\S]*?<\/a>/g, ""));
  }
  expect(run(), 1, /no link from site navigation/);
  reset();

  expect(run("--wrong"), 1, /Usage:/);
  console.log(
    `${cases} site-copy checks passed; markup outside the edited fields preserved.`
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
