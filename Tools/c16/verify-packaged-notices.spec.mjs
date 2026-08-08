// verify-packaged-notices.spec.mjs — mutants for the packaging-legality check.
//
// Run: node --test Tools/c16/verify-packaged-notices.spec.mjs
//
// WHY MUTANTS. This check's value is entirely in what it REJECTS. A spec that
// only ran it against the repository as it stands would pass just as happily
// against a version of the tool that returned "no violations" unconditionally —
// and that version would have shipped the Linearly Transformed Cosines defect
// exactly as the real one did. Every case below therefore removes one thing
// from a known-good fixture and requires the removal to be reported, paired
// where it matters with the legitimate variation that must still be accepted.
//
// The check takes its inputs as arguments, so nothing here needs a repository
// on disk except the two tests that pin the real files end to end.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DETERMINATIONS,
  NOTICE_FILES,
  normalizeBody,
  parseManifest,
  runChecks,
  splitSections,
  verifyRepository,
} from "./verify-packaged-notices.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SAMPLE_BODY = [
  "https://example.invalid/project",
  "",
  "Taken by `packages/engine/Source/Shaders/WebGPU/Thing.wgsl`.",
  "",
  "> MIT License",
  ">",
  "> Copyright (c) 2020 Someone",
  ">",
  "> Permission is hereby granted, free of charge, to any person obtaining a",
  "> copy of this software.",
].join("\n");

/** A licence file carrying one third-party entry plus unrelated neighbours. */
function licenseFile(body, { heading = "Widget" } = {}) {
  return [
    "# Third-Party Code",
    "",
    "CesiumJS includes the following third-party code.",
    "",
    "### Unrelated",
    "",
    "Something else entirely, with enough text to be substantive.",
    "",
    `### ${heading}`,
    "",
    body,
    "",
    "# Tests",
    "",
    "### Jasmine",
    "",
    "Not a third-party code entry.",
    "",
  ].join("\n");
}

const MANIFEST_MARKDOWN = [
  "# Determinations",
  "",
  "Prose a human reads.",
  "",
  "```json",
  JSON.stringify(
    {
      notices: [
        {
          id: "T-01",
          heading: "Widget",
          files: ["root", "engine"],
          thirdPartyJson: "widget",
          status: "RESOLVED",
        },
      ],
    },
    null,
    2,
  ),
  "```",
  "",
  "More prose.",
  "",
].join("\n");

/** Inputs that must produce zero violations. */
function goodInputs() {
  return {
    manifest: parseManifest(MANIFEST_MARKDOWN),
    noticeFiles: {
      root: licenseFile(SAMPLE_BODY),
      engine: licenseFile(
        SAMPLE_BODY.replace("packages/engine/Source/", "Source/"),
      ),
      widgets: licenseFile(
        "Unrelated widgets text, long enough to be substantive.",
      ),
    },
    thirdPartyJson: [{ name: "widget" }, { name: "other" }],
    packageJson: {
      root: { name: "cesium" },
      engine: { name: "@cesium/engine", files: ["Source", "LICENSE.md"] },
      widgets: { name: "@cesium/widgets", files: ["Source", "LICENSE.md"] },
    },
    npmignore: ["/Apps", "/Tools", "/Specs"].join("\n"),
    makezip: Object.values(NOTICE_FILES)
      .map((p) => `            "${p}",`)
      .join("\n"),
    buildScript: [
      "export async function copyEngineAssets(destination) {",
      "  const engineStaticAssets = [",
      '    "packages/engine/Source/**",',
      '    "!packages/engine/Source/**/*.js",',
      '    "!packages/engine/Source/**/*.md",',
      "  ];",
      "}",
    ].join("\n"),
    vendoredLicenseFiles: [
      "packages/engine/Source/ThirdParty/naga-wasm/LICENSE-MIT",
    ],
  };
}

/**
 * Assert a mutated input set is rejected, and that the message names the cause.
 *
 * @param {(inputs: object) => void} mutate Applied to a fresh good input set.
 * @param {RegExp} expected Pattern the violation detail must match.
 * @param {string} why Failure message.
 */
function assertRejected(mutate, expected, why) {
  const inputs = goodInputs();
  mutate(inputs);
  const report = runChecks(inputs);
  assert.ok(report.violations.length > 0, `${why} — nothing was reported`);
  assert.ok(
    report.violations.some((v) => expected.test(v.detail)),
    `${why} — reported instead: ${report.violations.map((v) => v.detail).join(" | ")}`,
  );
}

