#!/usr/bin/env node
// Probe: C11-205 — REAL MULTIPLE-CONTENT LIFECYCLE + VERSIONED MODEL-STATE
// PACKET MUTATION EVIDENCE.
//
// C11-205 exists because a resident renderer timing comparison is invalid
// unless both legs held the same tiles, requested the same bytes, and reached
// readiness on the same events. Batches 779/784/819 landed the ledger, the
// order-invariant identity hashes, the schema-v2 multiple-content observer and
// the versioned model-state packet. Two pieces of evidence were still owed and
// both live here:
//
//   1. The schema-v2 observer run against a REAL multiple-content fixture
//      rather than a synthesized one. The repository already ships a 3D Tiles
//      1.1 multiple-contents fixture and the dev server serves the repository
//      root statically, so no synthetic tileset is needed:
//        Specs/Data/Cesium3DTiles/MultipleContents/MultipleContents/tileset_1.1.json
//      Its root tile carries two content slots of two different formats
//      (batched.b3dm + instanced.i3dm), which is exactly the slot/group
//      membership the v2 schema claims to observe.
//
//   2. FOCUSED BROWSER MUTATION EVIDENCE for the versioned model-state packet:
//      it must not churn while nothing changes, it must advance exactly once
//      per broad mutation, that mutation must reach EVERY content slot of the
//      multiple-content tile, and per-tile dynamic state (model matrix) must
//      still apply without advancing the packet at all.
//
// This is an ATTRIBUTION probe, not a timing run. It renders with the globe
// off and requestRenderMode off; nothing here may be quoted as performance.
//
// Gates (per renderer leg):
//   L1 REACHABLE  the fixture loaded and the tileset settled.
//   L2 BACKEND    the resolved renderer is the requested one. A leg running
//                 the other backend is not the leg under test — STRUCTURAL.
//   L3 MULTI      schema v2 supported AND actually observed multiple-content
//                 slots. Supported-but-unobserved is a real FAIL: the fixture
//                 genuinely has two slots.
//   L4 LEDGER     valid, complete, zero open requests.
//   L5 SLOTS      every observed slot reached model-ready AND content-ready.
//   L6 STABLE     the ready signature held for the required frames.
//   L7 CLEAN      zero console / page errors.
//   M1 STEADY     no packet churn across idle frames.
//   M2 ADVANCE    each broad mutation advances the packet exactly once.
//   M3 PROPAGATE  each mutation reaches every content slot.
//   M4 DYNAMIC    per-tile model matrix still applies with no packet bump.
//   X1 CROSS-LEG  both backends produced the same request-ledger signature.
//
// Usage:
//   node Tools/visual-regression/probe-c11-205-lifecycle-v2.mjs
//
// Environment:
//   PROBE_BASE=http://localhost:8080
//   PROBE_RENDERERS=webgl,webgpu
//   PROBE_HEADED=1
//
// Exit codes: 0 = every gate decided and passed. 1 = a real product FAIL.
// 2 = watchdog or an exception. 3 = no FAIL, but at least one gate had no
// subject to measure — acceptance is INCOMPLETE, not green.

import { chromium } from "playwright";
import {
  C11_205_MULTIPLE_CONTENT_FIXTURE,
  C11_205_PACKET_MUTATIONS,
  classifyCrossLegGates,
  classifyLifecycleLegGates,
  classifyStatePacketMutationGates,
  combineC11205Gates,
  formatC11205Gates,
} from "./lib/c11-205-evidence.mjs";

const baseUrl = process.env.PROBE_BASE || "http://localhost:8080";
const renderers = (process.env.PROBE_RENDERERS || "webgl,webgpu")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const headed = process.env.PROBE_HEADED === "1";
const maximumFrames = 1500;
const stableFramesRequired = 12;
const steadyFrames = 30;

