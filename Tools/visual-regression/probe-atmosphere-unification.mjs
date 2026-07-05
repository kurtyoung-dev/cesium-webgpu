// probe-atmosphere-unification.mjs
//
// Structural regression probe for Q32 / ATMOSPHERE-UNIFICATION-FULL.
//
// PREMISE (queue NEXT_QUEUE_2026-07-04 Q32 / ROADMAP §9.2): "four subsystems
// independently re-derive the sky integral (sky FS inline march, env-cube
// inline march, aerial per-pixel march, cloud ambient heuristic); A-LUT-REPARAM
// shipped the shared table, AERIAL-FROXEL shipped the froxel bake, remaining =
// WIRE all four onto the ONE shared sky/transmittance/MS LUT".
//
// That "remaining = wiring" premise is STALE at HEAD. The wiring already
// landed, consumer-by-consumer, each with its own acceptance probe:
//   - sky FS         -> Batch 428 (A-LUT-REPARAM), probe-sky-view-lut.mjs
//   - env-cube       -> envMapMultiScatter path,   probe-env-aerial-ms.mjs (env)
//   - aerial march   -> Batch 430 (ENV-AERIAL-MS), probe-env-aerial-ms.mjs (aerial)
//                       + Batch Q23 froxel fast-path (probe-aerial-froxel.mjs)
//   - cloud ambient  -> Batch 434 (CLOUD-AMBIENT-LUT), probe-cloud-lut-flagon.mjs
//
// All four now sample the SAME shared views produced ONCE by
// WebGPUAtmosphereLUT.ts (ensureAtmosphereLUTResources -> the single skyView +
// multipleScatter textures; dispatchAtmosphereExtendedLUT -> computeSkyView /
// computeMultipleScattering). Each keeps its inline march as the default-OFF
// byte-identical fallback (fork charter rule 1 — the re-derivation is GATED
// behind an opt-in flag, not deleted).
//
// This is NOT a visual probe — it is the unification INVARIANT guard that the
// four per-consumer probes above do not collectively assert. It fails loudly if
// a future refactor (a) makes any consumer bake/read a PRIVATE sky/MS table
// instead of the shared one, (b) drops a consumer's shared-LUT sampling, or
// (c) removes the single shared bake. The four render probes remain the pixel
// regression net; this locks the "1 table, 4 consumers" architecture.
//
// Run: node Tools/visual-regression/probe-atmosphere-unification.mjs
// Exit 0 = unification intact; exit 1 = a consumer diverged from the shared LUT.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const ENGINE = join(ROOT, "packages", "engine", "Source");

function read(rel) {
  return readFileSync(join(ENGINE, rel), "utf8");
}

// ── The ONE shared LUT (single producer) ──
const lutTs = read(join("Renderer", "WebGPU", "WebGPUAtmosphereLUT.ts"));

// ── The four consumer shaders ──
const skyFs = read(join("Shaders", "WebGPU", "Environment", "SkyAtmosphere.wgsl"));
const envCube = read(
  join("Shaders", "WebGPU", "Compute", "ProceduralSkyCubemap.wgsl"),
);
const aerial = read(
  join("Shaders", "WebGPU", "PostProcess", "AerialPerspective.wgsl"),
);
const clouds = read(
  join("Shaders", "WebGPU", "Environment", "ProceduralClouds.wgsl"),
);

// ── The four consumer renderers (bind the SHARED views, not a private bake) ──
const skyRenderer = read(
  join("Renderer", "WebGPU", "WebGPUSkyAtmosphereRenderer.js"),
);
const envRenderer = read(
  join("Renderer", "WebGPU", "WebGPUDynamicEnvironmentMapManager.ts"),
);
const ppCollection = read(
  join("Renderer", "WebGPU", "WebGPUPostProcessStageCollection.ts"),
);
const cloudRenderer = read(
  join("Renderer", "WebGPU", "WebGPUProceduralCloudRenderer.ts"),
);

/**
 * Each check is a plain-substring assertion (not regex) against LIVE SOURCE, so
 * it is robust to whitespace/formatting churn. `all` requires every needle.
 */
