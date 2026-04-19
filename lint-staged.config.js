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

function buildCommands(files, tools) {
  const allowed = files.filter((f) => !isVendored(f));
  if (allowed.length === 0) {
    return [];
  }
  const quoted = allowed.map((f) => `"${f}"`).join(" ");
  return tools.map((t) => `${t} ${quoted}`);
}

export default {
  "*.{js,cjs,mjs,ts,tsx,css,html}": (files) =>
    buildCommands(files, ["eslint --cache --quiet", "prettier --write"]),
  "*.md": (files) => buildCommands(files, ["markdownlint", "prettier --write"]),
};
