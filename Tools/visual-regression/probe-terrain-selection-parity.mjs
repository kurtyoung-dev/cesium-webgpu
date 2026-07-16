/**
 * C9-02 fixed-checkpoint terrain selection parity probe.
 *
 * Unlike the moving performance lane, this probe settles the same local
 * ellipsoid/grid scene at exact camera waypoints before comparing the shared
 * quadtree selection and portable CPU terrain revisions across WebGL/WebGPU.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { GLOBE_CAMERA_TRACK } from "./lib/globe-camera-track.mjs";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(toolDirectory, "..", "..");
const baseUrl =
  process.env.CESIUM_VIEWER_URL ||
  "http://localhost:8080/Apps/CesiumViewer/index.html";
const outputPath = resolve(
  process.argv[2] ||
    resolve(
      toolDirectory,
      "output",
      "performance",
      "campaign9-c9-02-terrain-checkpoint-parity-2026-07-15.json",
    ),
);
const viewport = { width: 1280, height: 720 };
const fixedClock = "2026-06-21T08:00:00Z";
const stableFramesRequired = 20;
const checkpointTimeoutMs = 45_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function runtimeBundleIdentity() {
  const path = resolve(repositoryDirectory, "Build/CesiumUnminified/Cesium.js");
  const bytes = await readFile(path);
  return {
    path: "Build/CesiumUnminified/Cesium.js",
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

async function runRenderer(browser, renderer) {
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  const localOrigin = new URL(baseUrl).origin;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (
      (requestUrl.protocol === "http:" || requestUrl.protocol === "https:") &&
      requestUrl.origin !== localOrigin
    ) {
      externalRequests.push(request.url());
    }
  });

  const url = new URL(baseUrl);
  url.searchParams.set("renderer", renderer);
  url.searchParams.set("offline", "true");
  await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
  await page.waitForFunction(
    () => globalThis.viewer?.scene?._frameState?.frameNumber > 0,
    undefined,
    { timeout: checkpointTimeoutMs },
  );

  const setup = await page.evaluate(
    async ({ expectedRenderer, isoTime }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = globalThis.viewer;
      const scene = viewer.scene;
      const graphicsContext = scene.context;
      const actualRenderer = graphicsContext.isWebGPU ? "webgpu" : "webgl";
      if (actualRenderer !== expectedRenderer) {
        throw new Error(
          `resolved renderer ${actualRenderer}, expected ${expectedRenderer}`,
        );
      }
      const deviceErrors = [];
      graphicsContext.device?.addEventListener?.("uncapturederror", (event) => {
        deviceErrors.push(
          String(event?.error?.message || event?.error || "unknown GPU error"),
        );
      });
      globalThis.__terrainParityDeviceErrors = deviceErrors;

      scene.requestRenderMode = false;
      viewer.resolutionScale = 1;
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = C.JulianDate.fromIso8601(isoTime);
      scene.globe.imageryLayers.removeAll();
      scene.globe.imageryLayers.addImageryProvider(
        new C.GridImageryProvider({
          cells: 8,
          color: C.Color.fromBytes(80, 125, 170, 255),
          glowColor: C.Color.fromBytes(20, 35, 50, 255),
          glowWidth: 1,
          backgroundColor: C.Color.fromBytes(10, 20, 30, 255),
        }),
      );
      scene.globe.terrainProvider = new C.EllipsoidTerrainProvider();
      scene.morphTo3D(0);
      scene.requestRender();
      return {
        actualRenderer,
        imageryLayerCount: scene.globe.imageryLayers.length,
        ellipsoidTerrain:
          scene.globe.terrainProvider instanceof C.EllipsoidTerrainProvider,
      };
    },
    { expectedRenderer: renderer, isoTime: fixedClock },
  );

  const checkpoints = [];
  for (const waypoint of GLOBE_CAMERA_TRACK) {
    const checkpoint = await page.evaluate(
      async ({ camera, stableFrames, timeoutMs }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const scene = globalThis.viewer.scene;
        const surface = scene.globe._surface;
        const tileProvider = surface._tileProvider;

        scene.camera.setView({
          destination: C.Cartesian3.fromDegrees(
            camera.lon,
            camera.lat,
            camera.height,
          ),
          orientation: {
            heading: C.Math.toRadians(camera.heading),
            pitch: C.Math.toRadians(camera.pitch),
            roll: C.Math.toRadians(camera.roll),
          },
        });

        const finiteOrNull = (value) =>
          Number.isFinite(value) ? value : null;
        const tileId = (tile) => `${tile.level}/${tile.x}/${tile.y}`;
        const portableTile = (tile) => {
          const surfaceTile = tile.data;
          const renderedMesh = surfaceTile?.renderedMesh;
          const realMesh = surfaceTile?.mesh;
          const fillMesh = surfaceTile?.fill?.mesh;
          const mesh = renderedMesh || realMesh || fillMesh;
          const meshSource = renderedMesh
            ? "rendered-mesh"
            : realMesh
              ? "real-mesh"
              : fillMesh
                ? "fill-mesh"
                : "none";
          const imagery = [];
          for (const tileImagery of surfaceTile?.imagery || []) {
            const image =
              tileImagery?.readyImagery || tileImagery?.loadingImagery;
            if (!image) continue;
            imagery.push({
              layerIndex: image.imageryLayer?._layerIndex ?? null,
              level: image.level ?? null,
              x: image.x ?? null,
              y: image.y ?? null,
              state: image.state ?? null,
              useWebMercatorT: tileImagery?.useWebMercatorT === true,
            });
          }
          imagery.sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          );
          return {
            id: tileId(tile),
            portableRevision: {
              terrainState: surfaceTile?.terrainState ?? null,
              tileLoadState: tile.state ?? null,
              renderable: tile.renderable === true,
              upsampledFromParent: tile.upsampledFromParent === true,
              mesh: {
                source: meshSource,
                verticesByteLength: mesh?.vertices?.byteLength || 0,
                indexCount: mesh?.indices?.length || 0,
                indexBytes: mesh?.indices?.BYTES_PER_ELEMENT || 0,
                stride: finiteOrNull(mesh?.stride),
                quantization: finiteOrNull(mesh?.encoding?.quantization),
                minimumHeight: finiteOrNull(mesh?.minimumHeight),
                maximumHeight: finiteOrNull(mesh?.maximumHeight),
                indexCountWithoutSkirts: finiteOrNull(
                  mesh?.indexCountWithoutSkirts,
                ),
                vertexCountWithoutSkirts: finiteOrNull(
                  mesh?.vertexCountWithoutSkirts,
                ),
              },
              imagery,
              waterMaskPresent: Boolean(
                surfaceTile?.waterMaskTexture ||
                  surfaceTile?.terrainData?.waterMask,
              ),
            },
          };
        };
        const snapshot = () => {
          const selectedObjects = [...(surface._tilesToRender || [])];
          const selectedSet = new Set(selectedObjects);
          const bucketCounts = new Map();
          for (const bucket of tileProvider._tilesToRenderByTextureCount || []) {
            for (const tile of bucket || []) {
              bucketCounts.set(tile, (bucketCounts.get(tile) || 0) + 1);
            }
          }
          const records = selectedObjects.map(portableTile);
          records.sort((left, right) => left.id.localeCompare(right.id));
          return {
            records,
            bucketCoverage: {
              count: [...bucketCounts.values()].reduce(
                (sum, count) => sum + count,
                0,
              ),
              missing: selectedObjects
                .filter((tile) => !bucketCounts.has(tile))
                .map(tileId),
              extra: [...bucketCounts.keys()]
                .filter((tile) => !selectedSet.has(tile))
                .map(tileId),
              duplicates: [...bucketCounts.entries()]
                .filter(([, count]) => count > 1)
                .map(([tile, count]) => ({ id: tileId(tile), count })),
            },
          };
        };
        const loadQueuesEmpty = () =>
          surface._tileLoadQueueHigh.length === 0 &&
          surface._tileLoadQueueMedium.length === 0 &&
          surface._tileLoadQueueLow.length === 0 &&
          surface._debug.tilesWaitingForChildren === 0;

        return new Promise((resolveCheckpoint, rejectCheckpoint) => {
          let previousSignature = "";
          let consecutiveStableFrames = 0;
          let observedFrames = 0;
          let latest;
          const timeout = setTimeout(() => {
            remove();
            rejectCheckpoint(
              new Error(`terrain checkpoint ${camera.name} did not settle`),
            );
          }, timeoutMs);
          const remove = scene.postRender.addEventListener(() => {
            observedFrames++;
            latest = snapshot();
            const signature = JSON.stringify(latest);
            if (loadQueuesEmpty() && signature === previousSignature) {
              consecutiveStableFrames++;
            } else {
              consecutiveStableFrames = 0;
            }
            previousSignature = signature;
            if (consecutiveStableFrames >= stableFrames) {
              clearTimeout(timeout);
              remove();
              resolveCheckpoint({
                name: camera.name,
                camera,
                frameNumber: scene._frameState.frameNumber,
                observedFrames,
                stableFrames: consecutiveStableFrames,
                selectedCount: latest.records.length,
                ...latest,
              });
              return;
            }
            scene.requestRender();
          });
          scene.requestRender();
        });
      },
      {
        camera: waypoint,
        stableFrames: stableFramesRequired,
        timeoutMs: checkpointTimeoutMs,
      },
    );
    const canonical = JSON.stringify(checkpoint.records);
    checkpoint.selectedSetHash = sha256(canonical);
    checkpoints.push(checkpoint);
  }

  const deviceErrors = await page.evaluate(
    () => [...(globalThis.__terrainParityDeviceErrors || [])],
  );
  await context.close();
  return {
    renderer,
    setup,
    checkpoints,
    deviceErrors,
    pageErrors,
    consoleErrors,
    externalRequests,
  };
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
let report;
try {
  const webgl = await runRenderer(browser, "webgl");
  const webgpu = await runRenderer(browser, "webgpu");
  const comparisons = webgl.checkpoints.map((left, index) => {
    const right = webgpu.checkpoints[index];
    const leftJson = JSON.stringify(left.records);
    const rightJson = JSON.stringify(right.records);
    const leftById = new Map(left.records.map((record) => [record.id, record]));
    const rightById = new Map(
      right.records.map((record) => [record.id, record]),
    );
    return {
      name: left.name,
      exact: leftJson === rightJson,
      webglHash: left.selectedSetHash,
      webgpuHash: right.selectedSetHash,
      missingInWebGPU: [...leftById.keys()].filter(
        (id) => !rightById.has(id),
      ),
      extraInWebGPU: [...rightById.keys()].filter((id) => !leftById.has(id)),
      revisionMismatches: [...leftById.keys()].filter(
        (id) =>
          rightById.has(id) &&
          JSON.stringify(leftById.get(id).portableRevision) !==
            JSON.stringify(rightById.get(id).portableRevision),
      ),
    };
  });
  const failures = [];
  for (const run of [webgl, webgpu]) {
    if (run.deviceErrors.length) {
      failures.push(`${run.renderer}: ${run.deviceErrors.length} device errors`);
    }
    if (run.pageErrors.length) {
      failures.push(`${run.renderer}: ${run.pageErrors.length} page errors`);
    }
    if (run.externalRequests.length) {
      failures.push(
        `${run.renderer}: ${run.externalRequests.length} external requests`,
      );
    }
    for (const checkpoint of run.checkpoints) {
      const coverage = checkpoint.bucketCoverage;
      if (
        coverage.missing.length ||
        coverage.extra.length ||
        coverage.duplicates.length ||
        coverage.count !== checkpoint.selectedCount
      ) {
        failures.push(
          `${run.renderer}:${checkpoint.name}: inexact texture-bucket coverage`,
        );
      }
    }
  }
  for (const comparison of comparisons) {
    if (!comparison.exact) {
      failures.push(`${comparison.name}: cross-backend selection mismatch`);
    }
  }
  report = {
    schemaVersion: 1,
    kind: "terrain-selection-checkpoint-parity",
    generatedAt: new Date().toISOString(),
    runtimeBundle: await runtimeBundleIdentity(),
    browserVersion: browser.version(),
    viewport,
    fixedClock,
    stableFramesRequired,
    runs: { webgl, webgpu },
    comparisons,
    failures,
    result: failures.length ? "fail" : "pass",
  };
} finally {
  await browser.close();
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  result: report.result,
  failures: report.failures,
  comparisons: report.comparisons.map((comparison) => ({
    name: comparison.name,
    exact: comparison.exact,
    webglHash: comparison.webglHash,
    webgpuHash: comparison.webgpuHash,
  })),
  output: outputPath,
}, null, 2));
process.exitCode = report.result === "pass" ? 0 : 1;
