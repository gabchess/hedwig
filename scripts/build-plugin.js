// Bundles the MCP server into plugin/server/hedwig-mcp.js and writes
// plugin/THIRD-PARTY-NOTICES.md from the packages the bundle contains.
// Run `npm ci --ignore-scripts --prefix mcp`, `yarn consult:build` and
// `yarn mcp:build` first. CI runs this and fails if plugin/ changes.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const esbuild = require(path.join(root, "mcp/node_modules/esbuild"));

async function main() {
  const result = await esbuild.build({
    entryPoints: [path.join(root, "mcp/dist/server.js")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    legalComments: "none",
    metafile: true,
    outfile: path.join(root, "plugin/server/hedwig-mcp.js"),
  });

  const packages = new Map();
  for (const input of Object.keys(
    Object.values(result.metafile.outputs)[0].inputs
  )) {
    const at = input.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const parts = input.slice(at + "node_modules/".length).split("/");
    const name = parts[0].startsWith("@")
      ? `${parts[0]}/${parts[1]}`
      : parts[0];
    packages.set(
      name,
      path.join(root, input.slice(0, at), "node_modules", name)
    );
  }

  const sections = [...packages].sort().map(([name, dir]) => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8")
    );
    const licenseFile = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
    const text = licenseFile
      ? fs.readFileSync(path.join(dir, licenseFile), "utf8").trim()
      : "(no license file)";
    return `## ${name} ${pkg.version} (${pkg.license})\n\n${text}\n`;
  });
  fs.writeFileSync(
    path.join(root, "plugin/THIRD-PARTY-NOTICES.md"),
    `# Third-party notices\n\nThe bundled server contains these packages.\n\n${sections.join(
      "\n"
    )}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
