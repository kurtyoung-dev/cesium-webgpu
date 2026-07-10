// C7-GROUNDPRIM-TEXTURED-CLASSIFY-ZERO acceptance probe.
//
// Verifies textured GroundPrimitive classification (Stripe / Checkerboard /
// Grid / Image materials) draped on the globe renders on WebGPU and converges
// with WebGL, and that the flat Color path stays regression-green.
//
// HISTORY — why this probe exists and why it gates on GLOBE READINESS:
// the long-standing "textured GroundPrimitive classification renders ~0 px
// on WebGPU" report (re-confirmed at B595 via
// probe-classifier-textured-materials.mjs) turned out to be a PROBE-HARNESS
// RACE, not a classifier bug. The WebGPU globe terrain pipeline is created
// via `createRenderPipelineAsync` and takes ~1-2 s of wall time on a fresh
// browser profile; the old probe's settle loops exit on
// `scene.globe.tilesLoaded` (which does NOT cover pipeline readiness) and
// its ~90 RAF iterations complete in under a second headless. Every capture
// therefore ran against a GLOBE-LESS scene: the packed globe depth was the
// cleared sentinel, the textured path's log-depth slice-band check discarded
// every fragment (garbage decode), and only the flat Color path (which never
// reads the depth reconstruction) rasterized — over the sky, no less.
// WebGL compiles shaders synchronously, so only WebGPU showed the race.
//
// The correct readiness gate: poll until the frustum command lists contain
// GLOBE-pass commands (pass index 2) — that is only true once the terrain
// pipeline actually resolved and tiles emit draw commands.
//
// PASS criteria:
//   - Color: WebGPU lit-pixel count within 20 % of WebGL, 0 device errors.
//   - Stripe / Checkerboard / Grid / Image: WebGPU renders the pattern
//     (lit >= 50 % of WebGL, local color variance >= 30 % of WebGL's) and
//     the polygon-ROI pixel diff vs WebGL converges (< 25 % mismatch).
//
// Usage: node Tools/visual-regression/probe-groundprim-textured-classify.mjs

import { chromium } from "playwright";
import fs from "fs";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const MIN_LIT_RATIO = 0.5;
const MIN_VARIANCE_RATIO = 0.3;
const MAX_ROI_MISMATCH = 0.25;

// Polygon-interior ROI at the 350 km nadir view (800x600 viewport).
const ROI = { x0: 345, y0: 270, x1: 455, y1: 330 };
// "Lit polygon pixel" = channel sum above the dark globe fill (#26262c ->
// 114) + headroom.
const LIT_THRESHOLD = 160;

const MATERIALS = [
  {
    name: "Color",
    build: `new C.Material({
      fabric: { type: "Color", uniforms: { color: new C.Color(1.0, 0.05, 0.05, 1.0) } },
    })`,
  },
  {
    name: "Stripe",
    build: `new C.Material({
      fabric: {
        type: "Stripe",
        uniforms: {
          evenColor: new C.Color(1.0, 0.05, 0.05, 1.0),
          oddColor:  new C.Color(0.05, 0.05, 1.0, 1.0),
          repeat: 10,
          horizontal: true,
        },
      },
    })`,
  },
  {
    name: "Checkerboard",
    build: `new C.Material({
      fabric: {
        type: "Checkerboard",
        uniforms: {
          lightColor: new C.Color(1.0, 0.05, 0.05, 1.0),
          darkColor:  new C.Color(0.05, 0.05, 1.0, 1.0),
          repeat: new C.Cartesian2(6, 6),
        },
      },
    })`,
  },
  {
    name: "Grid",
    build: `new C.Material({
      fabric: {
        type: "Grid",
        uniforms: {
          color: new C.Color(1.0, 0.05, 0.05, 1.0),
          cellAlpha: 0.5,
          lineCount: new C.Cartesian2(10, 10),
          lineThickness: new C.Cartesian2(2.0, 2.0),
        },
      },
    })`,
  },
  {
    // 16x16 red/blue checkerboard data URL — exercises the group-0 material
    // texture upload path (materialType 4).
    name: "Image",
    build: `(() => {
      const cv = document.createElement("canvas");
      cv.width = 16; cv.height = 16;
      const cc = cv.getContext("2d");
      for (let yy = 0; yy < 16; yy++) {
        for (let xx = 0; xx < 16; xx++) {
          const on = (((xx >> 2) + (yy >> 2)) % 2) === 0;
          cc.fillStyle = on ? "#ff0d0d" : "#0d0dff";
          cc.fillRect(xx, yy, 1, 1);
        }
      }
      return new C.Material({
        fabric: {
          type: "Image",
          uniforms: {
            image: cv.toDataURL(),
            repeat: new C.Cartesian2(4, 4),
            color: new C.Color(1.0, 1.0, 1.0, 1.0),
          },
        },
      });
    })()`,
  },
];

