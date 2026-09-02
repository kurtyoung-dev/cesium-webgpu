#!/usr/bin/env node
// probe-q141-pick-readback.mjs — attributes every synchronous WebGPU pick miss
// in the AEC design-model scene to a named readback decline, on a pick position
// that both renderers agreed on first.
//
// @purpose Q-141 discriminator: validates one shared pick position asynchronously on both renderers, then attributes every synchronous pick miss to a named pick-framebuffer decline reason rather than reporting an unexplained hit count.
// @status ACTIVE
//
// WHY THIS PROBE EXISTS, AND WHAT THE PREVIOUS ONE COULD NOT SAY.
//
// The 2026-09-01 acceptance run reported WebGPU 4/40 picks against WebGL 40/40
// and read that as a WebGPU pick defect. Two things in that measurement make
// the number unusable on its own:
//
//   1. THE TWO BACKENDS WERE MEASURED AT DIFFERENT PIXELS. The run began with a
//      25-candidate hit search; WebGL found a feature at its first candidate and
//      ran its 40 picks there, while WebGPU found none and silently fell back to
//      the canvas centre. A hit-count comparison between two different screen
//      positions in a partially-streamed scene says nothing.
//
//   2. A MISS WAS NEVER ATTRIBUTED. `scene.pick()` returning nothing on WebGPU
//      has several unrelated causes — no readback has completed yet, the cached
//      readback belongs to a different position, the view changed, the pick pass
//      genuinely rendered nothing at that pixel — and the run recorded only the
//      outcome. `WebGPUPickFramebuffer` already counts every one of those
//      reasons; nothing read them.
//
// This probe fixes both. It establishes ONE pick position using the
// asynchronous path (which does not depend on a previous frame's readback and
// so is not subject to the warm-up contract at all), REFUSES if either renderer
// cannot validate that position rather than falling back to a guess, and then
// diffs `pickFramebuffer.getStatistics()` across every synchronous pick so each
// miss carries its reason.
//
// THE DISCRIMINATION IT PERFORMS. For every miss the receipt reports one of:
//   * a serve decline by name — the readback machinery refused, and the reason
//     says which gate;
//   * "served-but-empty" — a readback WAS served and decoded no object, which
//     means the pick pass rendered nothing at that pixel and the defect is in
//     pick rendering or tile residency, not in readback.
// Those two buckets are the fork Q-141 has been unable to take.
//
// BOUNDS. Every wait carries a deadline and every loop a count. The probe opens
// one browser per renderer, sequentially, and never runs two Edge jobs at once.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { preflightServedBuildArtifacts } from "./lib/served-build-preflight.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../..");

const DEFAULTS = Object.freeze({
  origin: "http://localhost:8094",
  entry: "/Build/CesiumUnminified/index.js",
  outputDirectory: path.join(HERE, "output", "q141-pick-readback"),
  pickSamples: 40,
  jitterRadius: 0,
  settleDeadlineMs: 90_000,
  loadDeadlineMs: 120_000,
});

const HARNESS_PATH = "/q141-pick-readback-harness.html";
const HARNESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="/Build/CesiumUnminified/Widgets/widgets.css">
<style>html,body,#cesiumContainer{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:#000}</style>
</head><body><div id="cesiumContainer"></div></body></html>`;

/**
 * The AEC design-model scene, matching the demo the row is about: the same ion
 * assets, camera, clock and ambient-occlusion settings the 2026-09-01 run used,
 * so a receipt from this probe is comparable with that evidence.
 *
 * @param {string} renderer
 * @param {string} entry
 * @returns {string} module source evaluated in the page
 */
function demoSource(renderer, entry) {
  return `
const Cesium = await import(${JSON.stringify(entry)});
window.Cesium = Cesium;
window.__q141 = { errors: [] };

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  globe: false,
  contextOptions: { renderer: ${JSON.stringify(renderer)} },
});
window.viewer = viewer;

