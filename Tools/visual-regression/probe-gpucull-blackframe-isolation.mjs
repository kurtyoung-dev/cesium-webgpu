#!/usr/bin/env node
// probe-gpucull-blackframe-isolation.mjs — opaque GPU-cull boundary walk
// under gpuCullingHint='always'.
//
// @purpose Original Edge-lane reproducer for Q-20/Q-48: walks the opaque command-count boundary around GPU_CULL_THRESHOLD_HI=384 under gpuCullingHint='always' and records the black-frame + locked-encoder validation error the missing translucent-pass render-pass bracket produced.
// @status ACTIVE
//
// Repatriated (CLAUDE.md Evidence Repatriation) from the Edge-executor
// tranche-2 run that first isolated Q-48 (2026-08-28,
// output/edge-executor-2026-08-28-t2/probe-gpucull-blackframe-isolation.mjs,
// a gitignored path — the run's RUNLOG.md lives there too). Moved into the
// tracked tree so this reproduction does not depend on evidence a clone
// reset or an `output/` prune can make disappear. The scene, the ARMS list
// and the camera are unchanged from the run that produced the banked
// before-numbers this row cites:
//   n256/n320/n384-always : clean  (nonBlack ~100%, 0 validation errors)
//   n448/n600-always      : BLACK  (nonBlack 0.00%, 1 locked-encoder
//                                   validation error — RUNLOG.md:264-272)
//   n600-auto-recheck     : clean  ('auto' never reaches the translucent
//                                   GPU-cull branch — RUNLOG.md:581 records
//                                   the opaque culler's own dispatch count
//                                   at 0 in the failing arms, so the
//                                   commands that trip this are translucent,
//                                   not opaque, despite the file's name)
// Wrapped with the machine-safety contract (watchdog + close-in-finally,
// Tools/visual-regression/probe-fleet-contract.spec.mjs) the original run
// did not carry; the scene-building and measurement logic is otherwise
// verbatim.
//
// Each arm is a FRESH page in the same browser, so no arm inherits another's
// state.
//
// Usage:
//   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-gpucull-blackframe-isolation.mjs
//
// Output: Tools/visual-regression/output/gpucull-blackframe-isolation/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import { readPng, frameStats } from "./lib/pnglite.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "output", "gpucull-blackframe-isolation");
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
// Round 3 (Orophin round-2 RETURN-2): the banked timestamps for this exact
// scene/ARMS list (output/edge-executor-2026-08-28-t2/job3-hiz-empty-opaque/,
// arm captures 12:04:28.9 -> isolation-round2.json at 12:07:49.4) put the
// measured total wall time at ~240s, with browser.close() alone accounting
// for ~49s of that tail. A watchdog set to the same 240_000 has no margin
// over a known-length run and races process.exit(2) against the final
// writeFileSync/browser.close(), which is a false hang report, not a real
// one. The watchdog's job is to bound an actual hang, not to cap a run whose
// length is already known — raised to 900_000 (~3.75x the measured run) so
// only a genuine stall trips it.
const WATCHDOG_MS = 900_000;

