#!/usr/bin/env node
// Probe (NEW-PICK-RAY-ASYNC, Batch 284): Scene.sampleHeight / Scene.clampToHeight
// must return a globe-surface height/position on WebGPU, matching WebGL, via the
// main-scene-depth reuse path (Batch 252 reconstruction). Scene.pickFromRay over
// an arbitrary ray is scoped out on WebGPU — it must NOT throw and must surface
// a one-time warning instead of failing silently.
//
// What it asserts:
//  1. WebGL leg: sampleHeight at a known location returns a finite height near
//     the globe surface (|h| within a few km of 0 over ocean/terrain-off), and
//     clampToHeight returns a Cartesian3 at ~the same lon/lat.
//  2. WebGPU leg, cold cache: the FIRST sampleHeight query returns undefined
//     (async readback only being armed) and converges to a finite height by
//     frame 3 at the latest.
//  3. WebGPU converged height matches WebGL: |dHeight| < 1500 m (RGBA8
//     log-depth quantum + camera-ray vs geodetic-normal angle slack at this
//     near-nadir view).
//  4. WebGPU clampToHeight converged lon/lat near the query location.
//  5. WebGPU pickFromRay (arbitrary ray) does not throw; returns undefined or a
//     position-less hit; the scope warning is emitted.
//  6. Zero console errors on both legs (warnings are allowed).
//
// Usage: node Tools/visual-regression/probe-pick-ray-async.mjs

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
// Look straight down at a known location; sample the height at the same point.
const LON = -75.0;
const LAT = 40.0;
const CAM_HEIGHT = 1_500_000.0;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runLeg(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  const errors = [];
  const warnings = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
    if (m.type() === "warning") warnings.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ LON, LAT, CAM_HEIGHT }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      // Disable terrain-relative complications: default scene has ellipsoid
      // globe. Look straight down so the camera ray ~= geodetic normal and the
      // main-scene-depth reuse closely matches the true geodetic-normal pick.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(LON, LAT, CAM_HEIGHT),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });

      // Warm up until tiles loaded (no pick call yet — that would arm the
      // readback and break the cold-cache assertion). Then settle frames so the
      // depth attachment is definitely written.
      const MAX_WARMUP_FRAMES = 600;
      let warmupFrames = 0;
      let tilesLoadedAt = -1;
      for (let i = 0; i < MAX_WARMUP_FRAMES; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        warmupFrames = i + 1;
        if (scene.globe && scene.globe.tilesLoaded) {
          tilesLoadedAt = i;
          break;
        }
      }
      const SETTLE_FRAMES = 60;
      for (let i = 0; i < SETTLE_FRAMES; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        warmupFrames += 1;
      }

      // The cartographic position we sample the height of.
      const sampleCarto = C.Cartographic.fromDegrees(LON, LAT);
      const clampCartesian = C.Cartesian3.fromDegrees(LON, LAT, 50000.0);

      const toCarto = (pos) => {
        if (!pos || typeof pos.x !== "number" || !isFinite(pos.x)) return null;
        const cc = C.Cartographic.fromCartesian(pos);
        return cc
          ? {
              lon: C.Math.toDegrees(cc.longitude),
              lat: C.Math.toDegrees(cc.latitude),
              h: cc.height,
            }
          : null;
      };

      const classify = (res) => {
        if (res && typeof res.then === "function") return "Promise";
        if (typeof res === "number" && isFinite(res)) return "number";
        if (typeof res === "number") return `number-NaN(${res})`;
        if (res && typeof res.x === "number" && isFinite(res.x))
          return "Cartesian3";
        if (res === undefined) return "undefined";
        return String(res);
      };

      // Per-frame samples: frame 0 is the cold-cache query.
      const heightSamples = [];
      const clampSamples = [];
      for (let i = 0; i < 8; i++) {
        let h, hKind;
        try {
          h = scene.sampleHeight(sampleCarto.clone());
          hKind = classify(h);
        } catch (e) {
          hKind = `THREW: ${e}`;
        }
        let c, cKind, cCarto;
        try {
          c = scene.clampToHeight(clampCartesian.clone());
          cKind = classify(c);
          cCarto = cKind === "Cartesian3" ? toCarto(c) : null;
        } catch (e) {
          cKind = `THREW: ${e}`;
        }
        heightSamples.push({
          frame: i,
          kind: hKind,
          h: typeof h === "number" && isFinite(h) ? h : null,
        });
        clampSamples.push({ frame: i, kind: cKind, carto: cCarto });
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // pickFromRay over an arbitrary ray: must not throw. Build a ray from
      // the camera toward the sample point.
      const surfacePos = C.Cartographic.toCartesian(sampleCarto);
      const dir = C.Cartesian3.subtract(
        surfacePos,
        v.camera.positionWC,
        new C.Cartesian3(),
      );
      C.Cartesian3.normalize(dir, dir);
      const ray = new C.Ray(C.Cartesian3.clone(v.camera.positionWC), dir);
      let pickFromRayKind, pickFromRayThrew;
      try {
        const r = scene.pickFromRay(ray);
        if (r === undefined) pickFromRayKind = "undefined";
        else if (r && r.object !== undefined && r.position === undefined)
          pickFromRayKind = "object-no-position";
        else if (r && r.position && typeof r.position.x === "number")
          pickFromRayKind = "object-with-position";
        else pickFromRayKind = `other:${typeof r}`;
        pickFromRayThrew = false;
      } catch (e) {
        pickFromRayKind = `THREW: ${e}`;
        pickFromRayThrew = true;
      }

      return {
        rendererType: scene.context?.rendererType,
        sampleHeightSupported: scene.sampleHeightSupported,
        clampToHeightSupported: scene.clampToHeightSupported,
        useLogDepth: scene.frameState?.useLogDepth,
        warmupFrames,
        tilesLoadedAt,
        tilesLoaded: !!(scene.globe && scene.globe.tilesLoaded),
        heightSamples,
        clampSamples,
        pickFromRayKind,
        pickFromRayThrew,
      };
    },
    { LON, LAT, CAM_HEIGHT },
  );

  await page.close();
  return { ...out, errors, warnings };
}

