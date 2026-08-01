#!/usr/bin/env node
// Probe (C9-14-GROUND-ATMOSPHERE-STAGE): acceptance for de-duplicating the
// globe ground-atmosphere integration. The WGSL vertex shader used to run the
// up-to-16x4 per-vertex Nishita ray march every frame while `fragmentMain`
// recomputed scattering per-fragment unconditionally (Batch 56 chose
// per-fragment-always). The VS varyings feed ONLY the per-vertex debug
// visualizers (tile.time in [13.5e9,15.5e9]); C9-14 gates the VS march on that
// same window so production does the work in exactly ONE stage (per-fragment).
//
// This probe captures WebGPU at GROUND / HORIZON / ORBIT with FULL ground
// atmosphere enabled and writes PNGs to output/<OUT_SUBDIR>/. Run it twice
// (before-change build into `before/`, after-change build into `after/`) and
// the second invocation with COMPARE=1 pixel-diffs the two sets: a byte-
// identical production change lands ~0% diff at every checkpoint.
//
// Usage:
//   OUT_SUBDIR=c9-14-after node Tools/visual-regression/probe-c9-14-ground-atmo-stage.mjs
//   OUT_SUBDIR=c9-14-before node Tools/visual-regression/probe-c9-14-ground-atmo-stage.mjs
//   COMPARE=1 node Tools/visual-regression/probe-c9-14-ground-atmo-stage.mjs   (diff before vs after)
// Env: PROBE_BASE (default http://localhost:8080), PROBE_HEADED=1

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_ROOT = path.join(__dirname, "output");
const OUT_SUBDIR = process.env.OUT_SUBDIR || "c9-14-after";
const HEADED = process.env.PROBE_HEADED === "1";
const VIEWPORT = { width: 900, height: 900 };
const DIFF_TOL = 6; // strict: this is a self-diff of the SAME renderer, not cross-backend

const CHECKPOINTS = [
  // ground: eye near the surface looking toward the horizon (fog band + near ground atmo)
  {
    name: "ground",
    lon: -122.4,
    lat: 37.75,
    height: 800,
    heading: 0,
    pitch: -10,
    roll: 0,
  },
  // horizon: mid altitude, camera pitched to put the limb across the frame
  {
    name: "horizon",
    lon: -122.4,
    lat: 37.75,
    height: 220000,
    heading: 0,
    pitch: -25,
    roll: 0,
  },
  // orbit: whole-disc view where the far-from-ground drape branch runs
  {
    name: "orbit",
    lon: -60,
    lat: 20,
    height: 12000000,
    heading: 0,
    pitch: -90,
    roll: 0,
  },
];

const MIN_FRAMES = 120;
const STABLE_NEEDED = 30;
const MAX_FRAMES = 1500;
const REL_EPS = 0.0015;

async function bootViewer(browser) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 90000 });
  return { page, errs };
}

async function setupScene(page) {
  return await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.requestRenderMode = false;
    v.clock.shouldAnimate = false;
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T19:00:00Z");
    // FULL ground atmosphere + fog + lighting ON — exercise the live path.
    v.scene.globe.enableLighting = true;
    v.scene.globe.showGroundAtmosphere = true;
    v.scene.fog.enabled = true;
    v.scene.skyAtmosphere.show = true;
    v.terrainProvider = new C.EllipsoidTerrainProvider();
    v.scene.globe.terrainProvider = v.terrainProvider;
    try {
      const url = C.buildModuleUrl("Assets/Textures/NaturalEarthII");
      const provider = await C.TileMapServiceImageryProvider.fromUrl(url);
      v.imageryLayers.removeAll();
      v.imageryLayers.addImageryProvider(provider);
      return { imagery: "NaturalEarthII-local" };
    } catch (e) {
      return {
        imagery: "unavailable",
        why: String(e && e.message ? e.message : e),
      };
    }
  });
}

async function setView(page, cp) {
  return await page.evaluate(
    async ({ cp }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(cp.lon, cp.lat, cp.height),
        orientation: {
          heading: C.Math.toRadians(cp.heading),
          pitch: C.Math.toRadians(cp.pitch),
          roll: C.Math.toRadians(cp.roll),
        },
      });
      return { rendererType: v.scene.context.rendererType };
    },
    { cp },
  );
}

