#!/usr/bin/env node
// verify-packaged-notices.mjs — does the notice reach the artifact?
//
// Determinations: migration_doc/LICENSE_DETERMINATIONS_2026-08-10.md
// Standard:       Documentation/Contributors/CodingGuide/ForkCommentStandard.md §6.2
//
// THE DEFECT THIS EXISTS FOR. A third-party notice is not satisfied by living
// in a file called `LICENSE.md`. It is satisfied by reaching the person who
// receives the code. This repository publishes three npm packages and a release
// archive, and they do not carry the same files:
//
//   cesium            root LICENSE.md + ThirdParty.json (no `files` field, so
//                     `.npmignore` governs and both are included)
//   @cesium/engine    packages/engine/LICENSE.md + Source/**  — and NOT the
//                     root LICENSE.md, and NOT ThirdParty.json
//   @cesium/widgets   packages/widgets/LICENSE.md + Source/**
//   release archive   all three LICENSE.md files, named explicitly in
//                     gulpfile.makezip.js
//
// So a notice covering code under `packages/engine/Source` that exists only in
// the root file is not published at all. That is not hypothetical: the
// Linearly Transformed Cosines entry — whose licence requires that
// redistributions of source retain its copyright notice — sat in the root file
// for months while the fitted tables it covers shipped inside `@cesium/engine`
// with no notice anywhere in the tarball. Reading either file alone shows
// nothing wrong. Only the pair, read against a list of what is owed, does.
//
// WHAT IT CHECKS, AND WHY EACH CHECK IS THE ONE THAT CATCHES SOMETHING.
//
//   1. Every determination that owes a notice has its heading in every file it
//      owes it in. This is the direct form of the defect above.
//   2. Headings the manifest requires in both files carry the SAME BODY in
//      both. A heading present in the mirror with an empty or truncated body is
//      the failure that check 1 alone reads as a pass. Bodies are compared
//      after applying the one documented difference between the files: the root
//      writes `packages/engine/Source/…` where the tarball-relative mirror
//      writes `Source/…`.
//   3. Rows the manifest names in `ThirdParty.json` exist there. That file is
//      generated from `ThirdParty.extra.json` by `gulp buildThirdParty`, so a
//      dependency nobody added to the source list is silently absent from the
//      manifest the root package ships.
//   4. The packaging wiring itself still routes the files: engine and widgets
//      list `LICENSE.md` in `files`, `.npmignore` excludes neither the root
//      `LICENSE.md` nor `ThirdParty.json`, and the archive names all three.
//      Every check above is void if a packaging change quietly drops the file
//      they all reason about.
//   5. Vendored licence files under `Source/ThirdParty/**` survive the build's
//      asset copy. `copyEngineAssets` skips `.md`, which is why a vendored
//      `README.md` cannot be the home of a notice — and why `LICENSE-MIT`,
//      extension-less, can.
//
// EXIT CODES
//   0  every required notice is present and reachable
//   1  at least one is missing
//   2  the tool itself failed (unreadable file, unparseable manifest)
//   3  STRUCTURAL: the manifest yielded no requirements. An empty check is not
//      a pass — it is the tool reporting it could not see its subject.
//
// USAGE
//   node Tools/c16/verify-packaged-notices.mjs
//   node Tools/c16/verify-packaged-notices.mjs --json
//   node Tools/c16/verify-packaged-notices.mjs --determinations <path>

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Default determinations document, relative to the repository root. */
export const DEFAULT_DETERMINATIONS =
  "migration_doc/LICENSE_DETERMINATIONS_2026-08-10.md";

/**
 * Licence files the manifest's `files` keys name, relative to the repository
 * root. `root` is the file GitHub and the `cesium` package show; `engine` is
 * the only licence file inside the `@cesium/engine` tarball.
 */
export const NOTICE_FILES = Object.freeze({
  root: "LICENSE.md",
  engine: "packages/engine/LICENSE.md",
  widgets: "packages/widgets/LICENSE.md",
});