const WATCHDOG_MS = 420_000;
const watchdog = setTimeout(() => {
  console.error(`STRUCTURAL: probe exceeded ${WATCHDOG_MS} ms`);
  process.exit(2);
}, WATCHDOG_MS);

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
      async ({
        maximumFrames,
        stableFramesRequired,
        steadyFrames,
        fixture,
        mutations,
      }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const { createRepresentativeTilesetLifecycleTracker } =
          await import("/Tools/visual-regression/lib/representative-performance-content.mjs");
        const viewer = window.viewer;
        const scene = viewer.scene;
        scene.requestRenderMode = false;
        scene.globe.show = false;

        const nextFrame = async () => {
          scene.render();
          await new Promise((resolve) => requestAnimationFrame(resolve));
        };

        let tileset;
        try {
          tileset = await C.Cesium3DTileset.fromUrl(fixture.url, {
            maximumScreenSpaceError: 1,
          });
        } catch (error) {
          return { reachError: String(error?.message ?? error) };
        }

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
            await nextFrame();
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

          // ── FOCUSED MUTATION EVIDENCE ────────────────────────────────────
          // Enumerate the content slots of the multiple-content tile. A slot
          // without a model cannot observe the packet, so it is excluded from
          // the propagation count rather than silently counted as agreeing.
          const collectModelContents = (tile, output) => {
            if (!tile) return output;
            const content = tile.content;
            const inner = content?.innerContents;
            const candidates = Array.isArray(inner) ? inner : [content];
            for (const candidate of candidates) {
              if (candidate?._model) {
                output.push(candidate);
              }
            }
            for (const child of tile.children ?? []) {
              collectModelContents(child, output);
            }
            return output;
          };
          const contents = collectModelContents(tileset._root, []);
          const readVersion = () =>
            tileset._model3DTileStatePacket?.version ?? null;

          let mutation;
          if (contents.length < fixture.contentSlots) {
            mutation = {
              supported: false,
              reason:
                `only ${contents.length} model-bearing content slots were ` +
                `reachable; the fixture declares ${fixture.contentSlots}`,
              contentSlots: contents.length,
            };
          } else if (readVersion() === null) {
            mutation = {
              supported: false,
              reason: "the tileset exposed no model-state packet",
              contentSlots: contents.length,
            };
          } else {
            // M1 — idle frames must not churn the packet.
            let versionChanges = 0;
            let previousVersion = readVersion();
            for (let index = 0; index < steadyFrames; index++) {
              await nextFrame();
              const current = readVersion();
              if (current !== previousVersion) {
                versionChanges++;
                previousVersion = current;
              }
            }

            // M2/M3 — one broad mutation at a time.
            const steps = [];
            for (const step of mutations) {
              const beforeVersion = readVersion();
              tileset[step.property] = step.value;
              // Two frames: the first refreshes the shared packet during the
              // tileset pass, the second guarantees every selected content has
              // run its own update against the new packet identity.
              await nextFrame();
              await nextFrame();
              const afterVersion = readVersion();
              let observedModels = 0;
              let mismatchedModels = 0;
              for (const content of contents) {
                const model = content._model;
                if (model?.[step.property] === step.value) {
                  observedModels++;
                } else {
                  mismatchedModels++;
                }
              }
              steps.push({
                property: step.property,
                value: step.value,
                versionDelta:
                  Number.isInteger(afterVersion) &&
                  Number.isInteger(beforeVersion)
                    ? afterVersion - beforeVersion
                    : null,
                observedModels,
                mismatchedModels,
              });
            }

            // M4 — per-tile dynamic state is deliberately OUTSIDE the packet.
            // It must still reach the model, and it must not bump the version.
            const dynamicBeforeVersion = readVersion();
            const dynamicBeforeMatrix = C.Matrix4.clone(
              contents[0]._model.modelMatrix,
            );
            tileset.modelMatrix = C.Matrix4.fromTranslation(
              new C.Cartesian3(0.0, 0.0, 25.0),
            );
            await nextFrame();
            await nextFrame();
            const dynamicApplied = !C.Matrix4.equals(
              contents[0]._model.modelMatrix,
              dynamicBeforeMatrix,
            );
            const dynamicAfterVersion = readVersion();
            tileset.modelMatrix = C.Matrix4.clone(C.Matrix4.IDENTITY);
            await nextFrame();

            mutation = {
              supported: true,
              contentSlots: contents.length,
              steady: { frames: steadyFrames, versionChanges },
              steps,
              dynamic: {
                applied: dynamicApplied,
                versionDelta:
                  Number.isInteger(dynamicAfterVersion) &&
                  Number.isInteger(dynamicBeforeVersion)
                    ? dynamicAfterVersion - dynamicBeforeVersion
                    : null,
              },
            };
          }

          return {
            renderer: scene.context?.rendererType ?? null,
            frames,
            stableFrames,
            tilesLoaded: tileset.tilesLoaded,
            totals: diagnostics.totals,
            ledger: diagnostics.requestLedger,
            mutation,
          };
        } finally {
          tracker.destroy();
          scene.primitives.remove(tileset);
          if (!tileset.isDestroyed()) {
            tileset.destroy();
          }
        }
      },
      {
        maximumFrames,
        stableFramesRequired,
        steadyFrames,
        fixture: {
          url: C11_205_MULTIPLE_CONTENT_FIXTURE.url,
          contentSlots: C11_205_MULTIPLE_CONTENT_FIXTURE.contentSlots,
        },
        mutations: C11_205_PACKET_MUTATIONS.map((entry) => ({ ...entry })),
      },
    );

    return {
      requestedRenderer: renderer,
      stableFramesRequired,
      faults,
      reachError: result?.reachError ?? null,
      result: result?.reachError ? null : result,
    };
  } finally {
    await page.close();
  }
}

