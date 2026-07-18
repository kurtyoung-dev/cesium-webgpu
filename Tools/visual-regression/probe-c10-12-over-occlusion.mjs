#!/usr/bin/env node
/**
 * C10-12 over-occlusion guard — the load-bearing check for the pick-depth-plane
 * gate flip.
 *
 * The Run-1 failure (2026-07-16) was a log depth-plane over a HYPERBOLIC pick
 * fleet OVER-OCCLUDING every visible pick across the globe disk. Now the fleet
 * is uniformly log (C10-11), so the plane must occlude ONLY beyond-limb picks
 * and NEVER drop a legitimately-visible one.
 *
 * A grid of OPAQUE points sits +250 m above the ellipsoid across the VISIBLE
 * face (central angles well inside the geometric horizon). At each of 20/500/
 * 5,000 km nadir cameras we measure the visible-face pick hit-rate with the
 * depth-plane pick draw ACTIVE (plane-on = C10-12 default) vs SKIPPED
 * (plane-off = the C10-11 baseline), toggled at runtime via the same
 * updateAndClearFramebuffers/debugSkipDepthPlane bridge the horizon oracle uses.
 *
 * PASS = plane-on hit-rate >= plane-off hit-rate at every altitude (the flip
 * drops NO legitimate visible pick), and plane-off is itself ~100%.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const outputPath = resolve(
  toolDirectory,
  "output",
  "performance",
  "campaign10-c10-12-over-occlusion.json",
);

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 180));
});
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message.slice(0, 160)}`));

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "load",
  timeout: 90000,
});
await page.waitForFunction(
  () => globalThis.viewer?.scene?._frameState?.frameNumber > 0,
  undefined,
  { timeout: 90000 },
);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = globalThis.viewer;
  const scene = viewer.scene;
  const ctx = scene.context;
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  scene.highDynamicRange = false;
  scene.msaaSamples = 1;
  scene.taaEnabled = false;
  scene.logarithmicDepthBuffer = true;
  scene.globe.show = true;
  scene.globe.depthTestAgainstTerrain = false;
  viewer.terrainProvider = new C.EllipsoidTerrainProvider({
    ellipsoid: C.Ellipsoid.WGS84,
  });

  // Bridge the debug skip to the final WebGPU config seam (same as the horizon
  // oracle): updateAndClearFramebuffers recomputes useDepthPlane without the
  // debug term, so force it off when debugSkipDepthPlane is set. This lets us
  // A/B the depth-plane PICK draw at runtime on one build.
  const originalUpdateAndClear = ctx.updateAndClearFramebuffers;
  ctx.updateAndClearFramebuffers = function (...args) {
    const handled = originalUpdateAndClear.apply(this, args);
    if (args[0]?.debugSkipDepthPlane === true) {
      args[0]._environmentState.useDepthPlane = false;
    }
    return handled;
  };

  const renderN = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render(viewer.clock.currentTime);
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  const project = (position) => {
    const w = C.SceneTransforms.worldToWindowCoordinates(scene, position);
    return w ? new C.Cartesian2(Math.round(w.x), Math.round(w.y)) : undefined;
  };
  const pickStable = async (win) => {
    if (!win) return undefined;
    let last;
    for (let i = 0; i < 8; i++) {
      scene.render(viewer.clock.currentTime);
      const r = await scene.pickAsync(win, 5, 5);
      if (C.defined(r)) return r;
      last = r;
      await new Promise((rr) => requestAnimationFrame(rr));
    }
    return last;
  };

  const radius = C.Ellipsoid.WGS84.maximumRadius;
  const altitudes = [
    { label: "near", h: 20_000 },
    { label: "middle", h: 500_000 },
    { label: "far", h: 5_000_000 },
  ];
  // 13 visible-face points: sub-camera center + 3 rings of 4. Ring offsets are
  // scaled to the on-screen ground extent (altitude * tan(fov/2)) so points
  // stay on-canvas AND well inside the limb at every altitude (a horizon-angle
  // fraction would push the low-altitude rings off the narrow nadir FOV).
  const ringFractions = [0.0, 0.25, 0.5, 0.7];
  const fovHalf = (scene.camera.frustum.fov ?? C.Math.toRadians(60)) / 2;
  const results = [];

  for (const alt of altitudes) {
    const horizonAngle = Math.acos(radius / (radius + alt.h));
    const groundHalfExtent = alt.h * Math.tan(fovHalf); // meters at nadir
    const points = new C.PointPrimitiveCollection();
    points.blendOption = C.BlendOption.OPAQUE;
    const specs = [];
    let idx = 0;
    for (const frac of ringFractions) {
      const bearings = frac === 0 ? [0] : [0, 90, 180, 270];
      for (const bearingDeg of bearings) {
        // ground offset -> central angle (small-angle: d / R), capped safely
        // inside the geometric horizon.
        const ang = Math.min(
          (groundHalfExtent * frac) / radius,
          horizonAngle * 0.85,
        );
        const b = C.Math.toRadians(bearingDeg);
        // offset the sub-camera point (lon 0, lat 0) by central angle `ang`
        // along bearing `b`
        const lat = Math.asin(Math.cos(ang) * 0 + Math.sin(ang) * Math.cos(b));
        const lon = Math.atan2(
          Math.sin(b) * Math.sin(ang),
          Math.cos(ang),
        );
        const id = `vf-${idx++}`;
        points.add({
          id,
          position: C.Cartesian3.fromRadians(lon, lat, 250),
          color: C.Color.CYAN,
          pixelSize: 26,
          disableDepthTestDistance: 0, // MUST respect depth vs the pick FBO
        });
        specs.push({ id, lon, lat });
      }
    }
    scene.primitives.add(points);

    scene.camera.setView({
      destination: C.Cartesian3.fromRadians(0, 0, alt.h),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
    });
    await renderN(30);

    const measure = async (skip) => {
      scene.debugSkipDepthPlane = skip;
      await renderN(8);
      let onCanvas = 0;
      let hits = 0;
      const misses = [];
      for (let i = 0; i < specs.length; i++) {
        const pos = points.get(i).position;
        const win = project(pos);
        const inView =
          win &&
          win.x >= 6 &&
          win.y >= 6 &&
          win.x < scene.canvas.width - 6 &&
          win.y < scene.canvas.height - 6;
        if (!inView) continue;
        onCanvas++;
        const r = await pickStable(win);
        const pid = C.defined(r)
          ? typeof r.id === "string"
            ? r.id
            : r.id?.id
          : undefined;
        if (pid === specs[i].id) hits++;
        else misses.push({ id: specs[i].id, got: pid ?? null });
      }
      return { onCanvas, hits, misses };
    };

    const planeOff = await measure(true); // C10-11 baseline (plane skipped)
    const planeOn = await measure(false); // C10-12 default (plane active)
    scene.debugSkipDepthPlane = false;

    scene.primitives.remove(points);
    results.push({
      label: alt.label,
      heightMeters: alt.h,
      horizonAngleDeg: C.Math.toDegrees(horizonAngle),
      pointCount: specs.length,
      planeOff,
      planeOn,
    });
  }

  return { renderer: scene.context.rendererType, results };
});

await browser.close();

const failures = [];
if (out.renderer !== "webgpu") failures.push(`renderer=${out.renderer}`);
for (const r of out.results) {
  // plane-off (baseline) should pick essentially everything visible
  if (r.planeOff.hits < r.planeOff.onCanvas) {
    failures.push(
      `${r.label}: plane-off baseline missed visible picks (${r.planeOff.hits}/${r.planeOff.onCanvas})`,
    );
  }
  // the load-bearing check: turning the plane ON must not DROP any visible pick
  if (r.planeOn.hits < r.planeOff.hits) {
    failures.push(
      `${r.label}: OVER-OCCLUSION — plane-on dropped visible picks (${r.planeOn.hits} on vs ${r.planeOff.hits} off)`,
    );
  }
}
if (errors.length) failures.push(`${errors.length} console errors`);

const report = {
  kind: "c10-12-over-occlusion-guard",
  generatedAt: new Date().toISOString(),
  result: failures.length ? "fail" : "pass",
  failures,
  errors,
  ...out,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      result: report.result,
      failures,
      table: out.results.map((r) => ({
        alt: r.label,
        onCanvas: r.planeOn.onCanvas,
        planeOff_hits: r.planeOff.hits,
        planeOn_hits: r.planeOn.hits,
        planeOn_misses: r.planeOn.misses,
      })),
    },
    null,
    2,
  ),
);
process.exitCode = report.result === "pass" ? 0 : 1;