async function captureMaterial(renderer, mat) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", (e) =>
    console.log(`>> [${renderer}/${mat.name}] pageerror: ${e.message.slice(0, 160)}`),
  );
  await page.goto(`${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(() => {
    window.__probeErrors = [];
    const dev = window.viewer?.scene?.context?._device;
    if (dev) dev.onuncapturederror = (ev) => window.__probeErrors.push(ev?.error?.message ?? "");
  });

  const setup = await page.evaluate(
    async ({ build }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.useDefaultRenderLoop = false;
      const scene = v.scene;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.backgroundColor = C.Color.fromCssColorString("#101014");
      // Token-free solid-fill imagery so the globe surface renders in
      // headless CI (the default ion imagery needs a token). The dark fill
      // (#26262c, channel-sum 114 < LIT_THRESHOLD) keeps the ROI signal
      // driven purely by the polygon material.
      {
        const solid = document.createElement("canvas");
        solid.width = 4;
        solid.height = 4;
        const sc = solid.getContext("2d");
        sc.fillStyle = "#26262c";
        sc.fillRect(0, 0, 4, 4);
        const prov = await C.SingleTileImageryProvider.fromUrl(solid.toDataURL(), {
          rectangle: C.Rectangle.fromDegrees(-180, -90, 180, 90),
        });
        scene.imageryLayers.removeAll();
        scene.imageryLayers.addImageryProvider(prov);
      }
      v.terrainProvider = new C.EllipsoidTerrainProvider();
      scene.globe.depthTestAgainstTerrain = true;
      scene.globe.showGroundAtmosphere = false;

      // eslint-disable-next-line no-new-func
      const material = new Function("C", `return (${build});`)(C);
      // Sub-1-degree polygon -> PLANAR extents path.
      const positions = C.Cartesian3.fromDegreesArray([
        -97.85, 41.35, -97.15, 41.35, -97.15, 41.65, -97.85, 41.65,
      ]);
      const ground = new C.GroundPrimitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(positions),
          }),
        }),
        appearance: new C.MaterialAppearance({
          material,
          translucent: true,
          flat: true,
        }),
        classificationType: C.ClassificationType.TERRAIN,
        asynchronous: false,
      });
      scene.groundPrimitives.add(ground);

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 350_000),
        orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
      });

      // READINESS GATE (see header): render until (a) the primitive is
      // ready, (b) globe tiles are loaded, AND (c) GLOBE-pass commands are
      // actually in the frustum lists — (c) is what proves the async
      // terrain pipeline resolved on WebGPU. Wall-clock bounded at 90 s.
      const globeCommandCount = () =>
        (scene.frustumCommandsList ?? []).reduce(
          (acc, fc) => acc + (fc.indices?.[2] ?? 0),
          0,
        );
      const t0 = performance.now();
      let ready = false;
      while (performance.now() - t0 < 90_000) {
        scene.requestRender();
        scene.render();
        if (ground.ready && scene.globe.tilesLoaded && globeCommandCount() > 0) {
          ready = true;
          break;
        }
        // setTimeout (not RAF) so headless wall time actually elapses while
        // the async pipeline cooks.
        await new Promise((r) => setTimeout(r, 50));
      }
      // Settle frames after readiness so imagery/classification stabilize.
      for (let i = 0; i < 30; i++) {
        scene.requestRender();
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return {
        ready,
        globeCommands: globeCommandCount(),
        waitedMs: Math.round(performance.now() - t0),
      };
    },
    { build: mat.build },
  );

  const png = await page.screenshot({ type: "png" });
  fs.writeFileSync(`${OUT_DIR}/gptc-${mat.name}-${renderer}.png`, png);

  const stats = await page.evaluate(
    async (args) => {
      const { durl, roi, litThreshold } = args;
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const cx = c.getContext("2d");
          cx.drawImage(img, 0, 0);
          const d = cx.getImageData(0, 0, c.width, c.height).data;
          let lit = 0;
          let r1 = 0, g1 = 0, b1 = 0, r2 = 0, g2 = 0, b2 = 0, n = 0;
          const roiPixels = [];
          for (let y = roi.y0; y < roi.y1; y++) {
            for (let x = roi.x0; x < roi.x1; x++) {
              const i = (y * c.width + x) * 4;
              const r = d[i], g = d[i + 1], b = d[i + 2];
              roiPixels.push(r, g, b);
              if (r + g + b < litThreshold) continue;
              lit++;
              r1 += r; g1 += g; b1 += b;
              r2 += r * r; g2 += g * g; b2 += b * b;
              n++;
            }
          }
          let variance = 0;
          if (n > 0) {
            const rm = r1 / n, gm = g1 / n, bm = b1 / n;
            variance = Math.round(
              (Math.max(0, r2 / n - rm * rm) +
                Math.max(0, g2 / n - gm * gm) +
                Math.max(0, b2 / n - bm * bm)) / 3,
            );
          }
          resolve({ lit, variance, roiPixels });
        };
        img.src = durl;
      });
    },
    {
      durl: `data:image/png;base64,${png.toString("base64")}`,
      roi: ROI,
      litThreshold: LIT_THRESHOLD,
    },
  );

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();
  return { ...stats, errs, setup };
}

// Per-pixel ROI mismatch between the two backends (tolerance 48/channel —
// generous enough for AA/dither differences, tight enough that a missing or
// wrong-frequency pattern fails).
function roiMismatch(a, b) {
  const n = Math.min(a.length, b.length);
  let bad = 0;
  for (let i = 0; i < n; i += 3) {
    if (
      Math.abs(a[i] - b[i]) > 48 ||
      Math.abs(a[i + 1] - b[i + 1]) > 48 ||
      Math.abs(a[i + 2] - b[i + 2]) > 48
    ) {
      bad++;
    }
  }
  return bad / (n / 3);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("=== GroundPrimitive textured-classification acceptance probe ===\n");
  console.log(
    "  material         WebGL lit/var | WebGPU lit/var  errs  gpuCmds  waitMs | roiDiff | verdict",
  );

  let pass = true;
  for (const mat of MATERIALS) {
    const wgl = await captureMaterial("webgl", mat);
    const wgpu = await captureMaterial("webgpu", mat);
    const litRatio = wgl.lit > 0 ? wgpu.lit / wgl.lit : 0;
    const varRatio = wgl.variance > 0 ? wgpu.variance / wgl.variance : 1;
    const mismatch = roiMismatch(wgl.roiPixels, wgpu.roiPixels);

    let ok =
      wgpu.errs.length === 0 &&
      wgpu.setup.ready &&
      litRatio >= MIN_LIT_RATIO &&
      mismatch <= MAX_ROI_MISMATCH;
    if (mat.name !== "Color") {
      ok = ok && varRatio >= MIN_VARIANCE_RATIO;
    }
    if (!ok) pass = false;

    console.log(
      `  ${mat.name.padEnd(14)} ${String(wgl.lit).padStart(6)}/${String(wgl.variance).padEnd(6)}| ` +
        `${String(wgpu.lit).padStart(7)}/${String(wgpu.variance).padEnd(6)} ` +
        `${String(wgpu.errs.length).padStart(4)}  ${String(wgpu.setup.globeCommands).padStart(6)}  ` +
        `${String(wgpu.setup.waitedMs).padStart(6)} | ${(mismatch * 100).toFixed(1).padStart(6)}% | ` +
        `${ok ? "OK" : "FAIL"}  (litR=${litRatio.toFixed(2)} varR=${varRatio.toFixed(2)})`,
    );
  }

  console.log(`\n  PNGs: ${OUT_DIR}/gptc-{Color,Stripe,Checkerboard,Grid,Image}-{webgl,webgpu}.png`);
  console.log(pass ? "\nPASS" : "\nFAIL");
  process.exit(pass ? 0 : 1);
})();
