#!/usr/bin/env node
// R-7 / Q26 RENDERBUNDLE-EXPANSION-PROFILE — data-collection pass.
// @purpose Data collection for the render-bundle shortlist: runs CesiumDebug.cpuPassCost across named scenes, dumps per-pass CPU cost.
// @status ACTIVE
//
// Runs the SHIPPED WebGPUCpuPassProfiler (CesiumDebug.cpuPassCost) across a
// set of named scenes and dumps per-pass CPU *recording* cost (avg ms over a
// rolling window). The output feeds the render-bundle expansion shortlist:
//   <1 ms avg   -> skip (not worth bundling)
//   3-5 ms avg  -> worth bundling
//   >5 ms avg   -> strong candidate
//
// Pass -> candidate map (see WebGPUSceneRendererFrustumLoop.ts):
//   "3dTiles"     -> R-7a (3D-Tiles opaque) + R-7e (Vector 3D Tiles)
//   "opaque"      -> R-7f (buffer / geometry primitives)
//   "translucent" -> R-7b (translucent / OIT collect)
//
// This probe changes NO runtime code — it only reads the live profiler.
//
// Usage: node Tools/visual-regression/probe-cpu-pass-profile.mjs
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "output", "cpu-pass-profile");
mkdirSync(OUT, { recursive: true });

const MEASURE_FRAMES = 150;
const SETTLE_FRAMES = 240;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer, { timeout: 60000 });

// Expose helpers on the page and run each scene sequentially.
const scenes = [
  "viewer-default",
  "osm-buildings",
  "google-photorealistic",
  "oit-translucent",
  "hover-pick",
];

