#!/usr/bin/env node
/**
 * Batch 611 (E2 CLOUD-EXOTIC-FEATURES-REMAINING) — the sibling supplementary features
 * to B592 mammatus / B610 species, as bounded density SHAPING on the baked-density-field
 * procedural-cloud arch. WebGPU-only.
 *
 * globe.cloudFeature ("asperitas" | "fluctus"/"kelvin-helmholtz" | "arcus" | "virga" |
 * "praecipitatio") (or numeric globe.cloudFeatureMode 1-4) shapes the deck:
 *   mode 1 asperitas — chaotic wavy underside carve;
 *   mode 2 fluctus   — Kelvin-Helmholtz breaking-wave billows along the top;
 *   mode 3 arcus     — shelf/roll leading edge;
 *   mode 4 virga     — fallstreak tail below the base (praecipitatio = denser streaks).
 * Default OFF (feature unset → featureMode=0) → the WGSL featureFactor() early-returns
 * 1.0 → byte-identical to the pre-611 render.
 *
 * Boots the Weather Inspector on a dense deck, FREEZES the clock (so cloud advection
 * can't confound the off-gate), and checks:
 *   (1) OFF baseline vs a 2nd OFF capture → ~0 diff (grown 136→140 UBO does not
 *       perturb the OFF render);
 *   (2) each of asperitas / fluctus / arcus / virga ON substantially changes the render;
 *   (3) virga carve THINS the deck (the fallstreak carve removes density);
 *   (4) praecipitatio differs from plain virga (the featureParam reach change);
 *   (5) restoring OFF returns to the OFF baseline (clean toggle, no residual);
 *   (6) 0 new device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-features.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const W = 1024,
  H = 768;
const OUT = "Tools/visual-regression/output";
const DEMO = "/Apps/Sandcastle/gallery/WebGPU%20Weather%20Inspector.html";

const CUMULONIMBUS = 10;

const SANDCASTLE_STUB = () => {
  window.Sandcastle = {
    finishedLoading() {
      document.body.classList.remove("sandcastle-loading");
      const o = document.getElementById("loadingOverlay");
      if (o) {
        o.style.display = "none";
      }
    },
    declare() {},
    highlight() {},
    reset() {},
    addToolbarButton() {},
    addToggleButton() {},
    addToolbarMenu() {},
  };
};

const BOOT = async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  window.Cesium = C;
  if (typeof window.startup !== "function") {
    return { ok: false, err: "window.startup not defined" };
  }
  try {
    await window.startup(C);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String((e && e.stack) || e) };
  }
};

// Grey-cloud-deck fraction in the deck region (lower-centre, right of panel).
function deck(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const x0 = Math.floor(c.width * 0.42),
      x1 = Math.floor(c.width * 0.95),
      y0 = Math.floor(c.height * 0.08),
      y1 = Math.floor(c.height * 0.86);
    const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let cloud = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b);
      const blueSky = b > r + 25 && b > 120;
      if (!blueSky && L > 90 && mx - mn < 50) {
        cloud++;
      }
      n++;
    }
    return +((100 * cloud) / n).toFixed(2);
  }, dataUrl);
}

async function diff(page, a, b) {
  return page.evaluate(
    async ([ua, ub]) => {
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
      const da = await load(ua),
        db = await load(ub);
      let acc = 0,
        n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        acc += Math.abs(
          0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2] -
            (0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2]),
        );
      }
      return +(acc / n).toFixed(3);
    },
    [a, b],
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
  await page.addInitScript(SANDCASTLE_STUB);
  await page.goto(`${BASE}${DEMO}`, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({
    content:
      "#cesiumContainer{position:absolute;top:0;left:0;width:100%;height:100%;}#loadingOverlay{display:none;}",
  });
  const boot = await page.evaluate(BOOT);
  if (!boot.ok) {
    console.log("BOOT FAILED:", boot.err);
    await browser.close();
    process.exitCode = 1;
    return;
  }
  await page.waitForFunction(() => !!(window.viewer && window.viewer.scene), null, {
    timeout: 60000,
  });
  await armWebGPUDevices(page);

  const canvas = await page.$(".cesium-widget canvas");
  const shot = async (name) => {
    await canvas.screenshot({ path: `${OUT}/${name}.png` });
    return (
      "data:image/png;base64," +
      fs.readFileSync(`${OUT}/${name}.png`).toString("base64")
    );
  };

  // Dense deck to shape. FREEZE the clock so cloud advection can't confound the OFF
  // byte-identity gate — with the clock stopped `cloud.time` is constant.
  await page.evaluate((cb) => {
    const v = window.viewer;
    const g = v.scene.globe;
    g.cloudType = cb;
    g.cloudCoverage = 0.85;
    g.cloudDensity = 0.5;
    g.cloudFeature = undefined; // OFF (default)
    g.cloudFeatureMode = undefined;
    v.clock.shouldAnimate = false;
    v.scene.requestRender();
  }, CUMULONIMBUS);
  await page.waitForTimeout(9000);

  const set = async (obj) => {
    await page.evaluate((o) => {
      const g = window.viewer.scene.globe;
      for (const k of Object.keys(o)) {
        g[k] = o[k] === "__undef__" ? undefined : o[k];
      }
      window.viewer.scene.requestRender();
    }, obj);
    await page.waitForTimeout(4000);
  };

  const duOff = await shot("features-off");
  const deckOff = await deck(page, duOff);

  // 2nd OFF capture (frozen clock) — determinism / grown-UBO off-gate.
  await set({ cloudFeature: "__undef__", cloudFeatureMode: "__undef__" });
  const duOff2 = await shot("features-off2");

  // Asperitas — chaotic wavy underside.
  await set({ cloudFeature: "asperitas", cloudFeatureStrength: 0.9, cloudFeatureScale: 1.0 });
  const duAsp = await shot("features-asperitas");

  // Fluctus — Kelvin-Helmholtz breaking-wave billows along the top.
  await set({ cloudFeature: "fluctus", cloudFeatureStrength: 0.9, cloudFeatureScale: 1.0 });
  const duFluc = await shot("features-fluctus");

  // Arcus — shelf/roll leading edge.
  await set({ cloudFeature: "arcus", cloudFeatureStrength: 0.9, cloudFeatureScale: 1.0 });
  const duArc = await shot("features-arcus");

  // Virga — fallstreak tail below the base (wispy).
  await set({ cloudFeature: "virga", cloudFeatureStrength: 0.9, cloudFeatureScale: 1.0 });
  const duVir = await shot("features-virga");
  const deckVir = await deck(page, duVir);

  // Praecipitatio — denser/reaching fallstreaks (featureParam=1).
  await set({ cloudFeature: "praecipitatio", cloudFeatureStrength: 0.9, cloudFeatureScale: 1.0 });
  const duPrc = await shot("features-praecipitatio");

  // Restore OFF — clean toggle, no residual.
  await set({
    cloudFeature: "__undef__",
    cloudFeatureMode: "__undef__",
    cloudFeatureStrength: "__undef__",
    cloudFeatureScale: "__undef__",
    cloudFeatureParam: "__undef__",
  });
  const duRestore = await shot("features-off-restored");

  const diffOffOff = await diff(page, duOff, duOff2);
  const diffAsp = await diff(page, duOff, duAsp);
  const diffFluc = await diff(page, duOff, duFluc);
  const diffArc = await diff(page, duOff, duArc);
  const diffVir = await diff(page, duOff, duVir);
  const diffVirPrc = await diff(page, duVir, duPrc);
  const diffRestore = await diff(page, duOff, duRestore);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter(
      (e) =>
        !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i.test(
          e,
        ),
    );

  console.log(`deck%%: off=${deckOff} virga=${deckVir}`);
  console.log(
    `diff: off-vs-off2=${diffOffOff} asp=${diffAsp} fluctus=${diffFluc} arcus=${diffArc} virga=${diffVir} prc-vs-virga=${diffVirPrc} restore=${diffRestore} | errs=${newErrs.length}`,
  );

  const checks = [
    [`OFF is deterministic w/ grown UBO (off-vs-off2 ${diffOffOff} < 0.25)`, diffOffOff < 0.25],
    [`asperitas ON substantially changes the render (${diffAsp} > 1.0)`, diffAsp > 1.0],
    [`fluctus ON substantially changes the render (${diffFluc} > 1.0)`, diffFluc > 1.0],
    [`arcus ON substantially changes the render (${diffArc} > 1.0)`, diffArc > 1.0],
    [`virga ON substantially changes the render (${diffVir} > 1.0)`, diffVir > 1.0],
    // The fallstreak carve removes density → measurably thinner deck vs OFF.
    [`virga carve THINS the deck (virga ${deckVir} < off ${deckOff} - 0.3)`, deckVir < deckOff - 0.3],
    // praecipitatio's denser/reaching streaks re-shape vs plain virga.
    [`praecipitatio differs from virga (prc-vs-virga ${diffVirPrc} > 0.3)`, diffVirPrc > 0.3],
    [`restoring OFF returns to baseline (restore-vs-off ${diffRestore} < 0.25)`, diffRestore < 0.25],
    [`no NEW device errors (${newErrs.length})`, newErrs.length === 0],
  ];
  console.log("\n=== ANALYSIS ===");
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) {
      pass = false;
    }
  }
  if (newErrs.length) {
    console.log("  errors:", newErrs.slice(0, 5));
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
