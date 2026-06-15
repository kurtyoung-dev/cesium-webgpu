#!/usr/bin/env node
// Probe (NEW-COMPUTE-INSTANCE-PICKPOSITION): scene.pickPosition over a
// GPU-resident compute-instance must return THAT INSTANCE's world position on
// BOTH backends.
//
// Positions live ONLY in the GPU storage buffer (WebGPU) or are CPU-computed by
// the cpuKernel (WebGL2), so the ordinary depth-buffer pickPosition can't
// reconstruct a dot's own center (sub-pixel; on WebGPU the translucent dots
// don't even write depth). The engine instead picks the object under the
// cursor; if it is a compute-instance it reconstructs the position directly —
//   WebGPU: copyBufferToBuffer the picked instance's record slot + mapAsync,
//           bridged by a one-frame-stale per-index sync cache (PickDepth model)
//   WebGL2: re-run the cpuKernel for the picked index.
//
// What it asserts (per backend):
//   (A) scene.pickPosition over each of THREE well-separated, KNOWN instances
//       converges to that instance's ECEF position within tolerance.
//   (B) scene.pickPosition over EMPTY space returns undefined (no false hit).
//   (C) ZERO console errors (incl. WebGPU validation errors).
//   (D) pickPosition never returns a Promise (synchronous contract).
//
// Determinism: instances at FIXED ECEF positions echoed straight from their
// param lanes (no time term), camera fixed, requestRenderMode off. WebGPU pick
// + position readback are one-frame-stale, so each query drives render frames
// and retries until it converges (same cold-cache shape as
// probe-compute-instance-pick.mjs / probe-pickposition-webgpu.mjs).
//
// Usage: node Tools/visual-regression/probe-compute-instance-pickposition.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

// Tolerance: the WGSL kernel computes position in f32 (low part 0), so the
// absolute ECEF position carries ~meter-scale f32 error at the ~7 Mm radii
// used here. 50 m is comfortably above that and far below the 1.6 Mm
// inter-instance spacing (a wrong-instance hit would be off by >1e6 m).
const POS_TOLERANCE_M = 50.0;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

// Instance world positions (ECEF meters) — strung along +Z, out on +X in front
// of the camera, separated by 1.6 Mm so their dots never overlap at this view.
const ANCHOR_X = 7.0e6;
const POSITIONS = [
  { x: ANCHOR_X, y: 0.0, z: -1.6e6 }, // index 0
  { x: ANCHOR_X, y: 0.0, z: 0.0 }, //     index 1
  { x: ANCHOR_X, y: 0.0, z: 1.6e6 }, //   index 2
];

