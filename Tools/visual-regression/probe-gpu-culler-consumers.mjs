// probe-gpu-culler-consumers.mjs
//
// Structural regression probe for Q18 / NEW-GPU-CULLER-CONSUME-OR-DELETE
// (Principle-7 landmine). The four GPU compute dispatchers — gpuCull, HiZ
// occlusion, GPUSortKeys, and PointCloudSort — were flagged as "orphan
// dispatchers that allocate eagerly with no live caller". That premise is
// STALE at HEAD: all four are (a) LAZILY allocated (WeakMap getOrCreate /
// null-until-first-dispatch) and (b) consumed behind a live, threshold- or
// opt-in-gated call site. See DEFERRED_WORK.md
// "NEW-GPU-CULLER-CONSUME-OR-DELETE" + "NEW-HIZ-SORT-CONSUME-OR-DELETE"
// (RESOLVED, Batches 209/210/211).
//
// This is NOT a visual probe — the consume-or-delete decision is an
// architecture/allocation-lifecycle invariant with no pixel output. The
// probe asserts, against LIVE SOURCE, that each dispatcher still has its
// consumer wired and its dispatch still sits behind an activation gate.
// If a future refactor orphans one of them again (re-arming the exact
// landmine Principle-7 warns about), this probe fails loudly.
//
// Run: node Tools/visual-regression/probe-gpu-culler-consumers.mjs
// Exit 0 = all consumers wired; exit 1 = a dispatcher was orphaned.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const ENGINE = join(ROOT, "packages", "engine", "Source");

function read(rel) {
  return readFileSync(join(ENGINE, rel), "utf8");
}

const sceneRenderer = read(
  join("Renderer", "WebGPU", "WebGPUSceneRenderer.ts"),
);
const pcBridge = read(join("Scene", "WasmPointCloudBridge.js"));
const timeDynamic = read(join("Scene", "TimeDynamicPointCloud.js"));

/**
 * Each check: a dispatcher's CONSUMER call site + the GATE that guards its
 * dispatch. Both must be present. `needle` is a plain-substring assertion
 * (not a regex) so it is robust to whitespace/formatting churn.
 */
const checks = [
  {
    name: "gpuCull — opaque consumer",
    file: "WebGPUSceneRenderer.ts",
    src: sceneRenderer,
    needle: "this.gpuCullCommands(",
  },
  {
    name: "gpuCull — activation gate",
    file: "WebGPUSceneRenderer.ts",
    src: sceneRenderer,
    needle: "if (gpuCullActive)",
  },
  {
    name: "HiZ — consumer (previous-frame visibility filter)",
    file: "WebGPUSceneRenderer.ts",
    src: sceneRenderer,
    needle: "this._filterByHiZVisibility(",
  },
  {
    name: "HiZ — producer (dispatch for next frame)",
    file: "WebGPUSceneRenderer.ts",
    src: sceneRenderer,
    needle: "this._dispatchHiZForNextFrame(",
  },
  {
    name: "GPUSortKeys — consumer (apply sorted order)",
    file: "WebGPUSceneRenderer.ts",
    src: sceneRenderer,
    needle: "this._applySortedOrder(",
  },
  {
    name: "GPUSortKeys — producer (dispatch sort keys)",
    file: "WebGPUSceneRenderer.ts",
    src: sceneRenderer,
    needle: "this._dispatchGPUSortKeys(",
  },
  {
    name: "HiZ/GPUSort — shared activation gate",
    file: "WebGPUSceneRenderer.ts",
    src: sceneRenderer,
    needle: "if (hiZActive || gpuSortActive)",
  },
  {
    name: "PointCloudSort — dispatcher consumer (fr.sort)",
    file: "WasmPointCloudBridge.js",
    src: pcBridge,
    needle: "fr.sort(encoder, distSq, count)",
  },
  {
    name: "PointCloudSort — opt-in gate (useGPUSort + threshold)",
    file: "WasmPointCloudBridge.js",
    src: pcBridge,
    needle: "this.useGPUSort && context && count >= this._threshold",
  },
  {
    name: "PointCloudSort — live scene caller (sortByDistance)",
    file: "TimeDynamicPointCloud.js",
    src: timeDynamic,
    needle: "bridge.sortByDistance(",
  },
];

let failed = 0;
for (const c of checks) {
  const ok = c.src.includes(c.needle);
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failed++;
  console.log(`[${tag}] ${c.name}  (${c.file})`);
  if (!ok) {
    console.log(`        missing consumer/gate: ${JSON.stringify(c.needle)}`);
  }
}

console.log("");
if (failed === 0) {
  console.log(
    `OK — all ${checks.length} dispatcher consumers + gates are wired. ` +
      `Q18 premise (orphan dispatchers) is stale; consume-decision holds.`,
  );
  process.exit(0);
} else {
  console.error(
    `ORPHANED — ${failed}/${checks.length} checks failed. A GPU dispatcher ` +
      `lost its consumer or gate (Principle-7 landmine re-armed). Either ` +
      `re-wire the consumer or delete the dispatcher + reclaim its allocation.`,
  );
  process.exit(1);
}