test("the unmutated fixture passes, and checks something", () => {
  const report = runChecks(goodInputs());
  assert.deepEqual(report.violations, []);
  assert.ok(
    report.checks > 5,
    "a fixture that exercises almost nothing would make every mutant below vacuous",
  );
});

test("a notice missing from the engine mirror is rejected", () => {
  // The Linearly Transformed Cosines defect, reduced: present in the root file,
  // absent from the only licence file inside the published engine tarball.
  assertRejected(
    (inputs) => {
      inputs.noticeFiles.engine = licenseFile("", {
        heading: "Something Else",
      });
    },
    /packages\/engine\/LICENSE\.md has no "### Widget"/,
    "a notice absent from the engine package must fail",
  );
});

test("a notice missing from the root file is rejected", () => {
  assertRejected(
    (inputs) => {
      inputs.noticeFiles.root = licenseFile("", { heading: "Something Else" });
    },
    /^LICENSE\.md has no "### Widget"/,
    "a notice absent from the root file must fail",
  );
});

test("a heading present in the mirror with a gutted body is rejected", () => {
  // The failure a presence-only check reads as a pass.
  assertRejected(
    (inputs) => {
      inputs.noticeFiles.engine = licenseFile("See the root file.");
    },
    /differs between|has no substantive body/,
    "a truncated mirrored notice must fail",
  );
});

test("a body that drifts in wording is rejected", () => {
  assertRejected(
    (inputs) => {
      inputs.noticeFiles.engine = licenseFile(
        SAMPLE_BODY.replace("packages/engine/Source/", "Source/").replace(
          "Copyright (c) 2020 Someone",
          "Copyright (c) 2021 Someone",
        ),
      );
    },
    /differs between/,
    "a changed copyright year between the two files must fail",
  );
});

test("the documented path-prefix difference is accepted", () => {
  // The mirror is tarball-relative by design. If this failed, the check would
  // be unusable and would be switched off.
  const inputs = goodInputs();
  assert.deepEqual(runChecks(inputs).violations, []);
  assert.notEqual(
    inputs.noticeFiles.root,
    inputs.noticeFiles.engine,
    "the fixture must actually differ, or this test proves nothing",
  );
});

test("markdown formatting differences are accepted, textual ones are not", () => {
  const withUnderscores = SAMPLE_BODY.replace(
    "packages/engine/Source/",
    "Source/",
  ).replace("MIT License", "_MIT License_");
  const inputs = goodInputs();
  inputs.noticeFiles.engine = licenseFile(withUnderscores);
  assert.deepEqual(
    runChecks(inputs).violations,
    [],
    "emphasis characters are not notice text",
  );

  assertRejected(
    (mutated) => {
      mutated.noticeFiles.engine = licenseFile(
        SAMPLE_BODY.replace("packages/engine/Source/", "Source/").replace(
          "MIT License",
          "BSD License",
        ),
      );
    },
    /differs between/,
    "a changed licence name must fail even though it is one word",
  );
});

test("a ThirdParty.json row the manifest names must exist", () => {
  assertRejected(
    (inputs) => {
      inputs.thirdPartyJson = [{ name: "other" }];
    },
    /ThirdParty\.json has no row named "widget"/,
    "a dependency absent from the generated manifest must fail",
  );
});

test("packaging wiring regressions are rejected", () => {
  assertRejected(
    (inputs) => {
      inputs.packageJson.engine.files = ["Source"];
    },
    /packages\/engine\/package\.json no longer ships LICENSE\.md/,
    "dropping LICENSE.md from the engine files list must fail",
  );

  assertRejected(
    (inputs) => {
      inputs.packageJson.root.files = ["Build"];
    },
    /root package\.json gained a `files` list/,
    "a root files list silently changes what the package carries",
  );

  assertRejected(
    (inputs) => {
      inputs.npmignore = `${inputs.npmignore}\n/ThirdParty.json`;
    },
    /\.npmignore excludes ThirdParty\.json/,
    "excluding the generated manifest from the root package must fail",
  );

  assertRejected(
    (inputs) => {
      inputs.makezip = inputs.makezip.replace(`"${NOTICE_FILES.engine}",`, "");
    },
    /makezip\.js no longer names packages\/engine\/LICENSE\.md/,
    "dropping a licence file from the release archive must fail",
  );
});

test("a vendored notice the build would drop is rejected", () => {
  assertRejected(
    (inputs) => {
      inputs.vendoredLicenseFiles = [
        "packages/engine/Source/ThirdParty/naga-wasm/LICENSE.md",
      ];
    },
    /copyEngineAssets excludes/,
    "a vendored notice with an excluded extension never reaches Build/**",
  );
});

