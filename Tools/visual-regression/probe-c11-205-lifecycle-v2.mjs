#!/usr/bin/env node

/**
 * Browser proof for the opt-in C11-205 lifecycle schema v2. It loads the real
 * 3D Tiles 1.1 multiple-contents fixture, installs the side observer before
 * payload requests begin, and requires exact per-slot request plus model,
 * content, and tile readiness evidence. This is attribution-only; it is not a
 * performance timing run.
 *
 * Usage:
 *   node Tools/visual-regression/probe-c11-205-lifecycle-v2.mjs
 *
 * Environment:
 *   PROBE_BASE=http://localhost:8080
 *   PROBE_RENDERERS=webgl,webgpu
 *   PROBE_HEADED=1
 */

import { chromium } from "playwright";

const baseUrl = process.env.PROBE_BASE || "http://localhost:8080";
const renderers = (process.env.PROBE_RENDERERS || "webgl,webgpu")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const headed = process.env.PROBE_HEADED === "1";
const maximumFrames = 1500;
const stableFramesRequired = 12;

async function runRenderer(browser, renderer) {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 800 },
  });
  const faults = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      faults.push(message.text());
    }
  });
  page.on("pageerror", (error) => faults.push(`PAGEERR: ${error.message}`));

  try {
    await page.goto(
      `${baseUrl}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 90_000 },
    );
    await page.waitForFunction(() => Boolean(window.viewer), null, {
      timeout: 90_000,
    });

    const result = await page.evaluate(
      async ({ maximumFrames, stableFramesRequired }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const { createRepresentativeTilesetLifecycleTracker } =
          await import("/Tools/visual-regression/lib/representative-performance-content.mjs");
        const viewer = window.viewer;
        const scene = viewer.scene;
        scene.requestRenderMode = false;
        scene.globe.show = false;

        const tileset = await C.Cesium3DTileset.fromUrl(
          "/Specs/Data/Cesium3DTiles/MultipleContents/MultipleContents/tileset_1.1.json",
          { maximumScreenSpaceError: 1 },
        );
        const tracker = createRepresentativeTilesetLifecycleTracker(
          C,
          { tilesets: [tileset] },
          { schemaVersion: 2 },
        );
        scene.primitives.add(tileset);

        try {
          viewer.camera.viewBoundingSphere(tileset.boundingSphere, {
            heading: 0,
            pitch: -0.5,
            range: Math.max(80, tileset.boundingSphere.radius * 2.5),
          });
          viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);

          let stableFrames = 0;
          let frames = 0;
          let lastReadySignature = null;
          while (
            frames < maximumFrames &&
            stableFrames < stableFramesRequired
          ) {
            scene.render();
            await new Promise((resolve) => requestAnimationFrame(resolve));
            frames++;
            const snapshot = tracker.snapshot();
            const ledger = snapshot.requestLedger;
            const readySignature = JSON.stringify([
              tileset.tilesLoaded,
              ledger.valid,
              ledger.openRequestCount,
              ledger.requestCount,
              ledger.readiness?.models?.filter(
                (model) => model.contentReady === true,
              ).length ?? 0,
              ledger.readiness?.tiles?.length ?? 0,
            ]);
            const ready =
              tileset.tilesLoaded === true &&
              ledger.valid === true &&
              ledger.complete === true &&
              ledger.openRequestCount === 0 &&
              ledger.coverage.multipleContentObserved === true &&
              ledger.readiness?.models?.length >= 2 &&
              ledger.readiness.models.every(
                (model) => model.modelReady && model.contentReady,
              ) &&
              ledger.readiness.tiles.length >= 1;
            stableFrames =
              ready && readySignature === lastReadySignature
                ? stableFrames + 1
                : ready
                  ? 1
                  : 0;
            lastReadySignature = readySignature;
          }

          const diagnostics = tracker.snapshot({
            timed: false,
            phase: "real-multiple-content-browser-probe",
          });
          return {
            renderer: scene.context?.rendererType ?? null,
            frames,
            stableFrames,
            tilesLoaded: tileset.tilesLoaded,
            totals: diagnostics.totals,
            ledger: diagnostics.requestLedger,
          };
        } finally {
          tracker.destroy();
          scene.primitives.remove(tileset);
          if (!tileset.isDestroyed()) {
            tileset.destroy();
          }
        }
      },
      { maximumFrames, stableFramesRequired },
    );

    const pass =
      result.stableFrames >= stableFramesRequired &&
      result.ledger.valid === true &&
      result.ledger.complete === true &&
      result.ledger.coverage.multipleContentSupported === true &&
      result.ledger.coverage.multipleContentObserved === true &&
      result.ledger.openRequestCount === 0 &&
      faults.length === 0;
    return { pass, faults, result };
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: !headed,
  args: ["--enable-unsafe-webgpu"],
});

let failed = false;
const outcomes = [];
try {
  for (const renderer of renderers) {
    const outcome = await runRenderer(browser, renderer);
    outcomes.push({ renderer, outcome });
    console.log(JSON.stringify({ renderer, ...outcome }, null, 2));
    failed ||= !outcome.pass;
  }
} finally {
  await browser.close();
}

if (outcomes.length > 1) {
  const signatures = outcomes.map(
    ({ outcome }) => outcome.result.ledger.signature,
  );
  const crossLegMatch = new Set(signatures).size === 1;
  console.log(
    JSON.stringify(
      {
        crossLegMatch,
        signatures: Object.fromEntries(
          outcomes.map(({ renderer, outcome }) => [
            renderer,
            outcome.result.ledger.signature,
          ]),
        ),
      },
      null,
      2,
    ),
  );
  failed ||= !crossLegMatch;
}

if (failed) {
  process.exitCode = 1;
}
