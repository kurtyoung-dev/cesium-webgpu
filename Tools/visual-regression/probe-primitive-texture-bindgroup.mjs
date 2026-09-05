#!/usr/bin/env node
/**
 * Probe: PRIMITIVE-TEXTURE-BINDGROUP (rows AR-834 / AR-832).
 * @purpose Acceptance for the frustum-dev group-2 texture bind group: zero WebGPU validation errors and a flat translucent-red frustum matching WebGL, with the sibling textured paths still clean.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * ── WHAT IT ANSWERS ────────────────────────────────────────────────────────
 *
 * The 2026-09-04 Sandcastle2 WebGPU sweep reported, on `frustum-dev` only:
 *
 *   Number of entries (2) did not match the expected number of entries (3)
 *   for [BindGroupLayoutInternal "Texture BGL"]
 *   … [Invalid BindGroup (unlabeled)] … SetBindGroup(2, …)
 *
 * so `CommandEncoder.finish()` failed and the whole scene frame's command
 * buffer was discarded, every frame the primitive was in the scene. Fixing the
 * entry count alone would have traded a dropped frame for a wrong-looking one:
 * the textured per-instance-color shaders compute `texColor * input.color`
 * against what used to be a 64×64 grey checkerboard, and the shader was chosen
 * from raw attribute presence, so a `flat: true` appearance was lit. The
 * acceptance therefore pins the APPEARANCE, not just the absence of the error:
 *
 *   1. Zero WebGPU validation errors on the frustum scene, and in particular no
 *      message matching the two above.
 *   2. At the demo's own camera the WebGPU canvas shows the frustum's faces as
 *      a uniform translucent red with a black wireframe outline — the same flat
 *      appearance as WebGL. No checkerboard, no directional shading.
 *   3. The sibling paths that already exercise a three-entry texture layout
 *      stay clean.
 *
 * ── HOW EACH CLAUSE IS MEASURED ────────────────────────────────────────────
 *
 *   Clause 1 — `lib/webgpu-error-gate.mjs` arms every GPUDevice's error scope
 *      and collects Dawn's own console prints. `messageGate` additionally
 *      requires no error text matching the two receipt patterns verbatim, so a
 *      future error of a different kind cannot be mistaken for this one.
 *
 *   Clause 2 — the same scene is built on BOTH backends at the same camera,
 *      viewport, clock and MSAA setting, and the two canvases are compared per
 *      pixel. "The same flat appearance as WebGL" IS the clause, so WebGL is
 *      the reference rather than a hand-tuned colour statistic. The gate is
 *      generous (<= 3 % of pixels differing by more than 12/255) because it
 *      only has to separate "correct" from the two faults it exists to catch:
 *      a checkerboard modulates about half the frustum's pixels by ~150/255,
 *      and Phong shading shifts whole faces — both are an order of magnitude
 *      past the gate. `highContrastAdjacentPct` — the fraction of horizontally
 *      adjacent pixel pairs differing by more than 40/255, which a
 *      checkerboard's 8-pixel blocks raise sharply — is a SECOND GATE on this
 *      scene, expressed as an excess over the WebGL leg (<= 2 pp) so it needs
 *      no absolute threshold. `distinctCoarseColors` is RECORDED on every leg,
 *      and gated only as the "nothing drew" canary described next.
 *
 *   "Nothing drew" — `frameStats`'s `nonBlackPct` CANNOT see it in this scene.
 *      The background is `BACKGROUND_COLOR`, (13, 15, 23) in 8-bit, and
 *      `frameStats` counts a pixel non-black when any channel exceeds 12
 *      (`Tools/lib/png-decode.mjs`), so a background-only frame reads 100 %.
 *      The canary is `distinctCoarseColors` instead: it bins to four bits per
 *      channel, so one flat colour scores exactly 1 and anything drawn over it
 *      scores more. `frustum-flat` would also fail the WebGL diff, but the
 *      three WebGPU-only clause-3 scenes have no diff — without this canary
 *      they would be gated on errors alone, and an invalidated command buffer
 *      (frames counting, nothing drawn) is exactly the bug under repair.
 *      `primitive-texture-bindgroup-probe-gates.spec.mjs` proves both halves
 *      mechanically, over the real `frameStats` and this exported constant:
 *      that `nonBlackPct` is pinned at 100 by this background, and that the
 *      canary fires on a background-only leg.
 *
 *   Clause 3 — three further WebGPU-only scenes reach the neighbouring
 *      producers of the same three-entry layout shape: the same frustum with a
 *      LIT appearance (the Phong branch of the very bind group under repair),
 *      an Image-material primitive ("Material Texture BGL" through
 *      `ensureMaterialTextureBindGroup`) and an Image-material polyline
 *      ("Polyline Mat Texture BGL"). Each is gated on zero validation errors
 *      and no entry-count message.
 *
 *      The full 338-demo Sandcastle2 sweep leg of clause 3 is NOT run here and
 *      is not available: `AR-D20` records that the sweep currently certifies
 *      0 of 338 demos because two gitignored `.d.ts` files 404 in every demo.
 *      When that clears, the sweep command is
 *        PROBE_BASE=http://localhost:8094 PROBE_SANDCASTLE_BASE=http://localhost:8081 \
 *        node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2 --renderer=webgpu
 *
 * ── WHY THE SCENE IS REBUILT RATHER THAN LOADED FROM SANDCASTLE2 ───────────
 *
 * The scenes below are `packages/sandcastle/gallery/frustum-dev/main.js`
 * transcribed: the same `PerspectiveFrustum`, the same ENU orientation, the
 * same `VertexFormat.POSITION_ONLY` `FrustumGeometry`, the same translucent red
 * at alpha 0.5, the same `PerInstanceColorAppearance({ closed: true, flat:
 * true })`, and the same `FrustumOutlineGeometry` in opaque black. Rebuilding
 * it keeps the probe on the shared runtime's single served origin — the
 * Sandcastle2 app needs a second bucket origin and currently 404s per AR-D20 —
 * and lets both backends be framed identically, which a pixel comparison needs.
 * The globe and sky are off and the background is a solid colour so the
 * comparison is about the frustum's own shading rather than terrain streaming.
 * `asynchronous: false` makes both primitives ready on the first update.
 *
 * ── PRECONDITIONS ──────────────────────────────────────────────────────────
 *
 *   * `npx gulp build`, then `node server.js --port 8094 --serve-built`
 *     (use `localhost`, not `127.0.0.1` — the dev server binds IPv6).
 *   * Edge, not Firefox: Playwright's bundled Firefox has no WebGPU.
 *
 * Run:
 *   node Tools/visual-regression/probe-primitive-texture-bindgroup.mjs
 *   node Tools/visual-regression/probe-primitive-texture-bindgroup.mjs --headed
 * Out:
 *   Tools/visual-regression/output/primitive-texture-bindgroup/
 */
