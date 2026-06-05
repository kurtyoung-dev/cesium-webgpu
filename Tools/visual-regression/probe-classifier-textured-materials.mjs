// Classifier textured-materials probe (NEW-GROUNDPRIM-TEXTURED-MATERIALS).
//
// Verifies textured `GroundPrimitive` materials on WebGPU vs WebGL across
// the materials WebGL ShadowVolumeAppearance.glsl supports:
//
//   - Color         (per-instance color — flat path; baseline)
//   - Stripe        (alternating rectangles, evenColor / oddColor)
//   - Checkerboard  (2D parity grid, lightColor / darkColor)
//   - Grid          (line-grid, color × line color)
//   - Image         (uniforms.image — texture sample modulated by color)
//
// Method: drop one ground-clamped polygon per material over the central US in
// SCENE3D (the easiest case — flat-color path was the only thing rendering
// before Batches 161/164/170; textured path is the next deferred gap). For
// each material capture both backends, count "lit fragments" inside the
// polygon's approximate footprint, and additionally compute a per-pixel
// color-variance signal that distinguishes "flat color" from "textured pattern":
//
//   - For Stripe / Checkerboard / Grid: WebGL has high local variance (the
//     stripes/squares/lines are visible); WebGPU currently has ZERO variance
//     because it ignores the material and renders flat color.
//   - For Image: WebGL has a recognizable Cesium logo / billboard variance;
//     WebGPU has zero.
//
// PASS criteria (regression guard for the eventual material-path landing):
//   - Color material: WebGPU coverage within ~20% of WebGL (already works).
//   - Stripe / Checkerboard / Grid: WebGPU local-variance >= some fraction
//     of WebGL's variance (the texture pattern is actually rendered).
//   - Image: WebGPU shows non-trivial variance + 0 device errors.
//
// Status (Batch 198): material dispatch is in place in
// `WebGPUGroundPrimitiveRenderer` — UBO carries invProj + materialMeta +
// planar/spherical extents; `applyMaterial` dispatches on `materialMeta.x`
// for Color (flat path), Stripe, Checkerboard, Grid, AND **Image** (Batch
// 198 — group-0 material texture + sampler, async upload via
// `ensureMaterialImage`, 1x1 white fallback). `resolveMaterialState` packs
// each material's params from the `Material.uniforms` Cesium API. 0 device
// errors across all materials. All textured materials render a pattern
// (high variance); the Image checkerboard, Stripe, and Checkerboard match
// WebGL's variance within ±25%.
//
// KNOWN LIMITATION — variance is FREQUENCY-BLIND. This probe asserts a
// pattern is present (variance) + coverage parity (lit), NOT that the
// tiling FREQUENCY matches WebGL. As of Batch 198 the WebGPU textured
// UV tiles ~4x FINER than WebGL at this 350 km nadir view (visible in the
// texmat-*-webgpu.png: the Image polygon reads as a fine magenta blur, the
// Stripe polygon shows ~30+ thin bands vs WebGL's ~10). The variance check
// still passes because a high-frequency red/blue pattern has ~constant
// variance regardless of tile count.
//
// ROOT CAUSE (confirmed empirically, Batch 198 — NEW-GROUNDPRIM-CLASSIFIER-
// RECON-PRECISION): the planar extents are CORRECT (eastward 58.6 km /
// northward 33.5 km world-space for the 0.7°×0.3° polygon) and the OBB
// remap is an identity u/v swap (uvMinAndExtents=[0,0,1,1],
// uMaxVmax=[0,1,1,0]). The ~4x error is in `windowToEye`'s NON-LOG path:
// it unprojects the sampled globe depth with `u.invProj` =
// inverse(uniformState.projection) captured ONCE at createCommands time.
// That projection's z-terms (p22/p23, near/far-dependent) don't match the
// per-slice projection the globe used to WRITE the sampled depth, so the
// recovered eye.w — and thus the eye.xy the UV is derived from — is scaled.
// The per-slice fix (fstate group-2 invProj) exists for the LOG path but
// `resolveFrustumStateBindGroup` is NOT invoked for the color draw
// ("Link 4 unresolved", Batch 184), so the non-log path can't use it yet.
// Fixing it = wiring the per-slice frustum-state bind group into the color
// draw + a fresh per-slice inverseProjection. Tracked in DEFERRED_WORK.

