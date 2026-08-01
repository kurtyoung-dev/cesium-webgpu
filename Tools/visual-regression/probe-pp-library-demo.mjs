#!/usr/bin/env node
// probe-pp-library-demo — NEW-WEBGPU-PP-LIBRARY-DEMO (B21) acceptance.
//
// Verifies the `webgpu-post-process-library` Sandcastle demo end-to-end on
// the WebGPU backend. New-format gallery main.js (bare `import "cesium"`)
// can't boot standalone on :8080, so — per the probe-dp46f-metadata-demo
// precedent — this probe replicates the demo's EXACT scenario (same asset,
// same stage construction + uniforms, same model/space views) inside the
// CesiumViewer page and drives the demo's cycle:
//   (1) the demo's asset path (Apps/SampleData/models/CesiumMan/
//       Cesium_Man.glb) SERVES,
//   (2) all 7 library builtins are constructed + added exactly as the demo
//       does; each, when selected, VISIBLY transforms the frame (screenshot
//       written per effect for visual confirmation) AND differs from the
//       previous effect's frame — the discriminating gate for the
//       _userStagesRefs rebuild-detection fix (a stale pipeline renders
//       every selection as the first-added effect; thin-outline effects
//       additionally cap diffBytes so a stale fullscreen frame can't pass),
//   (3) OFF-GATE: the demo's initial "None" state (all 7 stages added but
//       disabled) is BYTE-IDENTICAL to the true no-post-process frame,
//   (4) LensFlare uses the demo's space view (fixed time, sun-off-axis aim
//       computed via Simon1994 + ICRF like the demo's goSpaceView),
//   (5) zero console errors + zero GPU uncapturederrors.
//
// Cross-backend pixel parity of the 7 builtins themselves is proven by
// probe-pp-library-builtins.mjs (B486/B511); this probe proves the DEMO's
// wiring (asset, stage config, views, off-state).
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-pp-library-demo.mjs

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "pp-library-demo",
);
mkdirSync(OUT_DIR, { recursive: true });

const MODEL_URL = "/Apps/SampleData/models/CesiumMan/Cesium_Man.glb";

