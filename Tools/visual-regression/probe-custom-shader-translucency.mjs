/**
 * PARITY-CUSTOM-SHADER-WGSL (translucencyMode slice) verification.
 *
 * WebGL's CustomShaderPipelineStage lets a CustomShader override the primitive's
 * render pass via `translucencyMode`: TRANSLUCENT forces the model into the
 * blended translucent pass even if its glTF material is authored OPAQUE; OPAQUE
 * forces it opaque; INHERIT (default) keeps the material's own alpha mode. Batch
 * 473 shipped the native-WGSL customShader body injection but ignored
 * translucencyMode entirely — an OPAQUE-authored model could not be made
 * see-through from a customShader on WebGPU.
 *
 * This probe renders the CesiumMilkTruck (authored OPAQUE) over a solid BLUE
 * background with a native-WGSL customShader whose body sets `material.alpha`
 * to a partial value (leaving diffuse = the lit PBR color). It captures:
 *
 *   A. OFF-GATE — no customShader. Opaque truck, device-error-free. Establishes
 *      the byte-identical baseline: translucencyMode changes NOTHING here.
 *   B. INHERIT — customShader alpha=0.35, translucencyMode INHERIT. The model is
 *      authored OPAQUE, so the alpha is IGNORED → the truck stays opaque and its
 *      centre pixels match the opaque baseline (NOT blended toward the blue bg).
 *   C. TRANSLUCENT — same customShader, translucencyMode TRANSLUCENT. The
 *      override forces the BLEND pipeline + translucent pass, so alpha=0.35
 *      blends the lit truck over the blue background → the model centre shifts
 *      strongly toward blue.
 *
 * GATE: C's model-centre mean blue is significantly higher than B's (the truck
 * became see-through only when translucencyMode=TRANSLUCENT), B stays close to
 * the opaque baseline A (INHERIT is a no-op for an OPAQUE model), and every
 * capture runs with zero WebGPU device errors.
 *
 * Usage: node Tools/visual-regression/probe-custom-shader-translucency.mjs
 *   PROBE_BASE (default http://localhost:8080)
 */
import { chromium } from "playwright";
import zlib from "zlib";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODEL = "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";

const HEADING = 0.6;
const PITCH = -0.3;

// Alpha-only native-WGSL customShader body: leaves diffuse untouched (= the lit
// PBR color the FS already computed) and only drops alpha, so the ONLY variable
// under test is whether translucencyMode routes the primitive to the blend pass.
const WGSL_FRAGMENT_ALPHA = `
fn czm_customFragmentMain(fsInput: czm_customFragmentInput, material: ptr<function, czm_customModelMaterial>) {
  (*material).alpha = 0.35;
}
`;

// translucencyMode: 0 INHERIT, 1 OPAQUE, 2 TRANSLUCENT (CustomShaderTranslucencyMode).
async function capture(useCustomShader, translucencyMode) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(
    async ({ modelUrl, heading, pitch, useCustomShader, translucencyMode, wgslFrag }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      for (const sel of [
        ".cesium-viewer-toolbar",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-bottom",
        ".cesium-navigation-help",
        ".cesium-viewer-fullscreenContainer",
      ]) {
        document.querySelectorAll(sel).forEach((e) => (e.style.display = "none"));
      }

      // Solid BLUE background so a translucent model reveals it (blend → bluer).
      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.backgroundColor = new C.Color(0.0, 0.0, 1.0, 1.0);

      let customShader;
      if (useCustomShader) {
        customShader = new C.CustomShader({
          wgslFragmentShaderText: wgslFrag,
          translucencyMode: translucencyMode,
        });
        window.__customShader = customShader;
      }

      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75, 40, 0),
      );
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 4.0,
        customShader,
      });
      scene.primitives.add(model);
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      v.camera.viewBoundingSphere(
        model.boundingSphere,
        new C.HeadingPitchRange(heading, pitch, model.boundingSphere.radius * 3.0),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      for (let i = 0; i < 40; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-cs", "1");
      return { ready: !!model.ready };
    },
    {
      modelUrl: MODEL,
      heading: HEADING,
      pitch: PITCH,
      useCustomShader,
      translucencyMode,
      wgslFrag: WGSL_FRAGMENT_ALPHA,
    },
  );

  const gateArm = await armWebGPUDevices(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  const gate = await collectGateErrors(page);

  const png = await page.locator('canvas[data-cs="1"]').screenshot({ type: "png" });
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { w: bmp.width, h: bmp.height, data: Array.from(d) };
  }, Buffer.from(png).toString("base64"));

  await browser.close();
  return {
    ready: info.ready,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
    png,
    decoded,
  };
}

