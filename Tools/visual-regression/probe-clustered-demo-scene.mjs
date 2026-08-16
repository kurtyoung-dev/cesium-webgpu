#!/usr/bin/env node
// Probe-clustered-demo-scene — replicates the exact scene built by the
// "WebGPU Clustered Lighting" Sandcastle demo (ground Primitive + 3 entity
// models + 6 colored PointLights + clustered on, at night) and verifies it
// renders with a clustered-lighting contribution and 0 device errors. This
// validates the demo's Cesium API usage end-to-end (the Sandcastle HTML
// wrapper itself is verbatim from the shipped point-light-shadows demo).
// @purpose Replicates the Clustered Lighting Sandcastle demo scene and asserts a visible clustered contribution with 0 device errors.
// @status ACTIVE

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_OFF = "Tools/visual-regression/output/clustered-demo-off.png";
const OUT_ON = "Tools/visual-regression/output/clustered-demo-on.png";

(async () => {
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  page.on("pageerror", (e) => console.log(`>> pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (dev)
      dev.onuncapturederror = (ev) =>
        window.__probeErrors.push(ev?.error?.message ?? "");
  });

  const _setup = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    window.__C = C;
    const v = window.viewer;
    const scene = v.scene;
    scene.globe.show = false;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    scene.backgroundColor = C.Color.fromCssColorString("#05060a");

    const center = C.Cartesian3.fromDegrees(-75.59, 40.038, 0);
    const enu = C.Transforms.eastNorthUpToFixedFrame(center);
    window.__center = center;
    window.__enu = enu;
    const localToWC = (x, y, z) =>
      C.Matrix4.multiplyByPoint(
        enu,
        new C.Cartesian3(x, y, z),
        new C.Cartesian3(),
      );
    window.__localToWC = localToWC;

    scene.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: C.BoxGeometry.fromDimensions({
            vertexFormat: C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
            dimensions: new C.Cartesian3(400, 400, 2),
          }),
          modelMatrix: C.Matrix4.multiplyByTranslation(
            enu,
            new C.Cartesian3(0, 0, -1),
            new C.Matrix4(),
          ),
        }),
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType("Color", {
            color: C.Color.fromBytes(120, 120, 130, 255),
          }),
          flat: false,
          translucent: false,
        }),
        asynchronous: false,
      }),
    );

    const uris = [
      "../../SampleData/models/GroundVehicle/GroundVehicle.glb",
      "../../SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
      "../../SampleData/models/GroundVehicle/GroundVehicle.glb",
    ];
    const xs = [-22, 0, 22];
    const ents = [];
    for (let i = 0; i < uris.length; i++) {
      const pos = localToWC(xs[i], 0, 0);
      ents.push(
        v.entities.add({
          position: pos,
          orientation: C.Transforms.headingPitchRollQuaternion(
            pos,
            new C.HeadingPitchRoll(C.Math.toRadians(i * 40), 0, 0),
          ),
          model: { uri: uris[i], scale: 7.0 },
        }),
      );
    }

    const cols = [
      "#ff3b30",
      "#34c759",
      "#0a84ff",
      "#ffd60a",
      "#ff2d92",
      "#64d2ff",
    ];
    for (let i = 0; i < cols.length; i++) {
      const a = (i / cols.length) * C.Math.TWO_PI;
      scene.lights.add(
        new C.PointLight({
          position: localToWC(Math.cos(a) * 34, Math.sin(a) * 34, 14),
          color: C.Color.fromCssColorString(cols[i]),
          intensity: 600,
          range: 120,
        }),
      );
    }

    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T04:30:00Z");
    v.camera.lookAt(
      center,
      new C.HeadingPitchRange(
        C.Math.toRadians(-20),
        C.Math.toRadians(-16),
        105.0,
      ),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);

    // Wait for models to load.
    scene.clusteredLightingEnabled = false;
    for (let i = 0; i < 300; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (ents.every((e) => e.model && true)) {
        // crude: just render plenty of frames for async model load
      }
    }
    return { sceneLightCount: scene.lights.length };
  });
  await page.screenshot({ path: OUT_OFF, fullPage: false });

  const phase2 = await page.evaluate(async () => {
    const v = window.viewer;
    const scene = v.scene;
    scene.clusteredLightingEnabled = true;
    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const d =
      scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
    return {
      lastActive: d?.lastActiveLightCount ?? -1,
      clusteredActive: scene.context._clusteredLightingActive === true,
    };
  });
  await page.screenshot({ path: OUT_ON, fullPage: false });
  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  const db = await chromium.launch({ channel: "msedge", headless: true });
  const dp = await db.newPage();
  await dp.setContent("<html><body></body></html>");
  const offB64 = fs.readFileSync(OUT_OFF).toString("base64");
  const onB64 = fs.readFileSync(OUT_ON).toString("base64");
  const stats = await dp.evaluate(
    async ({ offB64, onB64 }) => {
      const dec = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: c.width,
          h: c.height,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const off = await dec(offB64);
      const on = await dec(onB64);
      let so = 0,
        sn = 0,
        n = 0,
        ch = 0,
        md = 0;
      for (let i = 0; i < off.data.length; i += 4) {
        const a = off.data[i] + off.data[i + 1] + off.data[i + 2];
        const b = on.data[i] + on.data[i + 1] + on.data[i + 2];
        so += a;
        sn += b;
        n++;
        const dd = Math.abs(b - a);
        if (dd > 5) ch++;
        if (dd > md) md = dd;
      }
      return {
        meanOff: so / n,
        meanOn: sn / n,
        delta: (sn - so) / n,
        changedPx: ch,
        maxDelta: md,
        n,
      };
    },
    { offB64, onB64 },
  );
  await db.close();

  console.log("[probe-clustered-demo-scene] result:");
  console.log(`  scene.lights.length: ${stats ? "" : ""}${/* */ ""}`);
  console.log(`  lastActiveLightCount: ${phase2.lastActive}`);
  console.log(`  clusteredLightingActive: ${phase2.clusteredActive}`);
  console.log(`  mean RGB-sum OFF: ${stats.meanOff.toFixed(2)}`);
  console.log(`  mean RGB-sum ON:  ${stats.meanOn.toFixed(2)}`);
  console.log(`  delta (on − off): ${stats.delta.toFixed(2)}`);
  console.log(`  changed pixels (Δ>5): ${stats.changedPx} / ${stats.n}`);
  console.log(`  max single-pixel delta: ${stats.maxDelta}`);
  console.log(`\nDevice errors: ${errs.length}`);
  errs
    .slice(0, 6)
    .forEach((e) => console.log(`  - ${(e ?? "").slice(0, 200)}`));

  let pass = true;
  if (phase2.lastActive < 6) {
    console.log(
      `FAIL: lastActiveLightCount = ${phase2.lastActive}, expected 6`,
    );
    pass = false;
  }
  if (stats.changedPx < 200) {
    console.log(
      `FAIL: only ${stats.changedPx} px changed (max ${stats.maxDelta})`,
    );
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }
  if (pass) {
    console.log(
      "\nPASS: demo scene renders with 6-light clustered lighting + 0 device errors",
    );
  }
  process.exit(pass ? 0 : 1);
})();