const results = {};
for (const sceneName of scenes) {
  const out = await page.evaluate(
    async ({ sceneName, MEASURE_FRAMES, SETTLE_FRAMES }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;

      // Locate the WebGPU renderer that owns the CPU pass profiler.
      const renderer =
        scene._alternateSceneRenderer &&
        typeof scene._alternateSceneRenderer.getCpuPassProfile === "function"
          ? scene._alternateSceneRenderer
          : null;
      if (!renderer) {
        return { sceneName, error: "no WebGPU cpu-pass profiler on scene" };
      }

      const oncePostRender = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            resolve();
          });
          // Fallback in case the render loop is idle.
          scene.requestRender();
        });

      const settle = async (frames, doneFn) => {
        for (let i = 0; i < frames; i++) {
          await oncePostRender();
          if (doneFn && i > 60 && doneFn()) break;
        }
      };

      // Clean prior primitives/tilesets at the START of each scene. We do
      // NOT clean at the end — after measurement we freeze the render loop
      // (requestRenderMode=true) so the screenshot captures the exact
      // measured frame instead of a post-cleanup globe frame.
      scene.requestRenderMode = false;
      scene.primitives.removeAll();
      v.entities.removeAll();
      scene.globe.show = true;

      const note = { sceneName, loaded: true, detail: {} };

      // ---- Scene setup ----
      try {
        if (sceneName === "viewer-default") {
          v.camera.setView({
            destination: C.Cartesian3.fromDegrees(-95.0, 40.0, 12000000.0),
          });
          await settle(SETTLE_FRAMES, () => scene.globe.tilesLoaded);
        } else if (sceneName === "osm-buildings") {
          const ts = await C.Cesium3DTileset.fromIonAssetId(96188);
          scene.primitives.add(ts);
          note.detail.tilesetReady = true;
          v.camera.setView({
            destination: C.Cartesian3.fromDegrees(-74.019, 40.6912, 2500.0),
            orientation: {
              heading: C.Math.toRadians(20),
              pitch: C.Math.toRadians(-20),
              roll: 0,
            },
          });
          await settle(
            SETTLE_FRAMES,
            () => scene.globe.tilesLoaded && ts.tilesLoaded,
          );
        } else if (sceneName === "google-photorealistic") {
          scene.globe.show = false;
          const ts = await C.createGooglePhotorealistic3DTileset();
          scene.primitives.add(ts);
          note.detail.tilesetReady = true;
          v.camera.setView({
            destination: C.Cartesian3.fromDegrees(-74.019, 40.69, 3000.0),
            orientation: {
              heading: C.Math.toRadians(20),
              pitch: C.Math.toRadians(-25),
              roll: 0,
            },
          });
          await settle(SETTLE_FRAMES, () => ts.tilesLoaded);
        } else if (sceneName === "oit-translucent") {
          // MANY SEPARATE translucent primitives -> each is its own draw
          // command in the TRANSLUCENT pass, honestly stressing the OIT
          // collect/record path (a single batched Primitive would collapse
          // to ~1 draw command and under-represent the record cost).
          scene.globe.show = false;
          const N = 16; // 16x16 = 256 separate translucent primitives
          for (let ix = 0; ix < N; ix++) {
            for (let iy = 0; iy < N; iy++) {
              const lon = -110 + ix * 0.9;
              const lat = 26 + iy * 0.9;
              const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
                C.Cartesian3.fromDegrees(lon, lat, 200000.0),
              );
              scene.primitives.add(
                new C.Primitive({
                  geometryInstances: new C.GeometryInstance({
                    geometry: C.BoxGeometry.fromDimensions({
                      vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
                      dimensions: new C.Cartesian3(90000, 90000, 90000),
                    }),
                    modelMatrix,
                    attributes: {
                      color: C.ColorGeometryInstanceAttribute.fromColor(
                        C.Color.fromHsl((ix * N + iy) / (N * N), 1.0, 0.5, 0.4),
                      ),
                    },
                  }),
                  appearance: new C.PerInstanceColorAppearance({
                    translucent: true,
                    closed: true,
                  }),
                  asynchronous: false,
                }),
              );
            }
          }
          note.detail.translucentPrimitives = N * N;
          // Grid center ~ (-103.25, 32.75). Frame it obliquely from the south.
          v.camera.setView({
            destination: C.Cartesian3.fromDegrees(-103.0, 18.0, 3200000.0),
            orientation: {
              heading: 0,
              pitch: C.Math.toRadians(-42),
              roll: 0,
            },
          });
          await settle(160);
        } else if (sceneName === "hover-pick") {
          // OSM buildings + a per-frame scene.pick at screen center to fire
          // the pick pass every frame (simulates active hover picking).
          const ts = await C.Cesium3DTileset.fromIonAssetId(96188);
          scene.primitives.add(ts);
          note.detail.tilesetReady = true;
          v.camera.setView({
            destination: C.Cartesian3.fromDegrees(-74.019, 40.6912, 2500.0),
            orientation: {
              heading: C.Math.toRadians(20),
              pitch: C.Math.toRadians(-20),
              roll: 0,
            },
          });
          await settle(
            SETTLE_FRAMES,
            () => scene.globe.tilesLoaded && ts.tilesLoaded,
          );
        }
      } catch (e) {
        note.loaded = false;
        note.error = String(e && e.message ? e.message : e).slice(0, 200);
      }

      // ---- Measure ----
      renderer.setCpuPassProfiling(true);
      renderer.getCpuPassProfile(); // no-op read; ensure enabled
      const center = new C.Cartesian2(
        scene.canvas.clientWidth / 2,
        scene.canvas.clientHeight / 2,
      );
      for (let i = 0; i < MEASURE_FRAMES; i++) {
        if (sceneName === "hover-pick") {
          // Fire an on-frame pick to exercise the pick pass.
          try {
            scene.pick(center);
          } catch (e) {
            /* ignore */
          }
        }
        await oncePostRender();
      }
      const profile = renderer.getCpuPassProfile();
      renderer.setCpuPassProfiling(false);

      const passes = {};
      for (const [name, p] of Object.entries(profile.passes)) {
        passes[name] = {
          avgMs: Number(p.avgMs.toFixed(4)),
          lastMs: Number(p.lastMs.toFixed(4)),
          maxMs: Number(p.maxMs.toFixed(4)),
          samples: p.samples,
        };
      }
      note.frameCount = profile.frameCount;
      note.passes = passes;
      note.frameAccounting = profile.frameAccounting;
      note.lastFrame = profile.lastFrame;
      note.commandCount =
        scene._frameState?.commandList?.length ??
        scene.frameState?.commandList?.length ??
        null;
      // Freeze the render loop so the Playwright screenshot captures THIS
      // measured frame (not a subsequent viewer-RAF globe frame).
      scene.render();
      scene.requestRenderMode = true;
      scene.render();
      return note;
    },
    { sceneName, MEASURE_FRAMES, SETTLE_FRAMES },
  );

  results[sceneName] = out;
  // Screenshot the current scene for visual confirmation.
  await page.screenshot({ path: join(OUT, `${sceneName}.png`) });
  console.log(`\n=== ${sceneName} ===`);
  if (out.error) console.log("  ERROR:", out.error);
  if (out.detail) console.log("  detail:", JSON.stringify(out.detail));
  console.log("  commandCount:", out.commandCount, "frames:", out.frameCount);
  if (out.lastFrame) {
    console.log(
      `  whole frame: total=${out.lastFrame.totalMs.toFixed(3)}ms ` +
        `profiled=${out.lastFrame.profiledPassMs.toFixed(3)}ms ` +
        `unaccounted=${out.lastFrame.unaccountedMs.toFixed(3)}ms ` +
        `coverage=${(out.lastFrame.coverageRatio * 100).toFixed(1)}% ` +
        `valid=${out.lastFrame.valid}`,
    );
  }
  if (out.passes) {
    const rows = Object.entries(out.passes)
      .sort((a, b) => b[1].avgMs - a[1].avgMs)
      .map(
        ([name, p]) =>
          `    ${name.padEnd(16)} avg=${p.avgMs.toFixed(3)}ms  max=${p.maxMs.toFixed(3)}ms  n=${p.samples}`,
      );
    console.log(rows.join("\n"));
  }
}

