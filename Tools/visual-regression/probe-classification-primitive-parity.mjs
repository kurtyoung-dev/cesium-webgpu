// Standalone ClassificationPrimitive parity probe
// (PARITY-GPRIM-CLASSIFY-STANDALONE).
//
// GroundPrimitive already classifies terrain / 3D-Tiles correctly on WebGPU
// (verified by probe-classifier-scenemode / -textured-materials). This probe
// exercises the STANDALONE `ClassificationPrimitive` path: a user-supplied
// volume geometry (here a BoxGeometry) added directly to `scene.primitives`
// with a per-instance color attribute + `classificationType`, classifying the
// globe terrain surface. That path delegates to the CLASSIFICATION_PRIMITIVE
// feature renderer (WebGPUGroundPrimitiveRenderer.createWebGPUGroundPrimitive
// Commands via the depth-2 wrapping-chain walk) — this is the code under test.
//
// Method: for each backend, add a red box classification volume straddling the
// terrain over the central US, frame it nadir, render to steady state, and
// count "classified" red pixels inside a fixed ROI over the box footprint. The
// box's lower half is below the ellipsoid surface so the depth-sample
// classifier tints the ground the box covers.
//
// A second variant adds a Vector3DTile-adjacent regression check is out of
// scope for a pure-terrain probe; instead we assert (a) WebGPU classified
// coverage is within tolerance of WebGL, and (b) 0 device errors (a broken
// classification command invalidates the whole scene pass → black + errors,
// which this catches).
//
// PASS:
//   - WebGPU classified red-pixel coverage within +/-25% of WebGL, AND both
//     backends clearly render the tint (>= MIN_RED px).
//   - 0 WebGPU device errors.
//
// READ the PNGs: classprim-{webgl,webgpu}.png in the output dir.

import { chromium } from "playwright";
import fs from "fs";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const MIN_RED = 1500; // classified-pixel floor: box tint clearly present
const MAX_COVERAGE_DELTA = 0.25; // WebGPU coverage within +/-25% of WebGL

// ROI over the box footprint at the framed nadir view. The box is 0.6 deg
// wide (-97.8..-97.2 / 41.2..41.8) at ~300 km nadir; it occupies roughly the
// center of the 800x600 viewport. A generous central ROI captures the tint.
const ROI = { x0: 250, y0: 170, x1: 560, y1: 440 };