// Mean color over the central crop (40%-60% in each axis), where the truck body
// sits under this framing. Only counts pixels that are NOT pure background blue
// (so we sample the model, not the surrounding bg) — a pixel is "model" if its
// red or green channel exceeds a small floor (blue bg has r=g≈0).
function centralModelMean(img, opaqueMode) {
  const x0 = Math.floor(img.w * 0.4);
  const x1 = Math.floor(img.w * 0.6);
  const y0 = Math.floor(img.h * 0.4);
  const y1 = Math.floor(img.h * 0.6);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * 4;
      // In opaque mode the truck has bright r/g; in blended mode it's dimmer but
      // still not pure bg. Count everything in the crop — the crop is chosen to
      // sit on the model silhouette for this fixed framing.
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n++;
    }
  }
  void opaqueMode;
  return {
    r: +(r / n).toFixed(1),
    g: +(g / n).toFixed(1),
    b: +(b / n).toFixed(1),
    n,
  };
}

// Whole-image diff over non-background pixels (used to prove C ≠ B).
function diffPixels(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { px: 0, mismatch: 0, pct: null };
  let px = 0, mismatch = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    px++;
    if (
      Math.abs(a.data[i] - b.data[i]) > 20 ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > 20 ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > 20
    ) {
      mismatch++;
    }
  }
  return { px, mismatch, pct: px ? +((100 * mismatch) / px).toFixed(2) : null };
}

// ── PNG encoder (zlib stored deflate) — zero external dep ──
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePNG({ w, h, data }) {
  const bpr = w * 4;
  const raw = Buffer.alloc((bpr + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (bpr + 1)] = 0;
    Buffer.from(data.slice(y * bpr, (y + 1) * bpr)).copy(raw, y * (bpr + 1) + 1);
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

// ── Captures ──
const off = await capture(false, 0); // A: off-gate, no customShader
const inherit = await capture(true, 0); // B: customShader alpha=0.35, INHERIT
const translucent = await capture(true, 2); // C: same, TRANSLUCENT

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
fs.writeFileSync("Tools/visual-regression/output/cs-trans-off.png", encodePNG(off.decoded));
fs.writeFileSync("Tools/visual-regression/output/cs-trans-inherit.png", encodePNG(inherit.decoded));
fs.writeFileSync("Tools/visual-regression/output/cs-trans-translucent.png", encodePNG(translucent.decoded));

const meanOff = centralModelMean(off.decoded, true);
const meanInherit = centralModelMean(inherit.decoded, true);
const meanTranslucent = centralModelMean(translucent.decoded, false);

const offVsInherit = diffPixels(off.decoded, inherit.decoded);
const inheritVsTranslucent = diffPixels(inherit.decoded, translucent.decoded);

const gateErrors = [
  ...off.gateErrors,
  ...inherit.gateErrors,
  ...translucent.gateErrors,
];
const deviceLost = off.deviceLost || inherit.deviceLost || translucent.deviceLost;

const report = {
  off: { ready: off.ready, mean: meanOff, gateArmed: off.gateArmed },
  inherit: { ready: inherit.ready, mean: meanInherit },
  translucent: { ready: translucent.ready, mean: meanTranslucent },
  offVsInherit_diffPct: offVsInherit.pct,
  inheritVsTranslucent_diffPct: inheritVsTranslucent.pct,
  gateErrors,
  deviceLost,
  consoleFaults: [
    ...off.consoleFaults,
    ...inherit.consoleFaults,
    ...translucent.consoleFaults,
  ].slice(0, 6),
};
console.log(JSON.stringify(report, null, 2));

// Gate:
//  - all captures ready, device-error-free.
//  - OFF-GATE: off ≈ inherit in the model centre (translucencyMode INHERIT is a
//    no-op for an OPAQUE-authored model — the alpha is ignored). Their central
//    means are within a tight tolerance and the whole-image diff is small.
//  - TRANSLUCENT EFFECT: translucent's model centre is markedly BLUER than
//    inherit's (blue channel up, red channel down as the truck blends over the
//    blue bg), and the images differ substantially.
const offInheritClose =
  Math.abs(meanOff.b - meanInherit.b) < 25 &&
  Math.abs(meanOff.r - meanInherit.r) < 25 &&
  (offVsInherit.pct === null || offVsInherit.pct < 5);
const becameBluer =
  meanTranslucent.b > meanInherit.b + 30 && meanTranslucent.r < meanInherit.r - 20;

const pass =
  off.ready &&
  inherit.ready &&
  translucent.ready &&
  gateErrors.length === 0 &&
  !deviceLost &&
  offInheritClose &&
  becameBluer &&
  inheritVsTranslucent.pct !== null &&
  inheritVsTranslucent.pct > 4;

console.log(
  JSON.stringify({
    offInheritClose,
    becameBluer,
    inheritVsTranslucent: inheritVsTranslucent.pct,
    offVsInherit: offVsInherit.pct,
  }),
);
console.log(
  pass
    ? "GATE PASS — customShader translucencyMode=TRANSLUCENT forces an OPAQUE-authored model into the blend pass (model blends over the bg); INHERIT is a byte-identical no-op; all captures device-error-free"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
