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
// License files are verbatim third-party terms — they must never be reflowed
// or restructured to satisfy MD013/MD034/etc. The root `.markdownlintignore`
// already exempts them for the glob-mode `npm run markdownlint`, but
// lint-staged passes ABSOLUTE Windows paths straight to markdownlint-cli,
// which does not apply the ignore file to explicitly-named paths — so the
// exemption has to live here too (learned landing the packages/engine
// LICENSE.md mirror, Batch 867).
function isLicenseMarkdown(filePath) {
  const rel = filePath.split(/[\\/]/).join("/");
  return rel === "LICENSE.md" || rel.endsWith("/LICENSE.md");
}

export default {
  "*.{js,cjs,mjs,ts,tsx,css,html}": (files) =>
    buildCommands(files, ["eslint --cache --quiet", "prettier --write"]),
  "*.md": (files) => [
    ...buildCommands(
      files.filter((f) => !isLicenseMarkdown(f)),
      ["markdownlint"],
    ),
    ...buildCommands(files, ["prettier --write"]),
  ],
};