test("the manifest parser rejects malformed input rather than yielding nothing", () => {
  // An empty requirement set is the failure mode that makes every other check
  // vacuous, so each way of reaching one has to throw.
  assert.throws(() => parseManifest("no fences here"), /no fenced json/);
  assert.throws(() => parseManifest("```json\n{}\n```"), /no `notices` array/);
  assert.throws(
    () =>
      parseManifest(
        '```json\n{"notices":[{"id":"x","files":["nope"],"heading":null}]}\n```',
      ),
    /unknown file key/,
  );
  assert.throws(
    () =>
      parseManifest(
        '```json\n{"notices":[{"id":"x","files":["root"],"heading":null}]}\n```',
      ),
    /no heading to look for/,
  );
  assert.throws(
    () => parseManifest("```json\n{}\n```\n```json\n{}\n```"),
    /exactly one fenced json block/,
  );
});

test("section splitting stops at the next top-level heading", () => {
  const sections = splitSections(licenseFile(SAMPLE_BODY));
  assert.ok(sections.has("Widget"));
  assert.ok(
    !sections.get("Widget")[0].includes("Jasmine"),
    "a section must not absorb entries under a later top-level heading",
  );
  assert.ok(
    sections.get("Widget")[0].includes("MIT License"),
    "the body must actually be captured",
  );
});

test("normalizeBody keeps words while dropping markdown", () => {
  assert.equal(
    normalizeBody("> **Copyright** (c) 2020 _Someone_"),
    "Copyright (c) 2020 Someone",
  );
  assert.notEqual(
    normalizeBody("Copyright (c) 2020 Someone"),
    normalizeBody("Copyright (c) 2021 Someone"),
  );
});

test("the repository itself satisfies every determination", async () => {
  const report = await verifyRepository();
  assert.deepEqual(
    report.violations,
    [],
    "the working tree must satisfy its own determinations document",
  );
  assert.ok(report.checks > 0, "a run that checks nothing is not a pass");
});

test("the determinations document parses and names real files", async () => {
  const markdown = await fs.readFile(
    path.join(ROOT, DEFAULT_DETERMINATIONS),
    "utf8",
  );
  const manifest = parseManifest(markdown);
  assert.ok(manifest.notices.length >= 10, "the manifest looks truncated");

  // Every id the manifest enforces must have a determination written for it.
  // A heading may cover several ids at once ("L-02, L-04, L-08 — vendored
  // naga"), so the set is built from the heading lines rather than matched
  // one id at a time.
  const written = new Set(
    markdown
      .split(/\r?\n/)
      .filter((line) => line.startsWith("### L-"))
      .flatMap((line) => [...line.matchAll(/L-\d+/g)].map((m) => m[0])),
  );
  assert.ok(written.size >= 10, "no determination headings were found");

  for (const notice of manifest.notices) {
    assert.match(
      notice.status,
      /^(RESOLVED|COVERED|PARTIAL|NEEDS-MAINTAINER)$/,
      `${notice.id} has an unrecognised status`,
    );
    assert.ok(
      written.has(notice.id.replace(/[a-z]$/, "")),
      `${notice.id} has no determination written for it`,
    );
  }
});

test("both shader-to-JS transforms extract @license banners identically", async () => {
  // glslToJavaScript has always re-emitted @license docblocks above the
  // minified module; wgslToJavaScript silently stripped them until the two
  // were mirrored. This pin holds the mirror: the extraction regex must
  // appear in BOTH transforms, and identically, so a notice-bearing shader
  // in either language survives minification with its attribution intact.
  const buildJs = await fs.readFile(
    path.join(ROOT, "scripts", "build.js"),
    "utf8",
  );
  const pattern = String.raw`/\/\*\*(?:[^*\/]|\*(?!\/)|
)*?@license(?:.|
)*?\*\//gm`;
  const occurrences = buildJs.split("@license").length - 1;
  assert.ok(
    occurrences >= 2,
    "the @license extraction must exist in both glslToJavaScript and wgslToJavaScript",
  );
  const glslAt = buildJs.indexOf("function glslToJavaScript");
  const wgslAt = buildJs.indexOf("function wgslToJavaScript");
  assert.ok(glslAt > 0 && wgslAt > glslAt);
  const glslBody = buildJs.slice(glslAt, wgslAt);
  const wgslBody = buildJs.slice(wgslAt);
  for (const body of [glslBody, wgslBody]) {
    assert.match(
      body,
      /extractedCopyrightComments/,
      "a transform lost its copyright extraction",
    );
    assert.match(body, /@license/);
  }
  void pattern;
});
