#!/usr/bin/env node
// Probe-contact-shadows — Slice 5c-B Batch 133 verification.
// @purpose Contact-shadows acceptance: wall base darkens when enabled, strength=0.5 darkens less than 1.0, all cells error-free.
// @status ACTIVE
//
// Loads an extruded "wall" polygon over the Pittsburgh terrain at a
// view where the sun is at a low angle. With contact shadows enabled,
// the BASE of the wall (where it meets terrain) should darken — the
// canonical contact-shadow signal.
//
// 3-cell matrix toggles enableContactShadows × strength:
//   A: off — baseline
//   B: on, strength=1.0 — maximum darkening
//   C: on, strength=0.5 — half darkening (verifies strength tuning)
//
// Expected:
//   - 0 device errors across all 3 cells
//   - A vs B: visible mismatch from the contact shadow darkening
//   - B vs C: smaller mismatch (strength halved produces less
//     darkening but still some)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Pittsburgh; sun at 18:00 UTC is at a low western angle perfect for
// long contact shadows on east-facing geometry.
// Close-altitude view so the contact shadow march distance is large
// relative to the eye-space depth (otherwise a 3-m sun-direction
// march doesn't traverse enough screen-space to reach any occluder).
const VIEW = { lon: -79.9959, lat: 40.4406, height: 300.0 };
const FIXED_CLOCK_UTC = "2026-05-19T22:30:00Z"; // late afternoon

async function capture(label, { cs, strength }) {
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
    async ({ view, clockUTC, cs, strength }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;
      v.scene.globe.enableLighting = true;
      v.scene.enableContactShadows = cs;
      v.scene.contactShadowStrength = strength;
      v.scene.contactShadowMaxDistance = 3.0;
      v.scene.contactShadowSteps = 16;
      // Fractional thickness — 1% of view depth covers most local
      // occluders without false-positive self-shadowing on the surface.
      v.scene.contactShadowThickness = 0.01;

      // Extruded wall — provides the occluder for contact shadow.
      const wallCoords = C.Cartesian3.fromDegreesArray([
        view.lon - 0.002,
        view.lat,
        view.lon + 0.002,
        view.lat,
        view.lon + 0.002,
        view.lat + 0.0003,
        view.lon - 0.002,
        view.lat + 0.0003,
      ]);
      const wall = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(wallCoords),
            height: 240,
            extrudedHeight: 280, // 40m tall
            vertexFormat:
              C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          }),
        }),
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType("Color", {
            color: new C.Color(0.85, 0.78, 0.65, 1.0),
          }),
          translucent: false,
        }),
        asynchronous: false,
      });
      v.scene.primitives.add(wall);

      // Camera positioned at glancing angle so the wall casts a contact
      // shadow visible toward the camera.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          view.lon,
          view.lat - 0.005,
          view.height,
        ),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-25),
        },
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 400) break;
      }
      for (let i = 0; i < 60; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const canvas = v.canvas;
      let centerPixel;
      try {
        const tmp = document.createElement("canvas");
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const ctx2d = tmp.getContext("2d");
        ctx2d.drawImage(canvas, 0, 0);
        const cx = (canvas.width / 2) | 0;
        const cy = (canvas.height / 2) | 0;
        const data = ctx2d.getImageData(cx, cy, 1, 1).data;
        centerPixel = { r: data[0], g: data[1], b: data[2], a: data[3] };
      } catch (e) {
        centerPixel = { error: String(e?.message ?? e) };
      }

      return {
        cs_requested: cs,
        scene_enableContactShadows: v.scene.enableContactShadows,
        strength: v.scene.contactShadowStrength,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        primitivesCount: v.scene.primitives.length,
        csFR_exists: !!v.scene.context?.getFeatureRenderer?.(48), // CONTACT_SHADOWS key
        centerPixel,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, cs, strength },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(1000);
  const out = path.join(OUT_DIR, `contact-shadows-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diagnostics, deviceErrors, messages };
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
      let mismatch = 0;
      let sum = 0;
      const total = a.w * a.h;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        sum += d;
        if (d > 30) mismatch++;
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
  console.log("[probe-contact-shadows] capturing 3-cell matrix");

  const cells = [];
  cells.push(await capture("a-off", { cs: false, strength: 0.0 }));
  cells.push(await capture("b-on-full", { cs: true, strength: 1.0 }));
  cells.push(await capture("c-on-half", { cs: true, strength: 0.5 }));

  for (const cell of cells) {
    console.log(`\n  [${cell.label}]`);
    console.log(
      `    canvas center: rgba(${cell.diagnostics.centerPixel?.r ?? "?"}, ${
        cell.diagnostics.centerPixel?.g ?? "?"
      }, ${cell.diagnostics.centerPixel?.b ?? "?"})`,
    );
    console.log(
      `    cs=${cell.diagnostics.scene_enableContactShadows} strength=${cell.diagnostics.strength} prims=${cell.diagnostics.primitivesCount} fr=${cell.diagnostics.csFR_exists}`,
    );
    if (cell.deviceErrors.length) {
      console.log(`    ✗ ${cell.deviceErrors.length} device errors`);
      cell.deviceErrors
        .slice(0, 2)
        .forEach((e) => console.log(`      ${e.text?.slice(0, 200)}`));
    } else {
      console.log(`    ✓ no device errors`);
    }
  }

  console.log("\n[probe-contact-shadows] diffs:");
  const aoff_bon = await diffPngs(cells[0].out, cells[1].out);
  console.log(
    `  [A off vs B on-full]: mismatch=${aoff_bon.mismatchPct.toFixed(3)}% meanDelta=${aoff_bon.meanDelta.toFixed(3)}`,
  );
  const bfull_chalf = await diffPngs(cells[1].out, cells[2].out);
  console.log(
    `  [B full vs C half]: mismatch=${bfull_chalf.mismatchPct.toFixed(3)}% meanDelta=${bfull_chalf.meanDelta.toFixed(3)}`,
  );
  console.log(
    `    A vs B > 0% → contact shadow darkening is producing visible output`,
  );
  console.log(
    `    B vs C > 0% but smaller → strength config tunes output magnitude`,
  );

  const reportPath = path.join(OUT_DIR, "contact-shadows-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        view: VIEW,
        cells: cells.map((c) => ({
          label: c.label,
          screenshot: c.out,
          diagnostics: c.diagnostics,
          deviceErrorCount: c.deviceErrors.length,
        })),
        diffs: { aoff_bon, bfull_chalf },
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
