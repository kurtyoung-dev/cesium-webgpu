#!/usr/bin/env node
/**
 * Probe: OIT-PRIMITIVE-REACHABLE (C11-157 Slice A).
 * @purpose C11-157 Slice A: MRT-OIT reachable for translucent primitives via both injectOITOutput branches; FAR-003 runtime flip, hard gates.
 * @status ACTIVE
 *
 * Proves the WebGPU MRT-OIT accumulation path is now REACHABLE for standard
 * translucent PRIMITIVES (the Batch-700 evidence probe proved it was NOT — no
 * Pass.TRANSLUCENT command carried `_shaderCode`/`_oitPipeline`). Slice A wires
 * translucent primitive color commands with the OIT variant inputs, so
 * `executeTranslucentPass` auto-builds the accumulation pipeline under the
 * FAR-003 `_webgpuOITEnabled` gate.
 *
 * FAR-003 stays DEFAULT-OFF — this probe FLIPS the gate at runtime via
 * CesiumDebug.webgpuOIT(true); it does not change the default.
 *
 * Scenes (WebGPU, msaaSamples=1 so the single-sample OIT accumulation targets
 * are sample-consistent — MSAA×OIT accumulation is the pre-existing tracked
 * adjacency NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING, out of Slice A scope):
 *   - lit  : the canonical Batch-700 scene — three intersecting translucent
 *            ellipsoids + a translucent polygon (PerInstanceColorAppearance,
 *            flat:false → LIT PrimitivePhongColor → FragOutput struct → OIT via
 *            the injectOITOutput STRUCT branch).
 *   - flat : a translucent PerInstanceColorAppearance({flat:true}) ellipsoid
 *            Primitive (→ PrimitiveBasicColor → single-@location → OIT via the
 *            legacy injectOITOutput path).
 *
 * Per scene: capture gate-OFF (sorted alpha, the default), flip the gate ON,
 * render, read `_webgpuOITActiveThisFrame`, capture gate-ON, restore.
 *
 * HARD GATES: gate-ON `_webgpuOITActiveThisFrame === true` (was ALWAYS false),
 * 0 device/validation errors, gate-ON non-black, and gate-ON visibly DIFFERS
 * from gate-OFF (the accumulation path actually changed the pixels — not a
 * no-op). Gate-OFF stability (two captures within the dither noise floor) is
 * recorded.
 *
 * Usage: node Tools/visual-regression/probe-oit-primitive-reachable.mjs
 * Out:   Tools/visual-regression/output/oitprim-*.png + oitprim-report.json
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const CLOCK_ISO = "2026-06-21T18:00:00Z";
const VIEWPORT = { width: 800, height: 600 };

// 3-minute HARD watchdog (machine safety: kill a hung Edge/device rather than
// wedge the box). Cleared on normal completion.
const watchdog = setTimeout(
  () => {
    console.error("[probe-oitprim] WATCHDOG 3min — forcing exit(3)");
    process.exit(3);
  },
  3 * 60 * 1000,
);

async function setupViewer(page, { sceneKind }) {
  return await page.evaluate(
    async ({ sceneKind, clockIso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      if (window.viewer && !window.viewer.isDestroyed()) {
        try {
          window.viewer.destroy();
        } catch (e) {
          void e;
        }
      }
      window.viewer = undefined;
      let container = document.getElementById("cesiumContainer");
      if (!container) {
        container = document.createElement("div");
        container.id = "cesiumContainer";
        document.body.appendChild(container);
      }
      container.innerHTML = "";
      Object.assign(container.style, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "800px",
        height: "600px",
      });

      const v = await C.Viewer.createAsync("cesiumContainer", {
        contextOptions: { renderer: "webgpu" },
        // Slice A: OIT accumulation targets are single-sample; keep the scene
        // single-sample so the accumulation render pass is sample-consistent.
        msaaSamples: 1,
        baseLayerPicker: false,
        geocoder: false,
        timeline: false,
        animation: false,
        fullscreenButton: false,
        navigationHelpButton: false,
        homeButton: false,
        sceneModePicker: false,
        infoBox: false,
        selectionIndicator: false,
        shouldAnimate: false,
      });
      window.__probeViewer = v;
      window.viewer = v;
      if (typeof C.CesiumDebug === "function") {
        try {
          C.CesiumDebug(v);
        } catch (e) {
          void e;
        }
      }

      const scene = v.scene;
      scene.msaaSamples = 1;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601(clockIso);

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = new C.Color(0.02, 0.02, 0.04, 1.0);
      scene.fog.enabled = false;
      if (scene.postProcessStages && scene.postProcessStages.fxaa) {
        scene.postProcessStages.fxaa.enabled = false;
      }

      const LON = -75.0;
      const LAT = 40.0;
      const H = 200.0;

      if (sceneKind === "lit") {
        // Canonical Batch-700 scene: three intersecting translucent ellipsoids
        // + a translucent polygon (entities → PerInstanceColorAppearance
        // flat:false → LIT PrimitivePhongColor).
        const dLon = 0.00042;
        const dLat = 0.00032;
        const radii = new C.Cartesian3(60, 60, 60);
        const ellipsoids = [
          { off: [0, dLat], color: new C.Color(1.0, 0.15, 0.15, 0.5) },
          {
            off: [-dLon, -dLat * 0.6],
            color: new C.Color(0.15, 1.0, 0.2, 0.5),
          },
          { off: [dLon, -dLat * 0.6], color: new C.Color(0.2, 0.35, 1.0, 0.5) },
        ];
        for (const e of ellipsoids) {
          v.entities.add({
            position: C.Cartesian3.fromDegrees(
              LON + e.off[0],
              LAT + e.off[1],
              H,
            ),
            ellipsoid: { radii, material: e.color, outline: false },
          });
        }
        const s = 0.0011;
        v.entities.add({
          polygon: {
            hierarchy: new C.PolygonHierarchy([
              C.Cartesian3.fromDegrees(LON - s, LAT - s, H),
              C.Cartesian3.fromDegrees(LON + s, LAT - s, H),
              C.Cartesian3.fromDegrees(LON + s, LAT + s, H),
              C.Cartesian3.fromDegrees(LON - s, LAT + s, H),
            ]),
            material: new C.Color(1.0, 0.9, 0.1, 0.4),
            perPositionHeight: true,
            outline: false,
          },
        });
      } else {
        // FLAT translucent primitive: PerInstanceColorAppearance({flat:true})
        // over intersecting EllipsoidGeometry instances → PrimitiveBasicColor
        // (single-@location) → OIT via the legacy injectOITOutput path.
        const dLon = 0.00042;
        const dLat = 0.00032;
        const mk = (off, color) =>
          new C.GeometryInstance({
            geometry: new C.EllipsoidGeometry({
              radii: new C.Cartesian3(60, 60, 60),
              vertexFormat: C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
            }),
            modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
              C.Cartesian3.fromDegrees(LON + off[0], LAT + off[1], H),
            ),
            attributes: {
              color: C.ColorGeometryInstanceAttribute.fromColor(color),
            },
          });
        scene.primitives.add(
          new C.Primitive({
            geometryInstances: [
              mk([0, dLat], new C.Color(1.0, 0.15, 0.15, 0.5)),
              mk([-dLon, -dLat * 0.6], new C.Color(0.15, 1.0, 0.2, 0.5)),
              mk([dLon, -dLat * 0.6], new C.Color(0.2, 0.35, 1.0, 0.5)),
            ],
            appearance: new C.PerInstanceColorAppearance({
              flat: true,
              translucent: true,
              closed: true,
            }),
            asynchronous: false,
          }),
        );
      }

      const center = C.Cartesian3.fromDegrees(LON, LAT, H);
      v.camera.lookAt(
        center,
        new C.HeadingPitchRange(
          C.Math.toRadians(35),
          C.Math.toRadians(-22),
          420,
        ),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);

      for (let i = 0; i < 45; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-oitprim", "1");
      return {
        renderer: scene.context.rendererType,
        msaa: scene.msaaSamples,
        hasAlternateRenderer: !!scene._alternateSceneRenderer,
      };
    },
    { sceneKind, clockIso: CLOCK_ISO },
  );
}

async function grabCanvas(page) {
  // Render fresh frames immediately before the screenshot. A WebGPU canvas has
  // no preserveDrawingBuffer, so the swapchain image can read back black if the
  // last present happened a while before Playwright grabs it. Rendering right
  // before capture guarantees current content without changing the OIT gate.
  await page.evaluate(async () => {
    const scene = window.__probeViewer.scene;
    for (let i = 0; i < 3; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const png = await page
    .locator('canvas[data-oitprim="1"]')
    .screenshot({ type: "png" });
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { w: bmp.width, h: bmp.height, data: Array.from(d) };
  }, Buffer.from(png).toString("base64"));
  return { decoded };
}

function nonBlackFrac(img) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] > 14 || img.data[i + 1] > 14 || img.data[i + 2] > 14) n++;
  }
  return +((100 * n) / (img.data.length / 4)).toFixed(2);
}

function diffPixels(a, b, thr = 16) {
  if (!a || !b || a.w !== b.w || a.h !== b.h)
    return { mismatch: 0, pct: null, maxDelta: null };
  let px = 0;
  let mismatch = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    px++;
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    const m = Math.max(dr, dg, db);
    if (m > maxDelta) maxDelta = m;
    if (dr > thr || dg > thr || db > thr) mismatch++;
  }
  return {
    mismatch,
    pct: px ? +((100 * mismatch) / px).toFixed(3) : null,
    maxDelta,
  };
}

function centralMean(img) {
  const x0 = Math.floor(img.w * 0.35);
  const x1 = Math.floor(img.w * 0.65);
  const y0 = Math.floor(img.h * 0.35);
  const y1 = Math.floor(img.h * 0.65);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n++;
    }
  }
  return {
    r: +(r / n).toFixed(1),
    g: +(g / n).toFixed(1),
    b: +(b / n).toFixed(1),
  };
}

// ── zero-dep PNG encoder ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePNG({ w, h, data }) {
  const bpr = w * 4;
  const raw = Buffer.alloc((bpr + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (bpr + 1)] = 0;
    Buffer.from(data.slice(y * bpr, (y + 1) * bpr)).copy(
      raw,
      y * (bpr + 1) + 1,
    );
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const tb = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([tb, body])), 0);
    return Buffer.concat([len, tb, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BENIGN_TEARDOWN_RE =
  /reason:\s*destroyed|Device was destroyed|Device lost: destroyed/i;
function realFaults(consoleErrors) {
  return consoleErrors.filter((e) => !BENIGN_TEARDOWN_RE.test(e));
}

async function runScene(page, consoleErrors, sceneKind) {
  const setup = await setupViewer(page, { sceneKind });
  await armWebGPUDevices(page);

  // Gate-OFF (default sorted alpha).
  const off1 = await grabCanvas(page);
  fs.writeFileSync(
    path.join(OUT_DIR, `oitprim-${sceneKind}-off.png`),
    encodePNG(off1.decoded),
  );
  // Second gate-OFF capture (no toggle) → dither noise floor.
  await page.evaluate(async () => {
    const scene = window.__probeViewer.scene;
    for (let i = 0; i < 8; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const off2 = await grabCanvas(page);
  const noiseFloor = diffPixels(off1.decoded, off2.decoded, 0);

  // Gate-ON.
  const status = await page.evaluate(async () => {
    const cd = window.CesiumDebug;
    const toggled = cd.webgpuOIT(true);
    const scene = window.__probeViewer.scene;
    const sr = scene._alternateSceneRenderer;
    let sawActive = false;
    for (let i = 0; i < 30; i++) {
      scene.render();
      if (sr && sr._webgpuOITActiveThisFrame) sawActive = true;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      toggled,
      live: cd.webgpuOIT(),
      sawOITActiveAnyFrame: sawActive,
      activeThisFrame: !!(sr && sr._webgpuOITActiveThisFrame),
    };
  });
  const on = await grabCanvas(page);
  fs.writeFileSync(
    path.join(OUT_DIR, `oitprim-${sceneKind}-on.png`),
    encodePNG(on.decoded),
  );

  // Restore containment.
  await page.evaluate(async () => {
    window.CesiumDebug.webgpuOIT(false);
    const scene = window.__probeViewer.scene;
    for (let i = 0; i < 20; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const restored = await grabCanvas(page);
  const restoreDiff = diffPixels(off1.decoded, restored.decoded, 0);

  const gate = await collectGateErrors(page);
  const faults = realFaults(consoleErrors);
  const errors = gate.errors.length + faults.length + (gate.deviceLost ? 1 : 0);

  const offNB = nonBlackFrac(off1.decoded);
  const onNB = nonBlackFrac(on.decoded);
  const onVsOff = diffPixels(on.decoded, off1.decoded, 16);

  return {
    sceneKind,
    setup,
    status,
    errors,
    gateErrorsSample: gate.errors.slice(0, 6),
    consoleFaults: faults.slice(0, 6),
    offNonBlack: offNB,
    onNonBlack: onNB,
    offMean: centralMean(off1.decoded),
    onMean: centralMean(on.decoded),
    onVsOff_diffPct: onVsOff.pct,
    onVsOff_maxDelta: onVsOff.maxDelta,
    noiseFloor_mismatchPx: noiseFloor.mismatch,
    noiseFloor_maxDelta: noiseFloor.maxDelta,
    restoreVsOff_mismatchPx: restoreDiff.mismatch,
    restoreVsOff_maxDelta: restoreDiff.maxDelta,
  };
}

// ─────────────────────────────── run ───────────────────────────────
const report = { base: BASE, scenes: {} };
fs.mkdirSync(OUT_DIR, { recursive: true });
let overallPass = true;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
try {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  // Machine safety: one scene per invocation keeps each Edge session short and
  // bounded. `SCENE=lit|flat` selects one; default runs both.
  const only = (process.env.SCENE || "").trim();
  const kinds = only === "lit" || only === "flat" ? [only] : ["lit", "flat"];
  for (const kind of kinds) {
    const r = await runScene(page, consoleErrors, kind);
    report.scenes[kind] = r;
    // HARD GATES: OIT engaged this frame, 0 errors, non-black, and the render
    // actually CHANGED vs sorted alpha (non-degenerate accumulation).
    const pass =
      r.status.activeThisFrame === true &&
      r.errors === 0 &&
      r.onNonBlack > 8 &&
      r.onVsOff_diffPct !== null &&
      r.onVsOff_diffPct > 0.5 &&
      r.restoreVsOff_mismatchPx <= Math.max(r.noiseFloor_mismatchPx * 3, 3);
    r.pass = pass;
    if (!pass) overallPass = false;
  }
} finally {
  await browser.close();
}

const outPath = path.join(OUT_DIR, "oitprim-report.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.scenes, null, 2));
console.log(`\nReport: ${outPath}`);
clearTimeout(watchdog);
console.log(
  overallPass
    ? "\nGATE PASS — translucent PRIMITIVES (lit canonical + flat) now REACH the WebGPU MRT-OIT accumulation: _webgpuOITActiveThisFrame=true, 0 errors, non-degenerate blended output, containment restores."
    : "\nGATE FAIL — see scene table.",
);
process.exit(overallPass ? 0 : 1);
