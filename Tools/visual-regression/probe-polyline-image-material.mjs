#!/usr/bin/env node
/**
 * REPRODUCTION probe (probe-FIRST): does an Image-material polyline render the
 * TEXTURE on WebGPU, or a solid color? (C2-14 / 376d)
 * @purpose Acceptance: Image-material polyline samples its texture along the line on WebGPU (red->blue gradient split), not a solid color
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * Premise: selectPolylineMaterialShader routes Image/DiffuseMap → polylineMatColor
 * (FS returns material.color), and the polyline material pipeline has no
 * texture+sampler bind group. So an Image material on a polyline renders SOLID
 * (or garbage from reading the image UBO as a color) instead of the texture.
 * WebGL's PolylineMaterialAppearance samples the image along the line via st.
 *
 * The probe builds a horizontal polyline with an Image material whose texture is
 * RED (left half) → BLUE (right half). On WebGL the line should run red→blue
 * along its length (2 distinct color regions). On WebGPU (pre-fix) it should be
 * a single solid region. Counts red-vs-blue pixel split.
 *
 * IT HAS NO GATE, AND THE HARVEST DOES NOT ADD ONE. Despite "Acceptance" in
 * its purpose line, this probe has only ever printed a DIAGNOSIS line per
 * backend ("TEXTURED (red+blue split)" or "solid/other") and exited 0 on
 * every outcome. On the runtime it publishes the same diagnosis in its receipt
 * and returns no verdicts, so it still exits 0 whenever it measured; promoting
 * the diagnosis to a verdict is filed as its own row rather than slipped in
 * here. The G7 cluster of `CAMPAIGN11_EXECUTION_GUIDE` lists it in C11-73's
 * verification recipe.
 *
 * ON THE SHARED RUNTIME (probe-kit harvest, polyline family, DX-108). The
 * browser, the origin (`--port`, a governed Edge port, never 8080), the
 * served-build preflight, the Edge slot, the lifecycle deadline and the
 * receipt belong to `lib/probe-runtime.mjs`. The scene is the rig
 * `polyline-image-material`, built in the page from its data. The split
 * texture is encoded in Node from the rig with the kit's `encodeRgbaPng`
 * (`Tools/lib/png-rgba.mjs`) and handed to the Image material as the same
 * kind of PNG data URI the page used to draw and encode itself, so the
 * material's string-image path is unchanged. Each
 * frame is an element capture of the scene canvas through `captureElement`,
 * taken after `lib/strip-viewer-widgets.mjs` has removed the viewer chrome that
 * otherwise sits inside the canvas's rectangle (a run with chrome left over
 * the canvas refuses); the red and blue counts and their mean x are
 * `maskCentroid` (`lib/metrics/colour-mask.mjs`) over the decoded PNG with the
 * original classes, where the original read the live canvas through
 * `drawImage` inside the page.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-polyline-image-material.mjs
 * Out:   Tools/visual-regression/output/polyline-image-material/
 */
import { decodePng } from "../lib/png-decode.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { channelThresholds, maskCentroid } from "./lib/metrics/colour-mask.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import rig from "./rigs/polyline-image-material.mjs";

/** The scene this probe builds. */
export const RIG = rig;

/** The texture's left half on screen: `r > 150 && g < 90 && b < 90`. */
export const RED = channelThresholds({ rAbove: 150, gBelow: 90, bBelow: 90 });

/** The texture's right half on screen: `b > 150 && g < 90 && r < 90`. */
export const BLUE = channelThresholds({ bAbove: 150, gBelow: 90, rBelow: 90 });

/** The canvas the scene draws into; the CesiumViewer page has exactly one. */
const SCENE_CANVAS = ".cesium-widget canvas";

/**
 * A bound on one backend's work, from the probe's own step timeouts: page load
 * (90 s), the wait for `window.viewer` (90 s), the settle loop (at most half a
 * second per settle frame) and the capture (30 s). Not a measurement — a
 * ceiling past which the lifecycle stops the run (the original had no watchdog
 * at all).
 */
const BACKEND_BUDGET_MS = 90_000 + 90_000 + rig.readiness.frames * 500 + 30_000;

/**
 * The RED|BLUE split texture as a PNG data URI: the left half one colour, the
 * right half the other, fully opaque — the pixels the page used to fill on a
 * 2D canvas, encoded in Node. Pure and exported so the spec can decode it.
 *
 * @param {{width: number, height: number, leftHalf: number[], rightHalf: number[]}} texture The rig's texture.
 * @returns {string} `data:image/png;base64,…`.
 */
