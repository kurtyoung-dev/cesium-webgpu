#!/usr/bin/env node
// NEW-COLLECTIONS-ERROR-SENTINELS — standalone node verification of the three
// PERMANENT (non-pragma) fault detectors in WebGPUCollectionRendererBase.ts:
//   1. Re-entry / infinite-loop guard  (beginCollectionFrame/endCollectionFrame)
//   2. Null-target guard                (validateInstanceSyncResult / validateDrawTargets)
//   3. Size-validation / overflow guard (validateInstancedDrawBuffer / writePickInstances)
//
// Drives each sentinel under (a) the happy path — must stay SILENT and return
// the unmodified value — and (b) a forced fault — must `console.error` and
// skip/clamp. esbuild-transpiles the TS in-memory (mirrors the Batch-302
// harness) so no GPUDevice / browser is needed.
//
// Run: node Tools/collection-sentinels-check.mjs
// Exit 0 on all-pass, 1 on any failure.

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseSrc = resolve(
  __dirname,
  "../packages/engine/Source/Renderer/WebGPU/WebGPUCollectionRendererBase.ts",
);

// Bundle the base; stub its two value imports (WebGPUBuffer, SceneMode) — the
// sentinels we exercise don't touch them, but the module imports them at top.
const tmp = mkdtempSync(resolve(tmpdir(), "coll-sentinel-"));
const stubBuffer = resolve(tmp, "WebGPUBuffer.js");
const stubScene = resolve(tmp, "SceneMode.js");
const stubResident = resolve(tmp, "WebGPUResidentInstanceBuffer.js");
const stubModuleCache = resolve(tmp, "WebGPUShaderModuleCache.js");
writeFileSync(stubBuffer, "export default class WebGPUBuffer {}\n");
writeFileSync(stubScene, "export default { SCENE3D: 3 };\n");
writeFileSync(
  stubResident,
  "export class WebGPUResidentInstanceBuffer {}\n",
);
writeFileSync(
  stubModuleCache,
  "export class WebGPUShaderModuleCache {}\n",
);

const result = await build({
  entryPoints: [baseSrc],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "stub-imports",
      setup(b) {
        b.onResolve({ filter: /WebGPUBuffer\.js$/ }, () => ({ path: stubBuffer }));
        b.onResolve({ filter: /SceneMode\.js$/ }, () => ({ path: stubScene }));
        b.onResolve({ filter: /WebGPUResidentInstanceBuffer\.js$/ }, () => ({
          path: stubResident,
        }));
        b.onResolve({ filter: /WebGPUShaderModuleCache\.js$/ }, () => ({
          path: stubModuleCache,
        }));
      },
    },
  ],
});

const outFile = resolve(tmp, "base.mjs");
writeFileSync(outFile, result.outputFiles[0].text);
const base = await import(pathToFileURL(outFile).href);
const {
  beginCollectionFrame,
  endCollectionFrame,
  validateInstanceSyncResult,
  validateDrawTargets,
  validateInstancedDrawBuffer,
} = base;

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
}

// Capture console.error.
let errors = [];
const realError = console.error;
console.error = (...a) => errors.push(a.join(" "));
function resetErrors() {
  errors = [];
}

// ── Sentinel 1 — re-entry guard ───────────────────────────────────────
resetErrors();
{
  const cache = {};
  const depth = beginCollectionFrame(cache, "Billboard");
  endCollectionFrame(cache);
  check("S1 normal call → depth 1, no log", depth === 1 && errors.length === 0);
  check("S1 depth settles to 0", cache._frameReentryDepth === 0);
}
resetErrors();
{
  const cache = {};
  for (let i = 0; i < 8; i++) beginCollectionFrame(cache, "Billboard");
  check("S1 overlap of 8 (<16) → no log", errors.length === 0);
}
resetErrors();
{
  const cache = {};
  for (let i = 0; i < 17; i++) beginCollectionFrame(cache, "Billboard");
  check(
    "S1 depth 17 (>16) → exactly 1 permanent error mentioning re-entry",
    errors.length === 1 && /re-entry/.test(errors[0]),
  );
  beginCollectionFrame(cache, "Billboard");
  check("S1 throttle → no second log in window", errors.length === 1);
}
resetErrors();
{
  const cache = {};
  endCollectionFrame(cache);
  endCollectionFrame(cache);
  check("S1 endCollectionFrame never goes below 0", cache._frameReentryDepth === 0);
}

// ── Sentinel 2 — null-target guard ────────────────────────────────────
resetErrors();
check(
  "S2 sync OK (5 visible, buffer set) → true, no log",
  validateInstanceSyncResult({ visibleCount: 5, buffer: { size: 1024 } }, "X") ===
    true && errors.length === 0,
);
resetErrors();
check(
  "S2 empty (0 visible) → false, no log",
  validateInstanceSyncResult({ visibleCount: 0, buffer: null }, "X") === false &&
    errors.length === 0,
);
resetErrors();
check(
  "S2 null buffer w/ 7 visible → false + permanent error",
  validateInstanceSyncResult({ visibleCount: 7, buffer: null }, "X") === false &&
    errors.length === 1 &&
    /null buffer/.test(errors[0]),
);
resetErrors();
check(
  "S2 validateDrawTargets all live (wrapper + raw) → true, no log",
  validateDrawTargets([{ buffer: {} }, {}], "Y") === true && errors.length === 0,
);
resetErrors();
check(
  "S2 validateDrawTargets null target → false + error",
  validateDrawTargets([{ buffer: {} }, null], "Y-null") === false &&
    errors.length === 1,
);
resetErrors();
check(
  "S2 validateDrawTargets destroyed wrapper (.buffer===null) → false + error",
  validateDrawTargets([{ buffer: null }], "Y-destroyed") === false &&
    errors.length === 1,
);

// ── Sentinel 3 — size validation / overflow ───────────────────────────
resetErrors();
check(
  "S3 fits (3×56 ≤ 256) → returns 3, no log",
  validateInstancedDrawBuffer({ size: 256 }, 3, 56, "Z") === 3 &&
    errors.length === 0,
);
resetErrors();
check(
  "S3 overflow (5×56 > 168) → clamp to 3 + permanent error",
  validateInstancedDrawBuffer({ size: 168 }, 5, 56, "Z-of") === 3 &&
    errors.length === 1 &&
    /clamping/.test(errors[0]),
);
resetErrors();
check(
  "S3 null buffer → 0 safe instances",
  validateInstancedDrawBuffer(null, 5, 56, "Z") === 0,
);
resetErrors();
check(
  "S3 zero count → 0, no log",
  validateInstancedDrawBuffer({ size: 256 }, 0, 56, "Z") === 0 &&
    errors.length === 0,
);

console.error = realError;
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
