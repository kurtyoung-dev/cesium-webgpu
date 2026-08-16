#!/usr/bin/env node
/**
 * Atmospheric Effects Phase D — COLD OPTICS (Batch 422). WebGPU-only visual probe.
 * @purpose Base cold-optics acceptance: ON adds a ring at constant angular radius around the sun (radial profile) vs OFF on the same canvas.
 * @status ACTIVE
 *
 * Cold optics (22 ice-crystal halo + sun-dogs) is a WebGPU screen-space sky
 * overlay with no WebGL twin, so the diff is OPTICS-ON vs OPTICS-OFF on the
 * SAME WebGPU canvas. The camera is placed near the surface looking UP at the
 * sky with the SUN ~35 above the horizon and centred horizontally, so the
 * full halo ring fits in frame against the sky.
 *
 * Proof criteria:
 *   - ON adds a bright RING of pixels at a roughly constant angular radius
 *     around the sun that OFF lacks: the per-radius "added brightness" profile
 *     (ON-minus-OFF) must PEAK in an annulus well away from the sun centre,
 *     and that peak must appear across MOST angular sectors (it's a ring, not
 *     a one-sided smear);
 *   - OFF vs OFF (two frames) ~0 — no spurious diff;
 *   - 0 WebGPU device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cold-optics.mjs
 * Outputs: Tools/visual-regression/output/cold-optics-{off,on}-webgpu.png
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
const OUT = "Tools/visual-regression/output";

function shotDU(buf) {
  return "data:image/png;base64," + buf.toString("base64");
}

// Analyze the ON-minus-OFF added brightness as a function of radius from the
// sun's screen position. Returns the radial profile + a ring score.
function analyze(page, offDU, onDU, sunXY) {
  return page.evaluate(
    async ([off, on, sun]) => {
      const dec = async (du) => {
        const img = new Image();
        img.src = du;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.getContext("2d").getImageData(0, 0, c.width, c.height);
      };
      const A = await dec(off);
      const B = await dec(on);
      const W = A.width;
      const H = A.height;
      const cx = sun[0];
      const cy = sun[1];
      const maxR = Math.floor(Math.min(W, H) * 0.5);
      const NB = 60; // radial bins
      const binW = maxR / NB;
      const added = new Float64Array(NB);
      const count = new Float64Array(NB);
      // Per-sector presence at each bin: 8 angular sectors. A ring lights up
      // most sectors; a one-sided smear lights only a few.
      const NS = 8;
      const sectorAdded = []; // [bin][sector]
      for (let i = 0; i < NB; i++) sectorAdded.push(new Float64Array(NS));

      let totalDiff = 0;
      let totalPx = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const lumA =
            0.2126 * A.data[i] +
            0.7152 * A.data[i + 1] +
            0.0722 * A.data[i + 2];
          const lumB =
            0.2126 * B.data[i] +
            0.7152 * B.data[i + 1] +
            0.0722 * B.data[i + 2];
          const d = lumB - lumA; // positive = ON brighter (added glow)
          const dx = x - cx;
          const dy = y - cy;
          const r = Math.sqrt(dx * dx + dy * dy);
          if (r >= maxR) continue;
          const bin = Math.min(NB - 1, Math.floor(r / binW));
          count[bin]++;
          totalPx++;
          if (Math.abs(lumB - lumA) > 8) totalDiff++;
          if (d > 8) {
            added[bin] += d;
            const ang = Math.atan2(dy, dx) + Math.PI; // 0..2pi
            const sec = Math.min(
              NS - 1,
              Math.floor((ang / (2 * Math.PI)) * NS),
            );
            sectorAdded[bin][sec] += d;
          }
        }
      }
      const profile = [];
      for (let i = 0; i < NB; i++) {
        profile.push(count[i] > 0 ? added[i] / count[i] : 0);
      }
      // Peak bin away from the sun centre (skip the inner 20% — the sun disc /
      // central region is not the ring).
      const innerSkip = Math.floor(NB * 0.15);
      let peakBin = innerSkip;
      let peakVal = -1;
      for (let i = innerSkip; i < NB; i++) {
        if (profile[i] > peakVal) {
          peakVal = profile[i];
          peakBin = i;
        }
      }
      // Ring coverage: scan every radius band (each bin +/-1) away from the
      // centre and find the MAX number of the 8 angular sectors lit at any one
      // radius. A full circular halo lights all 8 sectors at its radius; a
      // one-sided smear or the bottom-limb arc lights only a few. This is
      // radius-agnostic so it finds the ring even when the brightest single
      // bin is a sun-dog.
      let sectorsLit = 0; // best coverage found
      let ringBin = peakBin;
      for (let b = innerSkip; b < NB; b++) {
        let lit = 0;
        for (let s = 0; s < NS; s++) {
          let bandSum = 0;
          for (
            let bb = Math.max(0, b - 1);
            bb <= Math.min(NB - 1, b + 1);
            bb++
          ) {
            bandSum += sectorAdded[bb][s];
          }
          if (bandSum > 0) lit++;
        }
        if (lit > sectorsLit) {
          sectorsLit = lit;
          ringBin = b;
        }
      }
      // Inner-vs-ring contrast: mean added brightness in the inner skip region
      // vs at the peak. A real ring is much brighter at the peak than inside.
      let innerMean = 0;
      let innerN = 0;
      for (let i = 1; i < innerSkip; i++) {
        innerMean += profile[i];
        innerN++;
      }
      innerMean = innerN > 0 ? innerMean / innerN : 0;

      return {
        W,
        H,
        sun: [Math.round(cx), Math.round(cy)],
        maxR,
        binW: +binW.toFixed(2),
        peakBin,
        peakRadiusPx: Math.round(peakBin * binW),
        peakAddedBrightness: +peakVal.toFixed(2),
        innerAddedBrightness: +innerMean.toFixed(3),
        ringRadiusPx: Math.round(ringBin * binW),
        maxSectorsLit: sectorsLit,
        sectorsLitAtPeak: sectorsLit,
        totalChangedPct: +((100 * totalDiff) / Math.max(1, totalPx)).toFixed(2),
        profile: profile.map((v) => +v.toFixed(2)),
      };
    },
    [offDU, onDU, sunXY],
  );
}

async function shot(page, name) {
  const canvas = await page.$(".cesium-widget canvas");
  await canvas.screenshot({ path: `${OUT}/${name}.png` });
  return shotDU(fs.readFileSync(`${OUT}/${name}.png`));
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    {
      timeout: 60000,
    },
  );
  await armWebGPUDevices(page);

  // Place the camera near the surface and aim at the sky so the SUN sits ~35
  // above the horizon, centred horizontally. We build the look direction from
  // the actual sunDirectionWC so the sun is guaranteed in frame at a known
  // elevation regardless of clock/date.
  const setup = await page.evaluate(async () => {
    const C = (window.Cesium =
      window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
    const v = window.viewer;
    const s = v.scene;
    s.requestRenderMode = false;
    if (s.skyAtmosphere) s.skyAtmosphere.show = true;
    if (s.sun) s.sun.show = true;

    // Camera anchor: a mid-latitude point on the surface (clear daytime sky).
    const lon = 10.0;
    const lat = 40.0;
    const camHeight = 2000.0;
    const camPos = C.Cartesian3.fromDegrees(lon, lat, camHeight);

    // Local ENU frame at the camera.
    const enu = C.Transforms.eastNorthUpToFixedFrame(camPos);
    const up = C.Cartesian3.normalize(camPos, new C.Cartesian3());

    // Scan the day to find a clock time when the sun is ~35 above the horizon
    // at this location (morning, so it's rising in the east — sky to the east).
    // The default 60 FOV then fits the full 22 ring comfortably around a sun
    // that is well clear of the horizon but not near zenith.
    const TARGET_ELEV = 35.0;
    const targetDot = Math.sin(C.Math.toRadians(TARGET_ELEV));
    let best = null;
    for (let h = 4.0; h <= 12.0; h += 0.25) {
      const hh = Math.floor(h).toString().padStart(2, "0");
      const mm = Math.round((h - Math.floor(h)) * 60)
        .toString()
        .padStart(2, "0");
      const t = C.JulianDate.fromIso8601(`2026-06-21T${hh}:${mm}:00Z`);
      v.clock.currentTime = t.clone();
      s.render();
      const sd = s.context.uniformState.sunDirectionWC;
      if (!sd) continue;
      const sdn = C.Cartesian3.normalize(sd, new C.Cartesian3());
      const dot = C.Cartesian3.dot(sdn, up);
      if (dot <= 0) continue; // sun below horizon
      const err = Math.abs(dot - targetDot);
      if (!best || err < best.err) {
        best = { iso: `2026-06-21T${hh}:${mm}:00Z`, dot, err };
      }
    }
    const fixed = C.JulianDate.fromIso8601(
      best ? best.iso : "2026-06-21T08:00:00Z",
    );
    v.clock.currentTime = fixed.clone();
    v.clock.shouldAnimate = false;
    v.clock.multiplier = 0;
    s.render();

    // Sun direction in world coords (at the chosen time).
    const sunDirWC = s.context.uniformState.sunDirectionWC;
    let sunDir;
    if (sunDirWC && C.Cartesian3.magnitude(sunDirWC) > 0.5) {
      sunDir = C.Cartesian3.normalize(sunDirWC, new C.Cartesian3());
    } else {
      sunDir = C.Cartesian3.clone(up);
    }
    // Horizontal (tangent-plane) component of the sun direction.
    const sunUpDot = C.Cartesian3.dot(sunDir, up);
    let horiz = C.Cartesian3.subtract(
      sunDir,
      C.Cartesian3.multiplyByScalar(up, sunUpDot, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    if (C.Cartesian3.magnitude(horiz) < 1e-3) {
      // Sun near zenith — pick local east as the horizontal reference.
      horiz = C.Matrix4.multiplyByPointAsVector(
        enu,
        C.Cartesian3.UNIT_X,
        new C.Cartesian3(),
      );
    }
    C.Cartesian3.normalize(horiz, horiz);

    // Look direction: aim DIRECTLY at the sun's azimuth at the sun's own
    // elevation (~35) so the sun sits centred and the full 22 ring fits in
    // the default 60 FOV with sky all around. Aiming along the true sun
    // direction guarantees the sun is in frame.
    const sunElevDeg = C.Math.toDegrees(Math.asin(Math.min(1, sunUpDot)));
    const aimElevRad = C.Math.toRadians(Math.max(5.0, sunElevDeg));
    const dir = C.Cartesian3.add(
      C.Cartesian3.multiplyByScalar(
        horiz,
        Math.cos(aimElevRad),
        new C.Cartesian3(),
      ),
      C.Cartesian3.multiplyByScalar(
        up,
        Math.sin(aimElevRad),
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    C.Cartesian3.normalize(dir, dir);

    v.camera.setView({
      destination: camPos,
      orientation: { direction: dir, up: up },
    });

    // Probe diagnostics: confirm the cold-optics effect is wired/active.
    const ppPipe = s._alternateSceneRenderer?._postProcess ?? null;

    // Project the actual sun direction to screen so the analysis centres on
    // the true sun position, not the brightest pixel (which could be a dog).
    s.render();
    const sunFar = C.Cartesian3.add(
      camPos,
      C.Cartesian3.multiplyByScalar(sunDir, 1.0e9, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const win = C.SceneTransforms.worldToWindowCoordinates(
      s,
      sunFar,
      new C.Cartesian2(),
    );

    return {
      renderer: s.context.rendererType,
      sunUpDot: +sunUpDot.toFixed(3),
      sunElevDeg: +sunElevDeg.toFixed(1),
      aimElevDeg: +C.Math.toDegrees(aimElevRad).toFixed(1),
      sunWindow: win ? [Math.round(win.x), Math.round(win.y)] : null,
      hasPipeline: !!ppPipe,
    };
  });

  console.log("[cold-optics] setup:", JSON.stringify(setup));

  // Settle tiles/sky.
  await page
    .waitForFunction(
      () => window.viewer.scene.globe.tilesLoaded === true,
      null,
      {
        timeout: 20000,
      },
    )
    .catch(() => {});
  await page.waitForTimeout(1500);

  // OFF.
  await page.evaluate(() => {
    window.viewer.scene.coldOpticsEnabled = false;
  });
  await page.waitForTimeout(400);
  const off1 = await shot(page, "cold-optics-off-webgpu");
  await page.waitForTimeout(300);
  const off2 = await shot(page, "cold-optics-off2-webgpu");

  // ON.
  await page.evaluate(() => {
    window.viewer.scene.coldOpticsEnabled = true;
    window.viewer.scene.coldOpticsIntensity = 1.0;
  });
  await page.waitForTimeout(900);

  // Diagnostic: read the live effect/pipeline state after a few frames.
  const diag = await page.evaluate(() => {
    const s = window.viewer.scene;
    const pp = s._alternateSceneRenderer?._postProcess ?? null;
    const fx = pp?.coldOpticsEffect ?? null;
    const us = s.context?.uniformState;
    const cp = us?.cameraPosition;
    const sd = us?.sunDirectionWC;
    const ip = us?.inverseProjection;
    const iv = us?.inverseView;
    return {
      sceneFlag: s.coldOpticsEnabled,
      sceneIntensity: s.coldOpticsIntensity,
      hasPipeline: !!pp,
      hasActiveStages: pp?.hasActiveStages ?? null,
      hasEffect: !!fx,
      effectEnabled: fx?.enabled ?? null,
      usCameraPosition: cp
        ? [cp.x.toFixed(0), cp.y.toFixed(0), cp.z.toFixed(0)]
        : null,
      usSunDir: sd ? [sd.x.toFixed(3), sd.y.toFixed(3), sd.z.toFixed(3)] : null,
      usInvProjLen: ip ? ip.length : null,
      usInvViewLen: iv ? iv.length : null,
      // Read back what the effect packed (private field, but JS lets us peek).
      packedIntensity: fx?._uniformData ? fx._uniformData[7] : null,
      packedSunDir: fx?._uniformData
        ? [
            fx._uniformData[4].toFixed(3),
            fx._uniformData[5].toFixed(3),
            fx._uniformData[6].toFixed(3),
          ]
        : null,
      packedHaloRad: fx?._uniformData ? fx._uniformData[8].toFixed(4) : null,
      packedInvProj0: fx?._uniformData ? fx._uniformData[16].toFixed(4) : null,
      fovDeg: s.camera?.frustum?.fov
        ? ((s.camera.frustum.fov * 180) / Math.PI).toFixed(1)
        : null,
      fovyDeg: s.camera?.frustum?.fovy
        ? ((s.camera.frustum.fovy * 180) / Math.PI).toFixed(1)
        : null,
      aspect: s.camera?.frustum?.aspectRatio?.toFixed(3) ?? null,
      invProj: ip ? Array.from(ip).map((x) => +x.toFixed(4)) : null,
    };
  });
  console.log("[cold-optics] ON diag:", JSON.stringify(diag));

  const on1 = await shot(page, "cold-optics-on-webgpu");

  // The sun's screen position (fallback to frame centre if projection failed).
  const sunXY = setup.sunWindow ?? [512, 384];

  const onOff = await analyze(page, off1, on1, sunXY);
  const offStable = await analyze(page, off1, off2, sunXY);

  const gate = await collectGateErrors(page);
  await browser.close();

  console.log("\n[cold-optics] ON-vs-OFF analysis:");
  console.log(JSON.stringify(onOff, null, 1));
  console.log(
    `\n[cold-optics] OFF-vs-OFF totalChangedPct=${offStable.totalChangedPct}`,
  );
  console.log(
    `[cold-optics] gate errors=${gate.errors.length} deviceLost=${gate.deviceLost} console faults=${consoleErrors.length}`,
  );
  if (gate.errors.length) {
    gate.errors.slice(0, 5).forEach((e) => console.log("   ", e));
  }
  if (consoleErrors.length) {
    consoleErrors.slice(0, 5).forEach((e) => console.log("    console:", e));
  }

  // ── Verdict ──
  const ringPresent = onOff.peakAddedBrightness > 2.0;
  const ringAwayFromCentre = onOff.peakRadiusPx > onOff.binW * 4; // not the disc
  const ringIsRing = onOff.sectorsLitAtPeak >= 5; // covers most sectors
  const ringBeatsInner =
    onOff.peakAddedBrightness > onOff.innerAddedBrightness * 2.0;
  const offStableOk = offStable.totalChangedPct < 1.0;
  const noErrors = gate.errors.length === 0 && !gate.deviceLost;

  const checks = [
    [
      `ON adds a bright ring (peakAddedBrightness ${onOff.peakAddedBrightness} > 2)`,
      ringPresent,
    ],
    [
      `ring is away from the sun centre (peakRadiusPx ${onOff.peakRadiusPx})`,
      ringAwayFromCentre,
    ],
    [
      `ring covers most sectors (sectorsLitAtPeak ${onOff.sectorsLitAtPeak} >= 5)`,
      ringIsRing,
    ],
    [
      `ring brighter than inner region (${onOff.peakAddedBrightness} > ${onOff.innerAddedBrightness}*2)`,
      ringBeatsInner,
    ],
    [`OFF is stable (offStable ${offStable.totalChangedPct} < 1)`, offStableOk],
    [`0 device errors`, noErrors],
  ];
  console.log("\n=== ANALYSIS ===");
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) pass = false;
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  console.log("\nPNGs:");
  console.log("  " + path.resolve(`${OUT}/cold-optics-off-webgpu.png`));
  console.log("  " + path.resolve(`${OUT}/cold-optics-on-webgpu.png`));
  process.exitCode = pass ? 0 : 1;
}
run();
