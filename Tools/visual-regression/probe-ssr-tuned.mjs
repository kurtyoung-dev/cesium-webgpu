#!/usr/bin/env node
// Probe-ssr-tuned — Batch 136 SSR parameter tuning.
//
// Diagnoses: the Batch 132 SSR water probe got 0.094% A-vs-B mismatch
// — basically zero SSR signal. Root cause hypothesis: default
// ssrMaxDistance=50m is too small for typical Cesium scenes where
// reflective surfaces and tall reflectors are tens-to-hundreds of
// meters apart.
//
// This probe loads the same lake + wall setup with progressively
// larger ssrMaxDistance values and reports the diff against the
// SSR-off baseline. Goal: find a max-distance that engages SSR with
// the wall reflector and quantify the visual signal.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEW = { lon: -79.9959, lat: 40.4406, height: 380.0 };

async function capture(label, { ssr, maxDistance, strength, steps }) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
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

  const diag = await page.evaluate(
    async ({ view, ssr, maxDistance, strength, steps }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.scene.globe.enableLighting = true;
      v.scene.enableSSR = ssr;
      v.scene.ssrReflectionStrength = strength;
      v.scene.ssrMaxDistance = maxDistance;
      v.scene.ssrMaxSteps = steps;
      v.scene.ssrThickness = 1.0;
      v.scene.ssrStride = 1.0;

      // Lake — bigger so the camera sees more of it.
      const lake = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(
              C.Cartesian3.fromDegreesArray([
                view.lon - 0.004, view.lat - 0.002,
                view.lon + 0.004, view.lat - 0.002,
                view.lon + 0.004, view.lat + 0.002,
                view.lon - 0.004, view.lat + 0.002,
              ]),
            ),
            height: 240,
            vertexFormat:
              C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          }),
        }),
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType("Color", {
            color: new C.Color(0.03, 0.05, 0.12, 1.0),
          }),
          translucent: false,
        }),
        asynchronous: false,
      });
      v.scene.primitives.add(lake);

      // Bright tall wall RIGHT next to the lake (~30m offset). The
      // reflection ray from a near-lake pixel only has to traverse a
      // few meters to hit the wall.
      const wall = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(
              C.Cartesian3.fromDegreesArray([
                view.lon - 0.003, view.lat + 0.00203,
                view.lon + 0.003, view.lat + 0.00203,
                view.lon + 0.003, view.lat + 0.00208,
                view.lon - 0.003, view.lat + 0.00208,
              ]),
            ),
            height: 240,
            extrudedHeight: 360, // 120m tall
            vertexFormat:
              C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          }),
        }),
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType("Color", {
            color: new C.Color(1.0, 0.9, 0.2, 1.0),
          }),
          translucent: false,
        }),
        asynchronous: false,
      });
      v.scene.primitives.add(wall);

      // Camera south of lake, low + glancing angle north toward wall.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          view.lon,
          view.lat - 0.005,
          view.height,
        ),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-12),
        },
      });

      for (let i = 0; i < 1200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }
      for (let i = 0; i < 60; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Sample several pixels along the lake's near edge — that's
      // where the wall reflection should land.
      const canvas = v.canvas;
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      tmp.getContext("2d").drawImage(canvas, 0, 0);
      const samples = [];
      for (const py of [0.6, 0.65, 0.7, 0.75, 0.8]) {
        const y = Math.round(canvas.height * py);
        for (const px of [0.4, 0.5, 0.6]) {
          const x = Math.round(canvas.width * px);
          const d = tmp.getContext("2d").getImageData(x, y, 1, 1).data;
          samples.push({ px, py, r: d[0], g: d[1], b: d[2] });
        }
      }

      return {
        ssr,
        maxDistance,
        strength,
        primitivesCount: v.scene.primitives.length,
        samples,
      };
    },
    { view: VIEW, ssr, maxDistance, strength, steps },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(500);
  const out = path.join(OUT_DIR, `ssr-tuned-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diag, deviceErrors };
}

async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const r = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return { w: c.width, h: c.height, d: c.getContext("2d").getImageData(0, 0, c.width, c.height).data };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      let mm = 0, sum = 0;
      for (let i = 0; i < a.d.length; i += 4) {
        const d = Math.abs(a.d[i] - b.d[i]) + Math.abs(a.d[i + 1] - b.d[i + 1]) + Math.abs(a.d[i + 2] - b.d[i + 2]);
        sum += d;
        if (d > 20) mm++;
      }
      return { mismatchPct: (100 * mm) / (a.w * a.h), meanDelta: sum / (a.w * a.h) };
    },
    { ba, bb },
  );
  await browser.close();
  return r;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const cells = [];
  cells.push(await capture("a-ssr-off", { ssr: false, maxDistance: 50, strength: 0, steps: 64 }));
  cells.push(await capture("b-default", { ssr: true, maxDistance: 50, strength: 1.0, steps: 64 }));
  cells.push(await capture("c-md200", { ssr: true, maxDistance: 200, strength: 1.0, steps: 64 }));
  cells.push(await capture("d-md500", { ssr: true, maxDistance: 500, strength: 1.0, steps: 128 }));
  cells.push(await capture("e-md500-soft", { ssr: true, maxDistance: 500, strength: 0.7, steps: 128 }));

  console.log("[probe-ssr-tuned] cell diagnostics:");
  for (const c of cells) {
    const avg = c.diag.samples.reduce(
      (a, s) => ({ r: a.r + s.r, g: a.g + s.g, b: a.b + s.b }),
      { r: 0, g: 0, b: 0 },
    );
    const n = c.diag.samples.length;
    console.log(
      `  [${c.label}] errors=${c.deviceErrors.length}  ssr=${c.diag.ssr} maxDist=${c.diag.maxDistance} strength=${c.diag.strength}` +
      `  avgPix=rgba(${Math.round(avg.r / n)}, ${Math.round(avg.g / n)}, ${Math.round(avg.b / n)})`,
    );
  }

  console.log("\n[probe-ssr-tuned] diffs vs baseline (A = ssr off):");
  for (let i = 1; i < cells.length; i++) {
    const d = await diffPngs(cells[0].out, cells[i].out);
    console.log(
      `  [A vs ${cells[i].label}]: mismatch=${d.mismatchPct.toFixed(3)}% meanDelta=${d.meanDelta.toFixed(3)}`,
    );
  }
})();