viewer.scene.skyAtmosphere.show = true;
if (Cesium.PostProcessStageLibrary.isAmbientOcclusionSupported(viewer.scene)) {
  const ao = viewer.scene.postProcessStages.ambientOcclusion;
  ao.enabled = true;
  ao.uniforms.intensity = 2.0;
  ao.uniforms.bias = 0.1;
  ao.uniforms.lengthCap = 0.5;
  ao.uniforms.directionCount = 16;
  ao.uniforms.stepCount = 32;
}
viewer.clock.currentTime = Cesium.JulianDate.fromIso8601("2024-11-22T18:00:00Z");
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-79.886626, 40.021649, 235.65),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-20), roll: 0 },
});

const tilesets = [];
try {
  const google = await Cesium.Cesium3DTileset.fromIonAssetId(2275207);
  viewer.scene.primitives.add(google);
  tilesets.push({ title: "Google", ts: google });
  const positions = Cesium.Cartesian3.fromDegreesArray([
    -79.887735, 40.022564, -79.886341, 40.023087, -79.886161, 40.023087,
    -79.885493, 40.022032, -79.88703, 40.021456, -79.887735, 40.022564,
  ]);
  google.clippingPolygons = new Cesium.ClippingPolygonCollection({
    polygons: [new Cesium.ClippingPolygon({ positions })],
  });
} catch (error) { window.__q141.errors.push("google:" + error.message); }

