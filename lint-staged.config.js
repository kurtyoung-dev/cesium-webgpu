// Files under vendored / third-party paths shouldn't be linted or
// re-formatted — they're mirrors of upstream source we don't own.
// `packages/engine/Source/ThirdParty/` and
// `Tools/shader-pipeline/naga-wasm-tools/` include README / LICENSE / bundled
// .d.ts / .js that would otherwise trip markdownlint / eslint on their
// upstream formatting conventions. Same for `packages/wasm-naga/pkg*/`
// (reproducible wasm-pack output — gitignored but belt-and-suspenders here).
//
// The functional-config form lets us filter out vendored paths before the
// lint/format tools run. If every staged file is vendored we return an
// empty array so lint-staged skips the task entirely.
function isVendored(filePath) {
  const rel = filePath.split(/[\\/]/).join("/");
  return (
    rel.includes("/ThirdParty/") ||
    rel.includes("Tools/shader-pipeline/naga-wasm-tools/") ||
    rel.includes("packages/wasm-naga/pkg/") ||
    rel.includes("packages/wasm-naga/pkg-tooling/")
  );
}

// Cap on how many paths ride on one tool invocation.
//
// Two reasons, both learned the hard way on wide mechanical batches:
//   1. Windows caps a process command line at ~32 KB. A repository-wide
//      formatting or lint-coverage batch stages 700+ files whose quoted paths
//      total far more than that, and the spawn fails with an opaque error.
//   2. A single eslint process holding 700+ ASTs is what OOM-kills the
//      pre-commit hook. Chunking bounds peak memory without needing the
//      `--concurrent 1` workaround on every large commit.
//
// Tool-major ordering is preserved (all eslint chunks, then all prettier
// chunks), so the sequencing the hook relied on is unchanged.
const MAX_FILES_PER_INVOCATION = 150;

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function buildCommands(files, tools) {
  const allowed = files.filter((f) => !isVendored(f));
  if (allowed.length === 0) {
    return [];
  }
  const batches = chunk(allowed, MAX_FILES_PER_INVOCATION).map((batch) =>
    batch.map((f) => `"${f}"`).join(" "),
  );
  return tools.flatMap((t) => batches.map((quoted) => `${t} ${quoted}`));
}

// The glob must stay in step with `npm run eslint` ("./**/*.*js") and
// `npm run prettier-check` ("**/*" filtered by .prettierignore): every
// extension those two cover in CI has to be covered here, or the hook lets
// through what CI then rejects. `tooling-coverage.spec.mjs` pins that.
// markdownlint exemptions must mirror the root `.markdownlintignore`, because
// lint-staged passes ABSOLUTE Windows paths straight to markdownlint-cli and
// markdownlint-cli does not apply its ignore file to explicitly-named paths.
// Without this the hook rejects files that `npm run markdownlint` never looks
// at, which is a worse failure than the reverse: the author is told to
// restructure a document that CI has no opinion about.
//
//   - `LICENSE.md` (any depth): verbatim third-party terms, never reflowed or
//     restructured to satisfy MD013/MD034.
//   - `migration_doc/`: campaign queues, ledgers and the DEV notes archive.
//     The notes quote source comments verbatim, so their markdown is dictated
//     by whatever the original comment contained.
//   - `Tools/`: probe reports and tool notes.
//   - `ThirdParty/`: vendored upstream READMEs.
function isMarkdownlintExempt(filePath) {
  const rel = filePath.split(/[\\/]/).join("/");
  return (
    rel === "LICENSE.md" ||
    rel.endsWith("/LICENSE.md") ||
    rel.includes("migration_doc/") ||
    rel.includes("Tools/") ||
    rel.includes("ThirdParty/")
  );
}

// The fork comment standard
// (Documentation/Contributors/CodingGuide/ForkCommentStandard.md) applies to
// engine + widgets source only, and covers shader files that no other lane in
// this config touches. The guard is warn-only for paths the remediation shards
// have not reached yet and an error for paths listed in
// Tools/c16/comment-marker-cleanlist.txt, so it can be wired in before the
// rewrites land without failing every commit in the meantime.
const COMMENT_GUARD_GLOB =
  "packages/*/Source/**/*.{js,mjs,cjs,ts,tsx,wgsl,glsl}";

export default {
  "*.{js,cjs,mjs,ts,tsx,css,html}": (files) =>
    buildCommands(files, ["eslint --cache --quiet", "prettier --write"]),
  [COMMENT_GUARD_GLOB]: (files) =>
    buildCommands(files, ["node Tools/c16/comment-marker-guard.mjs"]),
  "*.md": (files) => [
    ...buildCommands(
      files.filter((f) => !isMarkdownlintExempt(f)),
      ["markdownlint"],
    ),
    ...buildCommands(files, ["prettier --write"]),
  ],
};
