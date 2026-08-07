#!/usr/bin/env node
// probe-moon-phase-gate.mjs — C11-176b MOON phaseGate BLACKOUT (WebGPU vs WebGL)
//
// ROOT CAUSE UNDER TEST (C11 queue §1.26/G8; C12-30 suspect (a)):
//   Moon.wgsl used to multiply the whole Phong-lit disc by
//       phaseGate = smoothstep(0.0, 0.3, u.phaseFraction)
//   where phaseFraction = 0.5*(1 - cos(sun-moon elongation)) ~ the
//   illuminated fraction. N·L against the real Simon1994 sun direction
//   ALREADY produces the correct terminator + illuminated fraction, so the
//   gate double-counted phase AND blacked out the entire disc — crescent
//   included — whenever the elongation was small. A daytime moon near the
//   sun (elongation < ~66°, phaseFraction < 0.3) is exactly that
//   configuration: the maintainer's C12-30 screenshot shows it as a dark
//   blob. WebGL (EllipsoidPrimitive + czm_private_phong) has no such term.
//
// THREE LANES, epochs DERIVED in-page from Simon1994PlanetaryPositions (no
// hardcoded lucky dates — the search scans 30 days at 3 h steps from a fixed
// base and picks the first epoch in each phase window; deterministic):
//   day-crescent : phaseFraction in (0.005, 0.09) — sun-moon elongation
//                  < ~28° so at the sub-lunar vantage the sun is > 60° high:
//                  a genuinely-daytime moon. OLD gate multiplier <= ~0.10
//                  (>= 90% blackout of the real crescent) — the defect lane.
//   crescent     : phaseFraction in (0.10, 0.20) — OLD gate ~0.35-0.65,
//                  partial dimming lane.
//   night-full   : phaseFraction in (0.93, 1.0) — sun opposite the moon,
//                  sub-lunar vantage is in night. OLD gate = 1.0 exactly, so
//                  this lane must be at parity BEFORE AND AFTER the fix —
//                  it isolates the phaseGate from any second cause.
//
// MEASUREMENT: the moon disc ROI is found by PROJECTING moonPositionWC (and
// a limb point one lunar radius off-axis) through the camera — no hardcoded
// pixels. Metrics: lit-pixel fraction of the disc area + mean luminance over
// lit pixels. Atmosphere/skybox/globe/sun/fog are hidden so the NS-MOON
// extinction gate yields exactly vec3(1) on both backends (Moon.js:188-204)
// and the phaseGate is the only variable under test. The defect still
// reproduces with the globe hidden because atmosphericConditions (and its
// enableMoonPhase=true default) rides on globe EXISTENCE, not globe.show
// (Scene.js frameState.atmosphericConditions wiring).
//
// PROBE RULES (fleet convention, Batch 744): useDefaultRenderLoop killed;
// EVERY scene.render(t) gets the pinned time; sun-direction settle loop
// (ICRF loads async); canvas capture in the SAME task as a render; canvas
// ELEMENT screenshots; rendererType recorded + hard-fail on mismatch;
// absolute sanity floors so an all-black canvas cannot vacuously pass;
// unref'd force-exit watchdog; try/finally close; bounded loops; hard exit
// codes (0 pass / 1 gate fail / 2 structural). Provenance: source Moon.wgsl
// must be byte-identical to the built copy, and the built JS bundle must not
// contain the deleted gate (stale-build guard, probe-cloud-temporal-rte
// pattern).
//
// Usage: node Tools/visual-regression/probe-moon-phase-gate.mjs
//   (requires the dev server on localhost:8080 and a current gulp build)

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const HARD_LIMIT_MS = 300000;
const watchdog = setTimeout(() => {
  console.error("[probe-moon-phase-gate] WATCHDOG FIRED (300s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

// ── Provenance: the probe must not run against a stale build ────────────────
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function fileFingerprint(p) {
  const bytes = fs.readFileSync(p);
  return {
    path: p.replaceAll("\\", "/"),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}
function provenance() {
  const sourcePath =
    "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl";
  const builtPath =
    "Build/CesiumUnminified/Shaders/WebGPU/Environment/Moon.wgsl";
  const source = fileFingerprint(sourcePath);
  let built = null;
  let exactMatch = false;
  try {
    built = fileFingerprint(builtPath);
    exactMatch = built.sha256 === source.sha256;
  } catch {
    // missing build — structural
  }
  // Stale-bundle guard: no shipped JS may still carry the deleted gate.
  const bundleDir = "Build/CesiumUnminified";
  const candidates = [];
  for (const name of fs.readdirSync(bundleDir)) {
    if (name.endsWith(".js")) candidates.push(path.join(bundleDir, name));
  }
  const chunksDir = path.join(bundleDir, "chunks");
  if (fs.existsSync(chunksDir)) {
    for (const name of fs.readdirSync(chunksDir)) {
      if (name.endsWith(".js")) candidates.push(path.join(chunksDir, name));
    }
  }
  const staleBundleFiles = [];
  for (const file of candidates) {
    if (fs.readFileSync(file, "utf8").includes("let phaseGate")) {
      staleBundleFiles.push(file.replaceAll("\\", "/"));
    }
  }
  const sourceGateDeleted = !fs
    .readFileSync(sourcePath, "utf8")
    .includes("let phaseGate");
  return {
    shaderPair: { source, built, exactMatch },
    sourceGateDeleted,
    staleBundleFiles,
    ok: exactMatch && sourceGateDeleted && staleBundleFiles.length === 0,
  };
}

// ── In-page: derive the three lane epochs from Simon1994 ────────────────────
// Pure ephemeris math, no rendering. Bounded: 241 samples (30 days, 3 h).
const DERIVE_EPOCHS = async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const sunScratch = new C.Cartesian3();
  const moonScratch = new C.Cartesian3();
  const phaseFractionAt = (t) => {
    const sun =
      C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        t,
        sunScratch,
      );
    const moon =
      C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
        t,
        moonScratch,
      );
    const cos =
      C.Cartesian3.dot(sun, moon) /
      (C.Cartesian3.magnitude(sun) * C.Cartesian3.magnitude(moon));
    return 0.5 * (1.0 - cos);
  };
  const base = C.JulianDate.fromIso8601("2026-08-01T00:00:00Z");
  const lanes = {
    "day-crescent": { lo: 0.005, hi: 0.09, iso: null, pf: null },
    crescent: { lo: 0.1, hi: 0.2, iso: null, pf: null },
    "night-full": { lo: 0.93, hi: 1.0, iso: null, pf: null },
  };
  const scratchT = new C.JulianDate();
  for (let i = 0; i <= 240; i++) {
    const t = C.JulianDate.addHours(base, i * 3, scratchT);
    const pf = phaseFractionAt(t);
    for (const lane of Object.values(lanes)) {
      if (lane.iso === null && pf > lane.lo && pf < lane.hi) {
        lane.iso = C.JulianDate.toIso8601(t);
        lane.pf = pf;
      }
    }
  }
  return lanes;
};

// ── In-page: measure one lane ───────────────────────────────────────────────
const MEASURE = async ({ iso, pfWindow }) => {
  // In-page copy of the Node-side r3 helper — this function is serialized
  // into the browser by page.evaluate, so module-scope bindings are not
  // visible here.
  const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;

  // Pinned-clock probe rules: kill the widget loop, render at the pinned
  // time EVERY time, capture in the same task as a render.
  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = C.JulianDate.fromIso8601(iso);
  const T = () => viewer.clock.currentTime;
  scene.requestRenderMode = false;

  // Isolate the moon disc: black background, no stars/atmosphere/globe/sun.
  // Extinction gate: skyAtmosphere hidden => frameState.skyAtmosphereVisible
  // false => extinction is exactly (1,1,1) on BOTH backends. The old
  // phaseGate defect is untouched by this: enableMoonPhase rides on globe
  // EXISTENCE (atmosphericConditions facade), not globe.show.
  scene.backgroundColor = C.Color.BLACK;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.globe) scene.globe.show = false;
  if (scene.fog) scene.fog.enabled = false;
  if (!scene.moon) scene.moon = new C.Moon();
  scene.moon.show = true;

  // Settle loop — ICRF/earth-orientation data loads async; until it lands
  // the sun/moon world directions migrate frame-to-frame. Bounded: <= 180
  // frames, stable when 10 consecutive deltas < 1e-9.
  {
    let prev = null;
    let stableRun = 0;
    for (let i = 0; i < 180 && stableRun < 10; i++) {
      scene.render(T());
      const cur = C.Cartesian3.clone(scene.context.uniformState.sunDirectionWC);
      if (prev && C.Cartesian3.distance(cur, prev) < 1e-9) stableRun++;
      else stableRun = 0;
      prev = cur;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  // Moon world position — same math as Scene/Moon.js.
  const t = T();
  let icrfToFixed = C.Transforms.computeIcrfToFixedMatrix(t, new C.Matrix3());
  let usedIcrf = true;
  if (!icrfToFixed) {
    icrfToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
      t,
      new C.Matrix3(),
    );
    usedIcrf = false;
  }
  const moonPos =
    C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      t,
      new C.Cartesian3(),
    );
  C.Matrix3.multiplyByVector(icrfToFixed, moonPos, moonPos);
  const moonDir = C.Cartesian3.normalize(moonPos, new C.Cartesian3());

  // The phase fraction actually in force this frame (uniformState sun dir
  // vs the moon direction) — must sit inside the lane's window or the lane
  // is structurally invalid.
  const sunDir = scene.context.uniformState.sunDirectionWC;
  const phaseFraction =
    0.5 *
    (1.0 -
      C.Cartesian3.dot(
        moonDir,
        C.Cartesian3.normalize(sunDir, new C.Cartesian3()),
      ));
  const pfInWindow = phaseFraction > pfWindow[0] && phaseFraction < pfWindow[1];

  // Camera: 8000 km from Earth center along the sub-lunar direction, aimed
  // at the moon, narrow FOV so the ~0.5 deg disc spans >~100 px.
  const camPos = C.Cartesian3.multiplyByScalar(
    moonDir,
    8.0e6,
    new C.Cartesian3(),
  );
  const dir = C.Cartesian3.normalize(
    C.Cartesian3.subtract(moonPos, camPos, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const seed =
    Math.abs(dir.z) < 0.9
      ? new C.Cartesian3(0, 0, 1)
      : new C.Cartesian3(1, 0, 0);
  const right = C.Cartesian3.normalize(
    C.Cartesian3.cross(dir, seed, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const up = C.Cartesian3.normalize(
    C.Cartesian3.cross(right, dir, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  scene.camera.setView({
    destination: camPos,
    orientation: { direction: dir, up },
  });
  scene.camera.frustum.fov = C.Math.toRadians(3.0);

  for (let i = 0; i < 12; i++) {
    scene.render(T());
    await new Promise((r) => requestAnimationFrame(r));
  }

  // Project the moon center + a limb point => ROI. No hardcoded pixels.
  scene.render(T());
  const center = C.SceneTransforms.worldToWindowCoordinates(
    scene,
    moonPos,
    new C.Cartesian2(),
  );
  const limbWorld = C.Cartesian3.add(
    moonPos,
    C.Cartesian3.multiplyByScalar(
      up,
      C.Ellipsoid.MOON.maximumRadius,
      new C.Cartesian3(),
    ),
    new C.Cartesian3(),
  );
  const limb = C.SceneTransforms.worldToWindowCoordinates(
    scene,
    limbWorld,
    new C.Cartesian2(),
  );
  if (!center || !limb) {
    return { structuralError: "moon center/limb did not project", iso };
  }
  const rPx = Math.hypot(limb.x - center.x, limb.y - center.y);

  const canvas = scene.canvas;
  const dprX = canvas.width / canvas.clientWidth;
  const dprY = canvas.height / canvas.clientHeight;
  const cx = center.x * dprX;
  const cy = center.y * dprY;
  const rDev = rPx * Math.max(dprX, dprY);
  const half = Math.ceil(rDev * 1.6);
  const x0 = Math.round(cx - half);
  const y0 = Math.round(cy - half);
  const roiValid =
    rDev >= 3 &&
    x0 >= 0 &&
    y0 >= 0 &&
    x0 + 2 * half < canvas.width &&
    y0 + 2 * half < canvas.height;
  if (!roiValid) {
    return { structuralError: `ROI invalid (r=${rDev}px at ${cx},${cy})`, iso };
  }

  // Warm loop — the moon texture (moonSmall.jpg) and the WebGPU pipeline
  // load async; wait (bounded, <= 90 frames) until the disc shows any
  // non-black pixel. A defect-blackout lane can legitimately stay ~black:
  // the cap expiring is NOT structural — measurement proceeds.
  {
    const probeCanvas = document.createElement("canvas");
    probeCanvas.width = 9;
    probeCanvas.height = 9;
    const probeCtx = probeCanvas.getContext("2d");
    for (let i = 0; i < 90; i++) {
      scene.render(T());
      probeCtx.drawImage(
        canvas,
        Math.round(cx) - 4,
        Math.round(cy) - 4,
        9,
        9,
        0,
        0,
        9,
        9,
      );
      const px = probeCtx.getImageData(0, 0, 9, 9).data;
      let anyLit = false;
      for (let p = 0; p < px.length; p += 4) {
        if (px[p] > 2 || px[p + 1] > 2 || px[p + 2] > 2) {
          anyLit = true;
          break;
        }
      }
      if (anyLit) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  // SAME-TASK capture: render, then drawImage with no await in between
  // (the WebGPU drawing buffer is cleared once the compositor consumes a
  // presented frame).
  scene.render(T());
  const tmp = document.createElement("canvas");
  tmp.width = 2 * half + 1;
  tmp.height = 2 * half + 1;
  const ctx = tmp.getContext("2d");
  ctx.drawImage(
    canvas,
    x0,
    y0,
    tmp.width,
    tmp.height,
    0,
    0,
    tmp.width,
    tmp.height,
  );
  const data = ctx.getImageData(0, 0, tmp.width, tmp.height).data;

  // Disc statistics: pixels inside 1.05*r of the projected center.
  const discR2 = rDev * 1.05 * (rDev * 1.05);
  let discPx = 0;
  let litPx = 0;
  let lumSum = 0;
  let litLumSum = 0;
  let maxLum = 0;
  let outsideSum = 0;
  let outsidePx = 0;
  for (let y = 0; y < tmp.height; y++) {
    for (let x = 0; x < tmp.width; x++) {
      const i = 4 * (y * tmp.width + x);
      const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const dx = x - half;
      const dy = y - half;
      if (dx * dx + dy * dy <= discR2) {
        discPx++;
        lumSum += l;
        if (l > maxLum) maxLum = l;
        if (l > 8) {
          litPx++;
          litLumSum += l;
        }
      } else if (dx * dx + dy * dy >= discR2 * 1.44) {
        outsidePx++;
        outsideSum += l;
      }
    }
  }

  return {
    iso,
    rendererType: scene.context.rendererType,
    usedIcrf,
    phaseFraction,
    pfInWindow,
    enableMoonPhase:
      scene.globe && scene.globe.atmosphericConditions
        ? scene.globe.atmosphericConditions.lighting.enableMoonPhase
        : null,
    moonWindowPos: { x: r3(cx), y: r3(cy) },
    discRadiusPx: r3(rDev),
    discPx,
    litPx,
    litFrac: discPx > 0 ? litPx / discPx : 0,
    meanLum: discPx > 0 ? lumSum / discPx : 0,
    meanLumLit: litPx > 0 ? litLumSum / litPx : 0,
    maxLum,
    backgroundMean: outsidePx > 0 ? outsideSum / outsidePx : 0,
  };
};

async function runBackend(browser, renderer, lanes) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text().slice(0, 200));
  });
  const out = { renderer, lanes: {}, consoleErrors: errs };
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      },
    );
    await page.waitForFunction(
      () =>
        !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      { timeout: 90000 },
    );
    await page.waitForTimeout(4000);
    for (const [name, lane] of Object.entries(lanes)) {
      const stats = await page.evaluate(MEASURE, {
        iso: lane.iso,
        pfWindow: [lane.lo, lane.hi],
      });
      out.lanes[name] = stats;
      // Canvas ELEMENT screenshot (not the page).
      const canvasHandle = await page.$("canvas");
      if (canvasHandle) {
        await canvasHandle.screenshot({
          path: path.join(OUT_DIR, `moon-phase-gate-${name}-${renderer}.png`),
        });
      }
      // HARD backend check — a lane measured on the wrong backend is void.
      if (stats && stats.rendererType && stats.rendererType !== renderer) {
        out.backendMismatch = `requested ${renderer}, got ${stats.rendererType}`;
      }
    }
    return out;
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 300);
    return out;
  } finally {
    await context.close().catch(() => {});
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const prov = provenance();
  if (!prov.ok) {
    console.error(
      "[probe-moon-phase-gate] PROVENANCE FAILURE — stale or missing build:",
      JSON.stringify(prov, null, 2),
    );
    process.exit(2);
  }

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let lanes, gl, gpu;
  try {
    // Derive the three epochs once (pure ephemeris math, deterministic).
    const derivePage = await (await browser.newContext()).newPage();
    await derivePage.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`,
      {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      },
    );
    lanes = await derivePage.evaluate(DERIVE_EPOCHS);
    await derivePage
      .context()
      .close()
      .catch(() => {});
    for (const [name, lane] of Object.entries(lanes)) {
      if (!lane.iso) {
        console.error(
          `[probe-moon-phase-gate] no epoch found for lane ${name}`,
        );
        process.exit(2);
      }
      console.log(`lane ${name}: ${lane.iso} (phaseFraction ${r3(lane.pf)})`);
    }

    gl = await runBackend(browser, "webgl", lanes);
    gpu = await runBackend(browser, "webgpu", lanes);
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  // Sanity floors: the WebGL reference lane must be non-vacuous (an all-black
  // canvas or an off-screen ROI must not pass anything).
  const FLOORS = {
    "day-crescent": { litFrac: 0.005, meanLumLit: 20 },
    crescent: { litFrac: 0.02, meanLumLit: 20 },
    "night-full": { litFrac: 0.55, meanLumLit: 30 },
  };
  const laneVerdicts = {};
  let structural = !!(
    gl.error ||
    gpu.error ||
    gl.backendMismatch ||
    gpu.backendMismatch
  );
  let anyFail = false;
  for (const name of Object.keys(lanes)) {
    const a = gl.lanes[name];
    const b = gpu.lanes[name];
    const v = { lane: name, iso: lanes[name].iso };
    // LATENT VACUITY, closed 2026-08-07 (NEW-PROBE-VACUOUS-REACHABILITY-
    // ASSERTION item 5). `enableMoonPhase` was read into the manifest and never
    // gated. `Moon.js:360-363` pins `phaseFraction = 1.0` when it is false, at
    // which point the historical gate evaluates to 1.0 on every lane and ALL
    // THREE lanes pass with the defect unobservable. The default is currently
    // safe (`AtmosphericConditions.js:463`), so this changes no verdict at
    // HEAD — it is the one default flip away from a fleet-wide false green, and
    // a flag whose value is printed but not asserted is exactly the shape this
    // class exists to close. Read from the settled frame each lane rendered,
    // not from setup, and it escalates to STRUCTURAL rather than FAIL: a lane
    // that cannot host its subject is blind, not broken.
    const phaseEnabled = (leg) =>
      leg && leg.enableMoonPhase === false ? "enableMoonPhase is OFF" : null;
    if (
      !a ||
      !b ||
      a.structuralError ||
      b.structuralError ||
      !a.pfInWindow ||
      !b.pfInWindow ||
      phaseEnabled(a) ||
      phaseEnabled(b)
    ) {
      v.structural = {
        webgl: a
          ? (phaseEnabled(a) ??
            a.structuralError ??
            (a.pfInWindow ? null : "pf outside window"))
          : "missing",
        webgpu: b
          ? (phaseEnabled(b) ??
            b.structuralError ??
            (b.pfInWindow ? null : "pf outside window"))
          : "missing",
      };
      structural = true;
      laneVerdicts[name] = v;
      continue;
    }
    const floors = FLOORS[name];
    const backgroundClean = a.backgroundMean < 2 && b.backgroundMean < 2;
    const referenceSane =
      a.litFrac >= floors.litFrac &&
      a.meanLumLit >= floors.meanLumLit &&
      a.meanLumLit <= 255;
    const litFracRatio = a.litFrac > 0 ? b.litFrac / a.litFrac : null;
    const meanLumLitRatio =
      a.meanLumLit > 0 ? b.meanLumLit / a.meanLumLit : null;
    const blackoutDetected = litFracRatio !== null && litFracRatio < 0.3;
    const parityOk =
      litFracRatio !== null &&
      meanLumLitRatio !== null &&
      litFracRatio > 0.7 &&
      litFracRatio < 1.35 &&
      meanLumLitRatio > 0.7 &&
      meanLumLitRatio < 1.4;
    Object.assign(v, {
      phaseFraction: r3(a.phaseFraction),
      webgl: {
        litFrac: r3(a.litFrac),
        meanLumLit: r3(a.meanLumLit),
        discRadiusPx: a.discRadiusPx,
      },
      webgpu: {
        litFrac: r3(b.litFrac),
        meanLumLit: r3(b.meanLumLit),
        discRadiusPx: b.discRadiusPx,
      },
      litFracRatio: r3(litFracRatio),
      meanLumLitRatio: r3(meanLumLitRatio),
      backgroundClean,
      referenceSane,
      blackoutDetected,
      parityOk,
      PASS: backgroundClean && referenceSane && parityOk && !blackoutDetected,
    });
    if (!referenceSane || !backgroundClean) structural = true;
    if (!v.PASS) anyFail = true;
    laneVerdicts[name] = v;
  }

  const GATE = structural
    ? "STRUCTURAL — a lane never reached a valid measurement"
    : anyFail
      ? "FAIL — phaseGate blackout (or parity drift) present"
      : "PASS — moon lit fraction follows real phase geometry on both backends in all 3 lanes";

  const manifest = {
    probe: "probe-moon-phase-gate",
    task: "C11-176b",
    date: new Date().toISOString(),
    provenance: prov,
    lanes: laneVerdicts,
    GATE,
    raw: { gl, gpu },
  };
  const outPath = path.join(OUT_DIR, "moon-phase-gate.json");
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ lanes: laneVerdicts, GATE }, null, 2));
  console.log(`\n[full report: ${outPath}]`);

  const exitCode = structural ? 2 : anyFail ? 1 : 0;
  console.log(`EXIT: ${exitCode}`);
  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-moon-phase-gate] FATAL", e);
  process.exit(2);
});