export function splitTextureDataUri(texture) {
  const { width, height, leftHalf, rightHalf } = texture;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = x < width / 2 ? leftHalf : rightHalf;
      const i = (y * width + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
  const png = Buffer.from(encodeRgbaPng(pixels, width, height));
  return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * Builds the rig's scene in the page — the split texture handed to an Image
 * material as a PNG data URI — and renders its
 * settle frames. `page.evaluate` ships this function's SOURCE, so everything
 * it reads arrives in `scene`; the pixels are read in Node from the capture.
 *
 * @param {object} page Playwright page.
 * @returns {Promise<{renderer: string, ready: boolean}>} Page-side facts.
 */
async function buildScene(page) {
  return page.evaluate(
    async (scene) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer,
        s = v.scene;
      for (const name of scene.hide) {
        if (s[name]) s[name].show = false;
      }
      s.backgroundColor = C.Color.BLACK;

      // The RED|BLUE split texture (left half red, right half blue).
      const dataUri = scene.textureDataUri;

      const positions = C.Cartesian3.fromDegreesArray(scene.positionsDegrees);
      const primitive = s.primitives.add(
        new C.Primitive({
          geometryInstances: new C.GeometryInstance({
            geometry: new C.PolylineGeometry({
              positions,
              width: scene.width,
              arcType: C.ArcType[scene.arcType],
              vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
            }),
          }),
          appearance: new C.PolylineMaterialAppearance({
            material: C.Material.fromType("Image", { image: dataUri }),
            translucent: false,
          }),
          asynchronous: false,
        }),
      );

      const look = scene.lookAt;
      v.camera.lookAt(
        C.Cartesian3.fromDegrees(look.lon, look.lat, look.height),
        new C.HeadingPitchRange(
          C.Math.toRadians(look.headingDegrees),
          C.Math.toRadians(look.pitchDegrees),
          look.rangeMetres,
        ),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      for (let i = 0; i < scene.frames; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { renderer: s.context?.rendererType, ready: primitive.ready };
    },
    {
      ...rig.dials,
      frames: rig.readiness.frames,
      textureDataUri: splitTextureDataUri(rig.dials.texture),
    },
  );
}

/**
 * One backend: a fresh browser context, the scene built and settled, the
 * viewer chrome removed, one element capture scored in Node.
 *
 * @param {object} options Inputs.
 * @returns {Promise<object>} The original's fields.
 */
async function runBackend({
  browser,
  origin,
  renderer,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({ viewport: { ...rig.viewport } });
  try {
    const page = await context.newPage();
    await page.goto(
      `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "networkidle", timeout: 90_000 },
    );
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 90_000,
    });
    const strip = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
    if (strip.leftovers.length > 0) {
      throw new ProbeRefusal(
        "viewer-chrome-over-canvas",
        `${rig.id}/${renderer}: elements still overlap the scene canvas after the widget strip (${strip.leftovers.join(", ")}), so an element capture would score them`,
        { rig: rig.id, renderer, ...strip },
      );
    }
    const facts = await buildScene(page);
    const shot = await captureElement({
      page,
      selector: SCENE_CANVAS,
      name: `polyline-image-${renderer}-run${run}`,
      outputDirectory,
      captures,
    });
    const image = decodePng(shot.buffer);
    const red = maskCentroid(image, RED);
    const blue = maskCentroid(image, BLUE);
    return {
      ...facts,
      red: red.count,
      blue: blue.count,
      redMeanX: red.count ? Math.round(red.meanX) : -1,
      blueMeanX: blue.count ? Math.round(blue.meanX) : -1,
      width: image.width,
      height: image.height,
    };
  } finally {
    await context.close();
  }
}

/**
 * The diagnosis the probe has always printed, as data: a backend reads
 * TEXTURED when both halves of the texture show more than 100 pixels each.
 * Pure and exported so `polyline-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {{red: number, blue: number}} result One backend's counts.
 * @returns {"TEXTURED"|"SOLID_OR_OTHER"} The diagnosis.
 */
export function diagnoseImageMaterial(result) {
  return result.red > 100 && result.blue > 100 ? "TEXTURED" : "SOLID_OR_OTHER";
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "polyline-image-material",
  title: "C2-14 / 376d — Image-material polyline texture sampling (diagnostic)",
  outputSubdirectory: "polyline-image-material",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  // The CesiumViewer page and the in-page import both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: () => 2 * BACKEND_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const shared = { browser, origin, run, outputDirectory, captures };
    const backends = {};
    for (const renderer of ["webgl", "webgpu"]) {
      if (options.renderers.includes(renderer)) {
        backends[renderer] = await runBackend({ ...shared, renderer });
        console.log(
          `${renderer.toUpperCase()}:`,
          JSON.stringify(backends[renderer]),
        );
      }
    }
    console.log("\n=== DIAGNOSIS ===");
    for (const [renderer, result] of Object.entries(backends)) {
      console.log(
        `${renderer}: red=${result.red}@x${result.redMeanX} blue=${result.blue}@x${result.blueMeanX} → ${diagnoseImageMaterial(result)}`,
      );
    }
    return [{ run, backends }];
  },
  // No verdicts: this probe has never carried a gate (see the header).
  receipt(cells) {
    return {
      rig: rig.id,
      cells: cells.map((cell) => ({
        ...cell,
        diagnosis: Object.fromEntries(
          Object.entries(cell.backends).map(([renderer, result]) => [
            renderer,
            diagnoseImageMaterial(result),
          ]),
        ),
      })),
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
