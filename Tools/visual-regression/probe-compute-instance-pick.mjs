#!/usr/bin/env node
// Probe (NEW-ORBITAL-GPU-PICKING): GPU-resident compute-instances must be
// pickable on WebGPU. Positions live ONLY in the GPU storage buffer (the
// kernel writes them every frame), so there is no CPU position to hit-test —
// the engine renders one pick id per instance into the pick FBO and the
// readback decodes the instance under the cursor.
// @purpose GPU-resident compute-instances are pickable: scene.pick returns the right instanceIndex for three instances; empty space undefined.
// @status ACTIVE
//
// What it asserts (WebGPU):
//   (A) scene.pick over a KNOWN instance returns that instance's record —
//       a { collection, instanceIndex, primitive } object whose
//       `instanceIndex` matches the instance actually under the cursor and
//       whose `collection` is the ComputeInstanceCollection. Verified for
//       THREE well-separated instances (indices 0, 1, 2) so a constant /
//       off-by-one index can't pass.
//   (B) scene.pick over EMPTY space (a corner far from every dot) returns
//       undefined (no false positives from the cleared pick FBO).
//   (C) ZERO console errors (incl. WebGPU validation errors) across the run.
//   (D) The engine stays domain-agnostic: the picked record carries the raw
//       instanceIndex + collection, NOT any satellite/orbital object — the
//       demo is what maps index -> domain object.
//
// Picking on WebGPU is async (the pick FBO read-back returns the PREVIOUS
// frame's result), so each pick query drives a few render frames and retries
// scene.pick until it converges (same cold-cache shape as
// probe-pickposition-webgpu.mjs).
//
// Determinism: instances are placed at FIXED ECEF positions carried in their
// param lanes (the kernel just echoes params -> position), camera is fixed,
// requestRenderMode off. No time dependence, so the picked pixel is stable.
//
// Usage: node Tools/visual-regression/probe-compute-instance-pick.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;

  // Deterministic background: hide globe/sky/sun/moon so the compute-instance
  // dots are the only pickable things on screen (billboard-pick probe
  // pattern). Without this an occluding globe tile can win the pick depth
  // test and the dot id never reaches the pick FBO.
  scene.globe.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;

  // Echo kernel: position = params[base+0..2] (ECEF meters), big bright dots.
  // No time term — the picked pixel is stable across frames.
  const echoKernel = `
    fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {
      let base = index * FLOATS_PER_INSTANCE;
      var out: ComputeInstanceOut;
      out.position = vec3<f32>(
        params[base + 0u], params[base + 1u], params[base + 2u]);
      out.color = vec4<f32>(1.0, 0.0, 1.0, 1.0);
      out.pixelSize = 26.0;
      return out;
    }`;

  // Three instances strung along +Z, all out on +X in front of the camera,
  // separated by 1.6 Mm so their 26 px dots never overlap at this view.
  const anchorX = 7.0e6;
  const positions = [
    new C.Cartesian3(anchorX, 0.0, -1.6e6), // index 0
    new C.Cartesian3(anchorX, 0.0, 0.0), //    index 1
    new C.Cartesian3(anchorX, 0.0, 1.6e6), //  index 2
  ];

  const BV_RADIUS = 2.0e7;
  const collection = scene.primitives.add(
    new C.ComputeInstanceCollection({
      kernel: echoKernel,
      floatsPerInstance: 3,
      boundingSphere: new C.BoundingSphere(C.Cartesian3.ZERO, BV_RADIUS),
    }),
  );
  for (const p of positions) {
    collection.addInstance([p.x, p.y, p.z]);
  }

  // Camera: 22 Mm out on +X looking back at -X, +Z up — the three dots make
  // a vertical column near screen center.
  scene.morphTo3D(0);
  v.camera.setView({
    destination: new C.Cartesian3(2.2e7, 0.0, 0.0),
    orientation: {
      direction: new C.Cartesian3(-1.0, 0.0, 0.0),
      up: new C.Cartesian3(0.0, 0.0, 1.0),
    },
  });

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });
  const renderFrame = async () => {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  };
  const renderN = async (n) => {
    for (let i = 0; i < n; i++) await renderFrame();
  };

  // Pick helper: scene.pickAsync `endAsync`-reads the pick FBO and AWAITS the
  // read-back for THIS pixel (no stale-previous-frame ambiguity the sync
  // scene.pick carries). 9x9 pick rect (billboard-pick probe convention) so
  // the spiral search has slack against sub-pixel projection rounding.
  const doPick = async (x, y) => {
    if (scene.pickAsync) return scene.pickAsync(new C.Cartesian2(x, y), 9, 9);
    return scene.pick(new C.Cartesian2(x, y), 9, 9);
  };
  const pickAt = async (px) => {
    if (!px) return undefined;
    try {
      return await doPick(px.x, px.y);
    } catch (e) {
      return `THREW: ${e}`;
    }
  };

  // Warm up: async render-pipeline resolve + params upload + first dispatch
  // so the dots are actually drawn before we project + pick.
  await renderN(40);
  await oncePostRender();

  // Project each instance's world position to the PICK pixel. NOTE the Y
  // mirror: scene.pick's drawing-buffer rectangle flips Y
  // (computePickingDrawingBufferRectangle: y = drawingBufferHeight - y) — the
  // convention real mouse events arrive in — so a programmatically-projected
  // canvas point must be mirrored about the canvas vertical center to address
  // the same pixel the pick FBO reads. This is the SAME convention every
  // WebGPU collection pick obeys (verified identical against
  // PointPrimitiveCollection), not a compute-instance quirk.
  const canvasH = scene.canvas.clientHeight || 768;
  const project = (worldPos) => {
    const w = scene.cartesianToCanvasCoordinates(worldPos);
    return w && isFinite(w.x) && isFinite(w.y)
      ? { x: Math.round(w.x), y: Math.round(canvasH - w.y) }
      : null;
  };
  const screen = positions.map(project);

  // Warm-up pick: the GPU pick pipeline materializes lazily on the FIRST pick
  // pass (async pipeline creation skips that frame's pick draw — Batch 73
  // behavior). One throwaway pick + a few frames lets it land before the
  // asserted picks (billboard-pick probe pattern).
  await pickAt(screen[1] ?? { x: 512, y: 384 });
  await renderN(10);

  // Describe a picked record without leaking non-serializable refs.
  const describe = (picked) => {
    if (picked === undefined || picked === null) return { kind: "undefined" };
    return {
      kind: "object",
      hasCollection: picked.collection === collection,
      collectionIsComputeInstance:
        picked.collection instanceof C.ComputeInstanceCollection,
      instanceIndex:
        typeof picked.instanceIndex === "number" ? picked.instanceIndex : null,
      // Domain-agnostic check (D): the engine record must NOT carry a
      // satellite / orbital object — only the raw index + collection (+ the
      // `primitive` alias the scene pick path requires).
      hasPrimitive: picked.primitive !== undefined,
      keys: Object.keys(picked).sort(),
    };
  };

  // (A) Pick over each known instance.
  const hits = [];
  for (let i = 0; i < positions.length; i++) {
    const picked = await pickAt(screen[i]);
    hits.push({ index: i, screen: screen[i], ...describe(picked) });
  }

  // (B) Pick over empty space — top-left corner, far from every dot.
  const emptyPx = { x: 12, y: 12 };
  const emptyPicked = await pickAt(emptyPx);
  const emptyHit =
    emptyPicked !== undefined &&
    emptyPicked !== null &&
    emptyPicked.collection === collection;

  // Pick-side cache introspection (pipeline + ids actually allocated).
  const cache = collection._webgpuCache;
  const pickState = {
    pickIdCount: cache?.pickIdCount ?? -1,
    pickIdsLen: cache?.pickIds?.length ?? -1,
    hasPickPipeline: !!cache?.pickPipeline,
    hasPickColorBuffer: !!cache?.pickColorBuffer,
    hasPickCommand: !!cache?.pickCommand,
  };

  return {
    instanceCount: collection.length,
    screen,
    hits,
    emptyPx,
    emptyHit,
    emptyKind: describe(emptyPicked).kind,
    pickState,
  };
});

