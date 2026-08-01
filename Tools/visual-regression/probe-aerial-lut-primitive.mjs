#!/usr/bin/env node
// Probe-aerial-lut-primitive — Verify FEAT-GAP-09 wiring on primitives.
//
// Hypothesis (Batch 96 audit): the primitive effects bind group path
// (`_getOrCreateSharedPrimitiveEffectsBG` in `WebGPUPrimitiveCommands.js`)
// does NOT forward `atmosphereLutTransmittanceView` / `atmosphereLutInscatterView`
// to `createEffectsBindGroup`. So even though PrimitiveBasicColor and
// PrimitiveMatColorLit (and all other Lit variants) have the aerial-LUT
// WGSL block, their `effects.atmosphereLutControl.x` is always 0.0 and
// the fog block is dead code. This probe surfaces the gap.
//
// What the probe does:
//   - Capture A: polyline + atmosphere ON. If FEAT-GAP-09 is wired
//     correctly the polyline should fog out at distance.
//   - Capture B: polyline + atmosphere OFF (`skyAtmosphere.show = false`).
//     Polyline appears at full color.
//   - Diff: with the wiring broken, A vs B should differ ONLY in the
//     sky region (no atmosphere = no sky), and the polyline pixels
//     should be ~identical between A and B (because the fog block
//     isn't running on the polyline).
//   - With the wiring fixed, A vs B should differ in BOTH the sky
//     region AND the polyline region.
//
// We also dump the JS-side state — `effects.atmosphereLutControl.x` as
// it appears in the primitive command path — by inspecting the active
// effects bind group bytes via `CesiumDebug`.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

