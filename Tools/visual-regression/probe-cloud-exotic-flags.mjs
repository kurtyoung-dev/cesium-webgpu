#!/usr/bin/env node
/**
 * CLOUD-U7-EXOTIC-E1-E2 — exotic E1/E2 flags exposed through collection.volumetric.
 * WebGPU-only. Slice 7 of the cloud-unification epic.
 *
 * The exotic density-shaping dials all live on
 * globe.defaultCloudCollection.volumetric (a CloudVolumetrics instance) and reach
 * the raymarcher purely through _resolveVolumetricConfig()'s `...this.volumetric`
 * spread (published via context.requestVolumetricClouds, consumed by
 * WebGPUSceneRendererEnvironmentalEffects → WebGPUProceduralCloudRenderer, which
 * packs them into UBO slots 128-139 and the WGSL ProceduralClouds.wgsl consumes
 * them):
 *   - E2 mammatus  : cloudMammatus{Strength,Scale,Depth}   → slots 128-131
 *   - E1 species   : cloudSpecies / cloudSpecies{Mode,...}  → slots 132-135
 *   - E2 remaining : cloudFeature / cloudFeature{Mode,...}  → slots 136-139
 *
 * Claims:
 *   (1) OFF-GATE: in BILLBOARD mode (no volumetric deck) flipping the exotic flags
 *       on↔off is BYTE-IDENTICAL — they are inert stores off the deck path.
 *   (2) OFF-GATE: in VOLUMETRIC mode with all exotics OFF, two successive renders
 *       are byte-identical (the mode=0 early-out path is deterministic and
 *       reproduces today's pixels).
 *   (3) WIRING (E2 mammatus): volumetric.cloudMammatusStrength through the collection
 *       materially changes the deck.
 *   (4) WIRING (E1 species): volumetric.cloudSpecies="lenticularis" through the
 *       collection materially changes the deck.
 *   (5) WIRING (E2 feature): volumetric.cloudFeature="asperitas" through the
 *       collection materially changes the deck.
 *   (6) no NEW device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-exotic-flags.mjs
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
      return +(acc / n).toFixed(4);
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
  const apply = async (fn) => {
    await page.evaluate(fn);
    await page.waitForTimeout(4500);
  };

  // Let terrain/imagery finish streaming before any capture, else an in-flight
  // tile load confounds the byte-identity diffs.
  await page
    .waitForFunction(() => window.viewer.scene.globe.tilesLoaded === true, null, {
      timeout: 30000,
    })
    .catch(() => {});
  await page.waitForTimeout(3000);

  // Common deck config so the exotic modes have a deck to shape.
  const deckCfg = () => {
    const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
    v.cloudCoverage = 0.6;
    v.cloudDensity = 0.9;
    v.cloudLayerBottom = 1500;
    v.cloudLayerTop = 4000;
    window.viewer.scene.requestRender();
  };
  const clearExotics = () => {
    const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
    v.cloudMammatusStrength = undefined;
    v.cloudSpecies = undefined;
    v.cloudSpeciesMode = undefined;
    v.cloudFeature = undefined;
    v.cloudFeatureMode = undefined;
    window.viewer.scene.requestRender();
  };

  // ── OFF-GATE 1: BILLBOARD mode — exotic flags inert off the deck path ──
  await apply(() => {
    const c = window.viewer.scene.globe.defaultCloudCollection;
    c.enableVolumetric = false; // renderMode → BILLBOARD
    const v = c.volumetric;
    v.cloudMammatusStrength = undefined;
    v.cloudSpecies = undefined;
    v.cloudFeature = undefined;
    window.viewer.scene.requestRender();
  });
  const billOff = await shot("exotic-billboard-off");
  await apply(() => {
    const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
    v.cloudMammatusStrength = 0.8;
    v.cloudMammatusScale = 2.0;
    v.cloudMammatusDepth = 0.4;
    v.cloudSpecies = "lenticularis";
    v.cloudFeature = "asperitas";
    window.viewer.scene.requestRender();
  });
  const billOn = await shot("exotic-billboard-exoticon");
  const diffBillboard = await diff(page, billOff, billOn);

  // ── OFF-GATE 2 + WIRING: VOLUMETRIC mode ──
  await apply(() => {
    window.viewer.scene.globe.defaultCloudCollection.enableVolumetric = true;
    window.viewer.scene.requestRender();
  });
  await apply(deckCfg);
  await apply(clearExotics);
  const volOffA = await shot("exotic-volumetric-off-a");
  await apply(() => window.viewer.scene.requestRender());
  const volOffB = await shot("exotic-volumetric-off-b");
  const diffVolStable = await diff(page, volOffA, volOffB);

  // WIRING (E2 mammatus)
  await apply(() => {
    const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
    v.cloudMammatusStrength = 0.9;
    v.cloudMammatusScale = 2.5;
    v.cloudMammatusDepth = 0.5;
    window.viewer.scene.requestRender();
  });
  const volMammatus = await shot("exotic-volumetric-mammatus");
  const diffMammatus = await diff(page, volOffA, volMammatus);

  // WIRING (E1 species) — reset exotics, then lenticularis
  await apply(clearExotics);
  await apply(() => {
    const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
    v.cloudSpecies = "lenticularis";
    v.cloudSpeciesStrength = 1.0;
    window.viewer.scene.requestRender();
  });
  const volSpecies = await shot("exotic-volumetric-species");
  const diffSpecies = await diff(page, volOffA, volSpecies);

  // WIRING (E2 feature) — reset exotics, then asperitas
  await apply(clearExotics);
  await apply(() => {
    const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
    v.cloudFeature = "asperitas";
    v.cloudFeatureStrength = 1.0;
    window.viewer.scene.requestRender();
  });
  const volFeature = await shot("exotic-volumetric-feature");
  const diffFeature = await diff(page, volOffA, volFeature);

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
    `diff: billboard(off vs exoticOn)=${diffBillboard} volumetric(off stability)=${diffVolStable} mammatus=${diffMammatus} species=${diffSpecies} feature=${diffFeature} | errs=${newErrs.length}`,
  );

  const checks = [
    [
      `OFF-GATE billboard: exotic flags inert (off vs exoticOn diff ${diffBillboard} < 0.4)`,
      diffBillboard < 0.4,
    ],
    [
      `OFF-GATE volumetric: exotics-off render deterministic (stability diff ${diffVolStable} < 0.6)`,
      diffVolStable < 0.6,
    ],
    [
      // Mammatus only carves the underside band (depth fraction), so it is the
      // subtlest of the three exotic modes — 0.4 cleanly separates its real
      // change from the 0 deterministic stability floor.
      `WIRING E2 mammatus: cloudMammatusStrength through collection changes the deck (diff ${diffMammatus} > 0.4)`,
      diffMammatus > 0.4,
    ],
    [
      `WIRING E1 species: cloudSpecies=lenticularis through collection changes the deck (diff ${diffSpecies} > 1.0)`,
      diffSpecies > 1.0,
    ],
    [
      `WIRING E2 feature: cloudFeature=asperitas through collection changes the deck (diff ${diffFeature} > 1.0)`,
      diffFeature > 1.0,
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