import fs from "node:fs";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { decodePng, diffPixels, frameStats } from "../lib/png-decode.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";

const VIEWPORT = { width: 800, height: 600 };
const CLOCK_ISO = "2026-06-21T18:00:00Z";
const SETTLE_FRAMES = 40;

// Machine safety: kill a hung Edge or device rather than wedge the box. A
// `ProbeRefusal` reaches exit 3 through the runtime's exit-code table and lets
// the runtime's `finally` close the browser, instead of killing the process
// out from under an open GPU device.
const WATCHDOG_BUDGET_MS = 5 * 60 * 1000;

// The two receipt messages, verbatim enough to be specific and loose enough to
// survive Dawn's punctuation. A different validation error must NOT satisfy
// this gate, which is why it is a message match and not just a count.
const ENTRY_COUNT_RE =
  /did not match the expected number of entries.*Texture BGL/i;
const INVALID_BIND_GROUP_RE = /Invalid BindGroup[\s\S]*SetBindGroup\(2/i;

// Clause 2's gate. See the header for why WebGL is the reference and why the
// threshold is deliberately loose.
const DIFF_TOLERANCE = 12;
const MAX_MISMATCH_PCT = 3;
// Clause 2's checkerboard leg, expressed relative to WebGL so it needs no
// absolute tuning: both backends draw the same black outline, which is the only
// legitimate source of high-contrast neighbours in this scene.
const MAX_HIGH_CONTRAST_EXCESS_PP = 2;

// The scene's flat ground, exported so the gate spec can measure the real value
// rather than a copy of it. (13, 15, 23) in 8-bit — one count above
// `frameStats`'s black threshold on the red channel, which is why `nonBlackPct`
// cannot serve as this probe's "nothing drew" gate. See the header.
export const BACKGROUND_COLOR = Object.freeze([0.05, 0.06, 0.09, 1.0]);

// A canvas showing one flat colour scores exactly 1 under `frameStats`'s
// four-bits-per-channel binning. Anything drawn over the background scores
// more, so the bound needs no tuning: it fires on "nothing drew" and on
// nothing else.
const MIN_DISTINCT_COARSE_COLORS = 2;

const SCENES = [
  {
    id: "frustum-flat",
    kind: "frustum",
    flat: true,
    renderers: "both",
    claim:
      "frustum-dev renders with zero validation errors and the same flat translucent red as WebGL",
  },
  // Keep this cell. Once a flat appearance stops selecting a Phong variant,
  // `frustum-dev` selects `basicTextured` and NO gallery demo instantiates
  // `phongTextured` on the per-instance-color path at all — this scene becomes
  // the only in-tree exerciser of that branch, and therefore the only thing
  // that would notice a regression in it or in the group-2 bind group it
  // builds. (`q130-wgsl-derivative-uniformity.spec.mjs` guards the same
  // shader's source, but source-shape guards do not execute it.)
  {
    id: "frustum-lit",
    kind: "frustum",
    flat: false,
    renderers: "webgpu",
    claim:
      "the same frustum with a lit appearance also builds a complete group-2 texture bind group",
  },
  {
    id: "material-image",
    kind: "materialImage",
    renderers: "webgpu",
    claim: "the Image-material primitive path stays clean",
  },
  {
    id: "polyline-material-image",
    kind: "polylineMaterialImage",
    renderers: "webgpu",
    claim: "the Image-material polyline path stays clean",
  },
];

/**
 * Fraction of horizontally adjacent pixel pairs whose colour moves by more than
 * `threshold` on any channel. A tiled grey checkerboard multiplied onto the
 * primitive raises this sharply; a flat fill leaves only the object's own
 * silhouette and outline.
 *
 * @param {{width: number, height: number, data: Uint8Array}} image Decoded PNG.
 * @param {number} [threshold] Per-channel delta counted as high contrast.
 * @returns {number} Percentage of adjacent pairs above the threshold.
 */
export function highContrastAdjacentPct(image, threshold = 40) {
  let pairs = 0;
  let contrasting = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x + 1 < image.width; x++) {
      const a = (y * image.width + x) * 4;
      const b = a + 4;
      const delta = Math.max(
        Math.abs(image.data[a] - image.data[b]),
        Math.abs(image.data[a + 1] - image.data[b + 1]),
        Math.abs(image.data[a + 2] - image.data[b + 2]),
      );
      pairs++;
      if (delta > threshold) {
        contrasting++;
      }
    }
  }
  return pairs === 0 ? 0 : (contrasting / pairs) * 100;
}

