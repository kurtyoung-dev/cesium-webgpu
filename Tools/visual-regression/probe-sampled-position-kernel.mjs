#!/usr/bin/env node
// Probe (NEW-SAMPLED-POSITION-KERNEL): the SampledPositionKernel family — the
// SECOND ComputeInstanceCollection kernel family — must interpolate each
// instance's GPU-resident position from its uploaded keyframes to the CORRECT
// position at a queried clock time, on BOTH backends.
//
// SampledPositionKernel.create() bakes a per-instance keyframe budget into a
// matched WGSL kernel + JS cpuKernel + param packer (one lane layout). The
// GPU (WebGPU compute) / CPU (WebGL2 fallback) kernels linearly interpolate
// the bracketing keyframes at the scene clock time; the same RTE instance
// record the instanced draw consumes is what we read back.
//
// What it asserts (per backend):
//   (A) RENDER — N keyframed dots produce a magenta pixel count over
//       threshold from a fixed camera.
//   (B) PARITY — for several KNOWN instances at several query times, the
//       GPU-resident interpolated position (read back via the same
//       getInstanceWorldPosition path scene.pickPosition uses) matches an
//       INDEPENDENT reference within tolerance. The reference is BOTH:
//         (i)  SampledPositionKernel.sample()  (the family's pure-JS
//              interpolation), AND
//         (ii) a CPU Cesium.SampledPositionProperty with linear
//              interpolation built from the SAME keyframes.
//       Querying mid-segment, exactly on a keyframe, before the first, and
//       after the last keyframe exercises interpolation + HOLD extrapolation.
//   (C) MOVE — driving the clock advances the dots: the magenta mask at an
//       early time vs a late time differs substantially while the camera is
//       fixed.
//   (D) ZERO console errors (incl. WebGPU validation errors).
//
// Determinism: clock pinned to epoch + a known offset per query, camera fixed,
// requestRenderMode off. On WebGPU the position readback is one-frame-stale
// (copyBufferToBuffer + mapAsync, PickDepth bridge), so each parity query
// drives render frames and retries until getInstanceWorldPosition converges.
//
// Usage: node Tools/visual-regression/probe-sampled-position-kernel.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

// f32 kernel (low part 0) → ~meter-scale error at ~7 Mm radii. 80 m is well
// above that and far below the inter-keyframe spacing (millions of meters).
const POS_TOLERANCE_M = 80.0;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

// Three instances, each with 4 keyframes (within the maxKeyframes=8 budget),
// strung out on +X in front of the camera so their dots are well separated.
// Per-instance keyframe times (seconds since epoch) + ECEF positions. Each
// track moves monotonically along +Z so the interpolation is easy to eyeball.
const ANCHOR_X = 7.0e6;
const TRACKS = [
  {
    zBase: -2.0e6,
    keyframes: [
      { t: 0.0, z: 0.0 },
      { t: 100.0, z: 0.6e6 },
      { t: 200.0, z: 0.6e6 }, // flat segment (duplicate value, distinct time)
      { t: 300.0, z: 1.2e6 },
    ],
  },
  {
    zBase: 0.0,
    keyframes: [
      { t: 0.0, z: 0.0 },
      { t: 150.0, z: -0.5e6 },
      { t: 220.0, z: 0.4e6 },
      { t: 400.0, z: 0.9e6 },
    ],
  },
  {
    zBase: 2.0e6,
    keyframes: [
      { t: 50.0, z: 0.0 }, // first keyframe at t=50 → t<50 holds this
      { t: 120.0, z: 0.3e6 },
      { t: 260.0, z: -0.2e6 },
      { t: 350.0, z: 0.7e6 },
    ],
  },
];

// Query times (seconds since epoch): mid-segment, exactly on a keyframe,
// before-first (HOLD), after-last (HOLD).
const QUERY_TIMES = [125.0, 200.0, -30.0, 999.0];

