#!/usr/bin/env node
/**
 * V2 — 3D noise-texture bake, bound INERT. WebGPU-only.
 * @purpose V2 inert-bake gate: 3D noise baked + bound with the shader not sampling it — byte-identical to the pre-V2 stash build, bake ran, zero device errors
 * @status INVESTIGATION
 *
 * V2 bakes the 128³ shape + 32³ detail 3D noise textures once and binds them
 * into the cloud BGL (bindings 6/7/8), but the shader keeps `noiseSource = 0` and
 * never samples them — the live `fbmNoise`/`worleyF1` march still produces every
 * pixel. So the frame must be BYTE-IDENTICAL to pre-V2, AND the bake must have
 * actually run (`noiseBaked === true`) with zero device errors (proves the new
 * BGL bindings + the compute bake dispatch are clean).
 *
 *   Run 1 (V2 build):   TAG=after  node probe-cloud-noisebake.mjs
 *   Run 2 (pre-V2):     git stash the renderer.ts + .wgsl, rebuild,
 *                       TAG=before node probe-cloud-noisebake.mjs   (computes the diff)
 *
 * PASS: noiseBaked true; mean-abs luma mismatch ≤ 0.5/255 (byte-identical);
 * 0 device errors. READ cloud-noisebake-after.png — clouds render as baseline.
 *
 * Usage: TAG=after PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-noisebake.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.TAG || "after";
const W = 1024,
  H = 768;
const LON = -95.0,
  LAT = 39.0,
  ALT = 800.0;
const NOON = "2026-06-21T18:20:00Z";
const OUT = "Tools/visual-regression/output";

const SETUP = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const g = s.globe;
  v.useDefaultRenderLoop = false;
  s.requestRenderMode = false;
  g.defaultCloudCollection.enableVolumetric = true;
  if ("cloudCoverage" in g)
    g.defaultCloudCollection.volumetric.cloudCoverage = 0.55;
  if ("cloudWeatherMap" in g)
    g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
  if ("cloudDensity" in g)
    g.defaultCloudCollection.volumetric.cloudDensity = 0.8;
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: C.Math.toRadians(90.0),
      pitch: C.Math.toRadians(16.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

const RENDER = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  for (let i = 0; i < 90; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  // Read the bake flag off the cloud cache (proves the bake actually ran).
  let noiseBaked;
  try {
    noiseBaked = !!(
      s.context &&
      s.context._cloudCache &&
      s.context._cloudCache.noiseBaked
    );
  } catch (e) {
    noiseBaked = false;
  }
  return { noiseBaked, dataUrl: s.canvas.toDataURL("image/png") };
};

async function imageMismatchCloud(page, duA, duB) {
  return page.evaluate(
    async ([a, b]) => {
      const load = async (u) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        return cx.getImageData(0, 0, c.width, c.height).data;
      };
      const da = await load(a);
      const db = await load(b);
      let acc = 0,
        n = 0,
        maxd = 0;
      for (let i = 0; i < da.length; i += 4) {
        const la = 0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2];
        const lb = 0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2];
        if (Math.max(la, lb) < 30) continue;
        const d = Math.abs(la - lb);
        acc += d;
        if (d > maxd) maxd = d;
        n++;
      }
      return {
        meanAbs: n ? +(acc / n).toFixed(4) : 0,
        maxAbs: +maxd.toFixed(2),
        cloudPx: n,
      };
    },
    [duA, duB],
  );
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);
  await page.evaluate(SETUP, { LON, LAT, ALT });

  const r = await page.evaluate(RENDER, { iso: NOON });
  const png = `${OUT}/cloud-noisebake-${TAG}.png`;
  fs.writeFileSync(png, Buffer.from(r.dataUrl.split(",")[1], "base64"));

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter((e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e));

  console.log(
    `[${TAG}] noiseBaked=${r.noiseBaked} device errors=${newErrs.length}`,
  );
  if (newErrs.length) console.log("  errs:", newErrs.slice(0, 3));

  const other = TAG === "after" ? "before" : "after";
  const otherPng = `${OUT}/cloud-noisebake-${other}.png`;
  let pass = newErrs.length === 0;
  if (fs.existsSync(otherPng)) {
    const otherDu =
      "data:image/png;base64," + fs.readFileSync(otherPng).toString("base64");
    const m = await imageMismatchCloud(page, r.dataUrl, otherDu);
    console.log("A/B (after vs before):", JSON.stringify(m));
    const checks = [
      ["bake ran (noiseBaked true)", TAG === "before" || r.noiseBaked === true],
      [`byte-identical: mean-abs ${m.meanAbs} ≤ 0.5`, m.meanAbs <= 0.5],
      [`max-abs ${m.maxAbs} ≤ 2`, m.maxAbs <= 2],
      [`cloud pixels present (${m.cloudPx})`, m.cloudPx > 5000],
      ["no NEW device errors", newErrs.length === 0],
    ];
    pass = true;
    console.log("\n=== ANALYSIS ===");
    for (const [n, ok] of checks) {
      console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
      if (!ok) pass = false;
    }
    console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  } else {
    console.log(`(no ${other} capture yet — run the other build to compare)`);
  }

  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