async function settle(page) {
  return await page.evaluate(
    async ({ MIN_FRAMES, STABLE_NEEDED, MAX_FRAMES, REL_EPS }) => {
      const v = window.viewer;
      const scene = v.scene;
      const SW = 200,
        SH = 200;
      const sampler = document.createElement("canvas");
      sampler.width = SW;
      sampler.height = SH;
      const sctx = sampler.getContext("2d", { willReadFrequently: true });
      let lastSig = 0;
      const sign = () => {
        try {
          sctx.clearRect(0, 0, SW, SH);
          sctx.drawImage(scene.canvas, 0, 0, SW, SH);
          const d = sctx.getImageData(0, 0, SW, SH).data;
          let s = 0;
          for (let i = 0; i < d.length; i += 16)
            s += d[i] + d[i + 1] * 3 + d[i + 2] * 7;
          lastSig = s;
        } catch (e) {
          lastSig = -1;
        }
      };
      const remove = scene.postRender.addEventListener(sign);
      let prevSig = -1,
        stable = 0,
        settledFrame = -1;
      for (let i = 0; i < MAX_FRAMES; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        const sig = lastSig;
        const rel =
          prevSig <= 0
            ? Infinity
            : Math.abs(sig - prevSig) / Math.max(1, Math.abs(prevSig));
        if (rel < REL_EPS) stable++;
        else stable = 0;
        prevSig = sig;
        if (i >= MIN_FRAMES && stable >= STABLE_NEEDED) {
          settledFrame = i;
          break;
        }
      }
      remove();
      for (let i = 0; i < 10; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { settledFrame, tilesLoaded: scene.globe.tilesLoaded };
    },
    { MIN_FRAMES, STABLE_NEEDED, MAX_FRAMES, REL_EPS },
  );
}

async function capture(page, outPath) {
  const b64 = await page.evaluate(async () => {
    const v = window.viewer;
    return await new Promise((resolve) => {
      const remove = v.scene.postRender.addEventListener(() => {
        remove();
        try {
          resolve(v.scene.canvas.toDataURL("image/png").split(",")[1]);
        } catch (e) {
          resolve(null);
        }
      });
      v.scene.requestRender();
      v.scene.render();
    });
  });
  if (!b64) return false;
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
  return true;
}

async function pixelDiff(page, aPath, bPath, tol) {
  const aB64 = fs.readFileSync(aPath).toString("base64");
  const bB64 = fs.readFileSync(bPath).toString("base64");
  return await page.evaluate(
    async ({ aB64, bB64, tol }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d", { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        return {
          w: c.width,
          h: c.height,
          data: cx.getImageData(0, 0, c.width, c.height).data,
        };
      };
      const A = await decode(aB64),
        B = await decode(bB64);
      if (A.w !== B.w || A.h !== B.h)
        return { ok: false, why: `size ${A.w}x${A.h} vs ${B.w}x${B.h}` };
      let diff = 0,
        maxd = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const dr = Math.abs(A.data[i] - B.data[i]);
        const dg = Math.abs(A.data[i + 1] - B.data[i + 1]);
        const db = Math.abs(A.data[i + 2] - B.data[i + 2]);
        const m = Math.max(dr, dg, db);
        if (m > maxd) maxd = m;
        if (m > tol) diff++;
      }
      const total = A.data.length / 4;
      return {
        ok: true,
        pct: +((100 * diff) / total).toFixed(4),
        diffPixels: diff,
        total,
        maxChannelDelta: maxd,
      };
    },
    { aB64, bB64, tol },
  );
}

async function main() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    args: ["--enable-unsafe-webgpu"],
  });

  if (process.env.COMPARE === "1") {
    const { page } = await bootViewer(browser);
    const beforeDir = path.join(OUT_ROOT, "c9-14-before");
    const afterDir = path.join(OUT_ROOT, "c9-14-after");
    const results = [];
    for (const cp of CHECKPOINTS) {
      const a = path.join(beforeDir, `${cp.name}.png`);
      const b = path.join(afterDir, `${cp.name}.png`);
      if (!fs.existsSync(a) || !fs.existsSync(b)) {
        results.push({
          checkpoint: cp.name,
          ok: false,
          why: "missing before/after png",
        });
        continue;
      }
      const d = await pixelDiff(page, a, b, DIFF_TOL);
      results.push({ checkpoint: cp.name, ...d });
    }
    console.log(
      JSON.stringify({ mode: "compare", tol: DIFF_TOL, results }, null, 2),
    );
    await browser.close();
    return;
  }

  const outDir = path.join(OUT_ROOT, OUT_SUBDIR);
  fs.mkdirSync(outDir, { recursive: true });
  const { page, errs } = await bootViewer(browser);
  const scene = await setupScene(page);
  const caps = [];
  for (const cp of CHECKPOINTS) {
    const view = await setView(page, cp);
    const st = await settle(page);
    const outPath = path.join(outDir, `${cp.name}.png`);
    const ok = await capture(page, outPath);
    caps.push({
      checkpoint: cp.name,
      ok,
      rendererType: view.rendererType,
      settledFrame: st.settledFrame,
      tilesLoaded: st.tilesLoaded,
    });
    process.stderr.write(
      `  [${cp.name}] captured=${ok} settled@${st.settledFrame}\n`,
    );
  }
  console.log(
    JSON.stringify(
      {
        mode: "capture",
        subdir: OUT_SUBDIR,
        scene,
        captures: caps,
        consoleErrors: errs,
      },
      null,
      2,
    ),
  );
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