async function runLeg(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
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
    async ({ renderer, ANCHOR_X, TRACKS, QUERY_TIMES, POS_TOLERANCE_M }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;

      // The keyframe family — maxKeyframes=8 budget, bright magenta dots.
      const family = C.SampledPositionKernel.create({
        maxKeyframes: 8,
        color: new C.Color(1.0, 0.0, 1.0, 1.0),
        pixelSize: 18.0,
      });

      const epoch = C.JulianDate.clone(v.clock.currentTime);

      // Build per-track keyframe lists in the shape the packer wants, plus a
      // CPU SampledPositionProperty (linear) from the SAME keyframes for the
      // independent parity reference (ii).
      const lanesPerInstance = [];
      const sampledProps = [];
      for (const track of TRACKS) {
        const keyframes = track.keyframes.map((k) => ({
          time: C.JulianDate.addSeconds(epoch, k.t, new C.JulianDate()),
          position: new C.Cartesian3(ANCHOR_X, 0.0, track.zBase + k.z),
        }));
        lanesPerInstance.push(family.packInstance(keyframes, epoch));

        const prop = new C.SampledPositionProperty();
        prop.setInterpolationOptions({
          interpolationDegree: 1,
          interpolationAlgorithm: C.LinearApproximation,
        });
        // The kernel CLAMPS to the endpoint outside the keyframe span (HOLD
        // extrapolation, matching ExtrapolationType.HOLD). SampledPositionProperty
        // defaults to ExtrapolationType.NONE (returns undefined out of range), so
        // set HOLD on both ends for the reference to agree on the out-of-range
        // query times (t=-30 before first, t=999 after last).
        prop.forwardExtrapolationType = C.ExtrapolationType.HOLD;
        prop.backwardExtrapolationType = C.ExtrapolationType.HOLD;
        for (const kf of keyframes) {
          prop.addSample(kf.time, kf.position);
        }
        sampledProps.push(prop);
      }

      const BV_RADIUS = 2.0e7;
      const collection = scene.primitives.add(
        new C.ComputeInstanceCollection({
          kernel: family.kernel,
          cpuKernel: family.cpuKernel,
          floatsPerInstance: family.floatsPerInstance,
          boundingSphere: new C.BoundingSphere(C.Cartesian3.ZERO, BV_RADIUS),
        }),
      );
      collection.epoch = epoch;
      for (const lanes of lanesPerInstance) {
        collection.addInstance(lanes);
      }

      // Camera 22 Mm out on +X, looking back at -X with +Z up → the dots make
      // a vertical column near screen center, in front of the (kept) globe.
      scene.morphTo3D(0);
      scene.globe.show = false; // dots are the subject; keep the frame clean
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
      const setClock = (simSeconds) => {
        v.clock.currentTime = C.JulianDate.addSeconds(
          epoch,
          simSeconds,
          new C.JulianDate(),
        );
      };

      // Magenta mask helpers (render + move checks).
      const grabMask = () => {
        const c = scene.canvas;
        const off = document.createElement("canvas");
        off.width = c.width;
        off.height = c.height;
        const cx = off.getContext("2d");
        cx.drawImage(c, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        const mask = new Uint8Array(c.width * c.height);
        let count = 0;
        for (let p = 0; p < mask.length; p++) {
          const i = 4 * p;
          if (d[i] > 150 && d[i + 2] > 150 && d[i + 1] < 90) {
            mask[p] = 1;
            count++;
          }
        }
        return { mask, count };
      };

      // Warm up at a mid time so the pipeline resolves + params upload + first
      // dispatch land before we read back.
      setClock(125.0);
      await renderN(40);

      // (A) RENDER — magenta dots present.
      const renderMask = grabMask();

      // (B) PARITY — for each query time, read each instance's GPU-resident
      // interpolated position back (the same getInstanceWorldPosition path
      // scene.pickPosition uses) and compare to the two CPU references.
      // WebGPU readback is one-frame-stale, so converge per (time, index).
      const eq3 = (a, b) =>
        a &&
        b &&
        Math.abs(a.x - b.x) < 1 &&
        Math.abs(a.y - b.y) < 1 &&
        Math.abs(a.z - b.z) < 1;
      const MAX_CONVERGE = 50;

      const queries = [];
      for (const qt of QUERY_TIMES) {
        setClock(qt);
        // Settle: drive frames so the kernel dispatches at this clock time and
        // (WebGPU) the readback catches up from the previous query's time.
        await renderN(renderer === "webgpu" ? 6 : 2);

        for (let idx = 0; idx < TRACKS.length; idx++) {
          // Reference (i): family pure-JS interpolation.
          const refKernel = family.sample(
            lanesPerInstance[idx],
            qt,
            new C.Cartesian3(),
          );
          // Reference (ii): CPU SampledPositionProperty (linear).
          const refTime = C.JulianDate.addSeconds(
            epoch,
            qt,
            new C.JulianDate(),
          );
          const refProp = sampledProps[idx].getValue(
            refTime,
            new C.Cartesian3(),
          );

          // GPU-resident readback — converge (require the same value twice on
          // WebGPU to reject a stale carry-over from the prior query time).
          let gpuPos = null;
          let kind = "undefined";
          let prev = null;
          for (let i = 0; i < MAX_CONVERGE; i++) {
            const r = collection.getInstanceWorldPosition(
              idx,
              new C.Cartesian3(),
            );
            if (r && typeof r.then === "function") {
              kind = "Promise";
              break;
            }
            const pos =
              r && typeof r.x === "number" && isFinite(r.x)
                ? { x: r.x, y: r.y, z: r.z }
                : null;
            if (pos) {
              if (renderer !== "webgpu") {
                gpuPos = pos;
                kind = "Cartesian3";
                break;
              }
              if (prev && eq3(pos, prev)) {
                gpuPos = pos;
                kind = "Cartesian3";
                break;
              }
              prev = pos;
            }
            await renderFrame();
          }

          const distOf = (a, b) =>
            a && b
              ? Math.sqrt(
                  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2,
                )
              : null;
          const distKernel = distOf(gpuPos, refKernel);
          const distProp = distOf(gpuPos, refProp);
          // Cross-check the two references agree with each other (sanity).
          const refRefDist = distOf(refKernel, refProp);

          queries.push({
            time: qt,
            index: idx,
            kind,
            gpuPos,
            refKernel: { x: refKernel.x, y: refKernel.y, z: refKernel.z },
            refProp: refProp
              ? { x: refProp.x, y: refProp.y, z: refProp.z }
              : null,
            distKernel,
            distProp,
            refRefDist,
            withinKernel: distKernel !== null && distKernel <= POS_TOLERANCE_M,
            withinProp: distProp !== null && distProp <= POS_TOLERANCE_M,
          });
        }
      }

      // (C) MOVE — early time mask vs late time mask differ. Use the two
      // extreme tracks' active spans: t=80 (early) vs t=380 (late).
      setClock(80.0);
      await renderN(8);
      const maskEarly = grabMask();
      setClock(380.0);
      await renderN(8);
      const maskLate = grabMask();
      let changed = 0;
      for (let p = 0; p < maskEarly.mask.length; p++) {
        if (maskEarly.mask[p] !== maskLate.mask[p]) changed++;
      }
      const moveDenom = Math.max(maskEarly.count, maskLate.count, 1);

      return {
        rendererType: scene.context?.rendererType,
        instanceCount: collection.length,
        floatsPerInstance: family.floatsPerInstance,
        renderMagenta: renderMask.count,
        queries,
        moveChanged: changed,
        moveChangedPct: changed / moveDenom,
        maskEarly: maskEarly.count,
        maskLate: maskLate.count,
      };
    },
    { renderer, ANCHOR_X, TRACKS, QUERY_TIMES, POS_TOLERANCE_M },
  );

  await page.close();
  return { ...out, errors };
}

