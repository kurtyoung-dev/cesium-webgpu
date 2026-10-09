// comment-flavour-release-pragma.spec.mjs — the comment-only gate on a file whose old text holds a malformed release-pragma anchor.
// @purpose Pins that an edit to a JS or TS file whose old text has a release-pragma anchor that is not a line-opening //>> comment is comment-only exactly when the release-stripped output is unchanged, in both directions (a repaired opener, a repaired closer), with LF and CRLF, and that every edit that was comment-only before still is.
// @status ACTIVE
//
// Run: node --test Tools/c16/comment-flavour-release-pragma.spec.mjs
//
// THE CLASS. The release build removes the text between a
// `//>>includeStart('debug', pragmas.debug)` and the next
// `//>>includeEnd('debug')` with a regex that has no line anchor, so prose
// that quotes either pragma moves the region the build strips. An edit that
// rewords such prose is a comment edit to the tokenizer, and it changes which
// code ships: a repaired opener or closer makes code the build used to strip
// ship, and the reverse. The gate used to compare the two release-stripped
// texts only when the old text had no malformed anchor, so a repair of the
// anchor was never compared. These cases assert the gate's answer through
// `compareSources`, never through how it is built.
//
// Each refusal is checked against a copy of the gate with the comparison made
// unreachable (and, separately, with the old condition put back), which must
// let the pair through again; that is what shows the refusal is live.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareSources } from "./comment-only-diff.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SUBJECTS = [
  "packages/engine/Source/Scene/WasmSubject.js",
  "packages/engine/Source/Renderer/WebGPU/Subject.ts",
];
const EOLS = ["\n", "\r\n"];

const OPEN = "//>>includeStart('debug', pragmas.debug);";
const CLOSE = "//>>includeEnd('debug');";

/**
 * The data URL of a copy of a module with anchors replaced. Relative imports
 * and `import.meta.url` point at the original files, so the copy loads
 * without writing anything to disk.
 *
 * @param {string} relPath Repo-relative module path.
 * @param {Array<[string, string]>} edits `[anchor, replacement]` pairs; each
 *   anchor must occur exactly once.
 * @param {Record<string, string>} [overrides] Relative import specifiers to
 *   load from another URL instead.
 * @returns {Promise<string>} Data URL.
 */
async function mutantUrl(relPath, edits, overrides = {}) {
  let mutated = (await fs.readFile(path.join(ROOT, relPath), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  for (const [anchor, replacement] of edits) {
    assert.equal(
      mutated.split(anchor).length,
      2,
      `mutation anchor must occur exactly once in ${relPath}: ${anchor}`,
    );
    mutated = mutated.replace(anchor, replacement);
  }
  const directory = path.dirname(path.join(ROOT, relPath));
  mutated = mutated
    .replace(
      /from "(\.{1,2}\/[^"]+)"/g,
      (_, specifier) =>
        `from "${overrides[specifier] ?? pathToFileURL(path.resolve(directory, specifier)).href}"`,
    )
    .replaceAll(
      "import.meta.url",
      JSON.stringify(pathToFileURL(path.join(ROOT, relPath)).href),
    );
  return `data:text/javascript;base64,${Buffer.from(mutated, "utf8").toString("base64")}`;
}

/**
 * The gate with some of `flavour-views.mjs` edited.
 *
 * @param {Array<[string, string]>} edits Edits to `flavour-views.mjs`.
 * @returns {Promise<(before: string, after: string, relPath: string) => unknown>}
 *   `compareSources` of the edited copy.
 */
async function gateWithViews(edits) {
  const views = await mutantUrl("Tools/c16/lib/flavour-views.mjs", edits);
  const gate = await import(
    await mutantUrl("Tools/c16/comment-only-diff.mjs", [], {
      "./lib/flavour-views.mjs": views,
    })
  );
  return gate.compareSources;
}

/** The release comparison, as the gate spells it. */
const RELEASE_COMPARISON =
  'if (flavourForPath(relPath) === "release-pragma") {';

/** The edits that make the repair unreachable, one way each. */
const INERT_VIEWS = {
  "the comparison made unreachable": [
    [RELEASE_COMPARISON, RELEASE_COMPARISON.replace("if (", "if (false && ")],
  ],
  "the old condition put back": [
    [
      RELEASE_COMPARISON,
      'if (flavourForPath(relPath) === "release-pragma" && prosePragmaAnchors(before).length === 0) {',
    ],
  ],
};

/**
 * Pairs whose old text holds a malformed anchor and whose edit repairs it
 * while the code between the anchors is the same.
 */
