// DP-H36 (Batch 325) — i3dm instance-translation RTE precision probe.
//
// Loads a real Earth-scale instanced (i3dm) 3D-Tiles tileset
// (InstancedWithBatchTable, ~Philadelphia, lon -75.61 / lat 40.04) on BOTH
// the WebGPU and WebGL viewers with a STATIONARY camera and the globe hidden
// (so only the instanced geometry shows against black).
//
// Two assertions:
//   1. STABILITY — capture frame A, render many more frames without touching
//      the camera, capture frame B. The instanced geometry must be
//      pixel-stable A↔B (deterministic; sanity that nothing flickers).
//   2. PLACEMENT — the WebGPU instanced render must match the WebGL render
//      (within a small tolerance). Pre-fix the per-instance translation was a
//      raw f32, so each instance landed up to ~1 m off its true ECEF position
//      → a visible pixel offset vs WebGL's proper RTE path. Post-fix the
//      translation is carried high/low and RTE'd against the encoded camera,
//      so the two backends place the instances identically.
//
// Usage: node Tools/visual-regression/probe-i3dm-instance-jitter.mjs
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
const TILESET =
  "/Apps/SampleData/Cesium3DTiles/Instanced/InstancedWithBatchTable/tileset.json";

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

// Shared scene setup: load tileset, frame it from a fixed oblique view,
// hide globe/sky, warm frames, then return a base64 PNG of the canvas.
// `capture` is called twice for WebGPU (A then B) without moving the camera.
async function runBackend(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("PROBE:")) console.log(`[${renderer}] ${t}`);
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const result = await page.evaluate(
    async ({ tilesetUrl }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      // Deterministic frame loop — disable requestRenderMode so render() always
      // re-renders, and freeze the clock so animation can't perturb anything.
      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;

      const ts = await C.Cesium3DTileset.fromUrl(tilesetUrl);
      scene.primitives.add(ts);
      // Wait for the tileset root content to load + render.
      for (let i = 0; i < 90; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Frame the instanced content from a fixed oblique angle, zoomed in so a
      // sub-meter placement error becomes a visible pixel offset.
      const bs = ts.boundingSphere;
      const cart = C.Cartographic.fromCartesian(bs.center);
      v.camera.setView({
        destination: C.Cartesian3.fromRadians(
          cart.longitude,
          cart.latitude,
          cart.height + bs.radius * 3.0,
        ),
        orientation: {
          heading: C.Math.toRadians(20),
          pitch: C.Math.toRadians(-35),
          roll: 0,
        },
      });

      // Hide globe + sky so ONLY the instanced geometry shows against black —
      // isolates the instance placement from terrain/atmosphere.
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const renderN = async (n) => {
        for (let i = 0; i < n; i++) {
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      };

      const grab = () => {
        const canvas = scene.canvas;
        const c2 = document.createElement("canvas");
        c2.width = canvas.width;
        c2.height = canvas.height;
        c2.getContext("2d").drawImage(canvas, 0, 0);
        return {
          w: canvas.width,
          h: canvas.height,
          dataUrl: c2.toDataURL("image/png"),
        };
      };

      // Count non-black coverage in the center region (placement sanity).
      const coverage = (dataUrl, w, h) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const cc = document.createElement("canvas");
            cc.width = w;
            cc.height = h;
            const cx = cc.getContext("2d");
            cx.drawImage(img, 0, 0);
            const d = cx.getImageData(0, 0, w, h).data;
            let nonBlack = 0;
            for (let i = 0; i < d.length; i += 4) {
              if (d[i] + d[i + 1] + d[i + 2] > 24) nonBlack++;
            }
            resolve(nonBlack);
          };
          img.src = dataUrl;
        });

      // Warm, capture A, render many more (stationary), capture B.
      await renderN(60);
      const A = grab();
      await renderN(180);
      const B = grab();

      const covA = await coverage(A.dataUrl, A.w, A.h);

      return { A, B, w: A.w, h: A.h, nonBlackA: covA };
    },
    { tilesetUrl: TILESET },
  );

  await page.close();
  return result;
}

// Decode two PNG data URLs and compute a pixel mismatch percentage. Runs in a
// throwaway page so we get a canvas 2D context for decoding (no Node PNG dep).
async function diffDataUrls(label, urlA, urlB, w, h) {
  const page = await browser.newPage();
  const pct = await page.evaluate(
    async ({ urlA, urlB, w, h }) => {
      const decode = (u) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            const cx = c.getContext("2d");
            cx.drawImage(img, 0, 0);
            resolve(cx.getImageData(0, 0, w, h).data);
          };
          img.src = u;
        });
      const a = await decode(urlA);
      const b = await decode(urlB);
      let mismatch = 0;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i += 4) {
        const dr = Math.abs(a[i] - b[i]);
        const dg = Math.abs(a[i + 1] - b[i + 1]);
        const db = Math.abs(a[i + 2] - b[i + 2]);
        // Tolerance 8/255 per channel — ignores trivial dithering/AA noise,
        // catches a real sub-pixel placement shift (which moves whole edges).
        if (dr > 8 || dg > 8 || db > 8) mismatch++;
      }
      return (mismatch / (n / 4)) * 100;
    },
    { urlA, urlB, w, h },
  );
  await page.close();
  return pct;
}

function savePng(name, dataUrl) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(`${OUT}/${name}`, Buffer.from(b64, "base64"));
}

const webgpu = await runBackend("webgpu");
const webgl = await runBackend("webgl");

savePng("probe-i3dm-jitter-webgpu-A.png", webgpu.A.dataUrl);
savePng("probe-i3dm-jitter-webgpu-B.png", webgpu.B.dataUrl);
savePng("probe-i3dm-jitter-webgl.png", webgl.A.dataUrl);

const stabilityPct = await diffDataUrls(
  "stability",
  webgpu.A.dataUrl,
  webgpu.B.dataUrl,
  webgpu.w,
  webgpu.h,
);
const placementPct = await diffDataUrls(
  "placement",
  webgpu.A.dataUrl,
  webgl.A.dataUrl,
  webgpu.w,
  webgpu.h,
);

await browser.close();

const report = {
  tileset: TILESET,
  canvas: { w: webgpu.w, h: webgpu.h },
  webgpuNonBlackPixels: webgpu.nonBlackA,
  webglNonBlackPixels: webgl.nonBlackA,
  stabilityMismatchPct: Number(stabilityPct.toFixed(4)),
  placementMismatchPct: Number(placementPct.toFixed(4)),
  pngs: [
    `${OUT}/probe-i3dm-jitter-webgpu-A.png`,
    `${OUT}/probe-i3dm-jitter-webgpu-B.png`,
    `${OUT}/probe-i3dm-jitter-webgl.png`,
  ],
};
console.log(JSON.stringify(report, null, 2));

// Pass criteria:
//   - WebGPU renders the instances (non-black coverage present)
//   - Stationary A↔B is pixel-stable (deterministic)
//   - WebGPU placement matches WebGL within a small tolerance
const ok =
  webgpu.nonBlackA > 200 &&
  webgl.nonBlackA > 200 &&
  stabilityPct < 0.05 &&
  placementPct < 1.0;
console.log(`RESULT: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