// "Classified red pixel": red channel dominant + bright enough to beat the
// dark globe baseColor. The box color is (1.0, 0.1, 0.1, 0.5) premultiplied
// over a dark surface, so the composited red channel stays high while G/B stay
// low.
function isRed(r, g, b) {
  return r > 90 && r > g + 40 && r > b + 40;
}

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", (e) =>
    console.log(`>> [${renderer}] pageerror: ${e.message.slice(0, 200)}`),
  );
  await page.goto(
    `${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(() => {
    window.__probeErrors = [];
    const dev = window.viewer?.scene?.context?._device;
    if (dev) {
      dev.onuncapturederror = (ev) =>
        window.__probeErrors.push(ev?.error?.message ?? "");
    }
  });

  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const scene = v.scene;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    scene.backgroundColor = C.Color.fromCssColorString("#101014");
    scene.globe.showGroundAtmosphere = false;

    // Token-free dark globe imagery so the classified tint is unambiguous
    // against the surface (mirrors the textured-materials probe).
    {
      const solid = document.createElement("canvas");
      solid.width = 4;
      solid.height = 4;
      const sc = solid.getContext("2d");
      sc.fillStyle = "#26262c";
      sc.fillRect(0, 0, 4, 4);
      const prov = await C.SingleTileImageryProvider.fromUrl(
        solid.toDataURL(),
        { rectangle: C.Rectangle.fromDegrees(-180, -90, 180, 90) },
      );
      scene.imageryLayers.removeAll();
      scene.imageryLayers.addImageryProvider(prov);
    }
    // Token-free ellipsoid terrain + depth-test-against-terrain so the
    // globe-depth pass writes real surface depth for the classifier to sample.
    v.terrainProvider = new C.EllipsoidTerrainProvider();
    scene.globe.depthTestAgainstTerrain = true;

    // Standalone ClassificationPrimitive: a BOX volume straddling the
    // ellipsoid surface over the central US. The box center sits ON the
    // surface (height 0) and extends +/-5 km in Z so its lower half is below
    // ground — the classifier tints the terrain the box's footprint covers.
    const center = C.Cartesian3.fromDegrees(-97.5, 41.5, 0.0);
    const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(center);
    // ~0.6 deg footprint at 41.5 lat: ~50 km E-W, ~66 km N-S. Height 10 km.
    const dimensions = new C.Cartesian3(50000.0, 66000.0, 10000.0);
    const boxGeometry = C.BoxGeometry.fromDimensions({
      vertexFormat: C.VertexFormat.POSITION_ONLY,
      dimensions: dimensions,
    });
    const boxInstance = new C.GeometryInstance({
      geometry: boxGeometry,
      modelMatrix: modelMatrix,
      attributes: {
        color: C.ColorGeometryInstanceAttribute.fromColor(
          new C.Color(1.0, 0.1, 0.1, 0.5),
        ),
      },
    });
    const classificationPrimitive = new C.ClassificationPrimitive({
      geometryInstances: boxInstance,
      classificationType: C.ClassificationType.TERRAIN,
      asynchronous: false,
    });
    scene.primitives.add(classificationPrimitive);
    window.__classPrim = classificationPrimitive;

    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 300_000),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
    });

    // Build the primitive AND settle globe tiles.
    //
    // READINESS RACE FIX (C7-GROUNDPRIM-TEXTURED-CLASSIFY-ZERO): also
    // gate on GLOBE-pass commands reaching the frustum lists —
    // `tilesLoaded` does NOT cover the WebGPU globe terrain pipeline's
    // ~1-2 s `createRenderPipelineAsync`, and headless RAF loops finish
    // well inside that window. Without the gate this probe captured a
    // globe-less scene; it historically still "passed" only because the
    // packed-depth pack lacked the WebGL no-surface sentinel and the
    // classifier rasterized over the sky. With czm_packDepth(1.0)
    // parity (packs emit vec4(0) for cleared depth), a globe-less
    // capture correctly classifies NOTHING — matching WebGL.
    const globeCommandCount = () =>
      (scene.frustumCommandsList ?? []).reduce(
        (acc, fc) => acc + (fc.indices?.[2] ?? 0),
        0,
      );
    const t0 = performance.now();
    while (performance.now() - t0 < 90_000) {
      scene.requestRender();
      scene.render();
      if (
        window.__classPrim.ready &&
        scene.globe.tilesLoaded &&
        globeCommandCount() > 0
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    for (let i = 0; i < 60; i++) {
      scene.requestRender();
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  const png = await page.screenshot({ type: "png" });
  fs.writeFileSync(`${OUT_DIR}/classprim-${renderer}.png`, png);

  const stats = await page.evaluate(
    async ({ durl, roi }) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const cx = c.getContext("2d");
          cx.drawImage(img, 0, 0);
          const d = cx.getImageData(0, 0, c.width, c.height).data;
          let red = 0;
          for (let y = roi.y0; y < roi.y1; y++) {
            for (let x = roi.x0; x < roi.x1; x++) {
              const i = (y * c.width + x) * 4;
              const r = d[i];
              const g = d[i + 1];
              const b = d[i + 2];
              if (r > 90 && r > g + 40 && r > b + 40) {
                red++;
              }
            }
          }
          resolve({ red });
        };
        img.src = durl;
      });
    },
    {
      durl: `data:image/png;base64,${png.toString("base64")}`,
      roi: ROI,
    },
  );

  const ready = await page.evaluate(() => !!window.__classPrim?.ready);
  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();
  return { ...stats, ready, errs };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    "=== Standalone ClassificationPrimitive parity probe (box over terrain) ===\n",
  );

  const wgl = await run("webgl");
  const wgpu = await run("webgpu");

  const coverageRatio = wgl.red > 0 ? wgpu.red / wgl.red : 0;
  const coverageDelta = Math.abs(coverageRatio - 1.0);

  console.log(`  backend  ready  classified-red  errs`);
  console.log(
    `  webgl    ${String(wgl.ready).padEnd(5)}  ${String(wgl.red).padStart(14)}  ${wgl.errs.length}`,
  );
  console.log(
    `  webgpu   ${String(wgpu.ready).padEnd(5)}  ${String(wgpu.red).padStart(14)}  ${wgpu.errs.length}`,
  );
  console.log(
    `\n  coverage ratio (webgpu/webgl) = ${coverageRatio.toFixed(3)} (delta ${coverageDelta.toFixed(3)}, max ${MAX_COVERAGE_DELTA})`,
  );
  if (wgpu.errs.length) {
    console.log(`  WebGPU device errors:`);
    for (const e of wgpu.errs.slice(0, 8)) console.log(`    - ${e}`);
  }

  const pass =
    wgl.red >= MIN_RED &&
    wgpu.red >= MIN_RED &&
    coverageDelta <= MAX_COVERAGE_DELTA &&
    wgpu.errs.length === 0;

  console.log(`\n  PNGs: ${OUT_DIR}/classprim-{webgl,webgpu}.png`);
  console.log(pass ? "\nPASS" : "\nFAIL");
  process.exit(pass ? 0 : 1);
})();
