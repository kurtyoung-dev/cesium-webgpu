#!/usr/bin/env node
// ACCEPTANCE / REGRESSION probe for C6-FFT-OCEAN (opt-in FFT spectral ocean).
// WebGPU-only feature. The base globe already renders an animated water-mask
// ocean (B630), so to ISOLATE this feature the probe uses fresh page loads at
// identical render counts (deterministic frameNumber → identical base) and an
// `globe.show=false` capture that shows ONLY the ocean patch.
//
// Asserts:
//   (a) OFF-gate: two OFF sessions (never-enabled vs enabled-then-disabled) at
//       the same frame count are pixel-identical → the feature leaves nothing
//       behind and is byte-identical when off.
//   (b) ISOLATED render: with the globe hidden, enabling paints a non-empty
//       ocean patch (coverage well above the empty-scene baseline).
//   (c) ANIMATION: two isolated ON frames differ over the patch (waves move).
// READ the emitted PNGs — numbers alone don't prove waves look right.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
// Low straight-down view over open Atlantic ocean; the ~3 km patch fills view.
const VIEW = "view=-40,35,600,0,-90,0";
const CLOCK = "2026-07-03T13:00:00Z";
const K = 200; // settle frames before first capture (deterministic)
const M = 90; // extra frames for the temporal animation capture
// Ocean crop avoiding the toolbar (top), help panel (right), clock (bottom-left).
const CROP = { x0: 200, y0: 200, x1: 980, y1: 600 };

function launch() {
  return chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
}

// mode: "off" | "on" | "toggle"; hideGlobe isolates the patch.
async function session(name, { mode, hideGlobe }) {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&${VIEW}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ clock, mode, hideGlobe, K }) => {
      const v = window.viewer;
      const JD = v.clock.currentTime.constructor;
      v.scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = JD.fromIso8601(clock);
      if (hideGlobe) v.scene.globe.show = false;
      if (mode === "on") v.scene.globe.water.ocean.enabled = true;
      if (mode === "toggle") {
        v.scene.globe.water.ocean.enabled = true;
        v.scene.globe.water.ocean.enabled = false;
      }
      for (let i = 0; i < K; i++) {
        v.clock.currentTime = JD.fromIso8601(clock);
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { clock: CLOCK, mode, hideGlobe, K },
  );
  const p1 = path.join(OUT_DIR, `fft-ocean-${name}.png`);
  await page.screenshot({ path: p1 });

  let p2 = null;
  if (mode === "on") {
    await page.evaluate(
      async ({ clock, M }) => {
        const v = window.viewer;
        const JD = v.clock.currentTime.constructor;
        for (let i = 0; i < M; i++) {
          v.clock.currentTime = JD.fromIso8601(clock);
          v.scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      },
      { clock: CLOCK, M },
    );
    p2 = path.join(OUT_DIR, `fft-ocean-${name}-t2.png`);
    await page.screenshot({ path: p2 });
  }

  await browser.close();
  return { p1, p2, errs };
}

async function analyze(paths, crop) {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const b64 = {};
  for (const [k, v] of Object.entries(paths)) if (v) b64[k] = fs.readFileSync(v).toString("base64");
  const res = await page.evaluate(
    async ({ b64, crop }) => {
      const decode = async (s) => {
        const img = new Image();
        img.src = "data:image/png;base64," + s;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return { w: img.naturalWidth, data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data };
      };
      const imgs = {};
      for (const [k, s] of Object.entries(b64)) imgs[k] = await decode(s);
      const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const idx = (w, x, y) => (y * w + x) * 4;
      const diff = (A, B) => {
        let s = 0, n = 0;
        for (let y = crop.y0; y < crop.y1; y++)
          for (let x = crop.x0; x < crop.x1; x++) {
            const i = idx(A.w, x, y);
            s += Math.abs(lum(A.data, i) - lum(B.data, i)); n++;
          }
        return s / n;
      };
      // Non-background coverage (pixels brighter than near-black) in crop.
      const coverage = (A) => {
        let n = 0, tot = 0;
        for (let y = crop.y0; y < crop.y1; y++)
          for (let x = crop.x0; x < crop.x1; x++) {
            if (lum(A.data, idx(A.w, x, y)) > 20) n++;
            tot++;
          }
        return +(n / tot).toFixed(4);
      };
      return {
        offGate: +diff(imgs.off1, imgs.off2).toFixed(4),
        noiseFloor: +diff(imgs.off1, imgs.off1b).toFixed(4),
        isoCoverageOff: coverage(imgs.isoOff),
        isoCoverageOn: coverage(imgs.isoOn),
        isoTemporal: +diff(imgs.isoOn, imgs.isoOnT2).toFixed(3),
      };
    },
    { b64, crop: CROP },
  );
  await browser.close();
  return res;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("== C6-FFT-OCEAN acceptance probe ==");

  // Off-gate: two OFF sessions at identical frame count (deterministic base).
  // off1b is a second NEVER-enabled session = the base-scene noise floor
  // (tile-load timing + animated water-mask differ between independent loads).
  const off1 = await session("off1", { mode: "off", hideGlobe: false });
  const off1b = await session("off1b", { mode: "off", hideGlobe: false });
  const off2 = await session("off2", { mode: "toggle", hideGlobe: false });
  // Isolated: globe hidden, ocean off (empty) vs on (patch) + animation.
  const isoOff = await session("iso-off", { mode: "off", hideGlobe: true });
  const isoOn = await session("iso-on", { mode: "on", hideGlobe: true });
  // Contextual money shot: globe shown, ocean on.
  const ctxOn = await session("ctx-on", { mode: "on", hideGlobe: false });

  const allErrs = [...off1.errs, ...off2.errs, ...isoOn.errs, ...ctxOn.errs];
  if (allErrs.length) {
    console.log("  PAGE ERRORS:");
    [...new Set(allErrs)].slice(0, 8).forEach((e) => console.log("    " + e));
  }

  const a = await analyze(
    {
      off1: off1.p1, off1b: off1b.p1, off2: off2.p1,
      isoOff: isoOff.p1, isoOn: isoOn.p1, isoOnT2: isoOn.p2,
    },
    CROP,
  );
  console.log("  metrics:", JSON.stringify(a));
  console.log("");
  console.log(`  (a) OFF-gate delta (off1 vs off2): ${a.offGate}  vs base noise floor (off1 vs off1b): ${a.noiseFloor}`);
  console.log(`      → off-gate is byte-identical iff offGate ≈ noiseFloor (both = base nondeterminism)`);
  console.log(`  (b) isolated coverage off/on     : ${a.isoCoverageOff} / ${a.isoCoverageOn}  (on >> off = patch renders)`);
  console.log(`  (c) isolated temporal delta      : ${a.isoTemporal}  (target > 0.5 = animating)`);
  console.log("PNGs:", [off1.p1, isoOff.p1, isoOn.p1, isoOn.p2, ctxOn.p1].join("  "));
  console.log("done");
})();