async function runLeg(renderer) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ POSITIONS, POS_TOLERANCE_M, renderer }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;

      // Hide globe/sky so the dots are the only pickable things (an occluding
      // globe tile would win the pick and the dot id never reaches the FBO).
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;

      // Echo kernel: position = params[base+0..2] (ECEF meters), big bright
      // dots, no time term — the picked pixel + position are stable.
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

      // CPU mirror for the WebGL2 backend (same element layout, same result).
      const cpuKernel = (o, index, time, params) => {
        const base = index * 3;
        o.position.x = params[base + 0];
        o.position.y = params[base + 1];
        o.position.z = params[base + 2];
        o.color.red = 1.0;
        o.color.green = 0.0;
        o.color.blue = 1.0;
        o.color.alpha = 1.0;
        o.pixelSize = 26.0;
      };

      const BV_RADIUS = 2.0e7;
      const collection = scene.primitives.add(
        new C.ComputeInstanceCollection({
          kernel: echoKernel,
          cpuKernel: cpuKernel,
          floatsPerInstance: 3,
          boundingSphere: new C.BoundingSphere(C.Cartesian3.ZERO, BV_RADIUS),
        }),
      );
      for (const p of POSITIONS) {
        collection.addInstance([p.x, p.y, p.z]);
      }

      // Camera 22 Mm out on +X looking back at -X, +Z up — the three dots make
      // a vertical column near screen center.
      scene.morphTo3D(0);
      v.camera.setView({
        destination: new C.Cartesian3(2.2e7, 0.0, 0.0),
        orientation: {
          direction: new C.Cartesian3(-1.0, 0.0, 0.0),
          up: new C.Cartesian3(0.0, 0.0, 1.0),
        },
      });

      const renderFrame = async () => {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      };
      const renderN = async (n) => {
        for (let i = 0; i < n; i++) await renderFrame();
      };

      // Warm up: pipeline resolve + params upload + first dispatch so the dots
      // exist before we project + pick.
      await renderN(40);

      // Project each instance to its pick pixel. The pick FBO read uses an
      // OPPOSITE Y convention between the two backends for a programmatically-
      // projected canvas point (cartesianToCanvasCoordinates is top-left
      // origin): WebGPU's pick rectangle reads mirror-Y, WebGL's reads
      // straight. This is the SAME per-backend convention probe-compute-
      // instance-pick.mjs (WebGPU) and the WebGL pick path obey — it is not a
      // pickPosition quirk. Mirror only on WebGPU so each leg addresses the
      // pixel its pick FBO actually samples. (Real mouse events arrive in the
      // convention each backend's pick already expects, so this only matters
      // for synthetic projection in the probe.)
      const canvasH = scene.canvas.clientHeight || 768;
      const mirrorY = renderer === "webgpu";
      const project = (p) => {
        const w = scene.cartesianToCanvasCoordinates(new C.Cartesian3(p.x, p.y, p.z));
        if (!w || !isFinite(w.x) || !isFinite(w.y)) return null;
        return { x: Math.round(w.x), y: Math.round(mirrorY ? canvasH - w.y : w.y) };
      };
      const screen = POSITIONS.map(project);

      // Drive scene.pickPosition until it converges to a STABLE Cartesian3.
      // On WebGPU both the pick FBO read and the position readback are
      // one-frame-stale, so the FIRST query after moving to a new pixel can
      // return the PREVIOUS pixel's instance (a stale carry-over). Requiring
      // the same position twice in a row at the same pixel rejects that — by
      // the time it repeats, the pick FBO + readback have caught up to this
      // pixel. WebGL is synchronous and stabilizes on frame 0. `frame0Kind`
      // records the sync contract (never a Promise).
      const MAX_CONVERGE = 40;
      const eq = (a, b) =>
        a && b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.z - b.z) < 1;
      // Frames to settle the one-frame-stale pick FBO at a NEW pixel before
      // trusting a result (the pick rasterized at the previous pixel can leak
      // into the first couple of reads here). WebGL is synchronous → 0.
      const SETTLE = renderer === "webgpu" ? 8 : 0;
      const pickPositionConverge = async (px) => {
        if (!px) return { kind: "no-screen", pos: null, frame0Kind: "no-screen" };
        let frame0Kind = null;
        // Settle phase: drive pickPosition at this pixel a few frames so the
        // pick FBO + readback catch up from the previous query's pixel.
        for (let i = 0; i < SETTLE; i++) {
          let s;
          try {
            s = scene.pickPosition(new C.Cartesian2(px.x, px.y));
          } catch (e) {
            return { kind: `THREW: ${e}`, pos: null, frame0Kind };
          }
          if (i === 0) {
            frame0Kind =
              s && typeof s.then === "function"
                ? "Promise"
                : s && typeof s.x === "number" && isFinite(s.x)
                  ? "Cartesian3"
                  : "undefined";
          }
          await renderFrame();
        }
        let prev = null;
        for (let i = 0; i < MAX_CONVERGE; i++) {
          let res, kind;
          try {
            res = scene.pickPosition(new C.Cartesian2(px.x, px.y));
          } catch (e) {
            return { kind: `THREW: ${e}`, pos: null, frame0Kind };
          }
          if (res && typeof res.then === "function") kind = "Promise";
          else if (res && typeof res.x === "number" && isFinite(res.x))
            kind = "Cartesian3";
          else if (res && typeof res.x === "number") kind = `NaN(${res.x})`;
          else kind = "undefined";
          if (frame0Kind === null) frame0Kind = kind;
          if (kind === "Promise" || kind.startsWith("NaN") || kind.startsWith("THREW")) {
            return { kind, pos: null, frame0Kind };
          }
          const pos =
            kind === "Cartesian3" ? { x: res.x, y: res.y, z: res.z } : null;
          if (pos && prev && eq(pos, prev)) {
            return { kind: "Cartesian3", pos, frame0Kind };
          }
          prev = pos;
          await renderFrame();
        }
        return { kind: prev ? "unstable" : "undefined", pos: prev, frame0Kind };
      };

      // (A) pickPosition over each known instance.
      const hits = [];
      for (let i = 0; i < POSITIONS.length; i++) {
        const r = await pickPositionConverge(screen[i]);
        let dist = null;
        if (r.pos) {
          const dx = r.pos.x - POSITIONS[i].x;
          const dy = r.pos.y - POSITIONS[i].y;
          const dz = r.pos.z - POSITIONS[i].z;
          dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        hits.push({
          index: i,
          screen: screen[i],
          kind: r.kind,
          frame0Kind: r.frame0Kind,
          pos: r.pos,
          dist,
          within: dist !== null && dist <= POS_TOLERANCE_M,
        });
      }

      // (B) pickPosition over empty space (top-left corner, far from every dot).
      // Drive a few frames so the pick FBO + readback settle, then require
      // undefined (no compute-instance under the cursor → the depth path also
      // returns undefined because the globe is hidden).
      const emptyPx = { x: 12, y: 12 };
      let emptyRes;
      for (let i = 0; i < 8; i++) {
        try {
          emptyRes = scene.pickPosition(new C.Cartesian2(emptyPx.x, emptyPx.y));
        } catch (e) {
          emptyRes = `THREW: ${e}`;
        }
        await renderFrame();
      }
      const emptyKind =
        emptyRes && typeof emptyRes.then === "function"
          ? "Promise"
          : emptyRes && typeof emptyRes.x === "number" && isFinite(emptyRes.x)
            ? "Cartesian3"
            : typeof emptyRes === "string"
              ? emptyRes
              : "undefined";

      return {
        rendererType: scene.context?.rendererType,
        instanceCount: collection.length,
        screen,
        hits,
        emptyPx,
        emptyKind,
      };
    },
    { POSITIONS, POS_TOLERANCE_M, renderer },
  );

  await page.close();
  return { ...out, errors };
}