const webgl = await runLeg("webgl");
const webgpu = await runLeg("webgpu");
await browser.close();

function printLeg(name, leg) {
  console.log(`\n=== ${name} (${leg.rendererType}) ===`);
  console.log(
    `instances: ${leg.instanceCount}  floatsPerInstance: ${leg.floatsPerInstance}`,
  );
  console.log(`(A) render magenta px: ${leg.renderMagenta}`);
  for (const q of leg.queries) {
    const g = q.gpuPos
      ? `(${q.gpuPos.x.toFixed(0)},${q.gpuPos.y.toFixed(0)},${q.gpuPos.z.toFixed(0)})`
      : "—";
    console.log(
      `  t=${String(q.time).padStart(6)} idx ${q.index}: kind=${q.kind} gpu=${g} ` +
        `distKernel=${q.distKernel === null ? "—" : q.distKernel.toFixed(1)}m ` +
        `distProp=${q.distProp === null ? "—" : q.distProp.toFixed(1)}m ` +
        `refRef=${q.refRefDist === null ? "—" : q.refRefDist.toFixed(2)}m`,
    );
  }
  console.log(
    `(C) move: early=${leg.maskEarly} late=${leg.maskLate} changed=${leg.moveChanged} (${(leg.moveChangedPct * 100).toFixed(1)}%)`,
  );
  console.log(`(D) console errors: ${leg.errors.length}`);
  leg.errors
    .slice(0, 8)
    .forEach((e) => console.log("   ERR:", e.slice(0, 250)));
}
printLeg("WebGL", webgl);
printLeg("WebGPU", webgpu);