const layers = [
  { title: "Architecture", assetId: 2887123, visible: true },
  { title: "Facade", assetId: 2887125, visible: true },
  { title: "Structural", assetId: 2887130, visible: false },
  { title: "Electrical", assetId: 2887124, visible: true },
  { title: "HVAC", assetId: 2887126, visible: true },
  { title: "Plumbing", assetId: 2887127, visible: true },
  { title: "Site", assetId: 2887129, visible: true },
];
for (const { title, assetId, visible } of layers) {
  try {
    const ts = await Cesium.Cesium3DTileset.fromIonAssetId(assetId);
    viewer.scene.primitives.add(ts);
    ts.show = visible;
    tilesets.push({ title, ts });
  } catch (error) { window.__q141.errors.push(title + ":" + error.message); }
}
window.__q141.tilesets = tilesets;
window.__q141.ready = true;
`;
}

/**
 * Names the single counter that changed between two reads, so a miss carries a
 * reason rather than a bare zero. `served-but-empty` is the important outcome:
 * the readback machinery answered and the answer contained no object, which
 * moves the defect out of readback entirely.
 *
 * @param {object|null} before
 * @param {object|null} after
 * @param {boolean} hit
 * @returns {string} the attribution label
 */
export function attributePick(before, after, hit) {
  if (!before || !after) {
    return "counters-unavailable";
  }
  const served =
    after.servedFresh - before.servedFresh > 0 ||
    after.servedCached - before.servedCached > 0;
  if (hit) {
    return served ? "hit-served" : "hit-without-serve";
  }
  if (served) {
    return "served-but-empty";
  }
  for (const [reason, count] of Object.entries(after.serveDeclines)) {
    if (count - (before.serveDeclines[reason] ?? 0) > 0) {
      return `serve-decline:${reason}`;
    }
  }
  for (const [reason, count] of Object.entries(after.armDeclines)) {
    if (count - (before.armDeclines[reason] ?? 0) > 0) {
      return `arm-decline:${reason}`;
    }
  }
  return "unattributed";
}

/**
 * Counts each attribution label so the receipt leads with the distribution
 * rather than a per-sample list nobody reads.
 *
 * @param {Array<{attribution: string}>} samples
 * @returns {Record<string, number>}
 */
export function summarizeAttributions(samples) {
  const totals = {};
  for (const sample of samples) {
    totals[sample.attribution] = (totals[sample.attribution] ?? 0) + 1;
  }
  return totals;
}

function refusal(reason, detail) {
  return { refused: true, reason, detail };
}

/**
 * One renderer's run. Sequential by design: two Edge jobs at once is a governed
 * violation, and the whole point is a comparison at ONE position anyway.
 */
async function runRenderer(chromium, options, sharedPosition) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const consoleLines = [];
  const result = { renderer: options.renderer, console: consoleLines };
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    page.on("console", (message) =>
      consoleLines.push(`${message.type()}: ${message.text()}`.slice(0, 300)),
    );
    page.on("pageerror", (error) =>
      consoleLines.push(`pageerror: ${error.message}`.slice(0, 300)),
    );
    await page.route(`**${HARNESS_PATH}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: HARNESS_HTML,
      }),
    );

    await page.goto(`${options.origin}${HARNESS_PATH}`, {
      waitUntil: "domcontentloaded",
    });
    // A navigation away from the preflighted origin invalidates every byte the
    // preflight vouched for, so it refuses rather than measuring an unknown
    // build.
    if (!page.url().startsWith(options.origin)) {
      return { ...result, ...refusal("origin-guard", { url: page.url() }) };
    }
    await page.addScriptTag({
      type: "module",
      content: demoSource(options.renderer, options.entry),
    });
    await page.waitForFunction(() => window.__q141?.ready === true, null, {
      timeout: options.loadDeadlineMs,
    });
    result.errors = await page.evaluate(() => window.__q141.errors);

    result.settle = await page.evaluate(async (deadlineMs) => {
      const scene = window.viewer.scene;
      const started = performance.now();
      let frames = 0;
      const onPostRender = () => frames++;
      scene.postRender.addEventListener(onPostRender);
      // Bounded: a scene that never finishes streaming still exits, and the
      // receipt records that it did not settle.
      while (performance.now() - started < deadlineMs) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (window.__q141.tilesets.every((entry) => entry.ts.tilesLoaded)) {
          break;
        }
      }
      scene.postRender.removeEventListener(onPostRender);
      const waitedMs = performance.now() - started;
      return {
        waitedMs: Math.round(waitedMs),
        frames,
        fps: +((frames / waitedMs) * 1000).toFixed(2),
        tilesLoaded: window.__q141.tilesets.every(
          (entry) => entry.ts.tilesLoaded,
        ),
      };
    }, options.settleDeadlineMs);

    // The pick position is established ASYNCHRONOUSLY. `pickAsync` reads its own
    // frame's readback, so it does not depend on a previous pick having warmed
    // the position — which is what makes it usable to establish ground truth
    // for the synchronous legs instead of assuming one.
    result.positionSearch = await page.evaluate(async (given) => {
      const Cesium = window.Cesium;
      const scene = window.viewer.scene;
      const isFeature = (picked) =>
        picked instanceof Cesium.Cesium3DTileFeature;
      const point = new Cesium.Cartesian2();
      const tried = [];
      const candidates = given
        ? [given]
        : (() => {
            const list = [];
            const width = scene.canvas.clientWidth;
            const height = scene.canvas.clientHeight;
            for (let row = 0; row < 5; row++) {
              for (let column = 0; column < 5; column++) {
                list.push({
                  x: Math.round(width * (0.3 + 0.1 * column)),
                  y: Math.round(height * (0.35 + 0.08 * row)),
                });
              }
            }
            return list;
          })();
      for (const candidate of candidates) {
        point.x = candidate.x;
        point.y = candidate.y;
        let picked;
        try {
          picked = await scene.pickAsync(point);
        } catch (error) {
          tried.push({ ...candidate, error: String(error?.message ?? error) });
          continue;
        }
        const hit = isFeature(picked);
        tried.push({
          ...candidate,
          hit,
          type: picked?.constructor?.name ?? null,
        });
        if (hit) {
          return { found: true, x: candidate.x, y: candidate.y, tried };
        }
      }
      return { found: false, tried };
    }, sharedPosition);

    if (!result.positionSearch.found) {
      // The refusal IS the result. Falling back to a guessed position is what
      // made the previous run's comparison meaningless.
      return {
        ...result,
        ...refusal("no-async-validated-pick-position", {
          candidates: result.positionSearch.tried.length,
        }),
      };
    }

    const position = {
      x: result.positionSearch.x,
      y: result.positionSearch.y,
    };
    result.position = position;

    result.syncPicks = await page.evaluate(
      async ([x, y, samples, jitter]) => {
        const Cesium = window.Cesium;
        const scene = window.viewer.scene;
        const read = () => {
          const framebuffer = scene.defaultView?.pickFramebuffer;
          if (!framebuffer || typeof framebuffer.getStatistics !== "function") {
            return null;
          }
          const statistics = framebuffer.getStatistics();
          return {
            endCalls: statistics.endCalls,
            servedFresh: statistics.servedFresh,
            servedCached: statistics.servedCached,
            cold: statistics.cold,
            serveDeclines: { ...statistics.serveDeclines },
            armDeclines: { ...statistics.armDeclines },
            readbacksArmed: statistics.readbacksArmed,
            readbacksPublished: statistics.readbacksPublished,
            ageMax: statistics.age?.max ?? null,
          };
        };
        const point = new Cesium.Cartesian2();
        const rows = [];
        // The warm-up pick the one-pick-stale contract asks for, at the exact
        // position the samples use.
        point.x = x;
        point.y = y;
        scene.pick(point);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        for (let index = 0; index < samples; index++) {
          const span = jitter * 2 + 1;
          point.x = x + (jitter === 0 ? 0 : (index % span) - jitter);
          point.y =
            y + (jitter === 0 ? 0 : (((index / span) | 0) % span) - jitter);
          const before = read();
          const startedAt = performance.now();
          const picked = scene.pick(point);
          const wallMs = performance.now() - startedAt;
          const after = read();
          rows.push({
            index,
            x: point.x,
            y: point.y,
            wallMs: +wallMs.toFixed(3),
            hit: picked instanceof Cesium.Cesium3DTileFeature,
            type: picked?.constructor?.name ?? null,
            before,
            after,
          });
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return rows;
      },
      [position.x, position.y, options.pickSamples, options.jitterRadius],
    );

    for (const row of result.syncPicks) {
      row.attribution = attributePick(row.before, row.after, row.hit);
    }
    result.attributions = summarizeAttributions(result.syncPicks);
    result.hits = result.syncPicks.filter((row) => row.hit).length;
    await context.close();
    return result;
  } finally {
    await browser.close();
  }
}