await browser.close();

// ---- Shortlist synthesis ----
const CANDIDATE_PASSES = {
  "3dTiles": "R-7a/R-7e (3D-Tiles opaque + Vector 3D Tiles)",
  opaque: "R-7f (buffer / geometry primitives)",
  translucent: "R-7b (translucent / OIT collect)",
};
console.log(
  "\n\n================ SHORTLIST (candidate passes) ================",
);
const peak = {};
for (const [sceneName, out] of Object.entries(results)) {
  if (!out.passes) continue;
  for (const [name, p] of Object.entries(out.passes)) {
    if (!(name in CANDIDATE_PASSES)) continue;
    if (!peak[name] || p.avgMs > peak[name].avgMs) {
      peak[name] = { avgMs: p.avgMs, scene: sceneName };
    }
  }
}
for (const [name, label] of Object.entries(CANDIDATE_PASSES)) {
  const pk = peak[name];
  if (!pk) {
    console.log(`  ${name.padEnd(12)} ${label}: NOT EXERCISED`);
    continue;
  }
  const verdict =
    pk.avgMs > 5
      ? "STRONG CANDIDATE"
      : pk.avgMs >= 3
        ? "worth bundling"
        : pk.avgMs >= 1
          ? "marginal"
          : "SKIP (<1ms)";
  console.log(
    `  ${name.padEnd(12)} peak avg=${pk.avgMs.toFixed(3)}ms @${pk.scene} -> ${verdict}  [${label}]`,
  );
}
console.log("\nconsole errors:", errors.length);
errors.slice(0, 8).forEach((e) => console.log("  ERR:", e));
console.log("\nPNGs + JSON in:", OUT);
writeFileSync(join(OUT, "profile.json"), JSON.stringify(results, null, 2));
process.exit(0);
