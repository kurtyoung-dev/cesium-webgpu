#!/usr/bin/env node
// Probe (CLOUD-U1-API-SCAFFOLD acceptance): pure-scaffold slice of the
// cloud-unification epic. Adds CloudVolumetrics / CloudRenderMode, the
// CloudCollection.renderMode / .volumetric / .cloudType surface,
// CumulusCloud.cloudType (dirty index 7, NUMBER_OF_PROPERTIES 7->8), and the
// backend-neutral context.requestVolumetricClouds / consumeVolumetricCloudRequest
// seam. NOTHING reads these yet.
//
// OFF-GATE (the key assertion): with renderMode===BILLBOARD and all volumetric
// flags off (default), a billboard cloud scene must render BYTE-IDENTICALLY vs
// the same scene where the new API is exercised (cloudType set on clouds, the
// whole .volumetric dial-set populated) — because none of it feeds the render
// path. Proven on BOTH backends by a 0-diff canvas hash.
//
// Assertions per backend:
//  1. API smoke: CloudVolumetrics/CloudRenderMode exported; renderMode default
//     BILLBOARD; enableVolumetric:true flips renderMode to VOLUMETRIC; the
//     .volumetric lazy getter returns a CloudVolumetrics; CumulusCloud.cloudType
//     stored (not dropped); NUMBER_OF_PROPERTIES===8; requestVolumetricClouds is
//     callable (no throw) on both backends.
//  2. Byte-identical: baseline billboard render hash === render hash after
//     exercising the new default-off API (renderMode stays BILLBOARD).
//  3. 0 console errors.
//
// Usage: node Tools/visual-regression/probe-cloud-u1-scaffold.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

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

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      scene = v.scene;

    // Black background so cloud pixels dominate; deterministic camera.
    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = C.Color.BLACK;
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(-98.0, 40.0, 16000.0),
    });

    const api = {};
    api.hasCloudVolumetrics = typeof C.CloudVolumetrics === "function";
    api.hasCloudRenderMode =
      !!C.CloudRenderMode &&
      C.CloudRenderMode.BILLBOARD === 0 &&
      C.CloudRenderMode.VOLUMETRIC === 1;
    api.numberOfProperties = C.CumulusCloud.NUMBER_OF_PROPERTIES;
    api.cloudTypeIndex = C.CumulusCloud.CLOUD_TYPE_INDEX;

    // Default renderMode + lazy volumetric + genus store checks.
    const probeColl = new C.CloudCollection();
    api.defaultRenderMode = probeColl.renderMode;
    api.volumetricIsCloudVolumetrics =
      probeColl.volumetric instanceof C.CloudVolumetrics;
    api.volumetricEnabledDefault = probeColl.volumetric.enabled;
    api.collDefaultCloudType = probeColl.cloudType;

    const volColl = new C.CloudCollection({ enableVolumetric: true });
    api.enableVolumetricFlipsMode =
      volColl.renderMode === C.CloudRenderMode.VOLUMETRIC;
    api.enableVolumetricSetsEnabled = volColl.volumetric.enabled === true;
    probeColl.destroy();
    volColl.destroy();

    // CumulusCloud.cloudType no longer dropped.
    const seedColl = new C.CloudCollection();
    const c0 = seedColl.add({
      position: C.Cartesian3.fromDegrees(-98.0, 40.0, 3000.0),
      cloudType: C.CloudType.CUMULONIMBUS,
    });
    api.cumulusCloudTypeStored = c0.cloudType === C.CloudType.CUMULONIMBUS;
    seedColl.destroy();

    // Backend-neutral publish seam is callable without throwing on BOTH
    // backends. On WebGL it is a no-op; on WebGPU it stores + consumes.
    let requestThrew = false;
    let consumeRoundTrips = false;
    try {
      const ctx = scene.context;
      ctx.requestVolumetricClouds({ enabled: true, cloudCoverage: 0.5 });
      if (typeof ctx.consumeVolumetricCloudRequest === "function") {
        const got = ctx.consumeVolumetricCloudRequest();
        // WebGL base returns undefined; WebGPU returns the stored object.
        consumeRoundTrips = got === undefined || got.enabled === true;
      } else {
        consumeRoundTrips = true;
      }
    } catch (e) {
      requestThrew = true;
    }
    api.requestSeamOk = !requestThrew && consumeRoundTrips;

    // ── Byte-identical render test ──
    // Helper: build a billboard cloud deck and hash the canvas after N frames.
    async function hashAfter(buildFn) {
      const coll = scene.primitives.add(new C.CloudCollection());
      buildFn(coll);
      // Let noise texture bake + a few frames settle.
      for (let i = 0; i < 12; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const canvas = scene.canvas;
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgpu");
      // Read pixels via a 2D snapshot of the canvas (works for both backends).
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const ctx2d = tmp.getContext("2d");
      ctx2d.drawImage(canvas, 0, 0);
      const data = ctx2d.getImageData(0, 0, tmp.width, tmp.height).data;
      // FNV-1a hash over the pixel bytes.
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

    function addPuffs(coll, withNewApi) {
      const pts = [
        [-98.02, 40.0],
        [-98.0, 40.0],
        [-97.98, 40.0],
        [-98.0, 40.02],
        [-98.0, 39.98],
      ];
      for (const [lon, lat] of pts) {
        const opts = {
          position: C.Cartesian3.fromDegrees(lon, lat, 3000.0),
          scale: new C.Cartesian2(2000.0, 1300.0),
          maximumSize: new C.Cartesian3(2000.0, 1300.0, 900.0),
          brightness: 1.0,
        };
        if (withNewApi) {
          opts.cloudType = C.CloudType.CUMULONIMBUS; // stored, ignored by billboard
        }
        coll.add(opts);
      }
      if (withNewApi) {
        // Exercise the whole default-off volumetric surface — renderMode stays
        // BILLBOARD so NONE of this may touch the rendered pixels.
        coll.cloudType = C.CloudType.STRATOCUMULUS;
        const vol = coll.volumetric;
        vol.enabled = true; // enabled but renderMode is BILLBOARD -> inert
        vol.cloudCoverage = 0.9;
        vol.cloudDensity = 0.8;
        vol.cloudLayerBottom = 800.0;
        vol.cloudLayerTop = 6000.0;
        vol.cloudWindSpeed = 40.0;
        vol.cloudCastShadows = true;
        vol.cloudContributesIBL = true;
        vol.cloudMultiDeck = true;
        vol.cloudHighPrecision = true;
        vol.cloudType = C.CloudType.CUMULONIMBUS;
        vol.cloudSpecies = "lenticularis";
        vol.cloudMammatusStrength = 0.7;
      }
    }

    const baseline = await hashAfter((coll) => addPuffs(coll, false));
    const withApi = await hashAfter((coll) => addPuffs(coll, true));

    // Grab a screenshot PNG of the withApi render for human read.
    const shotCanvas = scene.canvas;
    const shotUrl = shotCanvas.toDataURL("image/png");

    return {
      api,
      baselineHash: baseline.hash,
      withApiHash: withApi.hash,
      baselineBright: baseline.bright,
      withApiBright: withApi.bright,
      identical: baseline.hash === withApi.hash,
      shotUrl,
    };
  });

  // Save screenshot.
  const b64 = result.shotUrl.split(",")[1];
  writeFileSync(
    `Tools/visual-regression/out-cloud-u1-${renderer}.png`,
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
  const a = res.api;
  const checks = {
    hasCloudVolumetrics: a.hasCloudVolumetrics,
    hasCloudRenderMode: a.hasCloudRenderMode,
    numberOfProperties8: a.numberOfProperties === 8,
    cloudTypeIndex7: a.cloudTypeIndex === 7,
    defaultRenderModeBillboard: a.defaultRenderMode === 0,
    volumetricIsCloudVolumetrics: a.volumetricIsCloudVolumetrics,
    volumetricEnabledDefaultFalse: a.volumetricEnabledDefault === false,
    collDefaultCloudTypeCumulus: a.collDefaultCloudType === 0,
    enableVolumetricFlipsMode: a.enableVolumetricFlipsMode,
    enableVolumetricSetsEnabled: a.enableVolumetricSetsEnabled,
    cumulusCloudTypeStored: a.cumulusCloudTypeStored,
    requestSeamOk: a.requestSeamOk,
    byteIdentical: res.identical,
    zeroErrors: res.errors.length === 0,
  };
  const failed = Object.entries(checks).filter(([, v]) => !v);
  if (failed.length) ok = false;
  console.log(`\n=== ${res.renderer.toUpperCase()} ===`);
  console.log(
    `  baselineHash=${res.baselineHash} withApiHash=${res.withApiHash} ` +
      `bright(base=${res.baselineBright}, api=${res.withApiBright})`,
  );
  console.log(`  checks: ${JSON.stringify(checks)}`);
  if (failed.length) console.log(`  FAILED: ${failed.map(([k]) => k).join(", ")}`);
  if (res.errors.length)
    console.log(`  console errors: ${JSON.stringify(res.errors.slice(0, 5))}`);
}

console.log(`\n${ok ? "PASS" : "FAIL"} — CLOUD-U1-API-SCAFFOLD`);
process.exit(ok ? 0 : 1);
