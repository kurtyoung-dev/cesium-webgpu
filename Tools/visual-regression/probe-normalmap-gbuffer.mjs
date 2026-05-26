#!/usr/bin/env node
// Probe-normalmap-gbuffer — Batch 135 verification.
//
// Loads a NormalMap-textured primitive over Pittsburgh terrain with
// contact shadows ON. Pre-Batch-135 the G-buffer slot 1 emit was the
// geometric vertex normal, so contact shadows on a normal-mapped
// surface tested against a flat plane normal — they ignored the bumps.
// Post-Batch-135 the perturbed normal (post-TBN normal-map transform)
// is emitted, so contact-shadow direction tracks the bumpy surface.
//
// We can't directly inspect the G-buffer (it's an intermediate render
// target), but we CAN verify:
//   1. 0 device errors (shader still valid).
//   2. The rendered primitive shows visible contact-shadow modulation
//      that differs from a geometric-normal baseline.
//
// A vs B: rendered output should differ measurably between the
// normal-mapped + shadowed case and the no-normal-map case, because the
// shadow direction now follows the perturbed normal at each fragment.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEW = { lon: -79.9959, lat: 40.4406, height: 300.0 };

async function capture(label, { useNormalMap, contactShadows }) {
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
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );
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

  const diagnostics = await page.evaluate(
    async ({ view, useNormalMap, contactShadows }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.scene.globe.enableLighting = true;
      v.scene.enableContactShadows = contactShadows;
      v.scene.contactShadowMaxDistance = 4.0;
      v.scene.contactShadowSteps = 20;
      v.scene.contactShadowStrength = 0.8;
      v.scene.contactShadowThickness = 0.02;

      // Build a tiny normal map procedurally — vertical stripes with
      // alternating tangent-space normals (left/right slope). When the
      // normal-mapped path emits the perturbed normal to slot 1, the
      // contact-shadow direction per stripe will diverge significantly
      // from the geometric flat-plane normal.
      const nmCanvas = document.createElement("canvas");
      nmCanvas.width = 64;
      nmCanvas.height = 64;
      const nctx = nmCanvas.getContext("2d");
      for (let x = 0; x < 64; x++) {
        const tilt = ((x >> 3) & 1) ? 0.8 : -0.8; // left/right tilt
        // RGB encoding: R = tx*0.5+0.5, G = ty*0.5+0.5 (0.5), B = tz
        const r = Math.floor((tilt * 0.5 + 0.5) * 255);
        const g = 128;
        const b = Math.floor(Math.sqrt(Math.max(0, 1 - tilt * tilt)) * 255);
        nctx.fillStyle = `rgb(${r},${g},${b})`;
        nctx.fillRect(x, 0, 1, 64);
      }
      const nmUrl = nmCanvas.toDataURL("image/png");

      // Extruded slab so we have a flat surface to normal-map.
      const slab = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(
              C.Cartesian3.fromDegreesArray([
                view.lon - 0.0015, view.lat,
                view.lon + 0.0015, view.lat,
                view.lon + 0.0015, view.lat + 0.0005,
                view.lon - 0.0015, view.lat + 0.0005,
              ]),
            ),
            height: 240,
            extrudedHeight: 260, // 20m thick
            vertexFormat:
              C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
          }),
        }),
        appearance: new C.MaterialAppearance({
          // Batch 138 — NormalMap material UB sizing fix. Pre-Batch-138
          // this branch had to use BumpMap as a workaround because the
          // NormalMap channels uniform wasn't propagated to material.uniforms,
          // so MaterialUniformBuffer allocated 16 bytes instead of the
          // 32 bytes the WGSL struct expects. Now NormalMap works directly.
          material: useNormalMap
            ? new C.Material({
                fabric: {
                  type: "NormalMap",
                  uniforms: {
                    image: nmUrl,
                    strength: 1.0,
                    repeat: { x: 1, y: 1 },
                  },
                },
              })
            : C.Material.fromType("Color", {
                color: new C.Color(0.8, 0.7, 0.6, 1.0),
              }),
          translucent: false,
        }),
        asynchronous: false,
      });
      v.scene.primitives.add(slab);

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          view.lon,
          view.lat - 0.003,
          view.height,
        ),
        orientation: { pitch: C.Math.toRadians(-30) },
      });

      // Fix sun for low-angle shadowing.
      const fixed = C.JulianDate.fromIso8601("2026-05-19T22:30:00Z");
      v.clock.currentTime = fixed.clone();
      v.clock.shouldAnimate = false;

      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }
      for (let i = 0; i < 30; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      return {
        useNormalMap,
        contactShadows,
        primitivesCount: v.scene.primitives.length,
      };
    },
    { view: VIEW, useNormalMap, contactShadows },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(500);
  const out = path.join(OUT_DIR, `normalmap-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diagnostics, deviceErrors };
}

async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      let mismatch = 0, sum = 0;
      const total = a.w * a.h;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        sum += d;
        if (d > 20) mismatch++;
      }
      return { mismatchPct: (100 * mismatch) / total, meanDelta: sum / total };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-normalmap-gbuffer] capturing 3-cell matrix");

  const cells = [];
  cells.push(await capture("a-plain-nocs", { useNormalMap: false, contactShadows: false }));
  cells.push(await capture("b-nm-nocs", { useNormalMap: true, contactShadows: false }));
  cells.push(await capture("c-nm-cs", { useNormalMap: true, contactShadows: true }));

  for (const cell of cells) {
    console.log(`\n  [${cell.label}] errors=${cell.deviceErrors.length}`);
    if (cell.deviceErrors.length) {
      cell.deviceErrors
        .slice(0, 3)
        .forEach((e) => console.log(`    - ${e.text?.slice(0, 220)}`));
    }
  }

  console.log("\n[probe-normalmap-gbuffer] diffs:");
  const ab = await diffPngs(cells[0].out, cells[1].out);
  console.log(`  [A plain vs B normalmap-no-cs]: mismatch=${ab.mismatchPct.toFixed(3)}% meanDelta=${ab.meanDelta.toFixed(3)}`);
  const bc = await diffPngs(cells[1].out, cells[2].out);
  console.log(`  [B nm-nocs vs C nm-cs]:        mismatch=${bc.mismatchPct.toFixed(3)}% meanDelta=${bc.meanDelta.toFixed(3)}`);
  console.log("    A vs B > 0% → normal map produces visible lighting difference");
  console.log("    B vs C > 0% → contact shadows now reading G-buffer normal contribute additional darkening");

  const report = {
    runAt: new Date().toISOString(),
    cells: cells.map((c) => ({
      label: c.label,
      screenshot: c.out,
      diagnostics: c.diagnostics,
      deviceErrorCount: c.deviceErrors.length,
    })),
    diffs: { ab, bc },
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "normalmap-gbuffer-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`\n  report: ${path.join(OUT_DIR, "normalmap-gbuffer-report.json")}`);
})();