/**
 * Decides one scene's verdict from its collected evidence, so the decision is
 * testable without a browser.
 *
 * @param {object} scene The scene descriptor.
 * @param {object} legs Per-renderer evidence keyed by renderer name.
 * @returns {{id: string, claim: string, pass: boolean, reasons: string[]}} Verdict.
 */
export function decideSceneVerdict(scene, legs) {
  const reasons = [];
  const webgpu = legs.webgpu;
  if (!webgpu) {
    return {
      id: scene.id,
      claim: scene.claim,
      pass: false,
      reasons: ["no webgpu leg"],
    };
  }
  if (webgpu.errors.length > 0) {
    reasons.push(`${webgpu.errors.length} webgpu error(s)`);
  }
  if (webgpu.errors.some((e) => ENTRY_COUNT_RE.test(e))) {
    reasons.push("bind-group entry-count mismatch on Texture BGL");
  }
  if (webgpu.errors.some((e) => INVALID_BIND_GROUP_RE.test(e))) {
    reasons.push("invalid bind group at SetBindGroup(2, …)");
  }
  if (webgpu.deviceLost) {
    reasons.push("device lost");
  }
  if (webgpu.nonBlackPct < 1) {
    reasons.push(
      `webgpu canvas is ${webgpu.nonBlackPct.toFixed(2)}% non-black — nothing drew`,
    );
  }
  // `nonBlackPct` cannot see this scene on its own: the background is
  // (13,15,23), one count above `frameStats`'s black threshold of 12
  // (`Tools/lib/png-decode.mjs`), so it reads 100% whether or not the primitive
  // drew. `distinctCoarseColors` bins to four bits per channel, so a
  // background-only frame scores exactly 1 and anything that drew scores more.
  // This is the canary the three WebGPU-only clause-3 scenes have instead of a
  // WebGL diff.
  if (webgpu.distinctCoarseColors < MIN_DISTINCT_COARSE_COLORS) {
    reasons.push(
      `webgpu canvas carries only ${webgpu.distinctCoarseColors} distinct coarse colour — nothing drew over the background`,
    );
  }
  const webgl = legs.webgl;
  if (webgl) {
    if (!webgpu.diff?.comparable) {
      reasons.push(`captures not comparable: ${webgpu.diff?.reason}`);
    } else if (webgpu.diff.mismatchPct > MAX_MISMATCH_PCT) {
      reasons.push(
        `webgpu differs from webgl on ${webgpu.diff.mismatchPct.toFixed(2)}% of pixels (max ${MAX_MISMATCH_PCT}%)`,
      );
    }
    const excess =
      webgpu.highContrastAdjacentPct - webgl.highContrastAdjacentPct;
    if (excess > MAX_HIGH_CONTRAST_EXCESS_PP) {
      reasons.push(
        `webgpu carries ${excess.toFixed(2)}pp more high-contrast adjacent pixels than webgl — a tiled pattern is being multiplied onto the primitive`,
      );
    }
  }
  return {
    id: scene.id,
    claim: scene.claim,
    pass: reasons.length === 0,
    reasons,
  };
}

