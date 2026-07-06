#!/usr/bin/env node
// Probe (CLOUD-U8-DOCS-DEMO-PROBES close-out acceptance): the off-identity +
// WebGL-graceful-no-op gate for the whole cloud-unification epic.
//
// This is the STANDING guard for the epic's two hard invariants:
//
//   (A) BILLBOARD-mode byte-identity — with renderMode===BILLBOARD (the
//       default), populating the ENTIRE expanded WebGPU-only flag surface
//       (collection.cloudType genus + every collection.volumetric dial:
//       shell/coverage/wind/quality, genera, weather map/provider, exotic
//       E1 species, E2 mammatus + feature, E3 special) must render a
//       billboard cloud deck BYTE-IDENTICALLY vs the same scene with none of
//       it touched — because renderMode is BILLBOARD so none of it feeds the
//       render path. Proven on BOTH backends by a 0-diff canvas hash.
//
//   (B) WebGL no-op of every WebGPU-only flag — on the WebGL renderer,
//       flipping renderMode===VOLUMETRIC + enableVolumetric + the full flag
//       surface must NOT throw and must produce ZERO console errors (the
//       volumetric deck simply never renders; billboards are suppressed by
//       the exclusive toggle — documented graceful no-op, FORK_OVERVIEW
//       principle 10 / CloudRenderMode.VOLUMETRIC JSDoc).
//
// Usage: node Tools/visual-regression/probe-cloud-u8-offident.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

// Every WebGPU-only volumetric flag, exercised at a non-default value so a
// leak into the BILLBOARD path would move pixels. Kept in one place so the
// probe stays exhaustive as the flag surface grows.
function applyAllVolumetricFlags(C, coll) {
  coll.cloudType = C.CloudType.STRATOCUMULUS; // collection-level genus
  const v = coll.volumetric;
  v.enabled = true; // enabled but renderMode BILLBOARD -> inert
  // shell / coverage / wind
  v.cloudCoverage = 0.92;
  v.cloudLayerBottom = 800.0;
  v.cloudLayerTop = 6500.0;
  v.cloudWindSpeed = 40.0;
  v.cloudWindDirection = { x: -0.4, y: 0.9 };
  v.cloudDensity = 0.8;
  v.cloudAerialStrength = 0.4;
  v.cloudCastShadows = true;
  v.cloudContributesIBL = true;
  v.cloudMultiDeck = true;
  v.cloudHighPrecision = true;
  // quality
  v.cloudQuality = 96;
  v.cloudVolumetricQuality = "ultra";
  v.cloudType = C.CloudType.CUMULONIMBUS;
  // aerial / ambient modes
  v.cloudAerialMode = "physical";
  v.cloudAmbientSource = "sky";
  // appearance dials
  v.cloudSilverLiningIntensity = 1.3;
  v.cloudPhaseForwardG = 0.8;
  v.cloudPhaseBackG = -0.5;
  v.cloudPhaseBlend = 0.4;
  v.cloudAmbientIntensity = 1.7;
  v.cloudErosionStrength = 0.22;
  v.cloudCurlAmplitude = 0.5;
  v.cloudCurlFrequency = 2.0;
  v.cloudNoiseMorphology = 0.6;
  v.cloudPuffSize = 0.7;
  v.cloudExposure = 1.4;
  v.cloudMsDecayScatter = 0.6;
  v.cloudMsDecayExtinction = 0.5;
  v.cloudMsDecayPhase = 0.4;
  // weather map / provider
  v.cloudWeatherMap = true;
  v.cloudWeatherChannelStrength = 0.9;
  v.weatherProvider = { _fake: true }; // never fetched on BILLBOARD path
  // exotic E2 mammatus
  v.cloudMammatusStrength = 0.7;
  v.cloudMammatusScale = 1.5;
  v.cloudMammatusDepth = 0.6;
  // exotic E1 species
  v.cloudSpecies = "lenticularis";
  v.cloudSpeciesMode = 1;
  v.cloudSpeciesStrength = 0.8;
  v.cloudSpeciesScale = 1.2;
  v.cloudSpeciesParam = 0.5;
  // exotic E2 feature
  v.cloudFeature = "asperitas";
  v.cloudFeatureMode = 1;
  v.cloudFeatureStrength = 0.7;
  v.cloudFeatureScale = 1.1;
  v.cloudFeatureParam = 0.4;
  // exotic E3 special
  v.cloudSpecial = "noctilucent";
  v.cloudSpecialShadeStrength = 0.6;
  v.cloudSpecialShadeScale = 1.0;
  v.cloudSpecialShadeParam = 0.3;
}

