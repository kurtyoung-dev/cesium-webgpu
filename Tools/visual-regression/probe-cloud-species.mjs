#!/usr/bin/env node
/**
 * Batch 610 (E1 CLOUD-EXOTIC-SPECIES) — species/varieties as bounded density
 * SHAPING on the baked-density-field procedural-cloud arch. WebGPU-only.
 *
 * globe.defaultCloudCollection.volumetric.cloudSpecies ("lenticularis" | "fibratus" | "uncinus") (or numeric
 * globe.defaultCloudCollection.volumetric.cloudSpeciesMode 1/2) shapes the deck: mode 1 carves smooth wind-aligned
 * stacked lens plates (lenticularis); mode 2 carves wind-aligned wispy filaments
 * (fibratus), with speciesParam adding an uncinus fallstreak hook. Default OFF
 * (species unset → speciesMode=0) → the WGSL speciesFactor() early-returns 1.0 →
 * byte-identical to the pre-610 render.
 *
 * Boots the Weather Inspector on a dense deck, FREEZES the clock (so cloud
 * advection can't confound the off-gate), and checks:
 *   (1) OFF baseline vs a 2nd OFF capture → ~0 diff (grown 132→136 UBO does not
 *       perturb the OFF render);
 *   (2) lenticularis ON substantially changes the render (whole-frame diff);
 *   (3) fibratus ON substantially changes the render, and THINS the deck (the
 *       filament carve removes density → more sky between filaments);
 *   (4) uncinus differs from fibratus (the height-sheared hook re-shapes filaments);
 *   (5) restoring OFF returns to the OFF baseline (clean toggle, no residual);
 *   (6) 0 new device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-species.mjs
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
      let acc = 0;
      const n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        acc += Math.abs(
          0.299 * da[i] +
            0.587 * da[i + 1] +
            0.114 * da[i + 2] -
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
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    {
      timeout: 60000,
    },
  );
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
    g.defaultCloudCollection.cloudType = cb;
    g.defaultCloudCollection.volumetric.cloudCoverage = 0.85;
    g.defaultCloudCollection.volumetric.cloudDensity = 0.5;
    g.defaultCloudCollection.volumetric.cloudSpecies = undefined; // OFF (default)
    g.defaultCloudCollection.volumetric.cloudSpeciesMode = undefined;
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

  const duOff = await shot("species-off");
  const deckOff = await deck(page, duOff);

  // 2nd OFF capture (frozen clock) — determinism / grown-UBO off-gate.
  await set({ cloudSpecies: "__undef__", cloudSpeciesMode: "__undef__" });
  const duOff2 = await shot("species-off2");

  // Lenticularis — smooth stacked lens plates.
  await set({
    cloudSpecies: "lenticularis",
    cloudSpeciesStrength: 0.9,
    cloudSpeciesScale: 1.0,
  });
  const duLent = await shot("species-lenticularis");
  const deckLent = await deck(page, duLent);

  // Fibratus — wind-aligned wispy filaments (straight).
  await set({
    cloudSpecies: "fibratus",
    cloudSpeciesStrength: 0.9,
    cloudSpeciesScale: 1.0,
  });
  const duFib = await shot("species-fibratus");
  const deckFib = await deck(page, duFib);

  // Uncinus — filaments + fallstreak hook (height shear).
  await set({
    cloudSpecies: "uncinus",
    cloudSpeciesStrength: 0.9,
    cloudSpeciesScale: 1.0,
  });
  const duUnc = await shot("species-uncinus");

  // Restore OFF — clean toggle, no residual.
  await set({
    cloudSpecies: "__undef__",
    cloudSpeciesMode: "__undef__",
    cloudSpeciesStrength: "__undef__",
    cloudSpeciesScale: "__undef__",
    cloudSpeciesParam: "__undef__",
  });
  const duRestore = await shot("species-off-restored");

  const diffOffOff = await diff(page, duOff, duOff2);
  const diffLent = await diff(page, duOff, duLent);
  const diffFib = await diff(page, duOff, duFib);
  const diffFibUnc = await diff(page, duFib, duUnc);
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

  console.log(`deck%%: off=${deckOff} lent=${deckLent} fib=${deckFib}`);
  console.log(
    `diff: off-vs-off2=${diffOffOff} lent-vs-off=${diffLent} fib-vs-off=${diffFib} unc-vs-fib=${diffFibUnc} restore-vs-off=${diffRestore} | errs=${newErrs.length}`,
  );

  const checks = [
    [
      `OFF is deterministic w/ grown UBO (off-vs-off2 ${diffOffOff} < 0.25)`,
      diffOffOff < 0.25,
    ],
    [
      `lenticularis ON substantially changes the render (lent-vs-off ${diffLent} > 1.0)`,
      diffLent > 1.0,
    ],
    [
      `fibratus ON substantially changes the render (fib-vs-off ${diffFib} > 1.0)`,
      diffFib > 1.0,
    ],
    // The filament carve removes density → measurably thinner deck vs OFF.
    [
      `fibratus carve THINS the deck (fib ${deckFib} < off ${deckOff} - 0.3)`,
      deckFib < deckOff - 0.3,
    ],
    // The uncinus hook re-shapes the filaments → distinct from straight fibratus.
    [
      `uncinus differs from fibratus (unc-vs-fib ${diffFibUnc} > 0.3)`,
      diffFibUnc > 0.3,
    ],
    [
      `restoring OFF returns to baseline (restore-vs-off ${diffRestore} < 0.25)`,
      diffRestore < 0.25,
    ],
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