const failures = [];
for (const [name, leg] of [
  ["WebGL", webgl],
  ["WebGPU", webgpu],
]) {
  if (leg.instanceCount !== 3) {
    failures.push(`${name}: expected 3 instances, got ${leg.instanceCount}`);
  }
  // (A) RENDER
  if (!(leg.renderMagenta > 100)) {
    failures.push(
      `${name}: only ${leg.renderMagenta} magenta px (expected > 100) — dots did not render`,
    );
  }
  // (B) PARITY
  for (const q of leg.queries) {
    if (q.kind !== "Cartesian3") {
      failures.push(
        `${name} t=${q.time} idx ${q.index}: readback kind=${q.kind} (expected Cartesian3)`,
      );
      continue;
    }
    if (!q.withinKernel) {
      failures.push(
        `${name} t=${q.time} idx ${q.index}: GPU pos off from family.sample by ` +
          `${q.distKernel?.toFixed(1)}m (> ${POS_TOLERANCE_M}m)`,
      );
    }
    if (!q.withinProp) {
      failures.push(
        `${name} t=${q.time} idx ${q.index}: GPU pos off from SampledPositionProperty by ` +
          `${q.distProp?.toFixed(1)}m (> ${POS_TOLERANCE_M}m)`,
      );
    }
    // The two CPU references must themselves agree (linear == linear).
    if (q.refRefDist !== null && q.refRefDist > 1.0) {
      failures.push(
        `${name} t=${q.time} idx ${q.index}: the two CPU references disagree by ` +
          `${q.refRefDist.toFixed(2)}m — probe reference bug`,
      );
    }
  }
  // (C) MOVE
  if (!(leg.moveChangedPct > 0.2)) {
    failures.push(
      `${name}: dots barely moved (${(leg.moveChangedPct * 100).toFixed(1)}% mask change, expected > 20%)`,
    );
  }
  // (D) ERRORS
  if (leg.errors.length > 0) {
    failures.push(`${name}: ${leg.errors.length} console error(s)`);
  }
}

console.log("");
if (failures.length === 0) {
  console.log(
    "PROBE PASS: SampledPositionKernel interpolates GPU-resident positions to the correct keyframe value on both backends",
  );
  process.exit(0);
} else {
  console.log("PROBE FAIL:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