// Round 1 (banked in the original evidence tree's isolation.json) established:
// black frame + validation error requires hint 'always' AND a large command
// count; 'never' and 'auto' are clean at the same count. Round 2 walks the
// boundary — this is that walk.
const ARMS = [
  { name: "n256-always", n: 256, hint: "always", hiz: false },
  { name: "n320-always", n: 320, hint: "always", hiz: false },
  { name: "n384-always", n: 384, hint: "always", hiz: false },
  { name: "n448-always", n: 448, hint: "always", hiz: false },
  { name: "n600-auto-recheck", n: 600, hint: "auto", hiz: false },
];

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  try {
    for (const armSpec of ARMS) {
      const page = await browser.newPage({
        viewport: { width: 640, height: 480 },
      });
      const errs = [];
      page.on("console", (m) => {
        if (m.type() === "error") errs.push(m.text().slice(0, 200));
      });
      try {
        await page.goto(
          `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
          { waitUntil: "domcontentloaded" },
        );
        await page.waitForFunction(() => !!window.viewer, null, {
          timeout: 90_000,
        });
        await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
        await page.evaluate(async ({ n, hint, hiz }) => {
          const C = await import("/Build/CesiumUnminified/index.js");
          const s = window.viewer.scene;
          s.requestRenderMode = false;
          window.viewer.clock.shouldAnimate = false;
          window.viewer.clock.currentTime = C.JulianDate.fromIso8601(
            "2026-06-21T15:00:00Z",
          );
          s.globe.terrainProvider = new C.EllipsoidTerrainProvider();
          s.gpuCullingHint = hint;
          if (hiz) s._alternateSceneRenderer?.setHiZConsumeEnabled?.(true);
          const geom = C.BoxGeometry.fromDimensions({
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
            dimensions: new C.Cartesian3(2200, 2200, 24_000),
          });
          const side = Math.ceil(Math.sqrt(n));
          for (let k = 0; k < n; k++) {
            const i = k % side;
            const j = Math.floor(k / side);
            s.primitives.add(
              new C.Primitive({
                geometryInstances: new C.GeometryInstance({
                  geometry: geom,
                  modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
                    C.Cartesian3.fromDegrees(
                      -106.5 + (i / side) * 3,
                      37.8 + (j / side) * 3,
                      20_000 + ((i * 3 + j * 7) % 8) * 4000,
                    ),
                  ),
                  attributes: {
                    color: C.ColorGeometryInstanceAttribute.fromColor(
                      C.Color.fromHsl(
                        ((i * 11 + j * 3) % 360) / 360,
                        0.85,
                        0.5,
                        1,
                      ),
                    ),
                  },
                }),
                appearance: new C.PerInstanceColorAppearance({ flat: true }),
                asynchronous: false,
              }),
            );
          }
          s.camera.setView({
            destination: C.Cartesian3.fromDegrees(-105, 39.3, 330_000),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
        }, armSpec);
        for (let i = 0; i < 200; i++)
          await page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => r())),
          );
        const stats = await page.evaluate(() => {
          const s = window.viewer.scene;
          const st = s._alternateSceneRenderer?.getHighDensityCullStats?.();
          return {
            opaqueCommandsSeen: st?.gpuCullerOpaque.lastFrameInput ?? null,
            cullDispatches: st?.gpuCullerOpaque.dispatches ?? null,
            cullActive: st?.gpuCullerOpaque.active ?? null,
            hiZActive: st?.hiZ.active ?? null,
            hiZDispatches: st?.hiZ.dispatches ?? null,
            primitiveCount: s.primitives.length,
          };
        });
        const png = path.join(OUT, `iso-${armSpec.name}.png`);
        await page.locator("canvas").first().screenshot({ path: png });
        const st = frameStats(readPng(png));
        const validation = errs.filter((e) => /VALIDATION ERROR/i.test(e));
        results.push({
          ...armSpec,
          stats,
          nonBlackPct: st.nonBlackPct,
          meanLuminance: st.meanLuminance,
          validationErrorCount: validation.length,
          validationSample: validation[0] ?? null,
          validationFull: validation.slice(0, 2),
          otherErrorCount: errs.length - validation.length,
        });
        console.log(
          `[iso] ${armSpec.name}: nonBlack=${st.nonBlackPct.toFixed(2)}% ` +
            `cullIn=${stats.opaqueCommandsSeen} cullDisp=${stats.cullDispatches} ` +
            `hiZActive=${stats.hiZActive} validationErrs=${validation.length}`,
        );
      } catch (e) {
        results.push({ ...armSpec, error: String(e?.message ?? e) });
        console.log(`[iso] ${armSpec.name}: ERROR ${e?.message ?? e}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(
    path.join(OUT, "isolation-round2.json"),
    JSON.stringify(results, null, 2),
  );
  return results;
}

const watchdog = setTimeout(() => {
  console.error(
    `probe-gpucull-blackframe-isolation: watchdog fired after ${WATCHDOG_MS}ms`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => {
    clearTimeout(watchdog);
  });