async function main() {
  console.log(
    "[probe-c11-205-lifecycle-v2] real multiple-content lifecycle + state-packet mutation",
  );
  console.log(`  fixture: ${C11_205_MULTIPLE_CONTENT_FIXTURE.repositoryPath}`);
  console.log(
    `  predicted: ${C11_205_MULTIPLE_CONTENT_FIXTURE.contentSlots} content slots ` +
      `(${C11_205_MULTIPLE_CONTENT_FIXTURE.contentUris.join(" + ")}), ` +
      `>= ${C11_205_MULTIPLE_CONTENT_FIXTURE.minimumReadyModels} ready models, ` +
      `>= ${C11_205_MULTIPLE_CONTENT_FIXTURE.minimumReadyTiles} ready tiles, ` +
      `zero open requests`,
  );

  const browser = await chromium.launch({
    channel: "msedge",
    headless: !headed,
    args: ["--enable-unsafe-webgpu"],
  });

  const legs = [];
  try {
    for (const renderer of renderers) {
      legs.push(await runRenderer(browser, renderer));
    }
  } finally {
    await browser.close();
  }

  const gates = [];
  for (const leg of legs) {
    console.log(`\n── leg ${leg.requestedRenderer} ──`);
    console.log(
      `  measured: renderer=${leg.result?.renderer ?? "n/a"} frames=${
        leg.result?.frames ?? "n/a"
      } stableFrames=${leg.result?.stableFrames ?? "n/a"} requests=${
        leg.result?.ledger?.requestCount ?? "n/a"
      } open=${leg.result?.ledger?.openRequestCount ?? "n/a"} signature=${
        leg.result?.ledger?.signature ?? "n/a"
      }`,
    );
    if (leg.faults.length) {
      leg.faults.slice(0, 3).forEach((fault) => console.log(`    ${fault}`));
    }
    const legGates = [
      ...classifyLifecycleLegGates(leg),
      ...classifyStatePacketMutationGates(leg),
    ].map((entry) => ({
      ...entry,
      id: `${leg.requestedRenderer}/${entry.id}`,
    }));
    formatC11205Gates(legGates).forEach((line) => console.log(`  ${line}`));
    gates.push(...legGates);
  }

  const crossLegGates = classifyCrossLegGates(legs);
  console.log("");
  formatC11205Gates(crossLegGates).forEach((line) => console.log(line));
  gates.push(...crossLegGates);

  const combined = combineC11205Gates(gates);
  console.log(
    `\nGATE ${combined.verdict}` +
      (combined.structural && !combined.failed
        ? " — a leg could not see its subject. That is an instrument gap owed as" +
          " follow-up, NOT a product verdict, and NOT a pass: exit 3 so a" +
          " structural run can never be mistaken for a green one."
        : ""),
  );
  process.exitCode = combined.exitCode;
  console.log("[probe-c11-205-lifecycle-v2] done");
}

main()
  .catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
  })
  .finally(() => clearTimeout(watchdog));