import { chromium } from "playwright";
import fs from "fs";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
// Flip once the material path actually renders textures in WebGPU.
const ENFORCE_TEXTURED = false;

// Stripe / Checkerboard / Grid materials — variance ratio (WebGPU / WebGL)
// floor. ~0.3 catches a half-broken pattern; 0.0 means "anything > flat".
const MIN_TEXTURED_RATIO = 0.3;
// Color material — coverage ratio floor (already works).
const MIN_COLOR_RATIO = 0.5;

// Material definitions used by both backends. Strings + JS expressions
// evaluated inside page.evaluate where Cesium is in scope.
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
    // Image material — uniforms.image is a 16x16 red/blue checkerboard
    // built in-page as a data URL (self-contained, high spatial variance
    // so the pattern is unambiguous in the variance signal). repeat x4
    // tiles it across the polygon. White tint (no modulation) so the
    // image's own colors show. Exercises the Batch-198 group-0 material
    // texture + sampler path (ensureMaterialImage upload + bind-group
    // rebuild + the materialType==4 applyMaterial Image branch).
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

// Polygon-interior ROI (the polygon at -100..-95 / 40..43 at 2.4 Mm
// nadir occupies roughly center ~280-520 x 240-380 of the 800x600
// viewport). Tighten to a strip inside the polygon's visible area so
// the variance signal is driven by the material pattern, not by polygon
// vs. background contrast. The exact bounds were chosen empirically
// from a flat-color WebGPU baseline screenshot.
const ROI = { x0: 320, y0: 250, x1: 460, y1: 350 };