/**
 * Extract the machine-readable manifest from the determinations document.
 *
 * The document is prose for a human reviewer; the manifest is one fenced JSON
 * block inside it. Parsing the prose was rejected — a table that renders
 * correctly and a table a script reads correctly are different problems, and
 * the second one silently stops being true.
 *
 * @param {string} markdown Full text of the determinations document.
 * @returns {{notices: Array<object>}} Parsed manifest.
 */
export function parseManifest(markdown) {
  const blocks = [...markdown.matchAll(/```json\r?\n([\s\S]*?)```/g)];
  if (blocks.length === 0) {
    throw new Error("no fenced json manifest block found");
  }
  if (blocks.length > 1) {
    throw new Error(
      `expected exactly one fenced json block, found ${blocks.length}`,
    );
  }
  const manifest = JSON.parse(blocks[0][1]);
  if (!Array.isArray(manifest.notices)) {
    throw new Error("manifest has no `notices` array");
  }
  for (const notice of manifest.notices) {
    if (typeof notice.id !== "string") {
      throw new Error("a manifest entry has no string `id`");
    }
    if (!Array.isArray(notice.files)) {
      throw new Error(`${notice.id}: \`files\` must be an array`);
    }
    for (const key of notice.files) {
      if (!Object.hasOwn(NOTICE_FILES, key)) {
        throw new Error(`${notice.id}: unknown file key ${key}`);
      }
    }
    if (notice.heading === undefined) {
      throw new Error(`${notice.id}: \`heading\` must be present (or null)`);
    }
    if (notice.heading === null && notice.files.length > 0) {
      throw new Error(
        `${notice.id}: names files but has no heading to look for in them`,
      );
    }
  }
  return manifest;
}

/**
 * Split a `LICENSE.md` into its `###` sections.
 *
 * Headings repeat across the file's top-level sections — `# Third-Party Code`
 * and `# Bundled Engine Assets` could in principle both carry one — so the
 * result maps a heading to every body found under it.
 *
 * @param {string} markdown Licence file text.
 * @returns {Map<string, string[]>} Heading text to its section bodies.
 */