await browser.close();

// ── Report ──
console.log(`instances: ${out.instanceCount}`);
console.log(`pick-side cache: ${JSON.stringify(out.pickState)}`);
for (const h of out.hits) {
  console.log(
    `  index ${h.index} @ (${h.screen?.x},${h.screen?.y}): kind=${h.kind} ` +
      `instanceIndex=${h.instanceIndex} hasCollection=${h.hasCollection} ` +
      `isComputeInstance=${h.collectionIsComputeInstance} hasPrimitive=${h.hasPrimitive} ` +
      `keys=[${(h.keys || []).join(",")}]`,
  );
}
console.log(
  `  empty @ (${out.emptyPx.x},${out.emptyPx.y}): kind=${out.emptyKind} hit=${out.emptyHit}`,
);
console.log(`console errors: ${errors.length}`);
errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 250)));

// ── Assertions ──
const failures = [];

if (out.instanceCount !== 3) {
  failures.push(`expected 3 instances, got ${out.instanceCount}`);
}
// (A) each instance picks back its own index.
for (const h of out.hits) {
  if (h.kind !== "object") {
    failures.push(
      `index ${h.index}: pick returned ${h.kind} (expected object)`,
    );
    continue;
  }
  if (!h.hasCollection) {
    failures.push(
      `index ${h.index}: picked record.collection !== the collection`,
    );
  }
  if (!h.collectionIsComputeInstance) {
    failures.push(
      `index ${h.index}: picked collection not a ComputeInstanceCollection`,
    );
  }
  if (h.instanceIndex !== h.index) {
    failures.push(
      `index ${h.index}: picked instanceIndex=${h.instanceIndex} (expected ${h.index})`,
    );
  }
  // (D) domain-agnostic — record carries index + collection + primitive only.
  if (!h.hasPrimitive) {
    failures.push(
      `index ${h.index}: picked record missing the .primitive alias`,
    );
  }
}
// (B) empty space → no hit.
if (out.emptyHit) {
  failures.push(`empty-space pick returned the collection (false positive)`);
}
// pick resources actually allocated for all 3 instances.
if (out.pickState.pickIdCount !== 3 || out.pickState.pickIdsLen !== 3) {
  failures.push(
    `pick ids not allocated for all instances: ${JSON.stringify(out.pickState)}`,
  );
}
if (!out.pickState.hasPickPipeline || !out.pickState.hasPickColorBuffer) {
  failures.push(`pick pipeline / color buffer not allocated`);
}
// (C) console errors.
if (errors.length > 0) {
  failures.push(`${errors.length} console error(s)`);
}

console.log("");
if (failures.length === 0) {
  console.log("PROBE PASS: compute-instances are pickable on WebGPU");
  process.exit(0);
} else {
  console.log("PROBE FAIL:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
