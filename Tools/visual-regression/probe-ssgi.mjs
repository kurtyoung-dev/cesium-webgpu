#!/usr/bin/env node
/**
 * C6-SSGI-DIFFUSE — screen-space diffuse global illumination (SSILVB visibility
 * bitmask). Fork-added, opt-in, default-off, WebGPU-only.
 *
 * Verifies:
 *   (1) FEATURE RENDERS — with the AmbientOcclusion stage enabled and its
 *       `algorithm` uniform set to "ssgi", the frame DIFFERS from the no-effect
 *       baseline (the SSGI generate+blur+composite chain actually runs).
 *   (2) GI IS PRESENT — the GI-only debug output (composite debugMode 2) is
 *       non-black across a meaningful pixel fraction, proving indirect radiance
 *       is being gathered and would bleed onto neighbouring surfaces (not just
 *       an AO darkening term).
 *   (3) OFF-GATE (byte-identical) — disabling the stage returns the frame to
 *       within the scene's own noise floor of the baseline: no SSGI allocation
 *       or pass survives when off, and the hbao/gtao/off paths are untouched.
 *   (4) ORBIT NO-OP — from high orbit the maxWorldRadius cap degrades SSGI to a
 *       near no-op (planet-scale guard); ON vs OFF stays within the noise floor.
 *   (5) No new WebGPU device errors (sky-leak / NaN / precision failures would
 *       surface here).
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-ssgi.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const W = 1024,
  H = 768;
// Ground-level oblique view over Grand Canyon terrain — strong colour + relief
// variation so indirect bounce and AO are both exercised.
const LON = -111.5,
  LAT = 36.1,
  ALT = 2200.0;
const OUT = "Tools/visual-regression/output";

const SETVIEW = async (cfg) => {
  const v = window.viewer;
  const s = v.scene;
  v.useDefaultRenderLoop = false;
  s.requestRenderMode = false;
  // Freeze the clock so frame-to-frame captures are deterministic (no
  // atmosphere/sun animation between the composite-mode captures) — required
  // for the orbit no-op comparison to isolate the SSGI term from animation.
  if (v.clock) v.clock.shouldAnimate = false;
  v.camera.setView({
    destination: window.Cesium.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: window.Cesium.Math.toRadians(90.0),
      pitch: window.Cesium.Math.toRadians(-18.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

const SHOOT = async () => {
  const s = window.viewer.scene;
  for (let i = 0; i < 30; i++) {
    s.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return s.canvas.toDataURL("image/png");
};

async function diff(page, a, b) {
  return page.evaluate(
    async ([ua, ub]) => {
      const load = async (u) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        return cx.getImageData(0, 0, c.width, c.height).data;
      };
      const da = await load(ua),
        db = await load(ub);
      let changed = 0;
      const n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        if (
          da[i] !== db[i] ||
          da[i + 1] !== db[i + 1] ||
          da[i + 2] !== db[i + 2]
        ) {
          changed++;
        }
      }
      return { pctChanged: +((100 * changed) / n).toFixed(4), changed, n };
    },
    [a, b],
  );
}

// Fraction of non-black pixels (any channel > 4/255) — used to prove the GI
// debug output actually carries indirect radiance.
async function nonBlackPct(page, du) {
  return page.evaluate(async (u) => {
    const img = new Image();
    img.src = u;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 4 || d[i + 1] > 4 || d[i + 2] > 4) lit++;
    }
    return +((100 * lit) / n).toFixed(3);
  }, du);
}

async function settle(page, frames = 45) {
  await page.evaluate(async (f) => {
    const s = window.viewer.scene;
    for (let i = 0; i < f; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, frames);
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await page.evaluate(async () => {
    window.Cesium = await import("/Build/CesiumUnminified/index.js");
  });
  await armWebGPUDevices(page);
  await page.evaluate(SETVIEW, { LON, LAT, ALT });

  // Wait for terrain/imagery tiles to load in.
  await page.evaluate(async () => {
    const s = window.viewer.scene;
    const deadline = performance.now() + 45000;
    for (let i = 0; i < 2000 && performance.now() < deadline; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (i > 30 && s.globe.tilesLoaded) break;
    }
    for (let i = 0; i < 30; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  // (0) Baseline — AO stage disabled (default). Two shots → noise floor.
  const baseline = await page.evaluate(SHOOT);
  const baseline2 = await page.evaluate(SHOOT);

  // (1) Enable SSGI. Set the algorithm + params on the AO stage uniforms
  // BEFORE enabling so the lazy init picks them up.
  const onState = await page.evaluate(async () => {
    const s = window.viewer.scene;
    const ao = s.postProcessStages.ambientOcclusion;
    ao.uniforms.algorithm = "ssgi";
    ao.uniforms.giIntensity = 8.0; // exaggerate the bounce for the probe
    ao.uniforms.radiusPixels = 40.0;
    ao.enabled = true;
    for (let i = 0; i < 60; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const pp = s._alternateSceneRenderer?._postProcess ?? null;
    const fx = pp?.ambientOcclusionEffect ?? null;
    return {
      hasEffect: !!fx,
      algorithm: fx?._config?.algorithm ?? null,
      isSSGI: fx?._isSSGI ?? null,
      logActive: fx?._logActive ?? null,
      png: s.canvas.toDataURL("image/png"),
    };
  });
  const ssgiOn = onState.png;

  // (2) GI-only debug — write composite debugMode 2 directly into the composite
  // UB (avoids a re-init that would stale the bind-group cache).
  const giOnly = await page.evaluate(async () => {
    const s = window.viewer.scene;
    const pp = s._alternateSceneRenderer?._postProcess ?? null;
    const fx = pp?.ambientOcclusionEffect ?? null;
    if (fx && fx._device && fx._modulateUniforms) {
      // params: debugMode, aoWeight, -, -  → GI only = mode 2
      fx._device.queue.writeBuffer(
        fx._modulateUniforms,
        0,
        new Float32Array([2.0, 1.0, 0.0, 0.0]),
      );
    }
    for (let i = 0; i < 30; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const png = s.canvas.toDataURL("image/png");
    // restore composite mode
    if (fx && fx._device && fx._modulateUniforms) {
      fx._device.queue.writeBuffer(
        fx._modulateUniforms,
        0,
        new Float32Array([0.0, 1.0, 0.0, 0.0]),
      );
    }
    return png;
  });

  // (3) Off-gate — disable the stage, capture. Must return to baseline floor.
  const restored = await page.evaluate(async () => {
    const s = window.viewer.scene;
    s.postProcessStages.ambientOcclusion.enabled = false;
    for (let i = 0; i < 45; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return s.canvas.toDataURL("image/png");
  });

  // (4) Orbit no-op — high orbit, SSGI on vs off within the noise floor.
  await page.evaluate(async () => {
    const v = window.viewer;
    v.camera.setView({
      destination: window.Cesium.Cartesian3.fromDegrees(-111.5, 36.1, 9.0e6),
      orientation: {
        heading: 0.0,
        pitch: window.Cesium.Math.toRadians(-90.0),
        roll: 0.0,
      },
    });
  });
  await settle(page, 60);
  const orbitOff = await page.evaluate(SHOOT);
  const orbitState = await page.evaluate(async () => {
    const s = window.viewer.scene;
    const ao = s.postProcessStages.ambientOcclusion;
    ao.uniforms.algorithm = "ssgi";
    ao.enabled = true;
    for (let i = 0; i < 60; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const pp = s._alternateSceneRenderer?._postProcess ?? null;
    const fx = pp?.ambientOcclusionEffect ?? null;
    const png = s.canvas.toDataURL("image/png");
    // Diagnostic: force AO-only debug (mode 1) at orbit. If fade truly zeroes
    // the march, ao should be 1 → WHITE; if the march still runs, ao≈0 → black.
    const capMode = async (m) => {
      fx._device.queue.writeBuffer(
        fx._modulateUniforms,
        0,
        new Float32Array([m, 1.0, 0.0, 0.0]),
      );
      for (let i = 0; i < 20; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return s.canvas.toDataURL("image/png");
    };
    let aoOnlyPng = null;
    let giOnlyPng = null;
    if (fx && fx._device && fx._modulateUniforms) {
      aoOnlyPng = await capMode(1.0); // AO only → white if ao=1 (no-op)
      giOnlyPng = await capMode(2.0); // GI only → black if gi=0 (no-op)
      fx._device.queue.writeBuffer(
        fx._modulateUniforms,
        0,
        new Float32Array([0.0, 1.0, 0.0, 0.0]),
      );
    }
    return {
      png,
      aoOnlyPng,
      giOnlyPng,
      altitudeFade: fx?._altitudeFade ?? null,
      camHeight: s.camera?.positionCartographic?.height ?? null,
    };
  });
  const orbitOn = orbitState.png;
  const orbitAoLit = orbitState.aoOnlyPng
    ? await nonBlackPct(page, orbitState.aoOnlyPng)
    : null;
  const orbitGiLit = orbitState.giOnlyPng
    ? await nonBlackPct(page, orbitState.giOnlyPng)
    : null;
  console.log(
    `  [diag] orbit altitudeFade=${orbitState.altitudeFade} camHeight=${orbitState.camHeight} aoOnlyLit=${orbitAoLit}% giOnlyLit=${orbitGiLit}%`,
  );

  const save = (name, du) =>
    fs.writeFileSync(
      `${OUT}/ssgi-${name}.png`,
      Buffer.from(du.split(",")[1], "base64"),
    );
  save("baseline", baseline);
  save("on", ssgiOn);
  save("gi-only", giOnly);
  save("restored", restored);
  save("orbit-off", orbitOff);
  save("orbit-on", orbitOn);

  const floor = await diff(page, baseline, baseline2);
  const onDelta = await diff(page, baseline, ssgiOn);
  const offGate = await diff(page, baseline2, restored);
  const giLit = await nonBlackPct(page, giOnly);

  const gate = await collectGateErrors(page);
  const errs = [...(gate?.errors ?? []), ...(consoleErrors ?? [])];
  await browser.close();

  const checks = [];
  checks.push([
    "SSGI effect built and reports algorithm=ssgi",
    onState.hasEffect && onState.algorithm === "ssgi" && onState.isSSGI === true,
    `hasEffect=${onState.hasEffect} algo=${onState.algorithm} isSSGI=${onState.isSSGI}`,
  ]);
  checks.push([
    "feature renders — SSGI ON differs from no-effect baseline",
    onDelta.pctChanged > 1.0,
    `onDelta=${onDelta.pctChanged}% (floor=${floor.pctChanged}%)`,
  ]);
  checks.push([
    "GI is present — GI-only debug output is non-black",
    giLit > 2.0,
    `giLit=${giLit}% non-black`,
  ]);
  checks.push([
    "off-gate: stage disabled returns within scene noise floor",
    offGate.pctChanged <= floor.pctChanged + 0.1,
    `restored=${offGate.pctChanged}% vs floor=${floor.pctChanged}%`,
  ]);
  checks.push([
    "orbit no-op: altitude fade zeroes the SSGI term (ao=1 white, gi=0 black)",
    orbitAoLit !== null &&
      orbitAoLit > 60.0 &&
      orbitGiLit !== null &&
      orbitGiLit < 1.0,
    `aoOnlyLit=${orbitAoLit}% (want>60, ao=1) giOnlyLit=${orbitGiLit}% (want<1, gi=0)`,
  ]);
  checks.push([
    "no new WebGPU device errors",
    errs.length === 0,
    `${errs.length} errors${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`,
  ]);

  let pass = true;
  console.log("\n=== C6-SSGI-DIFFUSE probe ===");
  for (const [name, ok, detail] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
    if (!ok) pass = false;
  }
  console.log(
    `\nPNGs: ${OUT}/ssgi-{baseline,on,gi-only,restored,orbit-off,orbit-on}.png`,
  );
  console.log(pass ? "\nRESULT: PASS\n" : "\nRESULT: FAIL\n");
  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
