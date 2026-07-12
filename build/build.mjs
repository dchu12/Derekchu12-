/* Build the three deployments from a single source.
 *
 *   node build/build.mjs                 # regenerate <dir>/app.js + sw.js, stamp index.html
 *   node build/build.mjs --check         # verify committed output matches (CI/drift guard); exit 1 on drift
 *   node build/build.mjs --gen-patches       # re-capture Derek/Beta deltas after a shared edit collides
 *   node build/build.mjs --gen-patch derek   # re-capture just one deployment's delta
 *
 * Generated per deployment: app.js (config + starter categories + version, plus
 * Derek's dual-workspace patch), sw.js (cache name), and index.html cache-buster
 * version. Styles/manifest/theming stay per-deployment (rarely change).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION, deployments } from "./deployments.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..");
const mode = process.argv[2] || "";

const readSrc = (f) => fs.readFileSync(path.join(repo, "src", f), "utf8");
const rel = (dir, f) => path.join(repo, dir === "." ? "" : dir, f);

/* Serialize a starter-category list to the exact in-file format. */
function serializeStarter(list) {
  return list
    .map((c) => `    { emoji: ${JSON.stringify(c.emoji)}, name: ${JSON.stringify(c.name)}, budgeted: ""${c.fixed ? ", fixed: true" : ""} },`)
    .join("\n");
}
const fmtEmails = (list) => (list.length ? "[" + list.map((e) => `"${e}"`).join(", ") + "]" : "[]");

/* Produce a deployment's app.js from src, config-substituted but with the
 * {{VERSION}} token still in place. Version is stamped LAST (after any patch) so
 * that bumping the version never invalidates a deployment's patch context. */
function appBase(src, d) {
  return src
    .replace(/const STORAGE_KEY = "[^"]*"/, `const STORAGE_KEY = "${d.storageKey}"`)
    .replace(/const REPORT_EMAILS = \[[^\]]*\]/, `const REPORT_EMAILS = ${fmtEmails(d.reportEmails)}`)
    .replace(/const BUDGET_KEY = "[^"]*"/, `const BUDGET_KEY = "${d.budgetKey}"`)
    .replace(/const PERSON_NAME = "[^"]*"/, `const PERSON_NAME = "${d.personName}"`)
    .replace(/const PARTNER_NAME = "[^"]*"/, `const PARTNER_NAME = "${d.partnerName}"`)
    .replace(/const STARTER_CATEGORIES = \[[\s\S]*?\n {2}\];/, `const STARTER_CATEGORIES = [\n${serializeStarter(d.starter)}\n  ];`);
}
// Rewrite a committed app.js back to the {{VERSION}} token so patches stay
// version-independent when diffing/generating them.
const normalizeVersion = (s) => s.replace(/const APP_VERSION = "[^"]*"/, 'const APP_VERSION = "{{VERSION}}"');

/* Apply a unified-diff patch file to `input`, returning the patched text. */
function applyPatch(input, patchPath) {
  const tmpBase = path.join(os.tmpdir(), `yosan-base-${process.pid}.js`);
  const tmpOut = path.join(os.tmpdir(), `yosan-out-${process.pid}.js`);
  fs.writeFileSync(tmpBase, input);
  const r = spawnSync("patch", ["-s", "-o", tmpOut, tmpBase, path.join(repo, patchPath)], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`patch failed for ${patchPath} (status ${r.status}). ${r.stderr || ""}\n` +
      `A shared edit may collide with a deployment's bespoke code — run: node build/build.mjs --gen-patches`);
  }
  const out = fs.readFileSync(tmpOut, "utf8");
  fs.rmSync(tmpBase, { force: true });
  fs.rmSync(tmpOut, { force: true });
  return out;
}

/* Compute every generated file for a deployment: { relPath: contents }. */
function outputsFor(src, sw, d) {
  const files = {};
  let app = appBase(src, d);
  if (d.patch) app = applyPatch(app, d.patch);
  app = app.replaceAll("{{VERSION}}", VERSION); // stamp version last
  files[rel(d.dir, "app.js")] = app;
  files[rel(d.dir, "sw.js")] = sw.replaceAll("{{CACHE}}", `${d.cachePrefix}-v${VERSION}`);
  // index.html: stamp the ?v= cache-buster (keep everything else per-deployment).
  const idxPath = rel(d.dir, "index.html");
  if (fs.existsSync(idxPath)) {
    files[idxPath] = fs.readFileSync(idxPath, "utf8").replace(/\?v=\d+/g, `?v=${VERSION}`);
  }
  return files;
}

/* Capture a deployment's delta from its generated base as a unified patch.
 * Run after a shared edit collides with a deployment's bespoke code (Derek's
 * dual-workspace layer, Beta's local-only copy), or to (re)create the patch. */
function genPatch(id) {
  const src = readSrc("app.js");
  const d = deployments.find((x) => x.id === id);
  if (!d || !d.patch) throw new Error(`No patch configured for deployment "${id}".`);
  const base = appBase(src, d); // keeps the {{VERSION}} token
  const curNorm = normalizeVersion(fs.readFileSync(rel(d.dir, "app.js"), "utf8"));
  const tmpBase = path.join(os.tmpdir(), `yosan-${id}base-${process.pid}.js`);
  const tmpCur = path.join(os.tmpdir(), `yosan-${id}cur-${process.pid}.js`);
  fs.writeFileSync(tmpBase, base);
  fs.writeFileSync(tmpCur, curNorm);
  const r = spawnSync("diff", ["-u", tmpBase, tmpCur], { encoding: "utf8" });
  fs.rmSync(tmpBase, { force: true });
  fs.rmSync(tmpCur, { force: true });
  if (r.status === 2) throw new Error(`diff error: ${r.stderr}`);
  // Normalize the header paths so the patch is location-independent.
  const patch = r.stdout
    .replace(/^--- .*$/m, "--- a/app.js")
    .replace(/^\+\+\+ .*$/m, "+++ b/app.js");
  fs.writeFileSync(path.join(repo, d.patch), patch);
  console.log(`Wrote ${d.patch} (${patch.split("\n").length} lines).`);
}
function genAllPatches() {
  deployments.filter((d) => d.patch).forEach((d) => genPatch(d.id));
}

function build({ check }) {
  const src = readSrc("app.js");
  const sw = readSrc("sw.js");
  let drift = 0, wrote = 0;
  for (const d of deployments) {
    const files = outputsFor(src, sw, d);
    for (const [p, contents] of Object.entries(files)) {
      const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
      if (cur === contents) continue;
      if (check) {
        drift++;
        console.error(`DRIFT: ${path.relative(repo, p)} differs from generated output.`);
      } else {
        fs.writeFileSync(p, contents);
        wrote++;
        console.log(`wrote ${path.relative(repo, p)}`);
      }
    }
  }
  if (check) {
    if (drift) { console.error(`\n${drift} file(s) out of sync. Run \`npm run build\` and commit.`); process.exit(1); }
    console.log("✓ All deployments in sync with src/.");
  } else {
    console.log(wrote ? `\nBuilt ${wrote} file(s) for ${deployments.length} deployments.` : "Nothing to update — already in sync.");
  }
}

if (mode === "--gen-patches") genAllPatches();
else if (mode === "--gen-patch") genPatch(process.argv[3]);
else build({ check: mode === "--check" });