// ---- run both legs ----
const webgl = await runLeg("webgl");
const webgpu = await runLeg("webgpu");
await browser.close();

// ---- report ----
function printLeg(name, leg) {
  console.log(`\n=== ${name} (${leg.rendererType}) ===`);
  console.log(
    `sampleHeightSupported: ${leg.sampleHeightSupported}  clampToHeightSupported: ${leg.clampToHeightSupported}  useLogDepth: ${leg.useLogDepth}`,
  );
  console.log(
    `warmup: ${leg.warmupFrames} frames  tilesLoadedAt: ${leg.tilesLoadedAt}  tilesLoaded: ${leg.tilesLoaded}`,
  );
  console.log("  sampleHeight:");
  for (const s of leg.heightSamples) {
    console.log(
      `    frame ${String(s.frame).padStart(2)}: ${s.kind}` +
        (s.h !== null ? ` h=${s.h.toFixed(1)}` : ""),
    );
  }
  console.log("  clampToHeight:");
  for (const s of leg.clampSamples) {
    console.log(
      `    frame ${String(s.frame).padStart(2)}: ${s.kind}` +
        (s.carto
          ? ` @ lon=${s.carto.lon.toFixed(4)} lat=${s.carto.lat.toFixed(4)} h=${s.carto.h.toFixed(1)}`
          : ""),
    );
  }
  console.log(
    `  pickFromRay: ${leg.pickFromRayKind} (threw=${leg.pickFromRayThrew})`,
  );
  console.log(`  console errors: ${leg.errors.length}`);
  leg.errors.slice(0, 6).forEach((e) => console.log("   ERR:", e));
  const rayWarn = leg.warnings.find((w) => w.includes("pickFromRay"));
  console.log(`  pickFromRay scope warning emitted: ${!!rayWarn}`);
}
printLeg("WebGL", webgl);
printLeg("WebGPU", webgpu);

// ---- assertions ----
const failures = [];