const REPAIRS = [
  {
    id: "a prose opener reworded, its closer live",
    before: `// Mentions ${OPEN}\nexport const value = 1;\n${CLOSE}\n`,
    after: `// Mentions the debug pragma.\nexport const value = 1;\n${CLOSE}\n`,
  },
  {
    id: "a prose closer reworded, its opener live",
    before: `${OPEN}\nexport const value = 1;\n// Mentions ${CLOSE}\n`,
    after: `${OPEN}\nexport const value = 1;\n// Mentions the closing debug pragma.\n`,
  },
  {
    id: "an opener trailing code on its line, reworded",
    before: `export const first = 1; // Mentions ${OPEN}\nexport const value = 1;\n${CLOSE}\n`,
    after: `export const first = 1; // Debug only.\nexport const value = 1;\n${CLOSE}\n`,
  },
  {
    id: "a closer trailing code on its line, reworded",
    before: `${OPEN}\nexport const value = 1;\nexport const last = 2; // Mentions ${CLOSE}\n`,
    after: `${OPEN}\nexport const value = 1;\nexport const last = 2; // End of debug.\n`,
  },
];

/** Pairs the gate has to keep calling comment-only. */
const NEUTRAL = [
  {
    id: "an empty prose pair, both anchors reworded",
    before: `export const value = 1;\n// Mentions ${OPEN}\n// No code here.\n// Mentions ${CLOSE}\n`,
    after:
      "export const value = 1;\n// Mentions the debug pragma.\n// No code here.\n// Mentions the closing debug pragma.\n",
  },
  {
    id: "prose beside a live, well-formed pragma reworded",
    before: `// Debug output follows.\n${OPEN}\nexport const value = 1;\n${CLOSE}\nexport const kept = 2;\n`,
    after: `// The debug output follows.\n${OPEN}\nexport const value = 1;\n${CLOSE}\nexport const kept = 2;\n`,
  },
  {
    id: "a comment added to a file with no pragma",
    before: "export const value = 1;\n",
    after: "// The value.\nexport const value = 1;\n",
  },
];

const withEol = (text, eol) => text.replaceAll("\n", eol);
const label = (subject, eol) =>
  `${subject.split(".").pop()} ${eol === "\n" ? "LF" : "CRLF"}`;

for (const repair of REPAIRS) {
  test(`REFUSED: repairing ${repair.id} changes what the release build ships`, async () => {
    for (const subject of SUBJECTS) {
      for (const eol of EOLS) {
        const before = withEol(repair.before, eol);
        const after = withEol(repair.after, eol);
        const result = compareSources(before, after, subject);
        assert.equal(result.status, "flavour-differs", label(subject, eol));
        assert.equal(result.flavour, "release-pragma", label(subject, eol));
        assert.match(
          result.detail,
          /the release-stripped text differs/,
          label(subject, eol),
        );
      }
    }
  });
}

test("the repairs pass again when the release comparison is unreachable or conditional on the old text", async () => {
  for (const [name, edits] of Object.entries(INERT_VIEWS)) {
    const mutant = await gateWithViews(edits);
    for (const repair of REPAIRS) {
      for (const subject of SUBJECTS) {
        for (const eol of EOLS) {
          assert.deepEqual(
            mutant(
              withEol(repair.before, eol),
              withEol(repair.after, eol),
              subject,
            ),
            { status: "comment-only" },
            `${name}: ${repair.id} (${label(subject, eol)})`,
          );
        }
      }
    }
  }
});

test("PASSES: an edit whose release-stripped output is unchanged stays comment-only", () => {
  for (const pair of NEUTRAL) {
    for (const subject of SUBJECTS) {
      for (const eol of EOLS) {
        assert.deepEqual(
          compareSources(
            withEol(pair.before, eol),
            withEol(pair.after, eol),
            subject,
          ),
          { status: "comment-only" },
          `${pair.id} (${label(subject, eol)})`,
        );
      }
    }
  }
});

test("a code change next to a malformed anchor is still code-differs", () => {
  const before = `// Mentions ${OPEN}\nexport const value = 1;\n${CLOSE}\n`;
  const after = `// Mentions the debug pragma.\nexport const value = 2;\n${CLOSE}\n`;
  for (const subject of SUBJECTS) {
    for (const eol of EOLS) {
      assert.equal(
        compareSources(withEol(before, eol), withEol(after, eol), subject)
          .status,
        "code-differs",
        label(subject, eol),
      );
    }
  }
});

test("a malformed anchor in the new text is still refused, whether or not the old text had one", () => {
  const live = `${OPEN}\nexport const value = 1;\n${CLOSE}\n`;
  const pairs = [
    [
      `// Note.\n${live}`,
      `// Note //>>includeStart('debug', pragmas.debug);\n${live}`,
    ],
    [
      `// Mentions ${OPEN}\nexport const value = 1;\n${CLOSE}\n`,
      `// Mentions ${OPEN}\n// Also //>>includeEnd('debug');\nexport const value = 1;\n${CLOSE}\n`,
    ],
  ];
  for (const [before, after] of pairs) {
    const result = compareSources(before, after, SUBJECTS[0]);
    assert.equal(result.status, "flavour-differs");
    assert.equal(result.flavour, "release-pragma");
  }
});