/**
 * Builds one scene in the page and frames it, returning the page-side status.
 *
 * @param {object} page Playwright page.
 * @param {object} scene Scene descriptor.
 * @param {string} renderer Backend name.
 * @returns {Promise<object>} `{ ok, error }`.
 */
async function buildScene(page, scene, renderer) {
  return page.evaluate(
    async ({ kind, flat, renderer, clockIso, settleFrames, background }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      if (window.viewer && !window.viewer.isDestroyed()) {
        try {
          window.viewer.destroy();
        } catch (error) {
          void error;
        }
      }
      window.viewer = undefined;
      let container = document.getElementById("cesiumContainer");
      if (!container) {
        container = document.createElement("div");
        container.id = "cesiumContainer";
        document.body.appendChild(container);
      }
      container.innerHTML = "";
      Object.assign(container.style, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "800px",
        height: "600px",
      });

      let viewer;
      try {
        viewer = await C.Viewer.createAsync("cesiumContainer", {
          contextOptions: { renderer },
          msaaSamples: 1,
          baseLayerPicker: false,
          geocoder: false,
          timeline: false,
          animation: false,
          fullscreenButton: false,
          navigationHelpButton: false,
          homeButton: false,
          sceneModePicker: false,
          infoBox: false,
          selectionIndicator: false,
          shouldAnimate: false,
        });
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
      window.viewer = viewer;
      viewer.useDefaultRenderLoop = false;
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = C.JulianDate.fromIso8601(clockIso);

      const scene = viewer.scene;
      scene.msaaSamples = 1;
      // The frustum's own shading is what clause 2 is about, so everything that
      // would stream or vary between the two backends is switched off and the
      // ground is a single flat colour.
      scene.globe.show = false;
      if (scene.skyBox) {
        scene.skyBox.show = false;
      }
      if (scene.skyAtmosphere) {
        scene.skyAtmosphere.show = false;
      }
      if (scene.sun) {
        scene.sun.show = false;
      }
      if (scene.moon) {
        scene.moon.show = false;
      }
      scene.fog.enabled = false;
      scene.backgroundColor = new C.Color(...background);
      if (scene.postProcessStages?.fxaa) {
        scene.postProcessStages.fxaa.enabled = false;
      }

      const origin = C.Cartesian3.fromDegrees(-105.0, 45.0, 20.0);
      const enu = C.Transforms.eastNorthUpToFixedFrame(origin);
      const rotation = C.Matrix4.getMatrix3(enu, new C.Matrix3());
      C.Matrix3.multiply(
        rotation,
        C.Matrix3.fromRotationX(-C.Math.PI_OVER_TWO),
        rotation,
      );
      const orientation = C.Quaternion.fromRotationMatrix(rotation);

      // Only the frustum scene frames itself from the primitive, because the
      // demo does; the other two are framed from their own known positions
      // below, so nothing here needs a value before its branch assigns one.
      let frustumPrimitive;
      if (kind === "frustum") {
        // `packages/sandcastle/gallery/frustum-dev/main.js`, transcribed.
        const frustum = new C.PerspectiveFrustum({
          fov: C.Math.toRadians(60.0),
          aspectRatio: scene.canvas.clientWidth / scene.canvas.clientHeight,
          near: 10.0,
          far: 50.0,
        });
        const instance = new C.GeometryInstance({
          geometry: new C.FrustumGeometry({
            frustum: frustum,
            origin: origin,
            orientation: orientation,
            vertexFormat: C.VertexFormat.POSITION_ONLY,
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              new C.Color(1.0, 0.0, 0.0, 0.5),
            ),
          },
          id: "frustum",
        });
        frustumPrimitive = scene.primitives.add(
          new C.Primitive({
            geometryInstances: instance,
            appearance: new C.PerInstanceColorAppearance({
              closed: true,
              flat: flat,
            }),
            asynchronous: false,
          }),
        );
        scene.primitives.add(
          new C.Primitive({
            geometryInstances: new C.GeometryInstance({
              geometry: new C.FrustumOutlineGeometry({
                frustum: frustum,
                origin: origin,
                orientation: orientation,
              }),
              attributes: {
                color: C.ColorGeometryInstanceAttribute.fromColor(
                  new C.Color(0.0, 0.0, 0.0, 1.0),
                ),
              },
            }),
            appearance: new C.PerInstanceColorAppearance({ flat: true }),
            asynchronous: false,
          }),
        );
      } else if (kind === "materialImage") {
        scene.primitives.add(
          new C.Primitive({
            geometryInstances: new C.GeometryInstance({
              geometry: new C.EllipsoidGeometry({
                radii: new C.Cartesian3(120.0, 120.0, 120.0),
                vertexFormat:
                  C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
              }),
              modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
                C.Cartesian3.fromDegrees(-105.0, 45.0, 200.0),
              ),
            }),
            appearance: new C.MaterialAppearance({
              materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED,
              material: C.Material.fromType("Image", {
                image: "/Apps/Sandcastle/images/Cesium_Logo_Color.jpg",
              }),
            }),
            asynchronous: false,
          }),
        );
      } else {
        scene.primitives.add(
          new C.Primitive({
            geometryInstances: new C.GeometryInstance({
              geometry: new C.PolylineGeometry({
                positions: C.Cartesian3.fromDegreesArrayHeights([
                  -105.0015, 45.0, 40.0, -104.9985, 45.0, 40.0,
                ]),
                width: 12.0,
                vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
              }),
            }),
            appearance: new C.PolylineMaterialAppearance({
              material: C.Material.fromType("Image", {
                image: "/Apps/Sandcastle/images/Cesium_Logo_Color.jpg",
              }),
            }),
            asynchronous: false,
          }),
        );
      }

      // One update pass makes a synchronous primitive ready, which is what the
      // demo's own `postRender` framing waits for.
      viewer.render();

      // Framing is a PRECONDITION of every measurement below, not a nicety: a
      // scene captured at the default camera has the subject off-screen, and
      // the WebGL/WebGPU diff would then compare two equally empty canvases and
      // pass. So a framing that cannot be established REFUSES (the caller turns
      // a false `ok` into a ProbeRefusal, exit 3) rather than being skipped.
      if (kind === "frustum") {
        // The demo's own framing, from its own instance id — this is the camera
        // the acceptance names.
        const sphere =
          frustumPrimitive.getGeometryInstanceAttributes(
            "frustum",
          )?.boundingSphere;
        if (!sphere) {
          return {
            ok: false,
            error:
              "the frustum primitive reported no bounding sphere after its first update, so the demo's own camera could not be established",
          };
        }
        scene.camera.viewBoundingSphere(sphere);
      } else {
        // The other two scenes are framed from the positions this function just
        // built them at, rather than by reading a bounding sphere back off the
        // primitive. That keeps the framing deterministic and identical on both
        // backends, and avoids depending on `Primitive._boundingSpheres` — a
        // private field whose population is tied to update timing.
        const subject =
          kind === "materialImage"
            ? C.Cartesian3.fromDegrees(-105.0, 45.0, 200.0)
            : C.Cartesian3.fromDegrees(-105.0, 45.0, 40.0);
        const offset =
          kind === "materialImage"
            ? new C.Cartesian3(0.0, -400.0, 200.0)
            : new C.Cartesian3(0.0, -300.0, 150.0);
        scene.camera.lookAt(subject, offset);
      }
      // Release the reference frame in every case, keeping the position and
      // orientation the framing just chose.
      scene.camera.lookAtTransform(C.Matrix4.IDENTITY);

      for (let i = 0; i < settleFrames; i++) {
        viewer.render();
      }
      return { ok: true, error: null };
    },
    {
      kind: scene.kind,
      flat: scene.flat === true,
      renderer,
      clockIso: CLOCK_ISO,
      settleFrames: SETTLE_FRAMES,
      background: [...BACKGROUND_COLOR],
    },
  );
}