// ---- run both legs ----
const webgl = await runLeg("webgl");
const webgpu = await runLeg("webgpu");
await browser.close();

// ---- report ----
function printLeg(name, leg) {
  console.log(`\n=== ${name} (${leg.rendererType}) ===`);
  console.log(`instances: ${leg.instanceCount}`);
  for (const h of leg.hits) {
    const posStr = h.pos
      ? `(${h.pos.x.toFixed(0)},${h.pos.y.toFixed(0)},${h.pos.z.toFixed(0)})`
      : "—";
    console.log(
      `  index ${h.index} @ (${h.screen?.x},${h.screen?.y}): kind=${h.kind} ` +
        `frame0=${h.frame0Kind} pos=${posStr} ` +
        `dist=${h.dist === null ? "—" : h.dist.toFixed(2)}m within=${h.within}`,
    );
  }
  console.log(
    `  empty @ (${leg.emptyPx.x},${leg.emptyPx.y}): kind=${leg.emptyKind}`,
  );
  console.log(`  console errors: ${leg.errors.length}`);
  leg.errors.slice(0, 8).forEach((e) => console.log("   ERR:", e.slice(0, 250)));
}
printLeg("WebGL", webgl);
printLeg("WebGPU", webgpu);

// ---- assertions ----
const failures = [];

for (const [name, leg] of [
  ["WebGL", webgl],
  ["WebGPU", webgpu],
]) {
  if (leg.instanceCount !== 3) {
    failures.push(`${name}: expected 3 instances, got ${leg.instanceCount}`);
  }
  // (A) each instance's pickPosition lands on that instance's known position.
  for (const h of leg.hits) {
    if (h.kind !== "Cartesian3") {
      failures.push(
        `${name} index ${h.index}: pickPosition kind=${h.kind} (expected Cartesian3)`,
      );
      continue;
    }
    if (!h.within) {
      failures.push(
        `${name} index ${h.index}: pickPosition off by ${h.dist?.toFixed(1)}m ` +
          `(> ${POS_TOLERANCE_M}m tolerance)`,
      );
    }
    // (D) sync contract — no Promise ever.
    if (h.frame0Kind === "Promise") {
      failures.push(`${name} index ${h.index}: frame-0 pickPosition was a Promise`);
    }
  }
  // (B) empty space → undefined.
  if (leg.emptyKind !== "undefined") {
    failures.push(
      `${name}: empty-space pickPosition returned ${leg.emptyKind} (expected undefined)`,
    );
  }
  // (C) console errors.
  if (leg.errors.length > 0) {
    failures.push(`${name}: ${leg.errors.length} console error(s)`);
  }
}

console.log("");
if (failures.length === 0) {
  console.log(
    "PROBE PASS: compute-instance pickPosition returns instance positions on both backends",
  );
  process.exit(0);
} else {
  console.log("PROBE FAIL:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