async function capture(label, { atmosphereOn }) {
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

  const diagnostics = await page.evaluate(
    async ({ clockUTC, atmosphereOn }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      // Select WGS84 ellipsoid (no elevation, but imagery still loads).
      // Cesium World Terrain needs an Ion token in headless mode and
      // hangs the canvas otherwise — WGS84 gives us a textured flat
      // surface, which is fine for testing primitive fog.
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;

      v.scene.globe.enableLighting = false;
      v.scene.skyAtmosphere.show = atmosphereOn;
      // Force-enable the existing wired aerial-perspective LUT path.
      // (No public API toggle today; the LUT compute dispatcher kicks
      // in based on SkyAtmosphere visibility — pinning the show flag
      // above is the lever.)

      // Add a Box primitive over the Grand Canyon — uses the Mat
      // shader pipeline (PrimitiveMatColorFlat or *Lit depending on
      // appearance flags). This is what we need in the scene to make
      // `_getOrCreateSharedPrimitiveEffectsBG` run, so the toggle
      // hash + LUT wiring can be verified.
      // Huge magenta box centered on the camera's lookat point, sized
      // so it dominates the bottom-half of the frame. PerInstanceColor
      // Appearance with `flat: false` routes through the Lit Mat
      // shader pipeline (PrimitiveMatColorLit), which has the
      // aerial-LUT WGSL block wired.
      let primError = null;
      try {
        const center = C.Cartesian3.fromDegrees(-112.1129, 36.0544, 0);
        const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(center);
        const boxGeom = C.BoxGeometry.fromDimensions({
          vertexFormat: C.VertexFormat.POSITION_AND_NORMAL,
          dimensions: new C.Cartesian3(5000.0, 5000.0, 5000.0),
        });
        const boxInstance = new C.GeometryInstance({
          geometry: boxGeom,
          modelMatrix,
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              new C.Color(1.0, 0.0, 1.0, 1.0),
            ),
          },
        });
        v.scene.primitives.add(
          new C.Primitive({
            geometryInstances: boxInstance,
            appearance: new C.PerInstanceColorAppearance({
              flat: false,
            }),
          }),
        );
      } catch (e) {
        primError = e.message;
      }

      // Grand Canyon view that the Slice 4 probe confirmed renders
      // terrain. The polyline added above runs east-west across the
      // canyon, so its far end sits where atmospheric scattering
      // should fade it.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-112.1129, 36.0544, 8_000),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-30),
        },
      });

      for (let i = 0; i < 600; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 200) break;
      }

      // Diagnostic dump: report what the active primitive effects BG
      // would actually contain.
      const ctx = v.scene.context;
      const pm = ctx?.performanceManager;
      const lutResources =
        pm?.ensureAtmosphereLUTResources?.(ctx.device) ?? null;
      return {
        rendererType: ctx?.rendererType,
        atmosphereOn,
        skyAtmosphereShow: v.scene.skyAtmosphere.show,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        lutResources_exists: !!lutResources,
        lutResources_transmittanceView: !!lutResources?.transmittanceView,
        lutResources_inscatterView: !!lutResources?.inscatterView,
        // Batch 96 — the toggle hash encodes which features the
        // primitive effects BG was built with. Bits: 1=shadow, 2=CSM,
        // 4=atmosphereLut. A value with bit 4 set means createEffectsBindGroup
        // was called with the LUT views — i.e., atmosphereLutControl.x
        // will be 1.0 in the UBO and the wired shaders will run their
        // fog block. Before the fix, this stayed at 0 because LUT
        // views were never forwarded.
        primEffectsBG_exists: !!ctx?._primitiveEffectsBG,
        primEffectsBG_toggleHash: ctx?._primitiveEffectsBGToggleHash ?? null,
        primEffectsBG_hasLut:
          ((ctx?._primitiveEffectsBGToggleHash ?? 0) & 4) === 4,
        primError,
      };
    },
    { clockUTC: FIXED_CLOCK_UTC, atmosphereOn },
  );
  console.log(`    diag: ${JSON.stringify(diagnostics)}`);

  await page.waitForTimeout(2000);
  const out = path.join(OUT_DIR, `aerial-lut-prim-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();

  const errors = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { out, errors, diagnostics };
}

// Pixel-diff helper (mirrors probe-slice4-verify.mjs).
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
      const total = a.w * a.h;
      let mismatch = 0;
      let sum = 0;
      // Track diffs in two regions: top half (sky-dominant) vs bottom
      // half (terrain + polyline). The polyline crosses ~middle so the
      // bottom-half delta is the relevant one for primitive fog.
      let mismatchTop = 0;
      let mismatchBot = 0;
      const midY = (a.h / 2) | 0;
      for (let y = 0; y < a.h; y++) {
        for (let x = 0; x < a.w; x++) {
          const i = (y * a.w + x) * 4;
          const dr = Math.abs(a.data[i] - b.data[i]);
          const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
          const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
          const d = dr + dg + db;
          sum += d;
          if (d > 30) {
            mismatch++;
            if (y < midY) mismatchTop++;
            else mismatchBot++;
          }
        }
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: (100 * mismatch) / total,
        mismatchTopPct: (100 * mismatchTop) / (a.w * midY),
        mismatchBotPct: (100 * mismatchBot) / (a.w * (a.h - midY)),
        meanDelta: sum / total,
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-aerial-lut-primitive] capturing atmo on/off matrix");

  console.log("\n  [A] atmosphere ON  (LUT should fog polyline at distance)");
  const A = await capture("atmo-on", { atmosphereOn: true });
  console.log("\n  [B] atmosphere OFF (polyline at full color)");
  const B = await capture("atmo-off", { atmosphereOn: false });

  console.log("\n[probe-aerial-lut-primitive] diffs:");

  const diff = await diffPngs(A.out, B.out);
  console.log(`\n  [A vs B] atmosphere on vs off:`);
  console.log(
    `    overall: mismatch=${diff.mismatchPct.toFixed(3)}% meanDelta=${diff.meanDelta.toFixed(3)}`,
  );
  console.log(
    `    top-half (sky):    mismatch=${diff.mismatchTopPct.toFixed(3)}%`,
  );
  console.log(
    `    bottom-half (gnd): mismatch=${diff.mismatchBotPct.toFixed(3)}%`,
  );
  console.log(
    `    interpretation: sky delta is expected (atmosphere on→off removes sky).`,
  );
  console.log(
    `    Bottom-half delta should be LARGE if FEAT-GAP-09 wiring works`,
  );
  console.log(
    `    on primitives (polyline gets fogged at distance), and small/zero`,
  );
  console.log(`    if the wiring is broken (polyline immune to atmosphere).`);

  const reportPath = path.join(OUT_DIR, "aerial-lut-prim-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        clock: FIXED_CLOCK_UTC,
        captures: {
          A: { errors: A.errors.length, diag: A.diagnostics },
          B: { errors: B.errors.length, diag: B.diagnostics },
        },
        diffs: { atmoOnVsOff: diff },
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