/**
 * Runs one (scene, renderer) leg: build, settle, capture, collect errors.
 *
 * @param {object} options Leg inputs.
 * @param {object} options.browser Playwright browser.
 * @param {string} options.origin Served origin.
 * @param {object} options.scene Scene descriptor.
 * @param {string} options.renderer Backend name.
 * @param {string} options.outputDirectory Where captures are written.
 * @param {Array<object>} options.captures Runtime capture sink.
 * @returns {Promise<object>} The leg's evidence.
 */
async function runLeg({
  browser,
  origin,
  scene,
  renderer,
  outputDirectory,
  captures,
}) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  try {
    await page.goto(
      `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "networkidle", timeout: 90000 },
    );
    await page.waitForFunction(() => !!window.Cesium || !!window.viewer, {
      timeout: 90000,
    });
    await armWebGPUDevices(page);

    const built = await buildScene(page, scene, renderer);
    if (!built.ok) {
      throw new ProbeRefusal(
        "scene-build-failed",
        `${scene.id} failed to build on ${renderer}: ${built.error}`,
        { scene: scene.id, renderer, error: built.error },
      );
    }

    const capture = await captureElement({
      page,
      selector: "#cesiumContainer canvas",
      index: 0,
      name: `${scene.id}-${renderer}`,
      outputDirectory,
      captures,
    });
    const image = decodePng(capture.buffer);
    const stats = frameStats(image);
    const gate = await collectGateErrors(page);
    return {
      renderer,
      capture: capture.path,
      sha256: capture.sha256,
      image,
      errors: [...gate.errors, ...consoleErrors],
      deviceLost: gate.deviceLost,
      armedDevices: gate.armedDevices,
      nonBlackPct: stats.nonBlackPct,
      meanLuminance: stats.meanLuminance,
      distinctCoarseColors: stats.distinctCoarseColors,
      highContrastAdjacentPct: highContrastAdjacentPct(image),
    };
  } finally {
    await page.close();
  }
}

const descriptor = {
  name: "primitive-texture-bindgroup",
  title: "Primitive texture bind group (AR-834 / AR-832)",
  outputSubdirectory: "primitive-texture-bindgroup",
  async cells({ browser, options, origin, outputDirectory, captures }) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    const work = (async () => {
      const produced = [];
      for (const scene of SCENES) {
        const renderers =
          scene.renderers === "both"
            ? options.renderers
            : options.renderers.filter((r) => r === scene.renderers);
        const legs = {};
        for (const renderer of renderers) {
          legs[renderer] = await runLeg({
            browser,
            origin,
            scene,
            renderer,
            outputDirectory,
            captures,
          });
        }
        if (legs.webgpu && legs.webgl) {
          legs.webgpu.diff = diffPixels(
            legs.webgl.image,
            legs.webgpu.image,
            DIFF_TOLERANCE,
          );
        }
        // The decoded pixel buffers are working data, not receipt data.
        for (const leg of Object.values(legs)) {
          delete leg.image;
        }
        produced.push({
          scene: scene.id,
          claim: scene.claim,
          legs,
          verdict: decideSceneVerdict(scene, legs),
        });
      }
      return produced;
    })();
    work.catch(() => {});
    let watchdogTimer;
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new ProbeRefusal(
              "watchdog-timeout",
              `probe-primitive-texture-bindgroup exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
              { budgetMs: WATCHDOG_BUDGET_MS },
            ),
          ),
        WATCHDOG_BUDGET_MS,
      );
    });
    try {
      return await Promise.race([work, watchdog]);
    } finally {
      clearTimeout(watchdogTimer);
    }
  },
  receipt(cells, context) {
    return {
      base: context.origin,
      gates: {
        maxMismatchPct: MAX_MISMATCH_PCT,
        diffTolerance: DIFF_TOLERANCE,
        maxHighContrastExcessPp: MAX_HIGH_CONTRAST_EXCESS_PP,
      },
      scenes: cells,
    };
  },
  verdicts(cells) {
    return cells.map((cell) => cell.verdict);
  },
  summary(receipt) {
    const passed = receipt.scenes.filter((s) => s.verdict.pass).length;
    const lines = [
      "# Primitive texture bind group (AR-834 / AR-832)",
      "",
      `${passed}/${receipt.scenes.length} scenes passed.`,
      "",
      "| scene | pass | webgpu errors | mismatch % vs webgl | high-contrast adj % (webgl / webgpu) |",
      "| --- | --- | --- | --- | --- |",
    ];
    for (const scene of receipt.scenes) {
      const webgpu = scene.legs.webgpu ?? {};
      const webgl = scene.legs.webgl;
      lines.push(
        `| ${scene.scene} | ${scene.verdict.pass ? "PASS" : "FAIL"} | ` +
          `${webgpu.errors?.length ?? "-"} | ` +
          `${webgpu.diff?.mismatchPct?.toFixed(2) ?? "-"} | ` +
          `${webgl ? webgl.highContrastAdjacentPct.toFixed(2) : "-"} / ` +
          `${webgpu.highContrastAdjacentPct?.toFixed(2) ?? "-"} |`,
      );
    }
    lines.push("");
    for (const scene of receipt.scenes) {
      if (!scene.verdict.pass) {
        lines.push(`- ${scene.scene}: ${scene.verdict.reasons.join("; ")}`);
      }
    }
    lines.push("");
    return lines.join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
