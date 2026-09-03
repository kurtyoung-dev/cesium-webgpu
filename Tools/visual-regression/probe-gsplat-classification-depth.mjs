#!/usr/bin/env node
/**
 * C15-G7 Gaussian-splat classification-depth fleet probe.
 * @purpose Counter-assert WebGPU classification-depth pipeline selection and dual-backend polygon placement on the tower splat surface, with a terrain-return suppression control.
 * @status ACTIVE
 *
 * This probe is acquisition only.  The browser-free model owns all verdict
 * arithmetic.  Captures are made solely by the canonical fused snapshot
 * transaction.  Verdict pixels are decoded in Node from each PNG only after
 * its exclusive write and exact reread.  The probe must be run by an
 * authorized machine lane against an already-served build.  It does not
 * launch a server or build Cesium.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import sharp from "sharp";

import {
  GSPLAT_CLASSIFICATION_CONFIG,
  GSPLAT_CLASSIFICATION_SCHEMA,
  evaluateGsplatClassificationDepth,
  summarizeClassificationPixels,
} from "./lib/gsplat-classification-model.mjs";
import {
  FUSED_SNAPSHOT_BEGIN,
  FUSED_SNAPSHOT_END,
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
// The frustum-margin fraction and the pixel floor live here so the
// in-browser framing formula (below, in `acquirePageMeasurement`) and the
// pure spec in `gsplat-tower-framing.spec.mjs` read the same registered
// numbers. Neither can be imported INTO the browser call itself --
// Playwright's `page.evaluate` serializes `acquirePageMeasurement`'s source
// text and reruns it in the page with no closure over this module's
// bindings -- so both values are threaded through the page.evaluate
// argument object instead.
import { TOWER_FRAMING_CONFIG } from "./lib/gsplat-tower-framing.mjs";
import { exitCodeForS5Status } from "./lib/verdict-exit-gate.mjs";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const probeSourcePath = fileURLToPath(import.meta.url);
const defaultBase = process.env.PROBE_BASE ?? "http://localhost:8080";
const defaultOutputRoot = path.resolve(
  process.env.C15_G7_OUTPUT_DIR ??
    path.join(toolDirectory, "output/c15-g7-classification-depth"),
);
const RUN_WATCHDOG_MS = 300_000;
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
const BROWSER_CLOSE_TIMEOUT_MS = 30_000;
// The hard fuse remains armed through bounded cleanup and write-once evidence
// publication.  A wedged GPU/page loop may never settle the in-run rejection.
const PROCESS_WATCHDOG_MS =
  BROWSER_LAUNCH_TIMEOUT_MS +
  RUN_WATCHDOG_MS +
  BROWSER_CLOSE_TIMEOUT_MS +
  60_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function serializeError(value) {
  const error = value instanceof Error ? value : new Error(String(value));
  return {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
    watchdog: error.c15G7Watchdog ?? null,
    cleanup: error.c15G7Cleanup ?? null,
  };
}

function validateLoopbackBase(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("--base must be an uncredentialed loopback HTTP URL");
  }
  return { href: url.href, origin: url.origin };
}

function markerCount(source, marker) {
  let count = 0;
  let cursor = 0;
  while ((cursor = source.indexOf(marker, cursor)) >= 0) {
    count++;
    cursor += marker.length;
  }
  return count;
}

export function inspectC15G7CaptureContract(source) {
  const canonicalFailures = checkEmbeddedFusedSnapshotIsCanonical(source);
  const usageFailures = checkFusedCaptureUsage(source);
  const beginCount = markerCount(source, FUSED_SNAPSHOT_BEGIN);
  const endCount = markerCount(source, FUSED_SNAPSHOT_END);
  return {
    canonical: canonicalFailures.length === 0,
    singleBlock: beginCount === 1 && endCount === 1,
    usageValid: usageFailures.length === 0,
    beginCount,
    endCount,
    failures: [
      ...canonicalFailures,
      ...usageFailures,
      ...(beginCount === 1 && endCount === 1
        ? []
        : [
            `fused snapshot markers must occur exactly once (BEGIN=${beginCount}, END=${endCount})`,
          ]),
    ],
  };
}

function readExact(file, expected, label, operations = fs) {
  const actual = operations.readFileSync(file);
  const bytes = Buffer.isBuffer(actual) ? actual : Buffer.from(actual);
  if (!bytes.equals(Buffer.from(expected))) {
    throw new Error(`${label} bytes differ from the run-owned canonical bytes`);
  }
  return bytes;
}

function writeOnceExact(file, bytes, label, operations = fs) {
  const canonical = Buffer.from(bytes);
  try {
    operations.writeFileSync(file, canonical, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    readExact(file, canonical, label, operations);
  }
  readExact(file, canonical, label, operations);
  return readExact(file, canonical, label, operations);
}

function createRunPaths(runId, outputRoot = defaultOutputRoot) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      runId,
    )
  ) {
    throw new Error("runId must be a UUID v4");
  }
  const root = path.resolve(outputRoot);
  const directory = path.join(root, runId);
  if (path.dirname(directory) !== root) {
    throw new Error("run directory escaped the configured output root");
  }
  return {
    root,
    directory,
    artifact: path.join(directory, `${runId}.json`),
  };
}

function prepareRunDirectory(paths, operations = fs) {
  operations.mkdirSync(paths.root, { recursive: true });
  operations.mkdirSync(paths.directory, { recursive: false });
}

function pngBytes(dataUrl, label) {
  const prefix = "data:image/png;base64,";
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) {
    throw new Error(`${label} is not a PNG data URL`);
  }
  const encoded = dataUrl.slice(prefix.length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error(`${label} is not canonical base64`);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length <= signature.length ||
    !bytes.subarray(0, 8).equals(signature)
  ) {
    throw new Error(`${label} did not decode to a complete PNG`);
  }
  return bytes;
}

async function decodePngRgba(bytes, label) {
  let decoded;
  try {
    decoded = await sharp(bytes, {
      failOn: "error",
      limitInputPixels:
        GSPLAT_CLASSIFICATION_CONFIG.width *
        GSPLAT_CLASSIFICATION_CONFIG.height,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new Error(
      `${label} persisted PNG decode failed: ${error?.message ?? error}`,
      { cause: error },
    );
  }
  const { data, info } = decoded;
  if (
    info.width !== GSPLAT_CLASSIFICATION_CONFIG.width ||
    info.height !== GSPLAT_CLASSIFICATION_CONFIG.height ||
    info.channels !== 4 ||
    data.length !== info.width * info.height * 4
  ) {
    throw new Error(
      `${label} persisted PNG is not the configured RGBA viewport`,
    );
  }
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}

async function persistAndRederiveCaptureImages(
  paths,
  sessions,
  records,
  operations = fs,
) {
  const pixels = {};
  for (const session of sessions) {
    const backend = session.renderer;
    records[backend] = {};
    const persistedFrames = {};
    for (const [name, dataUrl] of Object.entries(
      session.measurement?.captures ?? {},
    )) {
      if (!/^[a-z][a-zA-Z]+$/u.test(name)) {
        throw new Error(`unsafe capture name ${name}`);
      }
      const bytes = pngBytes(dataUrl, `${backend}/${name}`);
      const decodedBeforeWrite = await decodePngRgba(
        bytes,
        `${backend}/${name} in-memory`,
      );
      const file = path.join(paths.directory, `${backend}-${name}.png`);
      if (path.dirname(file) !== paths.directory) {
        throw new Error(`${backend}/${name} escaped the run directory`);
      }
      const reread = writeOnceExact(
        file,
        bytes,
        `${backend}/${name}`,
        operations,
      );
      records[backend][name] = {
        file: path.basename(file),
        bytes: reread.length,
        sha256: sha256(reread),
        rgbaRederived: false,
      };
      const decodedAfterWrite = await decodePngRgba(
        reread,
        `${backend}/${name}`,
      );
      if (
        !Buffer.from(decodedBeforeWrite.data).equals(
          Buffer.from(decodedAfterWrite.data),
        )
      ) {
        throw new Error(
          `${backend}/${name} pixels changed across immutable publication`,
        );
      }
      persistedFrames[name] = decodedAfterWrite;
      records[backend][name].rgbaRederived = true;
    }
    pixels[backend] = summarizeClassificationPixels(
      {
        frames: persistedFrames,
        anchors: session.measurement?.runtime?.projectedAnchors,
      },
      GSPLAT_CLASSIFICATION_CONFIG,
    );
  }
  return { records, pixels };
}

async function closeBounded(instance, label, timeoutMs) {
  if (!instance) {
    return { label, attempted: false, closed: true, timedOut: false };
  }
  let timer;
  try {
    return {
      label,
      attempted: true,
      ...(await Promise.race([
        Promise.resolve()
          .then(() => instance.close())
          .then(
            () => ({ closed: true, timedOut: false }),
            (error) => ({
              closed: false,
              timedOut: false,
              error: serializeError(error),
            }),
          ),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ closed: false, timedOut: true }),
            timeoutMs,
          );
        }),
      ])),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function boundedPageCheckpoint(owned, timeoutMs = 2_000) {
  const page = owned.page;
  if (!page || page.isClosed()) {
    return { phase: owned.phase, pageAvailable: false };
  }
  let timer;
  try {
    return await Promise.race([
      page
        .evaluate(() => ({
          phase: window.__c15G7Progress?.phase ?? "unknown",
          renderer: window.__c15G7Progress?.renderer ?? null,
          frameNumber: window.viewer?.scene?.frameState?.frameNumber ?? null,
        }))
        .then(
          (checkpoint) => ({ ...checkpoint, pageAvailable: true }),
          (error) => ({
            phase: owned.phase,
            pageAvailable: true,
            error: serializeError(error),
          }),
        ),
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              phase: owned.phase,
              pageAvailable: true,
              timedOut: true,
            }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupOwned(owned) {
  const page = owned.page;
  const context = owned.context;
  const browser = owned.browser;
  const pageClose = await closeBounded(
    page,
    "watchdog page",
    SESSION_CLOSE_TIMEOUT_MS,
  );
  const contextClose = await closeBounded(
    context,
    "watchdog context",
    SESSION_CLOSE_TIMEOUT_MS,
  );
  const browserClose = await closeBounded(
    browser,
    "watchdog browser",
    BROWSER_CLOSE_TIMEOUT_MS,
  );
  if (pageClose.closed && owned.page === page) owned.page = undefined;
  if (contextClose.closed && owned.context === context) {
    owned.context = undefined;
  }
  if (browserClose.closed && owned.browser === browser) {
    owned.browser = undefined;
  }
  const pendingRequests = owned.pending?.size ?? 0;
  return {
    pageClose,
    contextClose,
    browserClose,
    pendingRequests,
    cleanupComplete:
      pageClose.closed &&
      contextClose.closed &&
      browserClose.closed &&
      pendingRequests === 0,
  };
}

export async function withC15G7Watchdog(
  operation,
  onTimeout,
  timeoutMs = RUN_WATCHDOG_MS,
) {
  let timer;
  let timingOut = false;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .then(
          (value) => (timingOut ? new Promise(() => {}) : value),
          (error) =>
            timingOut ? new Promise(() => {}) : Promise.reject(error),
        ),
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          timingOut = true;
          let timeoutEvidence;
          try {
            timeoutEvidence = await onTimeout();
          } catch (cleanupError) {
            const aggregate = new AggregateError(
              [
                new Error(`C15-G7 watchdog expired after ${timeoutMs} ms`),
                cleanupError,
              ],
              "C15-G7 watchdog cleanup failed",
            );
            aggregate.c15G7Watchdog = {
              timeoutMs,
              cleanupComplete: false,
            };
            reject(aggregate);
            return;
          }
          const error = new Error(
            timeoutEvidence?.cleanupComplete
              ? `C15-G7 watchdog expired after ${timeoutMs} ms`
              : `C15-G7 watchdog expired after ${timeoutMs} ms and cleanup remained unproven`,
          );
          error.c15G7Watchdog = { timeoutMs, ...timeoutEvidence };
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runBackend(browser, renderer, base, owned) {
  const session = {
    renderer,
    measurement: null,
    cleanup: null,
  };
  let context;
  let page;
  const pending = new Set();
  const externalRequests = [];
  try {
    owned.phase = `${renderer}:context`;
    context = await browser.newContext({
      viewport: {
        width: GSPLAT_CLASSIFICATION_CONFIG.width,
        height: GSPLAT_CLASSIFICATION_CONFIG.height,
      },
      deviceScaleFactor: 1,
    });
    owned.context = context;
    page = await context.newPage();
    owned.page = page;
    owned.pending = pending;
    await page.addInitScript(errorGateInit);
    const consoleErrors = attachConsoleErrorGate(page);

    page.on("request", (request) => {
      pending.add(request);
      const url = request.url();
      try {
        const parsed = new URL(url);
        if (
          parsed.origin !== base.origin &&
          parsed.protocol !== "data:" &&
          parsed.protocol !== "blob:"
        ) {
          externalRequests.push(url);
        }
      } catch {
        externalRequests.push(url);
      }
    });
    page.on("requestfinished", (request) => pending.delete(request));
    page.on("requestfailed", (request) => pending.delete(request));

    owned.phase = `${renderer}:navigate`;
    await page.goto(
      `${base.href.replace(/\/$/u, "")}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    await page.waitForFunction(() => Boolean(window.viewer), null, {
      timeout: 60_000,
    });
    if (renderer === "webgpu") {
      await armWebGPUDevices(page);
    }

    owned.phase = `${renderer}:measure`;
    const acquirePageMeasurement = async ({
      renderer,
      assetUrl,
      towerTerrainMarginFraction,
      minimumTowerMaskPixels,
    }) => {
      window.__c15G7Progress = { renderer, phase: "setup" };
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      viewer.useDefaultRenderLoop = false;
      viewer.clock.shouldAnimate = false;
      const scene = viewer.scene;
      const pageRuntimeErrors = [];
      scene.renderError.addEventListener((_scene, error) => {
        pageRuntimeErrors.push(error?.stack ?? error?.message ?? String(error));
      });
      scene.requestRenderMode = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.sun.show = false;
      scene.moon.show = false;
      scene.fog.enabled = false;
      scene.backgroundColor = C.Color.fromCssColorString("#101014");
      scene.imageryLayers.removeAll();
      scene.globe.baseColor = C.Color.fromCssColorString("#26262c");
      scene.globe.showGroundAtmosphere = false;
      scene.globe.depthTestAgainstTerrain = true;
      viewer.terrainProvider = new C.EllipsoidTerrainProvider();
      await C.GroundPrimitive.initializeTerrainHeights();

      const tileset = await C.Cesium3DTileset.fromUrl(assetUrl, {
        maximumScreenSpaceError: 1,
      });
      scene.primitives.add(tileset);
      const towerSphere = C.BoundingSphere.clone(
        tileset.boundingSphere,
        new C.BoundingSphere(),
      );
      const towerCenter = C.Cartesian3.clone(towerSphere.center);
      const terrainCenter = C.Ellipsoid.WGS84.scaleToGeodeticSurface(
        towerCenter,
        new C.Cartesian3(),
      );
      if (!terrainCenter) {
        throw new Error("tower center has no ellipsoid-surface projection");
      }

      const enu = C.Transforms.eastNorthUpToFixedFrame(terrainCenter);
      // A bounding sphere's horizontal support is at most its radius.  The
      // extra quarter-radius is footprint margin; keeping the polygon local
      // prevents its terrain-only projection from covering the vertically
      // separated tower silhouette (the Node model asserts that directly).
      const halfWidth = towerSphere.radius * 1.25;
      const worldPoint = (east, north) =>
        C.Matrix4.multiplyByPoint(
          enu,
          new C.Cartesian3(east, north, 0),
          new C.Cartesian3(),
        );
      const polygonPositions = [
        worldPoint(-halfWidth, -halfWidth),
        worldPoint(halfWidth, -halfWidth),
        worldPoint(halfWidth, halfWidth),
        worldPoint(-halfWidth, halfWidth),
      ];
      const classifier = new C.GroundPrimitive({
        geometryInstances: new C.GeometryInstance({
          id: "c15-g7-tower-drape",
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(polygonPositions),
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              new C.Color(1, 0.02, 0.85, 1),
            ),
          },
        }),
        appearance: new C.PerInstanceColorAppearance({
          translucent: false,
          flat: true,
        }),
        classificationType: C.ClassificationType.BOTH,
        asynchronous: false,
      });
      scene.groundPrimitives.add(classifier);

      // The tower and its terrain-reference point are separated almost
      // entirely by ALTITUDE (this asset's tower sits ~2852 m above its own
      // ellipsoid-surface projection -- see gsplat-tower-framing.mjs), not
      // by the ground-classification footprint. The look-at target is
      // therefore the true midpoint between those two points, and the
      // range is derived directly from that altitude separation and the
      // camera's live vertical field of view, so both anchors project
      // inside the frustum by construction rather than as a side effect of
      // an unrelated bounding sphere. `computeTowerTerrainRange` in
      // gsplat-tower-framing.mjs pins this exact formula, and
      // `evaluateGsplatClassificationDepth` recomputes it from the
      // telemetry recorded below to confirm the page actually used it.
      const target = C.Cartesian3.midpoint(
        towerCenter,
        terrainCenter,
        new C.Cartesian3(),
      );
      const verticalSeparationMeters = C.Cartesian3.distance(
        towerCenter,
        terrainCenter,
      );
      const fovYRadians = scene.camera.frustum.fovy;
      const range =
        verticalSeparationMeters /
        2 /
        (towerTerrainMarginFraction * Math.tan(fovYRadians / 2));
      viewer.camera.viewBoundingSphere(
        new C.BoundingSphere(target, 0),
        new C.HeadingPitchRange(
          0,
          // The shallow pitch separates the vertical splat surface from its
          // ground footprint while retaining an unmistakable globe frame.
          C.Math.toRadians(-20),
          range,
        ),
      );
      viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
      const framing = {
        verticalSeparationMeters,
        fovYRadians,
        marginFraction: towerTerrainMarginFraction,
        range,
        minimumTowerMaskPixels,
      };

      const frustumList = () =>
        scene._view?.frustumCommandsList ?? scene.frustumCommandsList ?? [];
      const passCount = (pass) =>
        frustumList().reduce(
          (count, band) => count + (band.indices?.[pass] ?? 0),
          0,
        );
      const commandInPass = (pass, command) =>
        frustumList().some((band) => {
          const count = band.indices?.[pass] ?? 0;
          const commands = band.commands?.[pass] ?? [];
          for (let index = 0; index < count; index++) {
            if (commands[index] === command) return true;
          }
          return false;
        });
      const renderNow = () => {
        scene.requestRender();
        scene.render(C.JulianDate.fromIso8601("2026-08-02T18:00:00Z"));
      };
      const settle = async (frames = 8) => {
        for (let frame = 0; frame < frames; frame++) {
          renderNow();
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
        await scene.context?._device?.queue?.onSubmittedWorkDone?.();
      };

      window.__c15G7Progress.phase = "readiness";
      const readinessStart = performance.now();
      let ready = false;
      while (performance.now() - readinessStart < 90_000) {
        renderNow();
        const cache = tileset.gaussianSplatPrimitive?._webgpuCache;
        const webgpuRouteReady =
          renderer !== "webgpu" ||
          (cache?.command?.classificationDepthPipeline &&
            cache.command.classificationDepthPipeline ===
              cache.depthWritePipeline &&
            commandInPass(C.Pass.GAUSSIAN_SPLATS, cache.command));
        if (
          tileset.tilesLoaded &&
          classifier.ready &&
          scene.globe.tilesLoaded &&
          passCount(C.Pass.GLOBE) > 0 &&
          passCount(C.Pass.GAUSSIAN_SPLATS) > 0 &&
          webgpuRouteReady
        ) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!ready) {
        throw new Error(
          "C15-G7 readiness deadline expired before the tower/globe/classifier route settled",
        );
      }
      await settle(20);

      const projected = (point) => {
        const value = C.SceneTransforms.worldToWindowCoordinates(
          scene,
          point,
          new C.Cartesian2(),
        );
        return value ? { x: value.x, y: value.y } : null;
      };
      const anchors = {
        splat: projected(towerCenter),
        terrain: projected(terrainCenter),
      };

      // ==BEGIN fused-snapshot-capture==
      const makeFusedSnapshotCapture = (scene, canvas, timeFn) => {
        const tmp = document.createElement("canvas");
        const ctx = tmp.getContext("2d", { willReadFrequently: true });
        const decode = async (dataUrl) => {
          const image = new Image();
          const loaded = new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error("fused PNG decode failed"));
          });
          image.src = dataUrl;
          await loaded;
          tmp.width = image.naturalWidth;
          tmp.height = image.naturalHeight;
          ctx.drawImage(image, 0, 0);
          return ctx.getImageData(0, 0, tmp.width, tmp.height);
        };
        const captureSnapshot = async () => {
          scene.render(timeFn());
          const dataUrl = canvas.toDataURL("image/png");
          const imageData = await decode(dataUrl);
          return { dataUrl, imageData };
        };
        return { captureSnapshot };
      };
      // ==END fused-snapshot-capture==

      const captureTime = C.JulianDate.fromIso8601("2026-08-02T18:00:00Z");
      const { captureSnapshot } = makeFusedSnapshotCapture(
        scene,
        scene.canvas,
        () => captureTime,
      );

      const routeEvidence = {
        instrument: {
          commandLocated: false,
          commandInFrustum: false,
          gaussianSplatPass: false,
          depthClassificationFlag: false,
          variantDefined: false,
          variantDistinctFromBase: false,
          bundleAbsent: false,
          stableCommandIdentity: false,
          suppressionGetterHeld: false,
          descriptorRestored: renderer !== "webgpu",
        },
        positive: null,
        suppressed: null,
        restored: null,
      };
      let routeController;
      if (renderer === "webgpu") {
        const primitive = tileset.gaussianSplatPrimitive;
        const cache = primitive?._webgpuCache;
        const command = cache?.command;
        const originalPipelineDescriptor = command
          ? Object.getOwnPropertyDescriptor(
              command,
              "classificationDepthPipeline",
            )
          : undefined;
        const originalExecuteDescriptor = command
          ? Object.getOwnPropertyDescriptor(command, "execute")
          : undefined;
        const originalExecute = command?.execute;
        let currentVariant = command?.classificationDepthPipeline;
        let suppressionActive = false;
        let activePhase = null;

        routeEvidence.instrument.commandLocated = Boolean(command);
        routeEvidence.instrument.commandInFrustum = Boolean(
          command && commandInPass(C.Pass.GAUSSIAN_SPLATS, command),
        );
        routeEvidence.instrument.gaussianSplatPass =
          command?.pass === C.Pass.GAUSSIAN_SPLATS;
        routeEvidence.instrument.depthClassificationFlag =
          command?.depthForTranslucentClassification === true;
        routeEvidence.instrument.variantDefined = Boolean(currentVariant);
        routeEvidence.instrument.variantDistinctFromBase = Boolean(
          currentVariant && currentVariant !== command?.pipeline,
        );
        routeEvidence.instrument.bundleAbsent = !command?.bundle;

        if (command && typeof originalExecute === "function") {
          Object.defineProperty(command, "classificationDepthPipeline", {
            configurable: true,
            enumerable: originalPipelineDescriptor?.enumerable ?? true,
            get() {
              return suppressionActive ? null : currentVariant;
            },
            set(value) {
              currentVariant = value;
            },
          });
          Object.defineProperty(command, "execute", {
            configurable: true,
            enumerable: originalExecuteDescriptor?.enumerable ?? false,
            writable: true,
            value: function (passEncoder, ...rest) {
              if (!activePhase) {
                return originalExecute.call(this, passEncoder, ...rest);
              }
              activePhase.executions++;
              let selectedCalls = 0;
              let fallbackCalls = 0;
              let unexpectedCalls = 0;
              const proxy = new Proxy(passEncoder, {
                get(target, property) {
                  if (property === "setPipeline") {
                    return (pipeline) => {
                      if (pipeline === currentVariant && !suppressionActive) {
                        selectedCalls++;
                      } else if (pipeline === command.pipeline) {
                        fallbackCalls++;
                      } else {
                        unexpectedCalls++;
                      }
                      return target.setPipeline(pipeline);
                    };
                  }
                  const value = Reflect.get(target, property, target);
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                },
              });
              try {
                return originalExecute.call(this, proxy, ...rest);
              } finally {
                if (
                  selectedCalls === 1 &&
                  fallbackCalls === 0 &&
                  unexpectedCalls === 0
                ) {
                  activePhase.selectedExecutions++;
                } else if (
                  fallbackCalls === 1 &&
                  selectedCalls === 0 &&
                  unexpectedCalls === 0
                ) {
                  activePhase.fallbackExecutions++;
                } else {
                  activePhase.unexpectedReadExecutions++;
                }
              }
            },
          });

          const beginPhase = (name) => {
            activePhase = {
              executions: 0,
              selectedExecutions: 0,
              fallbackExecutions: 0,
              unexpectedReadExecutions: 0,
              frameBefore: scene.frameState.frameNumber,
              frameAfter: null,
            };
            routeEvidence[name] = activePhase;
          };
          const endPhase = () => {
            activePhase.frameAfter = scene.frameState.frameNumber;
            activePhase = null;
          };
          const restore = () => {
            suppressionActive = false;
            if (originalPipelineDescriptor) {
              Object.defineProperty(
                command,
                "classificationDepthPipeline",
                originalPipelineDescriptor,
              );
            } else {
              delete command.classificationDepthPipeline;
            }
            if (originalExecuteDescriptor) {
              Object.defineProperty(
                command,
                "execute",
                originalExecuteDescriptor,
              );
            } else {
              delete command.execute;
            }
            const pipelineAfter = Object.getOwnPropertyDescriptor(
              command,
              "classificationDepthPipeline",
            );
            const executeAfter = Object.getOwnPropertyDescriptor(
              command,
              "execute",
            );
            routeEvidence.instrument.descriptorRestored =
              pipelineAfter?.value === originalPipelineDescriptor?.value &&
              pipelineAfter?.get === originalPipelineDescriptor?.get &&
              pipelineAfter?.set === originalPipelineDescriptor?.set &&
              executeAfter?.value === originalExecuteDescriptor?.value &&
              executeAfter?.get === originalExecuteDescriptor?.get &&
              executeAfter?.set === originalExecuteDescriptor?.set;
          };
          routeController = {
            command,
            beginPhase,
            endPhase,
            suppress() {
              suppressionActive = true;
              routeEvidence.instrument.suppressionGetterHeld =
                currentVariant !== null &&
                currentVariant !== undefined &&
                command.classificationDepthPipeline === null;
            },
            unsuppress() {
              suppressionActive = false;
            },
            restore,
          };
        }
      }

      const captures = {};
      const captureState = async (
        name,
        towerShown,
        classifierShown,
        routePhase,
      ) => {
        window.__c15G7Progress.phase = `capture:${name}:settle`;
        tileset.show = towerShown;
        classifier.show = classifierShown;
        await settle(10);
        if (routePhase) routeController?.beginPhase(routePhase);
        window.__c15G7Progress.phase = `capture:${name}:fused`;
        // Reset occurs immediately before this awaited call.  The canonical
        // transaction owns the only render, and no render occurs before the
        // frame number/counter is read below.
        const snapshot = await captureSnapshot();
        if (routePhase) routeController?.endPhase();
        captures[name] = snapshot.dataUrl;
      };

      let outcome;
      try {
        await captureState("baseline", false, false, null);
        await captureState("tower", true, false, null);
        await captureState("towerRepeat", true, false, null);
        await captureState("terrainReference", false, true, null);
        await captureState("positive", true, true, "positive");
        if (renderer === "webgpu") {
          routeController?.suppress();
          await captureState("suppressed", true, true, "suppressed");
          routeController?.unsuppress();
          await captureState("restored", true, true, "restored");
        }

        const cacheCommand =
          tileset.gaussianSplatPrimitive?._webgpuCache?.command;
        if (renderer === "webgpu") {
          routeEvidence.instrument.stableCommandIdentity =
            cacheCommand === routeController?.command &&
            commandInPass(C.Pass.GAUSSIAN_SPLATS, cacheCommand) &&
            [
              routeEvidence.positive,
              routeEvidence.suppressed,
              routeEvidence.restored,
            ].every(
              (counter) => counter?.frameAfter === counter?.frameBefore + 1,
            );
        }
        outcome = {
          captures,
          route: renderer === "webgpu" ? routeEvidence : null,
          runtime: {
            ready,
            rendererType: String(
              scene.context?.rendererType ?? "",
            ).toLowerCase(),
            waitedMs: Math.round(performance.now() - readinessStart),
            tilesetReady: tileset.tilesLoaded,
            globeTilesLoaded: scene.globe.tilesLoaded,
            classifierReady:
              classifier.ready &&
              classifier.classificationType === C.ClassificationType.BOTH,
            globeCommands: passCount(C.Pass.GLOBE),
            splatCommands: passCount(C.Pass.GAUSSIAN_SPLATS),
            frameNumber: scene.frameState.frameNumber,
            projectedAnchors: anchors,
            classificationTypeBoth:
              classifier.classificationType === C.ClassificationType.BOTH,
            framing,
          },
          harnessErrors: pageRuntimeErrors,
        };
      } finally {
        routeController?.restore();
        if (outcome?.route) {
          outcome.route = routeEvidence;
        }
        window.__c15G7Progress.phase = "measurement-complete";
      }
      return outcome;
    };
    const measurement = await page.evaluate(acquirePageMeasurement, {
      renderer,
      assetUrl: GSPLAT_CLASSIFICATION_CONFIG.assetUrl,
      towerTerrainMarginFraction: TOWER_FRAMING_CONFIG.marginFraction,
      minimumTowerMaskPixels: TOWER_FRAMING_CONFIG.minimumTowerMaskPixels,
    });

    owned.phase = `${renderer}:diagnostics`;
    const gpuGate =
      renderer === "webgpu"
        ? await collectGateErrors(page)
        : { errors: [], deviceLost: null, armedDevices: 0 };
    measurement.runtime.gpuGateArmedDevices = gpuGate.armedDevices;
    measurement.harnessErrors = [
      ...(measurement.harnessErrors ?? []),
      ...consoleErrors,
      ...gpuGate.errors,
      ...(gpuGate.deviceLost ? [gpuGate.deviceLost] : []),
      ...externalRequests.map(
        (url) => `non-loopback request escaped offline scene: ${url}`,
      ),
    ];
    measurement.diagnostics = {
      gpuGate,
      externalRequests: [...new Set(externalRequests)].sort(),
      pendingRequestsBeforeClose: pending.size,
    };
    session.measurement = measurement;
    return session;
  } finally {
    owned.phase = `${renderer}:cleanup`;
    const pageClose = await closeBounded(
      page,
      `${renderer} page`,
      SESSION_CLOSE_TIMEOUT_MS,
    );
    const contextClose = await closeBounded(
      context,
      `${renderer} context`,
      SESSION_CLOSE_TIMEOUT_MS,
    );
    if (pageClose.closed && owned.page === page) owned.page = undefined;
    if (contextClose.closed && owned.context === context) {
      owned.context = undefined;
    }
    const pendingRequests = pending.size;
    session.cleanup = {
      pageClose,
      contextClose,
      pendingRequests,
      complete:
        pageClose.closed && contextClose.closed && pendingRequests === 0,
    };
  }
}

async function acquireBothBackends(browser, options, owned) {
  const result = {
    sessions: [],
    cleanup: { complete: false },
  };
  try {
    for (const renderer of ["webgl", "webgpu"]) {
      result.sessions.push(
        await runBackend(browser, renderer, options.base, owned),
      );
    }
    return result;
  } finally {
    owned.phase = "browser-cleanup";
    const browserClose = await closeBounded(
      browser,
      "fleet browser",
      BROWSER_CLOSE_TIMEOUT_MS,
    );
    if (browserClose.closed && owned.browser === browser) {
      owned.browser = undefined;
    }
    let lastResortClose = {
      attempted: false,
      closed: browserClose.closed,
    };
    // This explicit finally close is the fleet source-contract anchor and a
    // last-resort reclamation.  It is reached only after the bounded close
    // reports a miss; the terminating process fuse remains armed if it wedges.
    if (!browserClose.closed && owned.browser === browser) {
      try {
        await browser.close();
        lastResortClose = { attempted: true, closed: true };
        owned.browser = undefined;
      } catch (error) {
        lastResortClose = {
          attempted: true,
          closed: false,
          error: serializeError(error),
        };
      }
    }
    result.cleanup = {
      browserClose,
      lastResortClose,
      sessions: result.sessions.map((session) => session.cleanup),
      complete:
        browserClose.closed &&
        result.sessions.length === 2 &&
        result.sessions.every((session) => session.cleanup?.complete === true),
    };
  }
}

function artifactWithStatus(status, fields) {
  return {
    schema: GSPLAT_CLASSIFICATION_SCHEMA,
    ...fields,
    status,
    exitCode: exitCodeForS5Status(status),
  };
}

export async function runC15G7Probe(options = {}) {
  const operations = options.operations ?? fs;
  const runId = options.runId ?? randomUUID();
  const paths = createRunPaths(runId, options.outputRoot);
  prepareRunDirectory(paths, operations);
  const startedAt = new Date().toISOString();
  const source = operations.readFileSync(probeSourcePath, "utf8");
  const capturePreflight = inspectC15G7CaptureContract(source);
  const owned = {
    browser: undefined,
    context: undefined,
    page: undefined,
    pending: new Set(),
    phase: "preflight",
  };
  let artifact;
  let imageRecords = {};
  let quiescent = true;
  try {
    if (capturePreflight.failures.length > 0) {
      artifact = artifactWithStatus("STRUCTURAL", {
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        captureContract: { ...capturePreflight, writeOnce: true },
        structural: capturePreflight.failures,
        failures: [],
        harnessErrors: [],
        images: {},
      });
    } else {
      // Launch sits outside the orderly watchdog.  A launch that never returns
      // cannot create a late, unowned browser after timeout; the terminating
      // process fuse is the sole authority for that pre-acquisition wedge.
      owned.phase = "browser-launch";
      const browser = await chromium.launch({
        channel: "msedge",
        headless: !options.headed,
        args: ["--enable-unsafe-webgpu"],
        timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      });
      owned.browser = browser;
      quiescent = false;
      const acquisition = await withC15G7Watchdog(
        () => acquireBothBackends(browser, options, owned),
        async () => {
          const checkpoint = await boundedPageCheckpoint(owned);
          const cleanup = await cleanupOwned(owned);
          return { checkpoint, ...cleanup };
        },
        options.watchdogMs ?? RUN_WATCHDOG_MS,
      );
      quiescent =
        acquisition.cleanup.complete === true &&
        !owned.browser &&
        !owned.context &&
        !owned.page &&
        (owned.pending?.size ?? 0) === 0;
      const persisted = await persistAndRederiveCaptureImages(
        paths,
        acquisition.sessions,
        imageRecords,
        operations,
      );
      imageRecords = persisted.records;
      const byRenderer = Object.fromEntries(
        acquisition.sessions.map((session) => [session.renderer, session]),
      );
      const harnessErrors = acquisition.sessions.flatMap((session) =>
        (session.measurement?.harnessErrors ?? []).map(
          (reason) => `${session.renderer}:${reason}`,
        ),
      );
      const evaluationInput = {
        schema: GSPLAT_CLASSIFICATION_SCHEMA,
        captureContract: {
          canonical: capturePreflight.canonical,
          singleBlock: capturePreflight.singleBlock,
          usageValid: capturePreflight.usageValid,
          writeOnce: true,
        },
        cleanup: acquisition.cleanup,
        harnessErrors,
        productErrors: [],
        webgl: {
          pixels: persisted.pixels.webgl,
          runtime: byRenderer.webgl?.measurement?.runtime,
        },
        webgpu: {
          pixels: persisted.pixels.webgpu,
          route: byRenderer.webgpu?.measurement?.route,
          runtime: byRenderer.webgpu?.measurement?.runtime,
        },
      };
      const evaluation = evaluateGsplatClassificationDepth(evaluationInput);
      const sessions = acquisition.sessions.map((session) => ({
        renderer: session.renderer,
        pixels: persisted.pixels[session.renderer],
        route: session.measurement.route,
        runtime: session.measurement.runtime,
        diagnostics: session.measurement.diagnostics,
        cleanup: session.cleanup,
      }));
      artifact = artifactWithStatus(evaluation.status, {
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        captureContract: { ...capturePreflight, writeOnce: true },
        structural: evaluation.structural,
        failures: evaluation.failures,
        harnessErrors: evaluation.harnessErrors,
        images: imageRecords,
        sessions,
        cleanup: acquisition.cleanup,
      });
    }
  } catch (error) {
    let terminalCleanup;
    let terminalCleanupError;
    try {
      terminalCleanup = await cleanupOwned(owned);
      quiescent =
        terminalCleanup.cleanupComplete === true &&
        !owned.browser &&
        !owned.context &&
        !owned.page;
    } catch (cleanupError) {
      quiescent = false;
      terminalCleanupError = serializeError(cleanupError);
    }
    artifact = artifactWithStatus("ERROR", {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      captureContract: { ...capturePreflight, writeOnce: true },
      structural: [],
      failures: [],
      harnessErrors: [
        serializeError(error),
        ...(terminalCleanupError ? [terminalCleanupError] : []),
      ],
      images: imageRecords,
      cleanup: terminalCleanup ?? { complete: false },
    });
  }

  const artifactBytes = Buffer.from(stableJson(artifact));
  const reread = writeOnceExact(
    paths.artifact,
    artifactBytes,
    "final evidence",
    operations,
  );
  return {
    artifact,
    quiescent,
    publication: {
      file: paths.artifact,
      bytes: reread.length,
      sha256: sha256(reread),
    },
  };
}

function usage() {
  console.log(
    "Usage: node Tools/visual-regression/probe-gsplat-classification-depth.mjs " +
      "[--base URL] [--output-directory DIR] [--headed]\n\n" +
      "Requires an already-running loopback server and a current Build/CesiumUnminified build.",
  );
}

function parseArguments(argv) {
  const parsed = {
    base: validateLoopbackBase(defaultBase),
    outputRoot: defaultOutputRoot,
    headed: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const nextValue = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === "--base") {
      parsed.base = validateLoopbackBase(nextValue());
    } else if (argument === "--output-directory") {
      parsed.outputRoot = path.resolve(nextValue());
    } else if (argument === "--headed") {
      parsed.headed = true;
    } else if (argument === "--help") {
      usage();
      process.exit(exitCodeForS5Status("PASS"));
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return parsed;
}

async function main() {
  // Terminating process fuse: the in-run watchdog rejects only if the event
  // loop comes back.  This timer is the final bound on a wedged GPU process.
  const processWatchdog = setTimeout(() => {
    console.error(
      `[c15-g7] process watchdog fired after ${PROCESS_WATCHDOG_MS} ms`,
    );
    process.exit(exitCodeForS5Status("ERROR"));
  }, PROCESS_WATCHDOG_MS);
  processWatchdog.unref?.();
  let quiescent = false;
  try {
    const result = await runC15G7Probe(parseArguments(process.argv.slice(2)));
    quiescent = result.quiescent === true;
    console.log(
      JSON.stringify(
        {
          status: result.artifact.status,
          exitCode: result.artifact.exitCode,
          runId: result.artifact.runId,
          evidence: result.publication,
        },
        null,
        2,
      ),
    );
    process.exitCode = exitCodeForS5Status(result.artifact.status);
  } catch (error) {
    console.error("[c15-g7] uncaught probe failure", error);
    process.exitCode = exitCodeForS5Status("ERROR");
  } finally {
    if (quiescent) clearTimeout(processWatchdog);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
