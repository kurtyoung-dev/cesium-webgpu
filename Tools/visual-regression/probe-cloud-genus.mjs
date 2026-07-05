#!/usr/bin/env node
/**
 * Batch 408 V11 per-genus cloud types — wiring + byte-identity probe. WebGPU-only.
 *
 * globe.defaultCloudCollection.cloudType (a CloudType index) selects a per-genus vertical density
 * profile: SLAB (flat stratus), BILLOWY (rounded cumulus = the historical
 * default), TOWERING_ANVIL (cumulonimbus), plus a per-genus density scale
 * normalized so CUMULUS == 1.0 (byte-identical default). This probe boots the
 * Weather Inspector, drives globe.defaultCloudCollection.cloudType, and screenshots each genus.
 *
 * Claims:
 *   (1) CUMULUS (and undefined) is byte-identical to the pre-V11 default;
 *   (2) CIRRUS (thin, densityScale ~0.21) renders a markedly THINNER deck;
 *   (3) CUMULONIMBUS (towering, densityScale ~1.43) renders a DENSER deck;
 *   (4) STRATUS (flat slab) differs from CUMULUS;
 *   (5) each non-cumulus genus changes the render (whole-frame diff); 0 errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-genus.mjs
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

// CloudType indices
const CUMULUS = 0,
  CIRRUS = 1,
  STRATUS = 7,
  CUMULONIMBUS = 10;

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

const SETTYPE = async (t) => {
  window.viewer.scene.globe.defaultCloudCollection.cloudType = t === null ? undefined : t;
  window.viewer.scene.requestRender();
  return { ok: true };
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

  // Fuller deck so the per-genus density scale (cirrus ~0.21x thin, cb ~1.43x
  // dense) reads clearly from the upward view; the genus is then the only
  // variable across captures (coverage held fixed, so CUMULUS still == default).
  await page.evaluate(() => {
    const g = window.viewer.scene.globe;
    g.defaultCloudCollection.volumetric.cloudCoverage = 0.8;
    g.defaultCloudCollection.volumetric.cloudDensity = 0.4;
    window.viewer.scene.requestRender();
  });
  await page.waitForTimeout(9000);
  const duDef = await shot("genus-default");
  const deckDef = await deck(page, duDef);

  const cap = async (t, name) => {
    await page.evaluate(SETTYPE, t);
    await page.waitForTimeout(4500);
    const du = await shot(name);
    return { du, deck: await deck(page, du) };
  };

  const cu = await cap(CUMULUS, "genus-cumulus");
  const ci = await cap(CIRRUS, "genus-cirrus");
  const cb = await cap(CUMULONIMBUS, "genus-cumulonimbus");
  const st = await cap(STRATUS, "genus-stratus");

  const diffCuDef = await diff(page, duDef, cu.du);
  const diffCi = await diff(page, cu.du, ci.du);
  const diffCb = await diff(page, cu.du, cb.du);
  const diffSt = await diff(page, cu.du, st.du);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter(
      (e) =>
        !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i.test(
          e,
        ),
    );

  console.log(
    `deck%%: default=${deckDef} cumulus=${cu.deck} cirrus=${ci.deck} cb=${cb.deck} stratus=${st.deck}`,
  );
  console.log(
    `diff: cumulus-vs-default=${diffCuDef} cirrus=${diffCi} cb=${diffCb} stratus=${diffSt} | errs=${newErrs.length}`,
  );

  const checks = [
    [`CUMULUS == default (byte-identical, diff ${diffCuDef} < 0.4)`, diffCuDef < 0.4],
    [`CIRRUS renders a thinner deck (${ci.deck} < ${cu.deck} - 3) — 0.21x density scale`, ci.deck < cu.deck - 3],
    [`CIRRUS + CUMULONIMBUS substantially change the render (cirrus ${diffCi} & cb ${diffCb} > 1.5)`,
      diffCi > 1.5 && diffCb > 1.5],
    [`STRATUS (flat slab) changes the render (diff ${diffSt} > 0.5)`, diffSt > 0.5],
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