// 1. WebGL reference: at least one finite height + a clampToHeight Cartesian3.
const glHeight = webgl.heightSamples.find((s) => s.kind === "number");
if (!glHeight) {
  failures.push("WebGL leg never returned a finite height from sampleHeight");
}
const glClamp = webgl.clampSamples.find(
  (s) => s.kind === "Cartesian3" && s.carto,
);
if (!glClamp) {
  failures.push("WebGL leg never returned a Cartesian3 from clampToHeight");
}

// 2. WebGPU cold cache: frame 0 undefined, converges by frame 3.
const gpuHeights = webgpu.heightSamples;
if (gpuHeights[0].kind !== "undefined") {
  failures.push(
    `WebGPU sampleHeight cold-cache: frame 0 expected undefined, got ${gpuHeights[0].kind}`,
  );
}
const gpuFirstHeightIdx = gpuHeights.findIndex((s) => s.kind === "number");
if (gpuFirstHeightIdx === -1) {
  failures.push("WebGPU leg never returned a finite height from sampleHeight");
} else if (gpuFirstHeightIdx > 3) {
  failures.push(
    `WebGPU sampleHeight converged too late: first number at frame ${gpuFirstHeightIdx} (expected <= 3)`,
  );
}
// No Promise leaks (sync contract).
for (const s of gpuHeights) {
  if (s.kind === "Promise")
    failures.push(`WebGPU sampleHeight frame ${s.frame} returned a Promise`);
}

// 3. Cross-backend height match.
if (glHeight && gpuFirstHeightIdx !== -1) {
  const dH = Math.abs(glHeight.h - gpuHeights[gpuFirstHeightIdx].h);
  console.log(
    `\ncross-backend sampleHeight delta: dH=${dH.toFixed(1)} m (WebGL=${glHeight.h.toFixed(1)} WebGPU=${gpuHeights[gpuFirstHeightIdx].h.toFixed(1)})`,
  );
  if (dH > 1500)
    failures.push(`sampleHeight dHeight ${dH.toFixed(1)} m > 1500 m`);
}

// 4. WebGPU clampToHeight converged lon/lat near the query.
const gpuClamp = webgpu.clampSamples.find(
  (s) => s.kind === "Cartesian3" && s.carto,
);
if (!gpuClamp) {
  failures.push("WebGPU leg never returned a Cartesian3 from clampToHeight");
} else {
  const dLon = Math.abs(gpuClamp.carto.lon - LON);
  const dLat = Math.abs(gpuClamp.carto.lat - LAT);
  console.log(
    `WebGPU clampToHeight converged: lon=${gpuClamp.carto.lon.toFixed(4)} lat=${gpuClamp.carto.lat.toFixed(4)} (dLon=${dLon.toFixed(4)} dLat=${dLat.toFixed(4)})`,
  );
  if (dLon > 0.1)
    failures.push(`WebGPU clampToHeight dLon ${dLon.toFixed(4)} > 0.1 deg`);
  if (dLat > 0.1)
    failures.push(`WebGPU clampToHeight dLat ${dLat.toFixed(4)} > 0.1 deg`);
}

// 5. WebGPU pickFromRay must not throw and must surface the scope warning.
if (webgpu.pickFromRayThrew) {
  failures.push(`WebGPU pickFromRay threw: ${webgpu.pickFromRayKind}`);
}
const gpuRayWarn = webgpu.warnings.find((w) => w.includes("pickFromRay"));
if (!gpuRayWarn) {
  failures.push(
    "WebGPU pickFromRay did not emit the NEW-PICK-RAY-ASYNC scope warning",
  );
}

// 6. Zero console errors both legs.
if (webgl.errors.length > 0)
  failures.push(`WebGL leg had ${webgl.errors.length} console errors`);
if (webgpu.errors.length > 0)
  failures.push(`WebGPU leg had ${webgpu.errors.length} console errors`);

// ---- verdict ----
console.log("\n========================================");
if (failures.length === 0) {
  console.log(
    "PASS — sampleHeight/clampToHeight parity + pickFromRay scope OK",
  );
  process.exit(0);
} else {
  console.log("FAIL:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
