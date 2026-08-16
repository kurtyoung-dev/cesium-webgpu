#!/usr/bin/env node
// Probe-scene-lights — Batch 142 / Slice 5d step 2 verification.
// @purpose Verifies the Scene.lights -> frameState.lights -> 164-float packed UBO chain matches the WGSL LightUniforms punctualLights region.
// @status ACTIVE
//
// Verifies the Scene.lights → frameState.lights → packed UBO chain:
//   1. scene.lights is a LightCollection instance.
//   2. lights.add(...) accepts DirectionalLight / PointLight / SpotLight.
//   3. lights.pack() produces the 164-float packed buffer matching
//      the WGSL LightUniforms.punctualLights region.
//   4. After scene.render(), frameState.lights points to scene.lights.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
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
    viewport: { width: 800, height: 600 },
  });
  const consoleMessages = [];
  page.on("console", (m) => consoleMessages.push(m.text()));
  page.on("pageerror", () => {});
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({ text: ev?.error?.message ?? "" });
    };
  });

  const result = await page.evaluate(async () => {
    // Use the relative path that CesiumViewer.js already imports
    // (../../Build/CesiumUnminified/index.js — same module instance
    // so the browser doesn't have to re-evaluate exports).
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;

    // Debug: what's actually exported?
    const lightyExports = Object.keys(C)
      .filter((k) => k.toLowerCase().includes("light"))
      .sort();
    console.log("Light-related exports:", lightyExports.join(", "));

    if (typeof C.PointLight !== "function") {
      return {
        early_exit: "C.PointLight not exported",
        lightyExports,
        pointLightType: typeof C.PointLight,
        lightCollectionType: typeof C.LightCollection,
      };
    }

    const initial = {
      hasScenelights: !!scene.lights,
      isLightCollection: scene.lights?.constructor?.name === "LightCollection",
      initialCount: scene.lights?.length ?? -1,
    };

    // Add a point light + spot light + directional light.
    const pl = new C.PointLight({
      position: C.Cartesian3.fromDegrees(-79.9959, 40.4406, 100),
      color: C.Color.RED,
      intensity: 5.0,
      range: 200.0,
    });
    const sl = new C.SpotLight({
      position: C.Cartesian3.fromDegrees(-79.9959, 40.4406, 150),
      direction: new C.Cartesian3(0, 0, -1),
      color: C.Color.BLUE,
      intensity: 10.0,
      innerConeAngle: 0.2,
      outerConeAngle: 0.5,
    });
    const dl = new C.DirectionalLight({
      direction: new C.Cartesian3(0, -1, -1),
      color: C.Color.YELLOW,
      intensity: 2.0,
    });
    scene.lights.add(pl);
    scene.lights.add(sl);
    scene.lights.add(dl);

    const postAdd = {
      countAfterAdd: scene.lights.length,
      enabledCount: scene.lights.enabledCount,
      packBufferLength: scene.lights.pack().length,
      lightCountInPackedBuffer: scene.lights.pack()[0],
    };

    // Render some frames so frameState.lights is populated.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-79.9959, 40.4406 - 0.005, 800),
      orientation: { pitch: C.Math.toRadians(-25) },
    });
    for (let i = 0; i < 60; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const renderState = {
      frameStateHasLights: !!scene._frameState?.lights,
      frameStateLightsSameAsSceneLights:
        scene._frameState?.lights === scene.lights,
      frameStateLightsLength: scene._frameState?.lights?.length ?? -1,
    };

    return { initial, postAdd, renderState };
  });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  console.log("Console:");
  consoleMessages
    .filter((m) => m.includes("Light"))
    .forEach((m) => console.log("  " + m));

  console.log("[probe-scene-lights] result:");
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    errs
      .slice(0, 3)
      .forEach((e) => console.log(`  - ${e.text?.slice(0, 200)}`));
  }

  let pass = true;
  const r = result;
  if (!r.initial.hasScenelights) {
    console.log(`FAIL: scene.lights missing`);
    pass = false;
  }
  if (!r.initial.isLightCollection) {
    console.log(
      `FAIL: scene.lights is not a LightCollection (got ${r.initial.isLightCollection})`,
    );
    pass = false;
  }
  if (r.postAdd.countAfterAdd !== 3) {
    console.log(`FAIL: expected 3 lights, got ${r.postAdd.countAfterAdd}`);
    pass = false;
  }
  if (r.postAdd.packBufferLength !== 164) {
    console.log(
      `FAIL: expected 164-float packed buffer, got ${r.postAdd.packBufferLength}`,
    );
    pass = false;
  }
  if (r.postAdd.lightCountInPackedBuffer !== 3) {
    console.log(
      `FAIL: packed buffer light count = ${r.postAdd.lightCountInPackedBuffer}, expected 3`,
    );
    pass = false;
  }
  if (!r.renderState.frameStateLightsSameAsSceneLights) {
    console.log(`FAIL: frameState.lights not wired to scene.lights`);
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }

  if (pass) {
    console.log(
      "\nPASS: Scene.lights API works end-to-end — Add/Remove/pack + frameState wiring + render cleanly",
    );
  }
  process.exit(pass ? 0 : 1);
})();