function parseArguments(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => argv[++index];
    if (argument === "--origin") {
      options.origin = next();
    } else if (argument === "--entry") {
      options.entry = next();
    } else if (argument === "--out") {
      options.outputDirectory = path.resolve(next());
    } else if (argument === "--pick-samples") {
      options.pickSamples = Math.max(1, Number.parseInt(next(), 10));
    } else if (argument === "--jitter") {
      options.jitterRadius = Math.max(0, Number.parseInt(next(), 10));
    } else if (argument === "--settle-deadline-ms") {
      options.settleDeadlineMs = Math.max(1000, Number.parseInt(next(), 10));
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const preflight = await preflightServedBuildArtifacts({
    origin: options.origin,
    repositoryRoot: REPOSITORY_ROOT,
  });
  const report = { options, preflight, renderers: {} };
  if (!preflight.ok) {
    report.refused = refusal("served-build-preflight-failed", {
      artifacts: preflight.artifacts.map((entry) => ({
        path: entry.path,
        match: entry.match,
      })),
    });
  } else {
    const { chromium } = require("playwright");
    // WebGL first: it establishes the position both renderers are measured at,
    // because it is the backend whose synchronous pick is not readback-bound.
    const webgl = await runRenderer(
      chromium,
      { ...options, renderer: "webgl" },
      undefined,
    );
    report.renderers.webgl = webgl;
    if (webgl.refused) {
      report.refused = refusal("webgl-leg-refused", { reason: webgl.reason });
    } else {
      report.renderers.webgpu = await runRenderer(
        chromium,
        { ...options, renderer: "webgpu" },
        webgl.position,
      );
    }
  }

  fs.mkdirSync(options.outputDirectory, { recursive: true });
  const target = path.join(options.outputDirectory, "q141-pick-readback.json");
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${target}\n`);
  if (report.refused) {
    process.stdout.write(`REFUSED ${report.refused.reason}\n`);
    process.exitCode = 2;
    return;
  }
  for (const [renderer, leg] of Object.entries(report.renderers)) {
    process.stdout.write(
      `${renderer}: ${leg.refused ? `REFUSED ${leg.reason}` : `${leg.hits}/${options.pickSamples} hits ${JSON.stringify(leg.attributions)}`}\n`,
    );
  }
}

// Importable for its attribution helpers; only a direct invocation runs the
// browser legs. Compared as resolved paths so a spec that imports this module
// can never launch Edge as a side effect of being loaded.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
