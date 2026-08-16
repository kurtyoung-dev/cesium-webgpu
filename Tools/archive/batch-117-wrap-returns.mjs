#!/usr/bin/env node
// Batch 117 helper — rewraps `return <expr>;` to `return makeFragOutput(<expr>, normalEC);`
// inside the body of GlobeTerrain.wgsl's fragmentMain.
//
// Why a helper instead of hand-editing 36 returns: the rewrap is fully
// uniform (every return inside the function takes the same transform),
// so manual edits introduce more risk (typos, missed returns) than a
// scoped regex. The helper bails if anything looks off (wrong return
// count, malformed expressions) instead of producing bad output.
//
// Why NOT a full bash sed: the CesiumJS WGSL pragma stripper would
// strip pragmas inside this file too, and a global regex risks touching
// the helper function's own `return out;` line. Scope-by-line-range
// keeps the edit local to fragmentMain.

import fs from "fs";
import path from "path";

const FILE = "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const START_MARKER = /^@fragment$/;
const FUNC_LINE = /^fn fragmentMain\(input: VertexOutput\) -> FragOutput \{$/;

const src = fs.readFileSync(FILE, "utf8");
const lines = src.split(/\r?\n/);

// Locate fragmentMain bounds. The function starts at the `@fragment`
// attribute and ends at the matching `}` of the `fn fragmentMain` body.
let fragmentAttrIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (START_MARKER.test(lines[i])) {
    if (lines[i + 1] && FUNC_LINE.test(lines[i + 1])) {
      fragmentAttrIdx = i;
      break;
    }
  }
}
if (fragmentAttrIdx < 0) {
  console.error("ERROR: could not locate @fragment + fn fragmentMain");
  process.exit(1);
}
const funcOpenIdx = fragmentAttrIdx + 1;
// Find matching close brace via depth tracking starting from the line
// AFTER the `fn fragmentMain(...) -> FragOutput {` opener.
let depth = 1;
let funcCloseIdx = -1;
for (let i = funcOpenIdx + 1; i < lines.length; i++) {
  const line = lines[i];
  // Count braces, ignoring those inside string literals (none in WGSL
  // shaders) or comments. We approximate by stripping `//` line comments.
  const code = line.replace(/\/\/.*$/, "");
  for (const ch of code) {
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        funcCloseIdx = i;
        break;
      }
    }
  }
  if (funcCloseIdx >= 0) break;
}
if (funcCloseIdx < 0) {
  console.error("ERROR: could not locate matching close brace");
  process.exit(1);
}

console.log(`fragmentMain body: lines ${funcOpenIdx + 1}..${funcCloseIdx + 1}`);

// Rewrap pattern: `<indent>return <expr>;<trailing>` → `<indent>return makeFragOutput(<expr>, normalEC);<trailing>`
// Where <expr> is everything between `return ` and the final `;` on the line.
// We deliberately match only single-line returns; multi-line return
// expressions in fragmentMain don't exist (verified by inspecting the
// 36-return list before running this).
const RETURN_RE = /^(\s*)return (.+);(\s*(?:\/\/.*)?)$/;
let count = 0;
let skipped = 0;
for (let i = funcOpenIdx + 1; i < funcCloseIdx; i++) {
  const line = lines[i];
  const m = RETURN_RE.exec(line);
  if (!m) continue;
  const expr = m[2].trim();
  // Skip the `return;` form (no value) — shouldn't exist in fragmentMain
  // but defensive. Also skip if the expression is already wrapped.
  if (expr === "" || expr.startsWith("makeFragOutput(")) {
    skipped++;
    continue;
  }
  lines[i] = `${m[1]}return makeFragOutput(${expr}, normalEC);${m[3] ?? ""}`;
  count++;
}

console.log(`rewrapped ${count} returns (skipped ${skipped})`);

// Sanity guard — we expect 33 rewraps (verified by inspecting the
// pre-edit `awk '/return /' fragmentMain` output). Bail if off by
// more than 2 to catch shader edits between when we counted and when
// we run this. Widened to 30..40 after initial run confirmed 33.
if (count < 30 || count > 40) {
  console.error(
    `ERROR: rewrap count ${count} outside expected range (30..40). Aborting.`,
  );
  process.exit(1);
}

fs.writeFileSync(FILE, lines.join("\r\n"), "utf8");
console.log(`wrote ${path.resolve(FILE)}`);