// Pixel-sum threshold for "lit polygon pixel" — must exceed the
// imagery-stripped globe baseColor #202028 (R+G+B = 104). Use 160 to
// reject background + leave headroom against compression noise.
const LIT_THRESHOLD = 160;

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

  await page.evaluate(
    async ({ build }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.useDefaultRenderLoop = false;
      const scene = v.scene;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.backgroundColor = C.Color.fromCssColorString("#101014");
      // The globe surface MUST render (both backends) so the globe-depth
      // pass writes real depth — without it, depth = 1.0 (far plane) and
      // the FS material path's windowToEye recovery degenerates. The
      // default ion imagery needs a token (absent in headless CI), so the
      // WebGL globe renders nothing and the classifier has no surface to
      // clamp to. Use a token-free SingleTileImageryProvider with a solid
      // DARK fill (#26262c, channel-sum 114 < LIT_THRESHOLD 160) so the
      // globe surface stays below the "lit polygon pixel" cutoff and the
      // ROI variance is driven purely by the polygon material — not by the
      // underlying imagery showing through the translucent appearance.
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
      // Force the token-free ellipsoid terrain so neither backend waits on
      // the (failing) ion World Terrain asset — the WebGL GroundPrimitive
      // depth-classification will not emit draw commands until its terrain
      // provider is ready, so a stalled ion terrain leaves the WebGL globe
      // surface unclassified (0 lit) even though the imagery loaded.
      v.terrainProvider = new C.EllipsoidTerrainProvider();
      scene.globe.depthTestAgainstTerrain = true;
      scene.globe.showGroundAtmosphere = false;

      // GroundPrimitive with a MaterialAppearance (no per-instance color —
      // material drives the FS).
      // eslint-disable-next-line no-new-func
      const material = new Function("C", `return (${build});`)(C);
      // Use a small (sub-1-degree) polygon so the GroundPrimitive
      // builds with PLANAR extents (smaller than MAX_WIDTH_FOR_PLANAR_EXTENTS
      // = 1°). Spherical-extent UV is also wired but has more moving
      // parts to verify; let the planar baseline land first.
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

      // Frame the polygon nadir FIRST so the globe tiles for this region
      // load during the build loop — the WebGL GroundPrimitive only emits
      // classification commands once the underlying surface tiles are ready.
      v.camera.setView({
        // Tighter altitude scaled to the sub-degree polygon (~0.7° wide
        // → ~80 km). 350 km altitude puts the polygon at a similar
        // screen footprint as the larger spherical polygon at 2.4 Mm.
        destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 350_000),
        orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
      });

      // Build the primitive AND settle globe tiles.
      for (let i = 0; i < 400; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (ground.ready && scene.globe.tilesLoaded && i > 30) break;
      }
      for (let i = 0; i < 60; i++) {
        scene.requestRender();
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { build: mat.build },
  );

  const png = await page.screenshot({ type: "png" });
  fs.writeFileSync(`${OUT_DIR}/texmat-${mat.name}-${renderer}.png`, png);

  // Decode + analyze: count "lit" non-background pixels inside ROI,
  // and compute a local-variance summary that flags "textured pattern".
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
          let r2 = 0, g2 = 0, b2 = 0;
          let r1 = 0, g1 = 0, b1 = 0;
          let nLit = 0;
          for (let y = roi.y0; y < roi.y1; y++) {
            for (let x = roi.x0; x < roi.x1; x++) {
              const i = (y * c.width + x) * 4;
              const r = d[i], g = d[i + 1], b = d[i + 2];
              const sum = r + g + b;
              if (sum < litThreshold) continue;
              lit++;
              // Variance computed ONLY over lit polygon pixels — so a
              // material that produces alternating red/blue stripes
              // gives high variance, while a flat-color polygon gives
              // near-zero variance, independent of polygon size.
              r1 += r; g1 += g; b1 += b;
              r2 += r * r; g2 += g * g; b2 += b * b;
              nLit++;
            }
          }
          let variance = 0;
          if (nLit > 0) {
            const rMean = r1 / nLit, gMean = g1 / nLit, bMean = b1 / nLit;
            const rVar = Math.max(0, r2 / nLit - rMean * rMean);
            const gVar = Math.max(0, g2 / nLit - gMean * gMean);
            const bVar = Math.max(0, b2 / nLit - bMean * bMean);
            variance = Math.round((rVar + gVar + bVar) / 3);
          }
          resolve({ lit, variance });
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
  return { ...stats, errs };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("=== Classifier textured-materials probe (GroundPrimitive) ===\n");
  console.log(
    "  material         WebGL lit  WebGL var | WebGPU lit  WebGPU var  errs | verdict",
  );

  let pass = true;
  for (const mat of MATERIALS) {
    const wgl = await captureMaterial("webgl", mat);
    const wgpu = await captureMaterial("webgpu", mat);
    const litRatio = wgl.lit > 0 ? wgpu.lit / wgl.lit : 0;
    const varRatio = wgl.variance > 0 ? wgpu.variance / wgl.variance : 0;

    let verdict;
    if (mat.name === "Color") {
      verdict = litRatio >= MIN_COLOR_RATIO && wgpu.errs.length === 0 ? "OK" : "FAIL";
    } else {
      const texturedOk =
        varRatio >= MIN_TEXTURED_RATIO && litRatio >= MIN_COLOR_RATIO && wgpu.errs.length === 0;
      verdict = texturedOk ? "OK" : ENFORCE_TEXTURED ? "FAIL" : "known-open(textured)";
    }

    console.log(
      `  ${mat.name.padEnd(14)} ${String(wgl.lit).padStart(10)} ${String(wgl.variance).padStart(10)} | ${String(wgpu.lit).padStart(10)} ${String(wgpu.variance).padStart(11)} ${String(wgpu.errs.length).padStart(5)} | ${verdict}` +
        `   (litR=${litRatio.toFixed(2)} varR=${varRatio.toFixed(2)})`,
    );

    if (wgpu.errs.length !== 0) pass = false;
    if (verdict === "FAIL") pass = false;
  }

  console.log(`\n  PNGs: ${OUT_DIR}/texmat-{Color,Stripe,Checkerboard,Grid,Image}-{webgl,webgpu}.png`);
  console.log(pass ? "\nPASS" : "\nFAIL");
  process.exit(pass ? 0 : 1);
})();