export function splitSections(markdown) {
  const sections = new Map();
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let heading = null;
  let body = [];

  const flush = () => {
    if (heading === null) {
      return;
    }
    const existing = sections.get(heading);
    const text = body.join("\n").trim();
    if (existing === undefined) {
      sections.set(heading, [text]);
    } else {
      existing.push(text);
    }
  };

  for (const line of lines) {
    if (line.startsWith("### ")) {
      flush();
      heading = line.slice(4).trim();
      body = [];
      continue;
    }
    if (line.startsWith("# ") || line.startsWith("## ")) {
      // A new top-level section closes the current entry: text after it
      // belongs to that section's preamble, not to the previous entry.
      flush();
      heading = null;
      body = [];
      continue;
    }
    if (heading !== null) {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Normalise a section body for cross-file comparison.
 *
 * Two documented differences are folded first. The root file writes monorepo
 * paths where the mirror writes tarball-relative ones. And the root links into
 * `migration_doc/`, where the mirror names the same file in prose — "in the
 * fork repository at …" — because that directory is not part of the published
 * package, so a relative link from inside the tarball resolves to nothing.
 * Markdown links are reduced to their link text and that connective phrase is
 * dropped, leaving both sides naming the same path.
 *
 * The comparison is then over TEXT CONTENT, not markdown syntax. The two files
 * have been through different formatter histories — `**` versus `_` emphasis,
 * `*` versus `-` bullets, a horizontal rule reflowed from forty hyphens to
 * three — and every one of those differences is invisible in the rendered
 * notice. Failing on them would train a reviewer to ignore this check, which
 * costs more than the sensitivity gained: a licence notice that differs only in
 * emphasis characters is not a licence notice that differs. Letters, digits and
 * punctuation are all preserved, so any change to what the notice actually says
 * is still caught.
 *
 * @param {string} body Section body.
 * @returns {string} Comparable form.
 */
export function normalizeBody(body) {
  return body
    .replace(/packages\/engine\/Source\//g, "Source/")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/the fork repository(?:'s| at) /g, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/[*`_|]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Run every check against already-loaded inputs.
 *
 * Inputs are injected rather than read here so the spec can drive the whole
 * decision surface — including the mutants — without a repository on disk.
 *
 * @param {object} inputs Everything the checks read.
 * @param {{notices: Array<object>}} inputs.manifest Parsed manifest.
 * @param {Record<string, string>} inputs.noticeFiles Licence text by file key.
 * @param {Array<{name: string}>} inputs.thirdPartyJson Generated manifest rows.
 * @param {Record<string, object>} inputs.packageJson Package manifests by key.
 * @param {string} inputs.npmignore Root `.npmignore` text.
 * @param {string} inputs.makezip `gulpfile.makezip.js` text.
 * @param {string} inputs.buildScript `scripts/build.js` text.
 * @param {string[]} inputs.vendoredLicenseFiles Repo-relative vendored notices.
 * @returns {{checks: number, violations: Array<{id: string, detail: string}>}} Report.
 */
export function runChecks({
  manifest,
  noticeFiles,
  thirdPartyJson,
  packageJson,
  npmignore,
  makezip,
  buildScript,
  vendoredLicenseFiles,
}) {
  const violations = [];
  let checks = 0;

  const sectionsByFile = new Map();
  for (const [key, text] of Object.entries(noticeFiles)) {
    sectionsByFile.set(key, splitSections(text));
  }

  // 1 + 2 — headings present where owed, with the same body in each.
  for (const notice of manifest.notices) {
    if (notice.heading === null) {
      continue;
    }
    /** @type {Array<[string, string]>} */
    const found = [];
    for (const key of notice.files) {
      checks += 1;
      const sections = sectionsByFile.get(key);
      if (sections === undefined) {
        violations.push({
          id: notice.id,
          detail: `no text supplied for ${key} (${NOTICE_FILES[key]})`,
        });
        continue;
      }
      const bodies = sections.get(notice.heading);
      if (bodies === undefined) {
        violations.push({
          id: notice.id,
          detail: `${NOTICE_FILES[key]} has no "### ${notice.heading}" section — the notice does not ship in that artifact`,
        });
        continue;
      }
      found.push([key, bodies.join("\n\n")]);
    }

    if (found.length > 1) {
      checks += 1;
      const [firstKey, firstBody] = found[0];
      for (const [key, body] of found.slice(1)) {
        if (normalizeBody(body) !== normalizeBody(firstBody)) {
          violations.push({
            id: notice.id,
            detail: `"${notice.heading}" differs between ${NOTICE_FILES[firstKey]} and ${NOTICE_FILES[key]} beyond the documented path-prefix difference`,
          });
        }
      }
    }

    // A section that exists but carries no terms is the shape a truncated
    // mirror takes, and check 2 cannot see it when only one file is named.
    for (const [key, body] of found) {
      checks += 1;
      if (normalizeBody(body).length < 40) {
        violations.push({
          id: notice.id,
          detail: `"${notice.heading}" in ${NOTICE_FILES[key]} has no substantive body`,
        });
      }
    }
  }

  // 3 — rows the manifest names in the generated dependency manifest.
  const thirdPartyNames = new Set(thirdPartyJson.map((row) => row.name));
  for (const notice of manifest.notices) {
    if (typeof notice.thirdPartyJson !== "string") {
      continue;
    }
    checks += 1;
    if (!thirdPartyNames.has(notice.thirdPartyJson)) {
      violations.push({
        id: notice.id,
        detail: `ThirdParty.json has no row named "${notice.thirdPartyJson}" — add it to ThirdParty.extra.json and re-run \`npm run build-third-party\``,
      });
    }
  }

  // 4 — the packaging wiring the checks above all depend on.
  for (const key of ["engine", "widgets"]) {
    checks += 1;
    const files = packageJson[key]?.files;
    if (!Array.isArray(files) || !files.includes("LICENSE.md")) {
      violations.push({
        id: "packaging",
        detail: `packages/${key}/package.json no longer ships LICENSE.md in its \`files\` list`,
      });
    }
  }

  checks += 1;
  if (Array.isArray(packageJson.root?.files)) {
    violations.push({
      id: "packaging",
      detail:
        "the root package.json gained a `files` list; LICENSE.md and ThirdParty.json are included today only because it has none",
    });
  }

  for (const entry of ["LICENSE.md", "ThirdParty.json"]) {
    checks += 1;
    const excluded = npmignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line === entry || line === `/${entry}`);
    if (excluded) {
      violations.push({
        id: "packaging",
        detail: `.npmignore excludes ${entry} from the root package`,
      });
    }
  }

  for (const licensePath of Object.values(NOTICE_FILES)) {
    checks += 1;
    if (!makezip.includes(`"${licensePath}"`)) {
      violations.push({
        id: "packaging",
        detail: `gulpfile.makezip.js no longer names ${licensePath}, so the release archive does not carry it`,
      });
    }
  }

  // 5 — vendored notices survive the engine asset copy.
  const copyStep = buildScript.slice(
    buildScript.indexOf("export async function copyEngineAssets"),
  );
  const excludedExtensions = [
    ...copyStep
      .slice(0, copyStep.indexOf("];"))
      .matchAll(/!packages\/engine\/Source\/\*\*\/\*(\.[a-z]+)/g),
  ].map((match) => match[1]);
  for (const vendored of vendoredLicenseFiles) {
    checks += 1;
    const extension = path.extname(vendored);
    if (extension !== "" && excludedExtensions.includes(extension)) {
      violations.push({
        id: "packaging",
        detail: `${vendored} has extension ${extension}, which copyEngineAssets excludes — the vendored notice never reaches Build/**`,
      });
    }
  }

  return { checks, violations };
}

/**
 * Read every input from the repository and run the checks.
 *
 * @param {object} [options] Overrides.
 * @param {string} [options.determinations] Determinations document path.
 * @returns {Promise<{checks: number, violations: Array<object>}>} Report.
 */
export async function verifyRepository(options = {}) {
  const read = (relPath) => fs.readFile(path.join(ROOT, relPath), "utf8");
  const readJson = async (relPath) => JSON.parse(await read(relPath));

  const determinationsPath = options.determinations ?? DEFAULT_DETERMINATIONS;
  const manifest = parseManifest(await read(determinationsPath));

  /** @type {Record<string, string>} */
  const noticeFiles = {};
  for (const [key, relPath] of Object.entries(NOTICE_FILES)) {
    noticeFiles[key] = await read(relPath);
  }

  const vendored = [];
  const thirdPartyRoot = path.join(ROOT, "packages/engine/Source/ThirdParty");
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/^LICENSE/i.test(entry.name)) {
        vendored.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  await walk(thirdPartyRoot);

  return runChecks({
    manifest,
    noticeFiles,
    thirdPartyJson: await readJson("ThirdParty.json"),
    packageJson: {
      root: await readJson("package.json"),
      engine: await readJson("packages/engine/package.json"),
      widgets: await readJson("packages/widgets/package.json"),
    },
    npmignore: await read(".npmignore"),
    makezip: await read("gulpfile.makezip.js"),
    buildScript: await read("scripts/build.js"),
    vendoredLicenseFiles: vendored,
  });
}

/**
 * Entry point.
 *
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const flagIndex = argv.indexOf("--determinations");
  const determinations = flagIndex === -1 ? undefined : argv[flagIndex + 1];

  const report = await verifyRepository({ determinations });

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log("verify-packaged-notices");
    console.log(`  checks       ${report.checks}`);
    console.log(`  violations   ${report.violations.length}`);
    for (const violation of report.violations) {
      console.log(`  VIOLATION  [${violation.id}] ${violation.detail}`);
    }
  }

  if (report.checks === 0) {
    console.error(
      "verify-packaged-notices: STRUCTURAL — the manifest produced no requirements. An empty check is not a pass.",
    );
    return 3;
  }
  return report.violations.length > 0 ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`verify-packaged-notices: ${error.stack ?? error}`);
      process.exitCode = 2;
    });
}