// Asset-serves check (the demo's ../../SampleData/... path target).
const head = await fetch(`${BASE}${MODEL_URL}`, { method: "HEAD" });
const assetServes = head.ok;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const consoleErrors = [];
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("favicon")) {
    consoleErrors.push(t.slice(0, 240));
  }
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const out = await page.evaluate(
  async ({ modelUrl }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;

    window.__gpuErrors = [];
    const dev = scene.context._device || scene.context.device;
    if (dev && dev.addEventListener) {
      dev.addEventListener("uncapturederror", (e) => {
        window.__gpuErrors.push(String(e.error && e.error.message));
      });
    }

    // ── demo scene, made deterministic for pixel gates ──
    scene.requestRenderMode = false;
    v.clock.shouldAnimate = false; // demo animates; freeze for byte-stability
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T18:00:00Z");
    scene.fog.enabled = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.sun) scene.sun.show = true; // demo keeps the sun (LensFlare needs it)
    if (scene.moon) scene.moon.show = false;
    scene.globe.showGroundAtmosphere = false;
    scene.terrainProvider = new C.EllipsoidTerrainProvider();
    scene.globe.showWaterEffect = false;
    scene.globe.baseColor = new C.Color(0.12, 0.15, 0.2, 1.0);
    v.imageryLayers.removeAll();

    // demo: CesiumMan entity. The demo tracks the entity interactively; the
    // probe uses an equivalent FIXED lookAt pose instead — trackedEntity's
    // easing flight is not frame-deterministic and can alias the settle loop.
    const modelPosition = C.Cartesian3.fromDegrees(-123.0744619, 44.0503706);
    v.entities.add({
      name: "Cesium Man",
      position: modelPosition,
      model: { uri: modelUrl },
    });
    const goModelView = () => {
      v.camera.lookAt(
        modelPosition,
        new C.HeadingPitchRange(
          C.Math.toRadians(90.0),
          C.Math.toRadians(-15.0),
          6.0,
        ),
      );
    };
    goModelView();

    const oncePostRender = () =>
      new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          resolve();
        });
      });
    const renderFrames = async (n) => {
      for (let i = 0; i < n; i++) await oncePostRender();
    };
    const grab = () =>
      new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          const c = scene.canvas;
          const off = document.createElement("canvas");
          off.width = c.width;
          off.height = c.height;
          const cx = off.getContext("2d");
          cx.drawImage(c, 0, 0);
          const u8 = new Uint8Array(
            cx.getImageData(0, 0, c.width, c.height).data.buffer,
          );
          let bin = "";
          const chunk = 0x8000;
          for (let i = 0; i < u8.length; i += chunk) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
          }
          resolve({ b64: btoa(bin), png: off.toDataURL("image/png") });
        });
      });
    const bytesEqual = (a, b) => a.b64 === b.b64;
    const settleAndGrab = async () => {
      let prev = await grab();
      for (let i = 0; i < 40; i++) {
        await renderFrames(10);
        const cur = await grab();
        if (scene.globe.tilesLoaded && bytesEqual(prev, cur)) return cur;
        prev = cur;
      }
      return prev;
    };

    // Strip the async default ion imagery until tiles settle (it arrives
    // AFTER setup; a one-shot removeAll leaves it landing mid-run and
    // shifting every later capture), then let the model load.
    let stable = 0;
    for (let i = 0; i < 600 && stable < 5; i++) {
      if (v.imageryLayers.length > 0) v.imageryLayers.removeAll();
      await oncePostRender();
      stable = scene.globe.tilesLoaded ? stable + 1 : 0;
    }
    await renderFrames(120);

    const captures = {};
    // TRUE no-PP baseline (before the demo adds any stage)
    captures.noPP = await settleAndGrab();

    // ── the demo's stage factories, verbatim ──
    const lib = C.PostProcessStageLibrary;
    const stages = scene.postProcessStages;
    const effects = [
      {
        key: "blackAndWhite",
        settle: true,
        create: () => {
          const stage = lib.createBlackAndWhiteStage();
          stage.uniforms.gradations = 5.0;
          return stage;
        },
      },
      {
        key: "brightness",
        settle: true,
        create: () => {
          const stage = lib.createBrightnessStage();
          stage.uniforms.brightness = 0.5;
          return stage;
        },
      },
      {
        key: "nightVision",
        settle: false,
        create: () => lib.createNightVisionStage(),
      },
      // Silhouette draws only a thin outline around the model — far fewer
      // changed bytes than the fullscreen effects; visually verified PNG.
      // maxDiff caps the diff so a STALE fullscreen frame (the _userStagesRefs
      // rebuild-detection bug renders the previously-added effect, ~1.9M diff
      // bytes) can't masquerade as a thin outline (~20K correct).
      {
        key: "silhouette",
        settle: true,
        minDiff: 2000,
        maxDiff: 500000,
        create: () => {
          const stage = lib.createSilhouetteStage();
          stage.uniforms.color = C.Color.YELLOW;
          return stage;
        },
      },
      // Edge composite draws thin outlines like silhouette — small byte diff,
      // same stale-frame cap.
      {
        key: "edgeDetection",
        settle: true,
        minDiff: 2000,
        maxDiff: 500000,
        create: () =>
          lib.createSilhouetteStage([lib.createEdgeDetectionStage()]),
      },
      {
        key: "lensFlare",
        settle: true,
        space: true,
        create: () => {
          const stage = lib.createLensFlareStage();
          stage.uniforms.intensity = 2.0;
          return stage;
        },
      },
      {
        key: "depthView",
        settle: true,
        create: () => lib.createDepthViewStage(),
      },
    ];

    // OFF-GATE capture: demo's initial "None" state — one add/remove cycle has
    // run (exercises the B486 removeStages compaction on WebGPU) and the
    // collection is empty again.
    const warmup = stages.add(effects[0].create());
    await renderFrames(10);
    stages.remove(warmup);
    await renderFrames(10);
    captures.allOff = await settleAndGrab();

    // ── the demo's goSpaceView, verbatim ──
    const FLARE_TIME = C.JulianDate.fromIso8601("2026-06-21T08:00:00Z");
    const goSpaceView = () => {
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      v.clock.currentTime = FLARE_TIME.clone();
      const sunICRF =
        C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
          FLARE_TIME,
          new C.Cartesian3(),
        );
      const icrfToFixed =
        C.Transforms.computeIcrfToFixedMatrix(FLARE_TIME, new C.Matrix3()) ??
        C.Transforms.computeTemeToPseudoFixedMatrix(
          FLARE_TIME,
          new C.Matrix3(),
        );
      const sunWC = C.Matrix3.multiplyByVector(
        icrfToFixed,
        sunICRF,
        new C.Cartesian3(),
      );
      const camPos = C.Cartesian3.fromDegrees(130.0, 0.0, 12756000.0);
      const dir = C.Cartesian3.normalize(
        C.Cartesian3.subtract(sunWC, camPos, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      let right = C.Cartesian3.cross(
        dir,
        C.Cartesian3.normalize(camPos, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      if (C.Cartesian3.magnitude(right) < 1e-6) {
        right = C.Cartesian3.cross(dir, C.Cartesian3.UNIT_Z, right);
      }
      C.Cartesian3.normalize(right, right);
      const aim = C.Cartesian3.normalize(
        C.Cartesian3.add(
          dir,
          C.Cartesian3.multiplyByScalar(right, 0.27, new C.Cartesian3()),
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      );
      const up = C.Cartesian3.normalize(
        C.Cartesian3.cross(right, aim, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      v.camera.setView({
        destination: camPos,
        orientation: { direction: aim, up },
      });
    };

    // ── cycle each effect exactly as the demo's selectEffect does:
    //    add the freshly-created stage, capture, remove it ──
    for (const effect of effects) {
      if (effect.space) {
        goSpaceView();
        await renderFrames(30);
        // flare baseline: same space view, no stage yet
        captures.flareBase = await settleAndGrab();
      }
      const stage = stages.add(effect.create());
      if (!effect.space) {
        goModelView();
      }
      await renderFrames(15);
      captures[effect.key] = effect.settle
        ? await settleAndGrab()
        : await grab();
      stages.remove(stage);
      if (effect.space) {
        // The interactive demo restores the animated clock on leaving the
        // space view; the probe restores the exact deterministic time so the
        // post-cycle "None" frame can be compared byte-wise against noPP.
        v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T18:00:00Z");
        goModelView();
        await renderFrames(30);
      }
    }

    // back to the demo's "None" selection — collection empty again
    await renderFrames(10);
    captures.restored = await settleAndGrab();

    return {
      captures,
      effectMeta: effects.map((e) => ({
        key: e.key,
        minDiff: e.minDiff || 5000,
        maxDiff: e.maxDiff || 0, // 0 = no cap
      })),
      gpuErrors: window.__gpuErrors,
    };
  },
  { modelUrl: MODEL_URL },
);

await browser.close();

// ---- adjudicate ----
function savePng(name, img) {
  writeFileSync(
    join(OUT_DIR, name),
    Buffer.from(img.png.split(",")[1], "base64"),
  );
}
function diffImgs(a, b) {
  const A = Buffer.from(a.b64, "base64");
  const B = Buffer.from(b.b64, "base64");
  if (A.length !== B.length) {
    return { diffBytes: -1, maxDelta: 255, note: "size mismatch" };
  }
  let diffBytes = 0;
  let maxDelta = 0;
  for (let i = 0; i < A.length; i++) {
    const d = Math.abs(A[i] - B[i]);
    if (d > 0) diffBytes++;
    if (d > maxDelta) maxDelta = d;
  }
  return { diffBytes, maxDelta };
}

const fails = [];
if (!assetServes) fails.push(`asset does not serve: ${MODEL_URL}`);

savePng("demo-noPP.png", out.captures.noPP);
savePng("demo-allOff.png", out.captures.allOff);
savePng("demo-restored.png", out.captures.restored);
savePng("demo-flareBase.png", out.captures.flareBase);

// (3) OFF-GATE: all-added-but-disabled === true no-PP, byte-identical.
const dOff = diffImgs(out.captures.allOff, out.captures.noPP);
console.log(
  `off-gate allOff vs noPP: ${dOff.diffBytes === 0 ? "BYTE-IDENTICAL" : `diffBytes=${dOff.diffBytes} max=${dOff.maxDelta}`}`,
);
if (dOff.diffBytes !== 0)
  fails.push("off-gate: allOff not byte-identical to noPP");
const dRes = diffImgs(out.captures.restored, out.captures.noPP);
console.log(
  `off-gate restored vs noPP: ${dRes.diffBytes === 0 ? "BYTE-IDENTICAL" : `diffBytes=${dRes.diffBytes} max=${dRes.maxDelta}`}`,
);
if (dRes.diffBytes !== 0) {
  fails.push("off-gate: restored (post-cycle None) not byte-identical to noPP");
}

// (2) each effect visibly transforms its baseline — AND is DISCRIMINATED
// from the other effects. The _userStagesRefs rebuild-detection bug (a
// same-frame remove()+add() swap missed by count-only detection) leaves the
// FIRST effect's WGSL twin running for every later selection; those stale
// frames still "visibly transform" vs noPP, so the visibility gate alone
// cannot catch it (empirically proven by revert+rerun in the B21 audit).
// Two stale-frame discriminators:
//   (a) each effect's capture must DIFFER from the previous effect's
//       capture (stale frames are byte-identical to each other), and
//   (b) thin-outline effects (silhouette/edgeDetection, maxDiff set) must
//       stay far below a stale fullscreen frame's ~1.9M diff bytes.
const PREV_MIN_DIFF = 1000;
let prevKey = null;
for (const { key, minDiff, maxDiff } of out.effectMeta) {
  const img = out.captures[key];
  savePng(`demo-${key}.png`, img);
  const base = key === "lensFlare" ? out.captures.flareBase : out.captures.noPP;
  const d = diffImgs(img, base);
  const visible = d.diffBytes > minDiff && d.maxDelta > 30;
  const dPrev = prevKey ? diffImgs(img, out.captures[prevKey]) : null;
  console.log(
    `${key.padEnd(14)} diffBytes=${d.diffBytes} max=${d.maxDelta} ${visible ? "VISIBLE" : "NO-TRANSFORM"}` +
      (dPrev ? ` | vsPrev(${prevKey})=${dPrev.diffBytes}` : ""),
  );
  if (!visible) fails.push(`${key}: no visible transform`);
  if (maxDiff > 0 && d.diffBytes >= maxDiff) {
    fails.push(
      `${key}: diffBytes=${d.diffBytes} >= cap ${maxDiff} — stale fullscreen frame masquerading as a thin outline (correct ~20K)`,
    );
  }
  if (dPrev && dPrev.diffBytes < PREV_MIN_DIFF) {
    fails.push(
      `${key}: capture (near-)identical to previous effect '${prevKey}' (diffBytes=${dPrev.diffBytes}) — stale pipeline, user-stage rebuild not triggered`,
    );
  }
  prevKey = key;
}

// (5) zero errors.
const allErrors = [...consoleErrors, ...out.gpuErrors];
if (allErrors.length) {
  fails.push(`errors: ${allErrors.slice(0, 3).join(" | ")}`);
}

console.log(`assetServes=${assetServes} errors=${allErrors.length}`);
console.log(`PNGs: ${OUT_DIR}`);
console.log(fails.length ? `FAILS:\n  ${fails.join("\n  ")}` : "");
console.log(fails.length ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