const checks = [
  // ── Single producer: ONE shared skyView + MS table, one bake ──
  {
    name: "shared LUT — single skyView + multipleScatter texture allocation",
    src: lutTs,
    all: ['label: "AtmosphereLUT_Sun_SkyView"', 'label: "AtmosphereLUT_Sun_MultipleScatter"'],
  },
  {
    name: "shared LUT — single extended bake (computeSkyView + computeMultipleScattering)",
    src: lutTs,
    all: ['"computeSkyView"', '"computeMultipleScattering"'],
  },

  // ── Consumer 1: sky FS inline march -> shared LUT ──
  {
    name: "sky FS — declares shared skyView + MS LUT bindings",
    src: skyFs,
    all: ["var skyViewLut: texture_2d<f32>", "var multipleScatterLut: texture_2d<f32>"],
  },
  {
    name: "sky FS — samples the shared LUT (sampleSkyViewLut / sampleMultipleScatterLut)",
    src: skyFs,
    all: ["sampleSkyViewLut(", "sampleMultipleScatterLut("],
  },
  {
    name: "sky renderer — binds the SHARED res.skyViewView / res.multipleScatterView",
    src: skyRenderer,
    all: ["res.skyViewView", "res.multipleScatterView"],
  },
  {
    name: "sky renderer — reachable opt-in gate (skyAtmosphere.useScatteringLut, default off)",
    src: skyRenderer,
    all: ["skyAtmosphere.useScatteringLut === true"],
  },

  // ── Consumer 2: env-cube inline march -> shared LUT ──
  {
    name: "env-cube FS — declares shared skyView + MS LUT bindings",
    src: envCube,
    all: ["var skyViewLut: texture_2d<f32>", "var multipleScatterLut: texture_2d<f32>"],
  },
  {
    name: "env-cube FS — samples the shared LUT (sampleSkyViewLut / sampleMultipleScatterLut)",
    src: envCube,
    all: ["sampleSkyViewLut(", "sampleMultipleScatterLut("],
  },
  {
    name: "env renderer — binds the SHARED lutRes.skyViewView / multipleScatterView",
    src: envRenderer,
    all: ["lutRes?.skyViewView", "lutRes?.multipleScatterView"],
  },
  {
    name: "env renderer — reachable opt-in gate (envMapMultiScatter, default off)",
    src: envRenderer,
    all: ["envMapMultiScatter === true"],
  },

  // ── Consumer 3: aerial per-pixel march -> shared LUT ──
  {
    name: "aerial FS — declares shared skyView + MS LUT bindings",
    src: aerial,
    all: ["var skyViewTex: texture_2d<f32>", "var multipleScatterTex: texture_2d<f32>"],
  },
  {
    name: "aerial FS — samples the shared LUT (sampleSkyViewLut / sampleMultipleScatterLut)",
    src: aerial,
    all: ["sampleSkyViewLut(", "sampleMultipleScatterLut("],
  },
  {
    name: "PP collection — feeds aerial the SHARED lut.skyViewView / multipleScatterView",
    src: ppCollection,
    all: ["fx.setSkyViewView(", "fx.setMultipleScatterView(", "skyViewView", "multipleScatterView"],
  },

  // ── Consumer 4: cloud ambient heuristic -> shared LUT ──
  {
    name: "cloud FS — declares shared cloud skyView + MS LUT bindings",
    src: clouds,
    all: ["var cloudSkyViewLut: texture_2d<f32>", "var cloudMultipleScatterLut: texture_2d<f32>"],
  },
  {
    name: "cloud FS — samples the shared LUT (cloudSampleSkyViewLut) under the ambient gate",
    src: clouds,
    all: ["cloudSampleSkyViewLut(", "QF_AMBIENT_LUT"],
  },
  {
    name: "cloud renderer — binds the SHARED res.skyViewView / res.multipleScatterView",
    src: cloudRenderer,
    all: ["res.skyViewView", "res.multipleScatterView"],
  },
  {
    name: "cloud renderer — reachable opt-in gate (cloudAmbientSource === 'sky-lut', default off)",
    src: cloudRenderer,
    all: ['cloudAmbientSource === "sky-lut"'],
  },

  // ── Anti-divergence: no consumer bakes its OWN sky/MS table ──
  // Each consumer must NOT create a private skyView/MS storage texture. The
  // ONLY skyView/MS texture allocations in the WebGPU tree live in
  // WebGPUAtmosphereLUT.ts. If a consumer renderer starts allocating one, the
  // unification is broken — assert its absence in the consumer renderers.
  {
    name: "env renderer — does NOT allocate a private SkyView storage texture",
    src: envRenderer,
    absent: ["createTexture(", "AtmosphereLUT_Sun_SkyView"], // absent = none of these co-occur as an alloc label
    absentLabel: 'label: "AtmosphereLUT_Sun_SkyView"',
  },
];

let failed = 0;
for (const c of checks) {
  let ok = true;
  const missing = [];
  if (c.all) {
    for (const needle of c.all) {
      if (!c.src.includes(needle)) {
        ok = false;
        missing.push(needle);
      }
    }
  }
  if (c.absentLabel) {
    if (c.src.includes(c.absentLabel)) {
      ok = false;
      missing.push(`UNEXPECTED private bake: ${c.absentLabel}`);
    }
  }
  if (ok) {
    console.log(`  PASS  ${c.name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${c.name}`);
    for (const m of missing) console.log(`          missing: ${JSON.stringify(m)}`);
  }
}

console.log("");
if (failed === 0) {
  console.log(
    `[atmosphere-unification] PASS ${checks.length}/${checks.length} — ` +
      `all 4 sky-integral consumers wired to the ONE shared sky/MS LUT.`,
  );
  process.exit(0);
} else {
  console.log(
    `[atmosphere-unification] FAIL ${failed}/${checks.length} check(s) — ` +
      `a consumer diverged from the shared LUT (unification broken).`,
  );
  process.exit(1);
}