async function runBackend(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(async (applySrc) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const applyAllVolumetricFlags = new Function(
      "C",
      "coll",
      `(${applySrc})(C, coll);`,
    );
    const v = window.viewer,
      scene = v.scene;

    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = C.Color.BLACK;
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(-98.0, 40.0, 16000.0),
    });

    async function hashAfter(buildFn) {
      const coll = scene.primitives.add(new C.CloudCollection());
      buildFn(coll);
      for (let i = 0; i < 12; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const canvas = scene.canvas;
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const ctx2d = tmp.getContext("2d");
      ctx2d.drawImage(canvas, 0, 0);
      const data = ctx2d.getImageData(0, 0, tmp.width, tmp.height).data;
      let h = 0x811c9dc5;
      let bright = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        if (r + g + b > 60) bright++;
        h ^= r;
        h = Math.imul(h, 0x01000193);
        h ^= g;
        h = Math.imul(h, 0x01000193);
        h ^= b;
        h = Math.imul(h, 0x01000193);
      }
      scene.primitives.remove(coll);
      return { hash: h >>> 0, bright };
    }

    const puffs = [
      [-98.02, 40.0],
      [-98.0, 40.0],
      [-97.98, 40.0],
      [-98.0, 40.02],
      [-98.0, 39.98],
    ];
    function addPuffs(coll) {
      for (const [lon, lat] of puffs) {
        coll.add({
          position: C.Cartesian3.fromDegrees(lon, lat, 3000.0),
          scale: new C.Cartesian2(2000.0, 1300.0),
          maximumSize: new C.Cartesian3(2000.0, 1300.0, 900.0),
          brightness: 1.0,
        });
      }
    }

    // (A) BILLBOARD byte-identity: baseline vs full-flag-surface, renderMode
    //     stays BILLBOARD.
    let applyThrew = false;
    const baseline = await hashAfter((coll) => addPuffs(coll));
    const withFlags = await hashAfter((coll) => {
      addPuffs(coll);
      try {
        applyAllVolumetricFlags(C, coll); // renderMode NOT changed -> BILLBOARD
      } catch (e) {
        applyThrew = true;
      }
    });

    // (B) WebGL no-op: renderMode VOLUMETRIC + full flags must not throw / error.
    let volumetricSetupThrew = false;
    try {
      const volColl = scene.primitives.add(new C.CloudCollection());
      addPuffs(volColl);
      applyAllVolumetricFlags(C, volColl);
      volColl.renderMode = C.CloudRenderMode.VOLUMETRIC; // exclusive toggle
      volColl.enableVolumetric = true;
      for (let i = 0; i < 8; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.primitives.remove(volColl);
    } catch (e) {
      volumetricSetupThrew = true;
    }

    const shotUrl = scene.canvas.toDataURL("image/png");

    return {
      baselineHash: baseline.hash,
      withFlagsHash: withFlags.hash,
      baselineBright: baseline.bright,
      withFlagsBright: withFlags.bright,
      identical: baseline.hash === withFlags.hash,
      applyThrew,
      volumetricSetupThrew,
      shotUrl,
    };
  }, applyAllVolumetricFlags.toString());

  const b64 = result.shotUrl.split(",")[1];
  writeFileSync(
    `Tools/visual-regression/out-cloud-u8-${renderer}.png`,
    Buffer.from(b64, "base64"),
  );
  delete result.shotUrl;

  await browser.close();
  return { renderer, errors, ...result };
}

const results = [];
for (const r of ["webgl", "webgpu"]) {
  results.push(await runBackend(r));
}

let ok = true;
for (const res of results) {
  const checks = {
    billboardByteIdentical: res.identical,
    applyDidNotThrow: !res.applyThrew,
    volumetricSetupDidNotThrow: !res.volumetricSetupThrew,
    zeroErrors: res.errors.length === 0,
  };
  const failed = Object.entries(checks).filter(([, v]) => !v);
  if (failed.length) ok = false;
  console.log(`\n=== ${res.renderer.toUpperCase()} ===`);
  console.log(
    `  baselineHash=${res.baselineHash} withFlagsHash=${res.withFlagsHash} ` +
      `bright(base=${res.baselineBright}, flags=${res.withFlagsBright})`,
  );
  console.log(`  checks: ${JSON.stringify(checks)}`);
  if (failed.length)
    console.log(`  FAILED: ${failed.map(([k]) => k).join(", ")}`);
  if (res.errors.length)
    console.log(`  console errors: ${JSON.stringify(res.errors.slice(0, 5))}`);
}

console.log(`\n${ok ? "PASS" : "FAIL"} — CLOUD-U8-DOCS-DEMO-PROBES off-identity`);
process.exit(ok ? 0 : 1);
