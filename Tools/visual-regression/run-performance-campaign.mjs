/**
 * Node/Playwright performance characterization runner.
 *
 * The runner consumes performance-workloads.json, asserts the resolved backend,
 * uses deterministic local/procedural content, and records full Scene.render CPU
 * samples plus capability-available WebGPU timestamps. It does not use FPS as a
 * promotion metric.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  GLOBE_CAMERA_TRACK,
  GLOBE_CAMERA_TRACK_ID,
} from "./lib/globe-camera-track.mjs";
import {
  assessPerformanceRunQuality,
  assessPerformanceRunStability,
  buildCounterbalancedSchedule,
  diffCounterLabelSnapshots,
  diffFlatCounterSnapshots,
  selectLongTasksInMeasurementWindow,
  summarizeFramePacing,
  summarizeMovingPickMetrics,
  summarizeTrackMetrics,
} from "./lib/performance-campaign-utils.mjs";
import { buildPerformanceViewerUrl } from "./lib/performance-viewer-url.mjs";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(toolDirectory, "..", "..");
const defaultManifestPath = resolve(
  toolDirectory,
  "performance-workloads.json",
);
const cameraTrackActions = new Set(["camera-track", "camera-track-pick"]);

function usesCameraTrack(action) {
  return cameraTrackActions.has(action);
}

function usesMovingPick(action) {
  return action === "camera-track-pick";
}

function usage() {
  console.log(`Usage: node Tools/visual-regression/run-performance-campaign.mjs [options]

Options:
  --manifest FILE          Workload manifest (default performance-workloads.json)
  --renderer NAME          webgl, webgpu, or both (default both)
  --workload ID            Run one workload; repeatable
  --repetitions N          Override manifest repetition count
  --frames N               Override measured frames
  --output FILE            Structured JSON output file
  --api-instrumentation    Count browser GPU API calls (adds observer overhead)
  --gpu-timestamps         Enable WebGPU pass timestamps (separate characterization lane)
  --no-gpu-timestamps      Explicitly select the default timestamp-off comparison lane
  --reuse-browser          Reuse one browser process (cross-run stress mode)
  --headed                 Launch a visible Edge window
  --help                   Show this help

The local Cesium Node server must already be available at the manifest baseUrl.
Use moving-camera-altitude-track-3d for normal renderer comparisons; an idle
scene is only a no-work diagnostic. Use moving-pick-camera-altitude-track-3d
for continuous hover-pick cost under the same camera route.`);
}

function parseArguments(argv) {
  const options = {
    manifestPath: defaultManifestPath,
    renderer: "both",
    workloads: [],
    repetitions: undefined,
    frames: undefined,
    output: resolve(toolDirectory, "output", "performance", "latest.json"),
    apiInstrumentation: false,
    // Cross-backend CPU comparisons must not instrument only the WebGPU leg.
    // Timestamp profiling is an explicit, separate characterization lane.
    gpuTimestamps: false,
    reuseBrowser: false,
    headed: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--manifest") {
      options.manifestPath = resolve(argv[++index]);
    } else if (argument === "--renderer") {
      options.renderer = argv[++index];
    } else if (argument === "--workload") {
      options.workloads.push(argv[++index]);
    } else if (argument === "--repetitions") {
      options.repetitions = Number.parseInt(argv[++index], 10);
    } else if (argument === "--frames") {
      options.frames = Number.parseInt(argv[++index], 10);
    } else if (argument === "--output") {
      options.output = resolve(argv[++index]);
    } else if (
      argument === "--api-instrumentation" ||
      argument === "--api-counters"
    ) {
      options.apiInstrumentation = true;
    } else if (argument === "--gpu-timestamps") {
      options.gpuTimestamps = true;
    } else if (argument === "--no-gpu-timestamps") {
      options.gpuTimestamps = false;
    } else if (argument === "--reuse-browser") {
      options.reuseBrowser = true;
    } else if (argument === "--headed") {
      options.headed = true;
    } else if (argument === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!["webgl", "webgpu", "both"].includes(options.renderer)) {
    throw new Error("--renderer must be webgl, webgpu, or both");
  }
  if (
    options.repetitions !== undefined &&
    (!Number.isInteger(options.repetitions) || options.repetitions < 1)
  ) {
    throw new Error("--repetitions must be a positive integer");
  }
  if (
    options.frames !== undefined &&
    (!Number.isInteger(options.frames) || options.frames < 1)
  ) {
    throw new Error("--frames must be a positive integer");
  }
  return options;
}

function command(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: resolve(toolDirectory, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function fileIdentity(path) {
  const bytes = await readFile(path);
  return {
    path,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
  };
}

function launchCampaignBrowser(manifest, options) {
  return chromium.launch({
    channel: manifest.protocol.browser,
    headless: !options.headed,
    args: ["--enable-unsafe-webgpu", "--enable-precise-memory-info"],
  });
}

function percentile(values, fraction) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function aggregateRuns(runs) {
  const cpuRuns = runs.filter(
    (run) =>
      run.result === "pass" &&
      run.quality?.validForCpuAggregation !== false,
  );
  const gpuRuns = runs.filter(
    (run) =>
      run.result === "pass" && run.quality?.validForGpuAggregation === true,
  );
  const cpuMetric = (reader) => cpuRuns.map(reader).filter(Number.isFinite);
  const gpuMetric = (reader) => gpuRuns.map(reader).filter(Number.isFinite);
  const readCpuP95 = (run) =>
    run.pickMetrics?.combinedCpuMs?.p95 ?? run.trace?.summary?.cpuMs?.p95;
  const stability = assessPerformanceRunStability(runs);
  return {
    runCount: runs.length,
    validRunCount: cpuRuns.length,
    validCpuRunCount: cpuRuns.length,
    validGpuRunCount: gpuRuns.length,
    stable: stability.stable,
    stabilityReasons: stability.reasons,
    cpuP95AcrossRuns: {
      p50: percentile(
        cpuMetric(readCpuP95),
        0.5,
      ),
      min: percentile(
        cpuMetric(readCpuP95),
        0,
      ),
      max: percentile(
        cpuMetric(readCpuP95),
        1,
      ),
    },
    gpuP95AcrossRuns: {
      p50: percentile(
        gpuMetric((run) => run.trace?.summary?.gpuMs?.p95),
        0.5,
      ),
      min: percentile(
        gpuMetric((run) => run.trace?.summary?.gpuMs?.p95),
        0,
      ),
      max: percentile(
        gpuMetric((run) => run.trace?.summary?.gpuMs?.p95),
        1,
      ),
    },
    wallP99AcrossRuns: {
      p50: percentile(
        cpuMetric((run) => run.trace?.summary?.wallDtMs?.p99),
        0.5,
      ),
      min: percentile(
        cpuMetric((run) => run.trace?.summary?.wallDtMs?.p99),
        0,
      ),
      max: percentile(
        cpuMetric((run) => run.trace?.summary?.wallDtMs?.p99),
        1,
      ),
    },
    navigationToStableMs: {
      p50: percentile(
        cpuMetric((run) => run.startup?.navigationToStableMs),
        0.5,
      ),
      min: percentile(
        cpuMetric((run) => run.startup?.navigationToStableMs),
        0,
      ),
      max: percentile(
        cpuMetric((run) => run.startup?.navigationToStableMs),
        1,
      ),
    },
  };
}

async function runOne(
  browser,
  manifest,
  renderer,
  workload,
  repetition,
  measurement,
  apiInstrumentation,
  gpuTimestamps,
) {
  const protocol = manifest.protocol;
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  const localOrigin = new URL(manifest.baseUrl).origin;
  // Own the BrowserContext explicitly so every repetition has a bounded
  // lifetime. WebGPU resources otherwise survived `page.close()` until the
  // browser chose to collect the implicit context, contaminating a following
  // repetition in the same process with severe CPU stalls.
  const browserContext = await browser.newContext({
    viewport: {
      width: protocol.viewport.width,
      height: protocol.viewport.height,
    },
    deviceScaleFactor: protocol.viewport.deviceScaleFactor,
  });
  const page = await browserContext.newPage();
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
      externalRequests.push({
        method: request.method(),
        resourceType: request.resourceType(),
        url: request.url(),
      });
    }
  });
  await page.addInitScript(
    ({ apiInstrumentation, expectedRenderer }) => {
      const apiCounters = Object.create(null);
      const apiCounterLabels = Object.create(null);
      const apiCounterOwners = Object.create(null);
      const apiCounterLabelCardinality = Object.create(null);
      const apiCounterOwnerCardinality = Object.create(null);
      const maxLabelsPerCounter = 512;
      const patchFailures = [];
      // Engine-side counters cover JS object/cache ownership that browser GPU
      // API wrappers cannot observe. Publish them only in the instrumented
      // lane so clean timing never allocates or mutates diagnostic state.
      const globeLogicalCounters = apiInstrumentation
        ? Object.create(null)
        : undefined;
      globalThis.__webgpuGlobeLogicalCounters = globeLogicalCounters;
      const createTerrainOwnershipDiagnostics = (backend) => {
        const objectGenerations = new WeakMap();
        const tileRevisionStates = new WeakMap();
        let nextObjectGeneration = 1;
        let nextSnapshotSerial = 1;
        let activeSnapshot = null;
        let snapshots = [];
        let revisionRecords = [];
        let revisionRecordIndices = new Map();
        let selectionSets = [];
        let selectionSetIndices = new Map();
        let terrainCommandRefreshRecords = new WeakMap();
        let snapshotSelectedOwnerSets = new WeakMap();
        const createTotals = () => ({
          snapshots: 0,
          renderSnapshots: 0,
          pickSnapshots: 0,
          selectedTiles: 0,
          bucketTiles: 0,
          commands: 0,
          uniqueCommandOwners: 0,
          selectedWithoutCommands: 0,
          ownerViolations: 0,
          pvsAdmittedCommands: 0,
          pvsCulledBeforeDerivedRefresh: 0,
          variantCommands: 0,
          variantOwnerViolations: 0,
          backendVariantViolations: 0,
          bucketMissing: 0,
          bucketExtra: 0,
          bucketDuplicates: 0,
          duplicateSelectedObjects: 0,
          revisionTransitionsDuringCompilation: 0,
          incompleteSnapshots: 0,
        });
        let totals = createTotals();

        const objectGeneration = (value) => {
          if (
            (typeof value !== "object" || value === null) &&
            typeof value !== "function"
          ) {
            return 0;
          }
          let generation = objectGenerations.get(value);
          if (generation === undefined) {
            generation = nextObjectGeneration++;
            objectGenerations.set(value, generation);
          }
          return generation;
        };
        const finiteOrNull = (value) =>
          Number.isFinite(value) ? value : null;
        const tileId = (tile) =>
          tile &&
          Number.isInteger(tile.level) &&
          Number.isInteger(tile.x) &&
          Number.isInteger(tile.y)
            ? `${tile.level}/${tile.x}/${tile.y}`
            : null;
        const meshRecord = (mesh, source) => {
          if (!mesh) {
            return {
              source,
              objectGeneration: 0,
              verticesGeneration: 0,
              verticesByteLength: 0,
              indicesGeneration: 0,
              indexCount: 0,
              indexBytes: 0,
              stride: null,
              quantization: null,
              minimumHeight: null,
              maximumHeight: null,
              indexCountWithoutSkirts: null,
              vertexCountWithoutSkirts: null,
            };
          }
          return {
            source,
            objectGeneration: objectGeneration(mesh),
            verticesGeneration: objectGeneration(mesh.vertices),
            verticesByteLength: mesh.vertices?.byteLength || 0,
            indicesGeneration: objectGeneration(mesh.indices),
            indexCount: mesh.indices?.length || 0,
            indexBytes: mesh.indices?.BYTES_PER_ELEMENT || 0,
            stride: finiteOrNull(mesh.stride),
            quantization: finiteOrNull(mesh.encoding?.quantization),
            minimumHeight: finiteOrNull(mesh.minimumHeight),
            maximumHeight: finiteOrNull(mesh.maximumHeight),
            indexCountWithoutSkirts: finiteOrNull(
              mesh.indexCountWithoutSkirts,
            ),
            vertexCountWithoutSkirts: finiteOrNull(
              mesh.vertexCountWithoutSkirts,
            ),
          };
        };
        const imageryRecords = (surfaceTile) => {
          const result = [];
          for (const tileImagery of surfaceTile?.imagery || []) {
            const imagery =
              tileImagery?.readyImagery || tileImagery?.loadingImagery;
            if (!imagery) continue;
            const image = imagery.image;
            const texture =
              tileImagery?.useWebMercatorT === true
                ? imagery.textureWebMercator || imagery.texture
                : imagery.texture || imagery.textureWebMercator;
            result.push({
              layerIndex: imagery.imageryLayer?._layerIndex ?? null,
              level: imagery.level ?? null,
              x: imagery.x ?? null,
              y: imagery.y ?? null,
              state: imagery.state ?? null,
              useWebMercatorT: tileImagery?.useWebMercatorT === true,
              imageryGeneration: objectGeneration(imagery),
              imageGeneration: objectGeneration(image),
              textureGeneration: objectGeneration(texture),
              imageWidth: image?.width ?? image?.naturalWidth ?? null,
              imageHeight: image?.height ?? image?.naturalHeight ?? null,
              imageUrl: imagery.imageUrl || image?.currentSrc || image?.src || null,
            });
          }
          return result;
        };
        const makeTileRecord = (tile, selectionOrder) => {
          const surfaceTile = tile?.data;
          const renderedMesh = surfaceTile?.renderedMesh;
          const realMesh = surfaceTile?.mesh;
          const fillMesh = surfaceTile?.fill?.mesh;
          const mesh = renderedMesh || realMesh || fillMesh;
          const source = renderedMesh
            ? "rendered-mesh"
            : realMesh
              ? "real-mesh"
              : fillMesh
                ? "fill-mesh"
                : "none";
          const meshInfo = meshRecord(mesh, source);
          const imagery = imageryRecords(surfaceTile);
          const portableMesh = {
            source: meshInfo.source,
            verticesByteLength: meshInfo.verticesByteLength,
            indexCount: meshInfo.indexCount,
            indexBytes: meshInfo.indexBytes,
            stride: meshInfo.stride,
            quantization: meshInfo.quantization,
            minimumHeight: meshInfo.minimumHeight,
            maximumHeight: meshInfo.maximumHeight,
            indexCountWithoutSkirts: meshInfo.indexCountWithoutSkirts,
            vertexCountWithoutSkirts: meshInfo.vertexCountWithoutSkirts,
          };
          const portableImagery = imagery.map((entry) => ({
            layerIndex: entry.layerIndex,
            level: entry.level,
            x: entry.x,
            y: entry.y,
            state: entry.state,
            useWebMercatorT: entry.useWebMercatorT,
          }));
          const portableRevision = JSON.stringify({
            terrainState: surfaceTile?.terrainState ?? null,
            tileLoadState: tile?.state ?? null,
            renderable: tile?.renderable === true,
            upsampledFromParent: tile?.upsampledFromParent === true,
            mesh: portableMesh,
            imagery: portableImagery,
            waterMaskPresent: Boolean(
              surfaceTile?.waterMaskTexture ||
                surfaceTile?.terrainData?.waterMask,
            ),
          });
          const exactSignature = JSON.stringify({
            portableRevision,
            mesh: [
              meshInfo.objectGeneration,
              meshInfo.verticesGeneration,
              meshInfo.indicesGeneration,
            ],
            imagery: imagery.map((entry) => [
              entry.imageryGeneration,
              entry.imageGeneration,
              entry.textureGeneration,
            ]),
            waterMaskGeneration: objectGeneration(
              surfaceTile?.waterMaskTexture ||
                surfaceTile?.terrainData?.waterMask,
            ),
          });
          const previous = tileRevisionStates.get(tile);
          const revision =
            previous?.signature === exactSignature
              ? previous.revision
              : (previous?.revision || 0) + 1;
          tileRevisionStates.set(tile, { signature: exactSignature, revision });
          return {
            id: tileId(tile),
            selectionOrder,
            tileObjectGeneration: objectGeneration(tile),
            revision,
            portableRevision,
            terrainState: surfaceTile?.terrainState ?? null,
            tileLoadState: tile?.state ?? null,
            lastSelectionResultFrame: tile?._lastSelectionResultFrame ?? null,
            lastSelectionResult: tile?._lastSelectionResult ?? null,
            renderable: tile?.renderable === true,
            upsampledFromParent: tile?.upsampledFromParent === true,
            mesh: meshInfo,
            imagery,
          };
        };
        const describeOwner = (owner) => ({
          id: tileId(owner),
          objectGeneration: objectGeneration(owner),
        });
        const registerRevisionRecord = (record) => {
          const key = `${record.tileObjectGeneration}/${record.revision}`;
          let index = revisionRecordIndices.get(key);
          if (index === undefined) {
            index = revisionRecords.length;
            revisionRecordIndices.set(key, index);
            revisionRecords.push(record);
          }
          return {
            id: record.id,
            selectionOrder: record.selectionOrder,
            tileObjectGeneration: record.tileObjectGeneration,
            revision: record.revision,
            revisionRecord: index,
          };
        };
        const registerSelectionSet = (selected) => {
          const key = selected
            .map(
              (tile) =>
                `${tile.tileObjectGeneration}/${tile.revision}/${tile.revisionRecord}`,
            )
            .join(",");
          let index = selectionSetIndices.get(key);
          if (index === undefined) {
            index = selectionSets.length;
            selectionSetIndices.set(key, index);
            selectionSets.push(selected);
          }
          return index;
        };
        const beginCompilation = (
          phase,
          frameNumber,
          selectedTiles,
          textureBuckets,
        ) => {
          if (activeSnapshot) {
            totals.incompleteSnapshots++;
          }
          const selected = Array.from(selectedTiles || []);
          const selectedSet = new Set(selected);
          const duplicateSelectedObjects = selected.length - selectedSet.size;
          const bucketCounts = new Map();
          let bucketTileCount = 0;
          for (const bucket of textureBuckets || []) {
            for (const tile of bucket || []) {
              bucketTileCount++;
              bucketCounts.set(tile, (bucketCounts.get(tile) || 0) + 1);
            }
          }
          const missing = selected
            .filter((tile) => !bucketCounts.has(tile))
            .map(describeOwner);
          const extra = [...bucketCounts.keys()]
            .filter((tile) => !selectedSet.has(tile))
            .map(describeOwner);
          const duplicates = [...bucketCounts.entries()]
            .filter(([, count]) => count > 1)
            .map(([tile, count]) => ({ ...describeOwner(tile), count }));
          const selectedRecords = selected.map(makeTileRecord);
          activeSnapshot = {
            serial: nextSnapshotSerial++,
            phase,
            frameNumber,
            selectedObjects: selected,
            selectedSet,
            selectedRecords,
            selected: selectedRecords.map(registerRevisionRecord),
            bucketCoverage: {
              count: bucketTileCount,
              missing,
              extra,
              duplicates,
              duplicateSelectedObjects,
            },
          };
        };
        const endCompilation = (
          phase,
          frameNumber,
          commandList,
          commandListStart,
        ) => {
          const active = activeSnapshot;
          activeSnapshot = null;
          if (
            !active ||
            active.phase !== phase ||
            active.frameNumber !== frameNumber
          ) {
            totals.incompleteSnapshots++;
            return;
          }
          const ownerViolations = [];
          const commandOwners = new Set();
          let commandCount = 0;
          const primaryCommands = [];
          for (let index = commandListStart; index < commandList.length; index++) {
            const command = commandList[index];
            commandCount++;
            const owner = command?.owner;
            if (!active.selectedSet.has(owner)) {
              ownerViolations.push({
                commandIndex: index - commandListStart,
                owner: describeOwner(owner),
              });
            } else {
              commandOwners.add(owner);
            }
            primaryCommands.push({ command, owner });
          }
          const postCompileSelected = active.selectedObjects.map(makeTileRecord);
          const revisionTransitions = postCompileSelected
            .map((record, index) => ({
              id: record.id,
              before: active.selectedRecords[index].revision,
              after: record.revision,
              beforeRevisionRecord:
                active.selected[index].revisionRecord,
              afterRevisionRecord: registerRevisionRecord(record).revisionRecord,
            }))
            .filter(
              (entry) =>
                entry.before !== entry.after ||
                entry.beforeRevisionRecord !== entry.afterRevisionRecord,
            );
          const selectedWithoutCommands = active.selectedObjects
            .filter((tile) => !commandOwners.has(tile))
            .map(describeOwner);
          const snapshot = {
            schemaVersion: 2,
            serial: active.serial,
            phase,
            frameNumber,
            selectedCount: active.selected.length,
            selectionSet: registerSelectionSet(active.selected),
            bucketCoverage: active.bucketCoverage,
            commands: {
              count: commandCount,
              uniqueOwnerCount: commandOwners.size,
              uniqueOwners: [...commandOwners].map(describeOwner),
              selectedWithoutCommands,
              ownerViolations,
              pvsAdmittedCount: 0,
              pvsCulledBeforeDerivedRefresh: commandCount,
              variantCount: 0,
              variantOwnerViolations: [],
              backendVariantViolations: [],
            },
            revisionTransitionsDuringCompilation: revisionTransitions,
            complete: true,
          };
          snapshots.push(snapshot);
          snapshotSelectedOwnerSets.set(snapshot, active.selectedSet);
          for (const { command, owner } of primaryCommands) {
            if (command && typeof command === "object") {
              terrainCommandRefreshRecords.set(command, {
                snapshot,
                expectedOwner: owner,
                observed: false,
              });
            }
          }
          totals.snapshots++;
          totals[phase === "pick" ? "pickSnapshots" : "renderSnapshots"]++;
          totals.selectedTiles += active.selected.length;
          totals.bucketTiles += active.bucketCoverage.count;
          totals.commands += commandCount;
          totals.uniqueCommandOwners += commandOwners.size;
          totals.selectedWithoutCommands += selectedWithoutCommands.length;
          totals.ownerViolations += ownerViolations.length;
          totals.pvsCulledBeforeDerivedRefresh += commandCount;
          totals.bucketMissing += active.bucketCoverage.missing.length;
          totals.bucketExtra += active.bucketCoverage.extra.length;
          totals.bucketDuplicates += active.bucketCoverage.duplicates.length;
          totals.duplicateSelectedObjects +=
            active.bucketCoverage.duplicateSelectedObjects;
          totals.revisionTransitionsDuringCompilation +=
            revisionTransitions.length;
        };
        return {
          schemaVersion: 2,
          enabled: true,
          attached: false,
          backend,
          reset() {
            activeSnapshot = null;
            snapshots = [];
            revisionRecords = [];
            revisionRecordIndices = new Map();
            selectionSets = [];
            selectionSetIndices = new Map();
            terrainCommandRefreshRecords = new WeakMap();
            snapshotSelectedOwnerSets = new WeakMap();
            totals = createTotals();
            nextSnapshotSerial = 1;
            this.attached = false;
            this.derivedRefreshObserverAttached = false;
          },
          recordTerrainCommandAfterDerivedRefresh(command) {
            const record = terrainCommandRefreshRecords.get(command);
            if (!record || record.observed) {
              return;
            }
            record.observed = true;
            const { snapshot, expectedOwner } = record;
            const selectedOwnerSet = snapshotSelectedOwnerSets.get(snapshot);
            snapshot.commands.pvsAdmittedCount++;
            snapshot.commands.pvsCulledBeforeDerivedRefresh--;
            totals.pvsAdmittedCommands++;
            totals.pvsCulledBeforeDerivedRefresh--;

            const visitedDerived = new WeakSet();
            const visitDerived = (node, path) => {
              if (!node || typeof node !== "object" || visitedDerived.has(node)) {
                return;
              }
              visitedDerived.add(node);
              for (const [name, value] of Object.entries(node)) {
                if (!value || typeof value !== "object") continue;
                const childPath = `${path}.${name}`;
                if (
                  typeof value.execute === "function" ||
                  value.isWebGPUDrawCommand === true
                ) {
                  snapshot.commands.variantCount++;
                  totals.variantCommands++;
                  if (
                    backend === "webgpu" &&
                    value.isWebGPUDrawCommand !== true
                  ) {
                    const violation = {
                      path: childPath,
                      owner: describeOwner(value.owner),
                    };
                    snapshot.commands.backendVariantViolations.push(
                      violation,
                    );
                    totals.backendVariantViolations++;
                  }
                  if (
                    value.owner !== expectedOwner ||
                    !selectedOwnerSet?.has(value.owner)
                  ) {
                    const violation = {
                      path: childPath,
                      parentOwner: describeOwner(expectedOwner),
                      owner: describeOwner(value.owner),
                    };
                    snapshot.commands.variantOwnerViolations.push(violation);
                    totals.variantOwnerViolations++;
                  }
                  visitDerived(value.derivedCommands, `${childPath}.derivedCommands`);
                } else {
                  visitDerived(value, childPath);
                }
              }
            };
            visitDerived(command?.derivedCommands, "derivedCommands");
          },
          beginTerrainCompilation(frameNumber, selectedTiles, textureBuckets) {
            beginCompilation(
              "render",
              frameNumber,
              selectedTiles,
              textureBuckets,
            );
          },
          endTerrainCompilation(frameNumber, commandList, commandListStart) {
            endCompilation(
              "render",
              frameNumber,
              commandList,
              commandListStart,
            );
          },
          beginTerrainPickCompilation(
            frameNumber,
            selectedTiles,
            textureBuckets,
          ) {
            beginCompilation(
              "pick",
              frameNumber,
              selectedTiles,
              textureBuckets,
            );
          },
          endTerrainPickCompilation(
            frameNumber,
            commandList,
            commandListStart,
          ) {
            endCompilation(
              "pick",
              frameNumber,
              commandList,
              commandListStart,
            );
          },
          snapshot() {
            return {
              schemaVersion: 2,
              enabled: true,
              attached: this.attached,
              derivedRefreshObserverAttached:
                this.derivedRefreshObserverAttached === true,
              backend,
              revisionRecords: [...revisionRecords],
              selectionSets: [...selectionSets],
              snapshots: [...snapshots],
              totals: { ...totals },
              truncated: false,
            };
          },
        };
      };
      const terrainOwnershipDiagnostics = apiInstrumentation
        ? createTerrainOwnershipDiagnostics(expectedRenderer)
        : undefined;
      const increment = (name, amount = 1) => {
        apiCounters[name] = (apiCounters[name] || 0) + amount;
      };
      const normalizeLabel = (label) => {
        const value = String(label || "").trim();
        return value ? value.slice(0, 240) : "(unlabeled)";
      };
      const normalizeOwnerLabel = (label) =>
        normalizeLabel(label)
          .replace(/\(\d+_\d+_\d+\)/g, "({tile})")
          .replace(/\b\d+_\d+_\d+\b/g, "{tile}")
          .replace(/\b(page|slot|frame)\s+\d+\b/gi, "$1 {n}");
      const incrementBucket = (
        buckets,
        cardinalities,
        counter,
        label,
        amount,
      ) => {
        let key = label;
        const bucket = (buckets[counter] ||= Object.create(null));
        if (!Object.prototype.hasOwnProperty.call(bucket, key)) {
          const cardinality = cardinalities[counter] || 0;
          if (cardinality >= maxLabelsPerCounter) {
            key = "(label-overflow)";
          } else {
            cardinalities[counter] = cardinality + 1;
          }
        }
        bucket[key] = (bucket[key] || 0) + amount;
      };
      const incrementLabel = (counter, label, amount = 1) => {
        const exactLabel = normalizeLabel(label);
        incrementBucket(
          apiCounterLabels,
          apiCounterLabelCardinality,
          counter,
          exactLabel,
          amount,
        );
        incrementBucket(
          apiCounterOwners,
          apiCounterOwnerCardinality,
          counter,
          normalizeOwnerLabel(exactLabel),
          amount,
        );
      };
      const byteLength = (value) => {
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
          return value.byteLength;
        }
        return 0;
      };
      const writeBufferByteLength = (data, dataOffset = 0, size) => {
        const bytesPerElement = ArrayBuffer.isView(data)
          ? data.BYTES_PER_ELEMENT || 1
          : 1;
        const totalElements = ArrayBuffer.isView(data)
          ? data.byteLength / bytesPerElement
          : data?.byteLength || 0;
        const elementCount = size ?? Math.max(0, totalElements - dataOffset);
        return Math.max(0, elementCount * bytesPerElement);
      };
      const textureBytes = (descriptor) => {
        const size = descriptor?.size;
        const width = Array.isArray(size) ? size[0] || 1 : size?.width || 1;
        const height = Array.isArray(size) ? size[1] || 1 : size?.height || 1;
        const depthOrLayers = Array.isArray(size)
          ? size[2] || 1
          : size?.depthOrArrayLayers || 1;
        const block =
          {
            r8unorm: [1, 1, 1],
            r16float: [1, 1, 2],
            rg8unorm: [1, 1, 2],
            rg16float: [1, 1, 4],
            rg32float: [1, 1, 8],
            rgba8unorm: [1, 1, 4],
            "rgba8unorm-srgb": [1, 1, 4],
            bgra8unorm: [1, 1, 4],
            "bgra8unorm-srgb": [1, 1, 4],
            rgba16float: [1, 1, 8],
            rgba32float: [1, 1, 16],
            depth16unorm: [1, 1, 2],
            depth24plus: [1, 1, 4],
            "depth24plus-stencil8": [1, 1, 4],
            depth32float: [1, 1, 4],
            "bc1-rgba-unorm": [4, 4, 8],
            "bc1-rgba-unorm-srgb": [4, 4, 8],
            "bc3-rgba-unorm": [4, 4, 16],
            "bc3-rgba-unorm-srgb": [4, 4, 16],
            "bc7-rgba-unorm": [4, 4, 16],
            "bc7-rgba-unorm-srgb": [4, 4, 16],
          }[descriptor?.format] || [1, 1, 4];
        const samples = descriptor?.sampleCount || 1;
        const mipLevels = descriptor?.mipLevelCount || 1;
        let bytes = 0;
        for (let level = 0; level < mipLevels; level++) {
          const levelDepthOrLayers =
            descriptor?.dimension === "3d"
              ? Math.max(1, depthOrLayers >> level)
              : depthOrLayers;
          bytes +=
            Math.ceil(Math.max(1, width >> level) / block[0]) *
            Math.ceil(Math.max(1, height >> level) / block[1]) *
            block[2] *
            levelDepthOrLayers;
        }
        return bytes * samples;
      };
      const textureRecords = new WeakMap();
      const textureViewRecords = new WeakMap();
      const destroyedBuffers = new WeakSet();
      const destroyedTextures = new WeakSet();
      const encoderLabels = new WeakMap();
      const commandBufferLabels = new WeakMap();
      const renderPassLabels = new WeakMap();
      const renderPassDrawCounts = new WeakMap();
      const computePassLabels = new WeakMap();
      const patch = (prototype, name, wrapper) => {
        if (!prototype || typeof prototype[name] !== "function") {
          patchFailures.push(name);
          return;
        }
        try {
          const original = prototype[name];
          prototype[name] = wrapper(original);
        } catch (error) {
          patchFailures.push(`${name}: ${String(error)}`);
        }
      };

      if (apiInstrumentation) {
        // These wrappers are installed only in explicitly instrumented benchmark
        // runs. Clean timing is the default because the wrappers themselves add
        // backend-dependent observer work to hot API calls.
        patch(
          globalThis.GPUDevice?.prototype,
          "createBuffer",
          (original) =>
            function (descriptor) {
              const buffer = original.call(this, descriptor);
              increment("webgpuBuffersCreated");
              incrementLabel("webgpuBuffersCreated", descriptor?.label);
              increment(
                "webgpuBufferBytesCreated",
                Number(descriptor?.size) || 0,
              );
              incrementLabel(
                "webgpuBufferBytesCreated",
                descriptor?.label,
                Number(descriptor?.size) || 0,
              );
              return buffer;
            },
        );
        patch(
          globalThis.GPUBuffer?.prototype,
          "destroy",
          (original) =>
            function (...args) {
              if (!destroyedBuffers.has(this)) {
                destroyedBuffers.add(this);
                increment("webgpuBuffersDestroyed");
                incrementLabel("webgpuBuffersDestroyed", this?.label);
              }
              return original.apply(this, args);
            },
        );
        patch(
          globalThis.GPUDevice?.prototype,
          "createTexture",
          (original) =>
            function (descriptor) {
              const texture = original.call(this, descriptor);
              increment("webgpuTexturesCreated");
              incrementLabel("webgpuTexturesCreated", descriptor?.label);
              const estimatedBytes = textureBytes(descriptor);
              increment("webgpuTextureEstimatedBytesCreated", estimatedBytes);
              // Campaign-9 compatibility alias. New consumers should prefer
              // the explicitly estimated name and instrumentation schema v2.
              increment("webgpuTextureBytesCreated", estimatedBytes);
              incrementLabel(
                "webgpuTextureEstimatedBytesCreated",
                descriptor?.label,
                estimatedBytes,
              );
              incrementLabel(
                "webgpuTextureBytesCreated",
                descriptor?.label,
                estimatedBytes,
              );
              textureRecords.set(texture, {
                label: normalizeLabel(descriptor?.label),
                format: descriptor?.format || "unknown",
                sampleCount: descriptor?.sampleCount || 1,
              });
              return texture;
            },
        );
        patch(
          globalThis.GPUTexture?.prototype,
          "createView",
          (original) =>
            function (descriptor) {
              const view = original.call(this, descriptor);
              const texture = textureRecords.get(this);
              textureViewRecords.set(view, {
                label: normalizeLabel(descriptor?.label || texture?.label),
                format: descriptor?.format || texture?.format || "unknown",
                sampleCount: texture?.sampleCount || 1,
              });
              return view;
            },
        );
        patch(
          globalThis.GPUTexture?.prototype,
          "destroy",
          (original) =>
            function (...args) {
              if (!destroyedTextures.has(this)) {
                destroyedTextures.add(this);
                increment("webgpuTexturesDestroyed");
                incrementLabel(
                  "webgpuTexturesDestroyed",
                  textureRecords.get(this)?.label || this?.label,
                );
              }
              return original.apply(this, args);
            },
        );
        for (const [method, counter] of [
          ["createBindGroup", "webgpuBindGroupsCreated"],
          ["createBindGroupLayout", "webgpuBindGroupLayoutsCreated"],
          ["createPipelineLayout", "webgpuPipelineLayoutsCreated"],
          ["createShaderModule", "webgpuShaderModulesCreated"],
          ["createRenderPipeline", "webgpuRenderPipelinesCreated"],
          ["createComputePipeline", "webgpuComputePipelinesCreated"],
          ["createRenderPipelineAsync", "webgpuAsyncRenderPipelinesCreated"],
          ["createComputePipelineAsync", "webgpuAsyncComputePipelinesCreated"],
        ]) {
          patch(
            globalThis.GPUDevice?.prototype,
            method,
            (original) =>
              function (...args) {
                increment(counter);
                incrementLabel(counter, args[0]?.label);
                return original.apply(this, args);
              },
          );
        }
        patch(
          globalThis.GPUDevice?.prototype,
          "createCommandEncoder",
          (original) =>
            function (descriptor) {
              increment("webgpuCommandEncodersCreated");
              const label = normalizeLabel(descriptor?.label);
              incrementLabel("webgpuCommandEncodersCreated", label);
              const encoder = original.call(this, descriptor);
              encoderLabels.set(encoder, label);
              return encoder;
            },
        );
        patch(
          globalThis.GPUCommandEncoder?.prototype,
          "beginRenderPass",
          (original) =>
            function (descriptor) {
              increment("webgpuRenderPassesBegun");
              const label = normalizeLabel(descriptor?.label);
              incrementLabel("webgpuRenderPassesBegun", label);
              const colors = (descriptor?.colorAttachments || []).map(
                (attachment) => {
                  if (!attachment) return "null";
                  const view = textureViewRecords.get(attachment.view);
                  const resolve = attachment.resolveTarget
                    ? textureViewRecords.get(attachment.resolveTarget)
                    : null;
                  return `${view?.format || "unknown"}@${view?.sampleCount || 1}:${attachment.loadOp || "?"}/${attachment.storeOp || "?"}${resolve ? `->${resolve.format}@${resolve.sampleCount}` : ""}`;
                },
              );
              const depthAttachment = descriptor?.depthStencilAttachment;
              const depthView = textureViewRecords.get(depthAttachment?.view);
              const depthTopology = depthAttachment
                ? `${depthView?.format || "unknown"}@${depthView?.sampleCount || 1}:d=${depthAttachment.depthLoadOp || "?"}/${depthAttachment.depthStoreOp || "?"}/ro=${depthAttachment.depthReadOnly === true ? 1 : 0};s=${depthAttachment.stencilLoadOp || "?"}/${depthAttachment.stencilStoreOp || "?"}/ro=${depthAttachment.stencilReadOnly === true ? 1 : 0}`
                : "none@1";
              const topology = `${label}|c=${colors.join(",") || "none"}|d=${depthTopology}`;
              incrementLabel("webgpuRenderPassTopologies", topology);
              const pass = original.call(this, descriptor);
              renderPassLabels.set(pass, label);
              renderPassDrawCounts.set(pass, 0);
              return pass;
            },
        );
        patch(
          globalThis.GPUCommandEncoder?.prototype,
          "beginComputePass",
          (original) =>
            function (descriptor) {
              increment("webgpuComputePassesBegun");
              const label = normalizeLabel(descriptor?.label);
              incrementLabel("webgpuComputePassesBegun", label);
              const pass = original.call(this, descriptor);
              computePassLabels.set(pass, label);
              return pass;
            },
        );
        for (const method of [
          "draw",
          "drawIndexed",
          "drawIndirect",
          "drawIndexedIndirect",
          "executeBundles",
        ]) {
          patch(
            globalThis.GPURenderPassEncoder?.prototype,
            method,
            (original) =>
              function (...args) {
                increment("webgpuRenderPassWorkOps");
                // Campaign-9 compatibility alias: executeBundles is one API
                // work op here, not a count of draws inside the bundle.
                increment("webgpuRenderPassDrawCalls");
                incrementLabel(
                  "webgpuRenderPassWorkOps",
                  renderPassLabels.get(this),
                );
                incrementLabel(
                  "webgpuRenderPassDrawCalls",
                  renderPassLabels.get(this),
                );
                renderPassDrawCounts.set(
                  this,
                  (renderPassDrawCounts.get(this) || 0) + 1,
                );
                return original.apply(this, args);
              },
          );
        }
        patch(
          globalThis.GPURenderPassEncoder?.prototype,
          "end",
          (original) =>
            function (...args) {
              const label = renderPassLabels.get(this);
              const drawOps = renderPassDrawCounts.get(this) || 0;
              increment("webgpuRenderPassesEnded");
              incrementLabel("webgpuRenderPassesEnded", label);
              incrementLabel(
                "webgpuRenderPassDrawOpsPerInstance",
                `${normalizeLabel(label)}|ops=${drawOps}`,
              );
              if (drawOps === 0) {
                increment("webgpuEmptyRenderPasses");
                incrementLabel("webgpuEmptyRenderPasses", label);
              }
              return original.apply(this, args);
            },
        );
        for (const method of ["dispatchWorkgroups", "dispatchWorkgroupsIndirect"]) {
          patch(
            globalThis.GPUComputePassEncoder?.prototype,
            method,
            (original) =>
              function (...args) {
                increment("webgpuComputeDispatches");
                incrementLabel(
                  "webgpuComputeDispatches",
                  computePassLabels.get(this),
                );
                return original.apply(this, args);
              },
          );
        }
        patch(
          globalThis.GPUCommandEncoder?.prototype,
          "finish",
          (original) =>
            function (descriptor) {
              increment("webgpuCommandBuffersFinished");
              const label = normalizeLabel(
                descriptor?.label || encoderLabels.get(this),
              );
              incrementLabel("webgpuCommandBuffersFinished", label);
              const commandBuffer = original.call(this, descriptor);
              commandBufferLabels.set(commandBuffer, label);
              return commandBuffer;
            },
        );
        patch(
          globalThis.GPUQueue?.prototype,
          "submit",
          (original) =>
            function (commandBuffers) {
              increment("webgpuQueueSubmits");
              incrementLabel("webgpuQueueSubmits", "physical-queue-submit");
              increment(
                "webgpuCommandBuffersSubmitted",
                commandBuffers?.length || 0,
              );
              for (const commandBuffer of commandBuffers || []) {
                incrementLabel(
                  "webgpuCommandBuffersSubmitted",
                  commandBufferLabels.get(commandBuffer) || commandBuffer?.label,
                );
              }
              return original.call(this, commandBuffers);
            },
        );
        patch(
          globalThis.GPUQueue?.prototype,
          "writeBuffer",
          (original) =>
            function (buffer, bufferOffset, data, dataOffset, size) {
              increment("webgpuWriteBufferCalls");
              incrementLabel("webgpuWriteBufferCalls", buffer?.label);
              incrementLabel(
                "webgpuWriteBufferOffsets",
                `${normalizeLabel(buffer?.label)}|offset=${bufferOffset ?? 0}`,
              );
              const bytes = writeBufferByteLength(data, dataOffset, size);
              increment(
                "webgpuWriteBufferBytes",
                bytes,
              );
              incrementLabel("webgpuWriteBufferBytes", buffer?.label, bytes);
              return original.call(
                this,
                buffer,
                bufferOffset,
                data,
                dataOffset,
                size,
              );
            },
        );
        patch(
          globalThis.GPUQueue?.prototype,
          "writeTexture",
          (original) =>
            function (destination, data, dataLayout, size) {
              increment("webgpuWriteTextureCalls");
              incrementLabel(
                "webgpuWriteTextureCalls",
                textureRecords.get(destination?.texture)?.label ||
                  destination?.texture?.label,
              );
              const bytes = byteLength(data);
              increment("webgpuWriteTextureSourceBytes", bytes);
              incrementLabel(
                "webgpuWriteTextureSourceBytes",
                textureRecords.get(destination?.texture)?.label ||
                  destination?.texture?.label,
                bytes,
              );
              return original.call(this, destination, data, dataLayout, size);
            },
        );
        patch(
          globalThis.GPUQueue?.prototype,
          "copyExternalImageToTexture",
          (original) =>
            function (source, destination, copySize) {
              increment("webgpuExternalImageCopies");
              incrementLabel(
                "webgpuExternalImageCopies",
                textureRecords.get(destination?.texture)?.label ||
                  destination?.texture?.label,
              );
              return original.call(this, source, destination, copySize);
            },
        );

        const patchWebGLPrototype = (
          prototype,
          prefix,
          ownMethodsOnly = false,
        ) => {
          const canPatch = (method) =>
            !ownMethodsOnly ||
            Object.prototype.hasOwnProperty.call(prototype, method);
          for (const [method, counter] of [
            ["createBuffer", `${prefix}BuffersCreated`],
            ["deleteBuffer", `${prefix}BuffersDeleted`],
            ["createTexture", `${prefix}TexturesCreated`],
            ["deleteTexture", `${prefix}TexturesDeleted`],
            ["createProgram", `${prefix}ProgramsCreated`],
            ["createShader", `${prefix}ShadersCreated`],
            ["drawArrays", `${prefix}DrawCalls`],
            ["drawElements", `${prefix}DrawCalls`],
          ]) {
            if (!canPatch(method)) continue;
            patch(
              prototype,
              method,
              (original) =>
                function (...args) {
                  increment(counter);
                  return original.apply(this, args);
                },
            );
          }
          if (canPatch("bufferData")) {
            patch(
              prototype,
              "bufferData",
              (original) =>
                function (target, sourceOrSize, ...args) {
                  increment(`${prefix}BufferDataCalls`);
                  increment(
                    `${prefix}BufferDataBytes`,
                    typeof sourceOrSize === "number"
                      ? sourceOrSize
                      : byteLength(sourceOrSize),
                  );
                  return original.call(this, target, sourceOrSize, ...args);
                },
            );
          }
          if (canPatch("bufferSubData")) {
            patch(
              prototype,
              "bufferSubData",
              (original) =>
                function (target, offset, source, ...args) {
                  increment(`${prefix}BufferSubDataCalls`);
                  increment(
                    `${prefix}BufferSubDataSourceBytes`,
                    byteLength(source),
                  );
                  return original.call(this, target, offset, source, ...args);
                },
            );
          }
          for (const method of ["texImage2D", "texSubImage2D"]) {
            if (!canPatch(method)) continue;
            patch(
              prototype,
              method,
              (original) =>
                function (...args) {
                  increment(`${prefix}${method}Calls`);
                  const source = args.at(-1);
                  increment(
                    `${prefix}${method}SourceBytes`,
                    byteLength(source),
                  );
                  return original.apply(this, args);
                },
            );
          }
        };
        patchWebGLPrototype(
          globalThis.WebGLRenderingContext?.prototype,
          "webgl",
        );
        // WebGL2 inherits most WebGL methods in Chromium. Patch only methods that
        // are own overrides to avoid counting one call twice through inheritance.
        if (
          globalThis.WebGL2RenderingContext?.prototype &&
          globalThis.WebGL2RenderingContext?.prototype !==
            globalThis.WebGLRenderingContext?.prototype
        ) {
          patchWebGLPrototype(
            globalThis.WebGL2RenderingContext.prototype,
            "webgl2",
            true,
          );
        }
      }

      globalThis.__perfCampaignDiagnostics = {
        longTasks: [],
        supportedEntryTypes:
          globalThis.PerformanceObserver?.supportedEntryTypes || [],
        apiCounters,
        apiCounterLabels,
        apiCounterOwners,
        globeLogicalCounters,
        terrainOwnershipDiagnostics,
        apiCounterPatchFailures: patchFailures,
      };
      if (
        globalThis.PerformanceObserver?.supportedEntryTypes?.includes(
          "longtask",
        )
      ) {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            globalThis.__perfCampaignDiagnostics.longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
            });
          }
        });
        observer.observe({ type: "longtask", buffered: true });
        globalThis.__perfCampaignDiagnostics.longTaskObserver = observer;
      }
    },
    { apiInstrumentation, expectedRenderer: renderer },
  );

  const url = buildPerformanceViewerUrl(manifest.baseUrl, renderer);
  const navigationStart = performance.now();
  let runRecord;
  try {
    await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
    await page.waitForFunction(
      () => globalThis.viewer?.scene?.context,
      undefined,
      {
        timeout: protocol.settleTimeoutMs,
      },
    );
    const rendererReady = performance.now();
    await page.waitForFunction(
      () => globalThis.viewer?.scene?._frameState?.frameNumber > 0,
      undefined,
      { timeout: protocol.settleTimeoutMs },
    );
    const firstObservedFrame = performance.now();
    const viewerBoot = await page.evaluate(async () => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = globalThis.viewer;
      const scene = viewer.scene;
      return {
        baseLayerPickerPresent: viewer.baseLayerPicker !== undefined,
        imageryLayerCount: scene.globe.imageryLayers.length,
        ellipsoidTerrain:
          scene.globe.terrainProvider instanceof C.EllipsoidTerrainProvider,
      };
    });

    const browserResult = await page.evaluate(
      async ({
        workloadDefinition,
        protocolDefinition,
        measurementDefinition,
        expectedRenderer,
        cameraTrack,
        apiInstrumentationEnabled,
        gpuTimestampsEnabled,
      }) => {
        const setupStart = performance.now();
        const C = await import("/Build/CesiumUnminified/index.js");
        const viewer = globalThis.viewer;
        const scene = viewer.scene;
        const context = scene.context;
        const deviceErrors = [];
        const onUncapturedDeviceError = (event) => {
          deviceErrors.push(
            String(
              event?.error?.message || event?.error || "unknown GPU error",
            ),
          );
        };
        context.device?.addEventListener?.(
          "uncapturederror",
          onUncapturedDeviceError,
        );
        if (workloadDefinition.contentProfile !== "local-grid-ellipsoid") {
          throw new Error(
            `unsupported content profile ${workloadDefinition.contentProfile}`,
          );
        }
        const actualRenderer = context.isWebGPU ? "webgpu" : "webgl";
        if (actualRenderer !== expectedRenderer) {
          throw new Error(
            `resolved renderer ${actualRenderer}, expected ${expectedRenderer}`,
          );
        }
        const cameraTrackEnabled =
          workloadDefinition.action === "camera-track" ||
          workloadDefinition.action === "camera-track-pick";
        const movingPickEnabled =
          workloadDefinition.action === "camera-track-pick";

        scene.requestRenderMode = false;
        viewer.resolutionScale = 1;
        viewer.clock.shouldAnimate = false;
        viewer.clock.currentTime = C.JulianDate.fromIso8601(
          protocolDefinition.fixedClock,
        );
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
        if (workloadDefinition.featureProfile === "deterministic-core") {
          // Explicit isolation profile for CPU/data-path micro-workloads. The
          // altitude flight uses default-globe and retains every default
          // renderer feature; nothing is disabled there merely for speed.
          scene.fog.enabled = false;
          if (scene.skyBox) {
            scene.skyBox.show = false;
          }
          if (scene.sun) {
            scene.sun.show = false;
          }
          if (scene.moon) {
            scene.moon.show = false;
          }
        }
        const featureState = {
          contentProfile: workloadDefinition.contentProfile,
          profile: workloadDefinition.featureProfile,
          fogEnabled: scene.fog?.enabled ?? null,
          skyBoxShown: scene.skyBox?.show ?? null,
          skyAtmosphereShown: scene.skyAtmosphere?.show ?? null,
          sunShown: scene.sun?.show ?? null,
          moonShown: scene.moon?.show ?? null,
          groundAtmosphereShown: scene.globe?.showGroundAtmosphere ?? null,
          globeLightingEnabled: scene.globe?.enableLighting ?? null,
          highDynamicRange: scene.highDynamicRange ?? null,
        };
        if (cameraTrackEnabled) {
          const firstWaypoint = cameraTrack[0];
          scene.camera.setView({
            destination: C.Cartesian3.fromDegrees(
              firstWaypoint.lon,
              firstWaypoint.lat,
              firstWaypoint.height,
            ),
            orientation: {
              heading: C.Math.toRadians(firstWaypoint.heading),
              pitch: C.Math.toRadians(firstWaypoint.pitch),
              roll: C.Math.toRadians(firstWaypoint.roll),
            },
          });
        } else {
          scene.camera.setView({
            destination: C.Cartesian3.fromDegrees(-122.4194, 37.7749, 900000),
            orientation: { heading: 0.1, pitch: -0.8, roll: 0 },
          });
        }

        const content = { collection: null, phase: 0 };
        const createPoints = () => {
          const collection = scene.primitives.add(
            new C.PointPrimitiveCollection(),
          );
          const side = 64;
          for (let index = 0; index < side * side; index++) {
            const x = index % side;
            const y = Math.floor(index / side);
            collection.add({
              position: C.Cartesian3.fromDegrees(
                -122.75 + x * 0.01,
                37.45 + y * 0.01,
                1000 + ((index * 37) % 5000),
              ),
              color: C.Color.fromBytes(
                80 + (index % 160),
                100 + ((index * 13) % 140),
                120 + ((index * 29) % 120),
                255,
              ),
              pixelSize: 4 + (index % 4),
            });
          }
          content.collection = collection;
          return collection;
        };
        if (workloadDefinition.content === "points-4096") createPoints();

        const waitFrames = async (count) => {
          let rendered = 0;
          await new Promise((resolveWait) => {
            const remove = scene.postRender.addEventListener(() => {
              rendered++;
              if (rendered >= count) {
                remove();
                resolveWait();
              }
            });
          });
        };
        const waitForMorph = async () => {
          const deadline =
            performance.now() + protocolDefinition.settleTimeoutMs;
          while (
            scene.mode === C.SceneMode.MORPHING &&
            performance.now() < deadline
          ) {
            await new Promise((resolveFrame) =>
              requestAnimationFrame(resolveFrame),
            );
          }
        };
        if (workloadDefinition.mode === "2d") {
          scene.morphTo2D(0);
          await waitForMorph();
        } else if (workloadDefinition.mode === "columbus") {
          scene.morphToColumbusView(0);
          await waitForMorph();
        } else if (scene.mode !== C.SceneMode.SCENE3D) {
          scene.morphTo3D(0);
          await waitForMorph();
        }

        let stable = 0;
        let settleFrames = 0;
        const settleDeadline =
          performance.now() + protocolDefinition.settleTimeoutMs;
        while (
          stable < protocolDefinition.settleStableFrames &&
          performance.now() < settleDeadline
        ) {
          await new Promise((resolveFrame) =>
            requestAnimationFrame(resolveFrame),
          );
          settleFrames++;
          stable = scene.globe.tilesLoaded ? stable + 1 : 0;
        }
        if (stable < protocolDefinition.settleStableFrames) {
          throw new Error(
            "deterministic scene did not reach tile-stable state",
          );
        }
        const setupToStableMs = performance.now() - setupStart;

        const actionCounters = {
          frames: 0,
          pointsMutated: 0,
          picks: 0,
          resizes: 0,
          morphs: 0,
          contentRecreates: 0,
          cameraTrackUpdates: 0,
        };
        const trackDurationMs =
          measurementDefinition.durationMs ??
          (measurementDefinition.frames * 1000) / 60;
        let trackEpochMs = performance.now();
        let currentTrackState = null;
        const currentPickState = {
          valid: false,
          sequence: 0,
          x: 0,
          y: 0,
          normalizedX: 0,
          normalizedY: 0,
          routeProgress: 0,
          publicCallCpuMs: 0,
        };
        let pickIssuanceEnabled = true;
        let recordPickTelemetry = false;
        let pickDrainStarted = false;
        let publicPickCallDepth = 0;
        let publicPickCpuSinceLastRender = 0;
        let asyncPickExecutionCpuSinceLastRender = 0;
        const measuredPickPromises = new Set();
        const movingPickTelemetry = {
          publicApi:
            typeof scene.pickHoverAsync === "function"
              ? "pickHoverAsync"
              : "pickAsync",
          publicCalls: 0,
          completedCalls: 0,
          completedBeforeDrain: 0,
          completedDuringDrain: 0,
          rejectedCalls: 0,
          hitCalls: 0,
          pendingCalls: 0,
          maxPendingCalls: 0,
          executionCount: 0,
          nestedExecutionCount: 0,
          asyncExecutionCount: 0,
          publicCallCpuMs: [],
          executionCpuMs: [],
          nestedExecutionCpuMs: [],
          asyncExecutionCpuMs: [],
          completionLatencyMs: [],
          errors: [],
          drainStatus: "not-started",
          drainElapsedMs: 0,
          executionCpuUnbucketedMs: 0,
        };
        const picking = scene._picking;
        const originalPickAsyncWithMode = picking?._pickAsyncWithMode;
        const drainHoverPick = async (timeoutMs) => {
          const startedAt = performance.now();
          let observedWork = false;
          while (true) {
            // The bounded hover scheduler can expose one current cycle and
            // one queued latest-wins cycle. Prefer the queued promise because
            // it assimilates the current predecessor and its own physical
            // readback; loop in case settlement callbacks rotate the slots.
            const pending =
              picking?._queuedHoverPick ?? picking?._inFlightHoverPick;
            if (!pending) {
              return {
                status: observedWork ? "drained" : "idle",
                elapsedMs: performance.now() - startedAt,
              };
            }
            observedWork = true;
            const remainingMs = timeoutMs - (performance.now() - startedAt);
            if (remainingMs <= 0) {
              return {
                status: "timeout",
                elapsedMs: performance.now() - startedAt,
              };
            }
            let timeoutId;
            const result = await Promise.race([
              Promise.resolve(pending).then(
                () => ({ status: "settled" }),
                (error) => ({
                  status: "rejected",
                  error: String(error?.stack || error),
                }),
              ),
              new Promise((resolveTimeout) => {
                timeoutId = setTimeout(
                  () => resolveTimeout({ status: "timeout" }),
                  remainingMs,
                );
              }),
            ]);
            clearTimeout(timeoutId);
            if (result.status !== "settled") {
              return {
                ...result,
                elapsedMs: performance.now() - startedAt,
              };
            }
          }
        };
        if (movingPickEnabled && originalPickAsyncWithMode) {
          picking._pickAsyncWithMode = function (...args) {
            const start = performance.now();
            try {
              return originalPickAsyncWithMode.apply(this, args);
            } finally {
              if (recordPickTelemetry) {
                const cpuMs = performance.now() - start;
                movingPickTelemetry.executionCount++;
                movingPickTelemetry.executionCpuMs.push(cpuMs);
                if (publicPickCallDepth > 0) {
                  // The public API duration already contains this initial
                  // physical pick execution. Keep it as a diagnostic but do
                  // not add it to the combined workload CPU twice.
                  movingPickTelemetry.nestedExecutionCount++;
                  movingPickTelemetry.nestedExecutionCpuMs.push(cpuMs);
                } else {
                  // A coalesced trailing hover execution resumes from a
                  // Promise continuation, outside Scene.render and outside
                  // the public call that requested it. Attribute that CPU to
                  // the next measured render interval explicitly.
                  movingPickTelemetry.asyncExecutionCount++;
                  movingPickTelemetry.asyncExecutionCpuMs.push(cpuMs);
                  asyncPickExecutionCpuSinceLastRender += cpuMs;
                }
              }
            }
          };
        }
        const trackDestination = new C.Cartesian3();
        const trackOrientation = { heading: 0, pitch: 0, roll: 0 };
        const trackView = {
          destination: trackDestination,
          orientation: trackOrientation,
        };
        // Reuse the cursor object so the benchmark measures renderer picking,
        // not one avoidable Cartesian2 allocation per animation frame.
        const pickPosition = new C.Cartesian2();
        const interpolateDegrees = (start, end, amount) => {
          const delta = ((((end - start) % 360) + 540) % 360) - 180;
          return start + delta * amount;
        };
        const applyCameraTrack = (timestamp) => {
          const segmentCount = cameraTrack.length - 1;
          const elapsedMs = Math.max(0, timestamp - trackEpochMs);
          const progress = Math.min(1, elapsedMs / trackDurationMs);
          const scaled = progress * segmentCount;
          const segmentIndex = Math.min(segmentCount - 1, Math.floor(scaled));
          const amount =
            segmentIndex === segmentCount - 1 && progress === 1
              ? 1
              : scaled - segmentIndex;
          const start = cameraTrack[segmentIndex];
          const end = cameraTrack[segmentIndex + 1];
          const lon = interpolateDegrees(start.lon, end.lon, amount);
          const lat = start.lat + (end.lat - start.lat) * amount;
          const height = Math.exp(
            Math.log(start.height) +
              (Math.log(end.height) - Math.log(start.height)) * amount,
          );
          C.Cartesian3.fromDegrees(
            lon,
            lat,
            height,
            undefined,
            trackDestination,
          );
          trackOrientation.heading = C.Math.toRadians(
            interpolateDegrees(start.heading, end.heading, amount),
          );
          trackOrientation.pitch = C.Math.toRadians(
            start.pitch + (end.pitch - start.pitch) * amount,
          );
          trackOrientation.roll = C.Math.toRadians(
            interpolateDegrees(start.roll, end.roll, amount),
          );
          scene.camera.setView(trackView);
          currentTrackState = {
            segmentIndex,
            segmentProgress: amount,
            routeProgress: progress,
            height,
          };
          actionCounters.cameraTrackUpdates++;
        };
        const applyMovingPick = () => {
          if (!pickIssuanceEnabled) {
            return;
          }
          const width = Math.max(1, scene.canvas.clientWidth);
          const height = Math.max(1, scene.canvas.clientHeight);
          const insetX = Math.min(
            Math.floor((width - 1) / 2),
            Math.max(2, Math.floor(width * 0.08)),
          );
          const insetY = Math.min(
            Math.floor((height - 1) / 2),
            Math.max(2, Math.floor(height * 0.08)),
          );
          const routeProgress = currentTrackState?.routeProgress ?? 0;
          // Relatively-prime cycle counts prevent a short repeated line while
          // guaranteeing both axes visit the viewport-safe edges.
          const xAmount =
            0.5 +
            0.5 * Math.sin(routeProgress * Math.PI * 2 * 3 - Math.PI / 2);
          const yAmount =
            0.5 +
            0.5 * Math.sin(routeProgress * Math.PI * 2 * 2 + Math.PI / 2);
          pickPosition.x = Math.round(
            insetX + (width - 1 - insetX * 2) * xAmount,
          );
          pickPosition.y = Math.round(
            insetY + (height - 1 - insetY * 2) * yAmount,
          );
          const issuedAt = performance.now();
          let pickPromise;
          try {
            publicPickCallDepth++;
            pickPromise =
              typeof scene.pickHoverAsync === "function"
                ? scene.pickHoverAsync(pickPosition, 3, 3)
                : scene.pickAsync(pickPosition, 3, 3);
          } catch (error) {
            if (recordPickTelemetry) {
              const publicCallCpuMs = performance.now() - issuedAt;
              movingPickTelemetry.publicCalls++;
              movingPickTelemetry.rejectedCalls++;
              movingPickTelemetry.publicCallCpuMs.push(publicCallCpuMs);
              publicPickCpuSinceLastRender += publicCallCpuMs;
              movingPickTelemetry.errors.push(String(error?.stack || error));
            }
            actionCounters.picks++;
            return;
          } finally {
            publicPickCallDepth--;
          }
          const publicCallCpuMs = performance.now() - issuedAt;
          currentPickState.valid = true;
          currentPickState.sequence++;
          currentPickState.x = pickPosition.x;
          currentPickState.y = pickPosition.y;
          currentPickState.normalizedX =
            pickPosition.x / Math.max(1, width - 1);
          currentPickState.normalizedY =
            pickPosition.y / Math.max(1, height - 1);
          currentPickState.routeProgress = routeProgress;
          currentPickState.publicCallCpuMs = publicCallCpuMs;
          if (recordPickTelemetry) {
            movingPickTelemetry.publicCalls++;
            movingPickTelemetry.publicCallCpuMs.push(publicCallCpuMs);
            publicPickCpuSinceLastRender += publicCallCpuMs;
            movingPickTelemetry.pendingCalls++;
            movingPickTelemetry.maxPendingCalls = Math.max(
              movingPickTelemetry.maxPendingCalls,
              movingPickTelemetry.pendingCalls,
            );
            let tracked;
            tracked = Promise.resolve(pickPromise)
              .then((result) => {
                movingPickTelemetry.completedCalls++;
                if (pickDrainStarted) {
                  movingPickTelemetry.completedDuringDrain++;
                } else {
                  movingPickTelemetry.completedBeforeDrain++;
                }
                if (
                  Array.isArray(result)
                    ? result.length > 0
                    : result !== undefined && result !== null
                ) {
                  movingPickTelemetry.hitCalls++;
                }
                movingPickTelemetry.completionLatencyMs.push(
                  performance.now() - issuedAt,
                );
              })
              .catch((error) => {
                movingPickTelemetry.rejectedCalls++;
                if (movingPickTelemetry.errors.length < 16) {
                  movingPickTelemetry.errors.push(
                    String(error?.stack || error),
                  );
                }
              })
              .finally(() => {
                movingPickTelemetry.pendingCalls--;
                measuredPickPromises.delete(tracked);
              });
            measuredPickPromises.add(tracked);
          }
          actionCounters.picks++;
        };
        let actionRunning = true;
        const applyAction = (timestamp) => {
          if (!actionRunning) return;
          const frame = actionCounters.frames++;
          const collection = content.collection;
          if (workloadDefinition.action === "orbit") {
            scene.camera.rotateRight(0.0015);
          } else if (cameraTrackEnabled) {
            applyCameraTrack(timestamp);
            if (movingPickEnabled) {
              applyMovingPick();
            }
          } else if (
            workloadDefinition.action === "sparse-point-mutation" ||
            workloadDefinition.action === "full-point-mutation"
          ) {
            const count = collection?.length || 0;
            const mutationCount =
              workloadDefinition.action === "full-point-mutation"
                ? count
                : Math.max(1, Math.floor(count * 0.01));
            for (let offset = 0; offset < mutationCount; offset++) {
              const index =
                workloadDefinition.action === "full-point-mutation"
                  ? offset
                  : (frame * mutationCount + offset) % count;
              const point = collection.get(index);
              const x = index % 64;
              const y = Math.floor(index / 64);
              point.position = C.Cartesian3.fromDegrees(
                -122.75 + x * 0.01,
                37.45 + y * 0.01,
                1000 + ((index * 37 + frame * 11) % 5000),
              );
            }
            actionCounters.pointsMutated += mutationCount;
          } else if (workloadDefinition.action === "pick-center") {
            pickPosition.x = Math.floor(scene.canvas.clientWidth / 2);
            pickPosition.y = Math.floor(scene.canvas.clientHeight / 2);
            scene.pick(pickPosition, 1, 1);
            actionCounters.picks++;
          } else if (
            workloadDefinition.action === "resize-cycle" &&
            frame > 0 &&
            frame % 30 === 0
          ) {
            const small = (frame / 30) % 2 === 1;
            viewer.container.style.width = small ? "1120px" : "1280px";
            viewer.container.style.height = small ? "640px" : "720px";
            viewer.resize();
            actionCounters.resizes++;
          } else if (
            workloadDefinition.action === "morph-roundtrip" &&
            frame > 0 &&
            frame % 120 === 0
          ) {
            const phase = (frame / 120) % 3;
            if (phase === 1) scene.morphToColumbusView(0);
            else if (phase === 2) scene.morphTo2D(0);
            else scene.morphTo3D(0);
            actionCounters.morphs++;
          } else if (
            workloadDefinition.action === "destroy-recreate-content" &&
            frame > 0 &&
            frame % 120 === 0
          ) {
            scene.primitives.remove(content.collection);
            createPoints();
            actionCounters.contentRecreates++;
          }
          requestAnimationFrame(applyAction);
        };

        requestAnimationFrame(applyAction);
        await waitFrames(protocolDefinition.warmupFrames);
        if (movingPickEnabled) {
          // Warmup generates real asynchronous hover requests. Stop issuing
          // before resetting the route and wait for that chain to finish so
          // no setup readback or trailing mini-frame leaks into the measured
          // CPU/GPU window.
          pickIssuanceEnabled = false;
          const warmupDrain = await drainHoverPick(
            protocolDefinition.settleTimeoutMs,
          );
          if (
            warmupDrain.status !== "idle" &&
            warmupDrain.status !== "drained"
          ) {
            throw new Error(
              `hover-pick warmup drain ${warmupDrain.status}: ${warmupDrain.error || "timeout"}`,
            );
          }
        }
        if (cameraTrackEnabled) {
          trackEpochMs = performance.now();
          applyCameraTrack(trackEpochMs);
          if (movingPickEnabled) {
            // Prime the correct route-start location outside the measurement
            // window; otherwise the first evidence sample can retain the last
            // cursor position from warmup because viewer/action rAF order is
            // intentionally not assumed.
            pickIssuanceEnabled = true;
            applyMovingPick();
            pickIssuanceEnabled = false;
            const primeDrain = await drainHoverPick(
              protocolDefinition.settleTimeoutMs,
            );
            if (
              primeDrain.status !== "idle" &&
              primeDrain.status !== "drained"
            ) {
              throw new Error(
                `hover-pick route-prime drain ${primeDrain.status}: ${primeDrain.error || "timeout"}`,
              );
            }
            // The setup readback consumed wall time while the camera was
            // intentionally stationary. Restart the time-parametrized route
            // so both renderers still measure the complete 20-second flight.
            trackEpochMs = performance.now();
            applyCameraTrack(trackEpochMs);
          }
        }
        if (movingPickEnabled) {
          publicPickCpuSinceLastRender = 0;
          asyncPickExecutionCpuSinceLastRender = 0;
          recordPickTelemetry = true;
          pickIssuanceEnabled = true;
        }
        const actionCountersStart = { ...actionCounters };
        const diagnostics = globalThis.__perfCampaignDiagnostics;
        const apiCountersStart = { ...diagnostics.apiCounters };
        const globeLogicalCountersStart = {
          ...(diagnostics.globeLogicalCounters || {}),
        };
        const copyGlobeBindGroupStats = () => {
          const stats =
            globalThis.__webgpuGlobeBindGroupCache?.getStats?.() || null;
          return stats
            ? {
                ...stats,
                byGroup: { ...(stats.byGroup || {}) },
                lastFrameByGroup: { ...(stats.lastFrameByGroup || {}) },
              }
            : null;
        };
        const globeBindGroupCacheStart = copyGlobeBindGroupStats();
        const copyCounterLabels = (labels) =>
          Object.fromEntries(
            Object.entries(labels || {}).map(([counter, bucket]) => [
              counter,
              { ...bucket },
            ]),
          );
        const apiCounterLabelsStart = copyCounterLabels(
          diagnostics.apiCounterLabels,
        );
        const apiCounterOwnersStart = copyCounterLabels(
          diagnostics.apiCounterOwners,
        );
        const memoryStart = globalThis.performance?.memory
          ? {
              usedJSHeapSize: globalThis.performance.memory.usedJSHeapSize,
              totalJSHeapSize: globalThis.performance.memory.totalJSHeapSize,
              jsHeapSizeLimit: globalThis.performance.memory.jsHeapSizeLimit,
            }
          : null;
        const statisticsStart = context.getRendererStatistics?.() || {};
        const frameStatisticsStart = context.getStatistics?.() || null;
        const timestampAvailable =
          actualRenderer === "webgpu" &&
          context.hasFeature?.("timestamp-query") === true;
        const timestampEnabled = timestampAvailable && gpuTimestampsEnabled;
        if (timestampEnabled) globalThis.CesiumDebug?.gpuPassCost?.(true);

        const trackEvidence = [];
        const removeActionEvidence =
          cameraTrackEnabled
            ? scene.postRender.addEventListener(() => {
                if (currentTrackState) {
                  const evidence = { ...currentTrackState };
                  if (movingPickEnabled && currentPickState.valid) {
                    evidence.x = currentPickState.x;
                    evidence.y = currentPickState.y;
                    evidence.normalizedX = currentPickState.normalizedX;
                    evidence.normalizedY = currentPickState.normalizedY;
                    evidence.pickRouteProgress =
                      currentPickState.routeProgress;
                    evidence.pickSequence = currentPickState.sequence;
                    evidence.pickPublicCallCpuMs =
                      publicPickCpuSinceLastRender;
                    evidence.pickAsyncExecutionCpuMs =
                      asyncPickExecutionCpuSinceLastRender;
                    evidence.pickCpuMs =
                      publicPickCpuSinceLastRender +
                      asyncPickExecutionCpuSinceLastRender;
                    // Each evidence row represents the out-of-render CPU
                    // accumulated since the preceding measured render.
                    publicPickCpuSinceLastRender = 0;
                    asyncPickExecutionCpuSinceLastRender = 0;
                  }
                  trackEvidence.push(evidence);
                }
              })
            : null;
        const traceFrameLimit =
          measurementDefinition.mode === "frames"
            ? measurementDefinition.frames
            : 100_000;
        const terrainOwnershipDiagnostics =
          diagnostics.terrainOwnershipDiagnostics;
        let originalSceneUpdateDerivedCommands;
        if (terrainOwnershipDiagnostics) {
          terrainOwnershipDiagnostics.reset();
          terrainOwnershipDiagnostics.attached = true;
          context._visibilityExecutionOwnershipDiagnostics =
            terrainOwnershipDiagnostics;
          originalSceneUpdateDerivedCommands = scene.updateDerivedCommands;
          scene.updateDerivedCommands = function (command) {
            const result = originalSceneUpdateDerivedCommands.call(this, command);
            terrainOwnershipDiagnostics.recordTerrainCommandAfterDerivedRefresh(
              command,
            );
            return result;
          };
          terrainOwnershipDiagnostics.derivedRefreshObserverAttached = true;
        }
        scene.beginPerformanceTrace(
          `${expectedRenderer}:${workloadDefinition.id}`,
          {
            frames: traceFrameLimit,
          },
        );
        const measurementStartMs = performance.now();
        if (measurementDefinition.mode === "duration") {
          await new Promise((resolveMeasurement) => {
            const remove = scene.postRender.addEventListener(() => {
              if (
                performance.now() - measurementStartMs >=
                  measurementDefinition.durationMs &&
                (!cameraTrackEnabled ||
                  currentTrackState?.routeProgress >= 0.999)
              ) {
                remove();
                resolveMeasurement();
              }
            });
          });
        } else {
          await waitFrames(measurementDefinition.frames);
        }

        // End all workload and counter windows at the measured-frame boundary.
        // Timestamp readback may continue below, but it must not add motion,
        // uploads, API calls, heap deltas, or long tasks to this measurement.
        const measurementEndMs = performance.now();
        actionRunning = false;
        pickIssuanceEnabled = false;
        removeActionEvidence?.();
        const measurementElapsedMs = measurementEndMs - measurementStartMs;
        const trace = scene.endPerformanceTrace();
        if (originalSceneUpdateDerivedCommands) {
          scene.updateDerivedCommands = originalSceneUpdateDerivedCommands;
        }
        context._visibilityExecutionOwnershipDiagnostics = undefined;
        const terrainSelectionAudit = terrainOwnershipDiagnostics?.snapshot() || {
          schemaVersion: 2,
          enabled: false,
          attached: false,
          backend: expectedRenderer,
          snapshots: [],
          totals: {},
          truncated: false,
        };
        const statisticsEnd = context.getRendererStatistics?.() || {};
        const frameStatisticsEnd = context.getStatistics?.() || null;
        const apiCountersEnd = { ...diagnostics.apiCounters };
        const apiCounterLabelsEnd = copyCounterLabels(
          diagnostics.apiCounterLabels,
        );
        const apiCounterOwnersEnd = copyCounterLabels(
          diagnostics.apiCounterOwners,
        );
        const globeLogicalCountersEnd = {
          ...(diagnostics.globeLogicalCounters || {}),
        };
        const globeBindGroupCacheEnd = copyGlobeBindGroupStats();
        const memoryEnd = globalThis.performance?.memory
          ? {
              usedJSHeapSize: globalThis.performance.memory.usedJSHeapSize,
              totalJSHeapSize: globalThis.performance.memory.totalJSHeapSize,
              jsHeapSizeLimit: globalThis.performance.memory.jsHeapSizeLimit,
            }
          : null;
        // A PerformanceObserver callback cannot deliver the long task that
        // contains this boundary until the current task yields. Freeze every
        // hot-path/API/logical/memory snapshot above, yield once, drain any
        // still-queued observer records, then select entries by their actual
        // start timestamp. This excludes a setup task delivered late and
        // includes the terminal measured task without extending other windows.
        await new Promise((resolveObserverBoundary) =>
          setTimeout(resolveObserverBoundary, 0),
        );
        for (const entry of
          diagnostics.longTaskObserver?.takeRecords?.() || []) {
          diagnostics.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
        const observedLongTasks = [...diagnostics.longTasks];
        const measuredActionCounters = Object.fromEntries(
          Object.keys(actionCounters).map((name) => [
            name,
            actionCounters[name] - (actionCountersStart[name] || 0),
          ]),
        );
        if (movingPickEnabled) {
          pickDrainStarted = true;
          const drainStartedAt = performance.now();
          const internalDrain = await drainHoverPick(
            protocolDefinition.settleTimeoutMs,
          );
          let publicDrainStatus = "drained";
          if (measuredPickPromises.size > 0) {
            let timeoutId;
            publicDrainStatus = await Promise.race([
              Promise.allSettled([...measuredPickPromises]).then(
                () => "drained",
              ),
              new Promise((resolveTimeout) => {
                timeoutId = setTimeout(
                  () => resolveTimeout("timeout"),
                  protocolDefinition.settleTimeoutMs,
                );
              }),
            ]);
            clearTimeout(timeoutId);
          }
          movingPickTelemetry.drainElapsedMs =
            performance.now() - drainStartedAt;
          movingPickTelemetry.drainStatus =
            internalDrain.status === "idle" ||
            internalDrain.status === "drained"
              ? publicDrainStatus
              : internalDrain.status;
          if (internalDrain.error && movingPickTelemetry.errors.length < 16) {
            movingPickTelemetry.errors.push(internalDrain.error);
          }
          movingPickTelemetry.executionCpuUnbucketedMs =
            publicPickCpuSinceLastRender +
            asyncPickExecutionCpuSinceLastRender;
          recordPickTelemetry = false;
          if (originalPickAsyncWithMode) {
            picking._pickAsyncWithMode = originalPickAsyncWithMode;
          }
        }
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, protocolDefinition.gpuReadbackDelayMs || 0),
        );
        const statisticsAfterReadback = context.getRendererStatistics?.() || {};
        if (timestampEnabled) globalThis.CesiumDebug?.gpuPassCost?.(false);
        context.device?.removeEventListener?.(
          "uncapturederror",
          onUncapturedDeviceError,
        );
        const adapterInfo = context.adapter?.info
          ? {
              vendor: context.adapter.info.vendor || "",
              architecture: context.adapter.info.architecture || "",
              device: context.adapter.info.device || "",
              description: context.adapter.info.description || "",
              subgroupMinSize: context.adapter.info.subgroupMinSize,
              subgroupMaxSize: context.adapter.info.subgroupMaxSize,
            }
          : null;
        return {
          actualRenderer,
          settleFrames,
          setupToStableMs,
          mode: scene.mode,
          timestampAvailable,
          timestampEnabled,
          featureState,
          deviceErrors,
          adapterInfo,
          enabledFeatures: context.enabledFeatures || [],
          trace,
          measurement: {
            ...measurementDefinition,
            elapsedMs: measurementElapsedMs,
            renderedFrames: trace?.samples?.length || 0,
          },
          trackEvidence,
          movingPickTelemetry: movingPickEnabled
            ? movingPickTelemetry
            : null,
          timestampResults: statisticsAfterReadback.timestamps || null,
          rendererStatisticsStart: statisticsStart,
          rendererStatisticsEnd: statisticsEnd,
          rendererStatisticsAfterReadback: statisticsAfterReadback,
          frameStatisticsStart,
          frameStatisticsEnd,
          apiCounters: {
            enabled: apiInstrumentationEnabled,
            patchFailures: diagnostics.apiCounterPatchFailures,
            start: apiCountersStart,
            end: apiCountersEnd,
            delta: Object.fromEntries(
              [
                ...new Set([
                  ...Object.keys(apiCountersStart),
                  ...Object.keys(apiCountersEnd),
                ]),
              ]
                .sort()
                .map((name) => [
                  name,
                  (apiCountersEnd[name] || 0) - (apiCountersStart[name] || 0),
                ]),
            ),
            labels: {
              limitPerCounter: 512,
              start: apiCounterLabelsStart,
              end: apiCounterLabelsEnd,
            },
            owners: {
              limitPerCounter: 512,
              start: apiCounterOwnersStart,
              end: apiCounterOwnersEnd,
            },
          },
          globeLogicalCounters: {
            enabled: apiInstrumentationEnabled,
            start: globeLogicalCountersStart,
            end: globeLogicalCountersEnd,
          },
          terrainSelectionAudit,
          globeBindGroupCache: {
            start: globeBindGroupCacheStart,
            end: globeBindGroupCacheEnd,
          },
          actionCounters: measuredActionCounters,
          actionCountersTotal: actionCounters,
          memory: {
            available: memoryStart !== null && memoryEnd !== null,
            start: memoryStart,
            end: memoryEnd,
            usedHeapDelta:
              memoryStart && memoryEnd
                ? memoryEnd.usedJSHeapSize - memoryStart.usedJSHeapSize
                : null,
          },
          longTasks: {
            available: diagnostics.supportedEntryTypes.includes("longtask"),
            windowStartMs: measurementStartMs,
            windowEndMs: measurementEndMs,
            observedCount: observedLongTasks.length,
            entries: observedLongTasks,
          },
          userAgent: navigator.userAgent,
        };
      },
      {
        workloadDefinition: workload,
        protocolDefinition: protocol,
        measurementDefinition: measurement,
        expectedRenderer: renderer,
        cameraTrack: GLOBE_CAMERA_TRACK,
        apiInstrumentationEnabled: apiInstrumentation,
        gpuTimestampsEnabled: gpuTimestamps,
      },
    );
    browserResult.apiCounters.labels.delta = diffCounterLabelSnapshots(
      browserResult.apiCounters.labels.start,
      browserResult.apiCounters.labels.end,
    );
    browserResult.apiCounters.owners.delta = diffCounterLabelSnapshots(
      browserResult.apiCounters.owners.start,
      browserResult.apiCounters.owners.end,
    );
    browserResult.globeLogicalCounters.delta = diffFlatCounterSnapshots(
      browserResult.globeLogicalCounters.start,
      browserResult.globeLogicalCounters.end,
    );
    const measuredLongTasks = selectLongTasksInMeasurementWindow(
      browserResult.longTasks.entries,
      browserResult.longTasks.windowStartMs,
      browserResult.longTasks.windowEndMs,
    );
    browserResult.longTasks.entries = measuredLongTasks;
    browserResult.longTasks.count = measuredLongTasks.length;
    browserResult.longTasks.totalMs = measuredLongTasks.reduce(
      (sum, entry) => sum + entry.duration,
      0,
    );
    browserResult.longTasks.maxMs = measuredLongTasks.reduce(
      (maximum, entry) => Math.max(maximum, entry.duration),
      0,
    );
    const terrainSelectionAudit = browserResult.terrainSelectionAudit;
    if (terrainSelectionAudit?.enabled) {
      const routeByFrame = new Map(
        (browserResult.trace?.samples || []).map((sample, index) => [
          sample.frameNumber,
          browserResult.trackEvidence?.[index] || null,
        ]),
      );
      const hashValues = (values) =>
        createHash("sha256").update(JSON.stringify(values)).digest("hex");
      for (const snapshot of terrainSelectionAudit.snapshots) {
        const selected =
          terrainSelectionAudit.selectionSets[snapshot.selectionSet] || [];
        snapshot.route = routeByFrame.get(snapshot.frameNumber) || null;
        snapshot.selectedSetHash = hashValues(
          selected.map((tile) => tile.id).sort(),
        );
        snapshot.selectedPortableRevisionHash = hashValues(
          selected
            .map(
              (tile) =>
                `${tile.id}|${terrainSelectionAudit.revisionRecords[tile.revisionRecord]?.portableRevision}`,
            )
            .sort(),
        );
        snapshot.selectedExactRevisionHash = hashValues(
          selected
            .map(
              (tile) =>
                `${tile.id}|${tile.tileObjectGeneration}|${tile.revision}`,
            )
            .sort(),
        );
        snapshot.emittedOwnerSetHash = hashValues(
          snapshot.commands.uniqueOwners.map((owner) => owner.id).sort(),
        );
      }
      const renderSnapshots = terrainSelectionAudit.snapshots.filter(
        (snapshot) => snapshot.phase === "render",
      );
      terrainSelectionAudit.routeCoverage = {
        segmentIndices: [
          ...new Set(
            renderSnapshots
              .map((snapshot) => snapshot.route?.segmentIndex)
              .filter(Number.isInteger),
          ),
        ].sort((left, right) => left - right),
        segmentsWithCommands: [
          ...new Set(
            renderSnapshots
              .filter((snapshot) => snapshot.commands.count > 0)
              .map((snapshot) => snapshot.route?.segmentIndex)
              .filter(Number.isInteger),
          ),
        ].sort((left, right) => left - right),
      };
    }
    browserResult.framePacing = summarizeFramePacing(
      browserResult.trace?.samples || [],
    );
    browserResult.trackMetrics =
      usesCameraTrack(workload.action)
        ? summarizeTrackMetrics(
            browserResult.trace?.samples || [],
            browserResult.trackEvidence || [],
            GLOBE_CAMERA_TRACK,
          )
        : null;
    browserResult.pickMetrics = usesMovingPick(workload.action)
      ? summarizeMovingPickMetrics(
          browserResult.trace?.samples || [],
          browserResult.trackEvidence || [],
          browserResult.movingPickTelemetry,
        )
      : null;
    browserResult.quality = assessPerformanceRunQuality(browserResult);
    const failures = [];
    if (browserResult.actualRenderer !== renderer) {
      failures.push(
        `resolved ${browserResult.actualRenderer}, expected ${renderer}`,
      );
    }
    if (pageErrors.length) failures.push(`${pageErrors.length} page errors`);
    if (externalRequests.length) {
      failures.push(`${externalRequests.length} external network requests`);
    }
    if (
      viewerBoot.baseLayerPickerPresent ||
      viewerBoot.imageryLayerCount !== 0 ||
      !viewerBoot.ellipsoidTerrain
    ) {
      failures.push("viewer did not resolve the deterministic offline boot");
    }
    if (browserResult.deviceErrors?.length) {
      failures.push(
        `${browserResult.deviceErrors.length} uncaptured GPU errors`,
      );
    }
    if (
      apiInstrumentation &&
      renderer === "webgpu" &&
      (browserResult.globeLogicalCounters.end.rendererInstancesAttached || 0) <
        1
    ) {
      failures.push(
        "instrumented WebGPU run did not attach the globe logical-counter sink",
      );
    }
    if (apiInstrumentation) {
      const audit = browserResult.terrainSelectionAudit;
      if (!audit?.enabled || !audit.attached) {
        failures.push("terrain selection ownership audit did not attach");
      } else {
        const totals = audit.totals || {};
        if (!audit.derivedRefreshObserverAttached) {
          failures.push(
            "terrain derived-command post-refresh ownership observer did not attach",
          );
        }
        if ((totals.pvsAdmittedCommands || 0) < 1) {
          failures.push(
            "terrain ownership audit observed no post-refresh executable commands",
          );
        }
        for (const [name, value] of [
          ["owner violations", totals.ownerViolations],
          ["derived variant owner violations", totals.variantOwnerViolations],
          ["backend variant violations", totals.backendVariantViolations],
          ["bucket missing tiles", totals.bucketMissing],
          ["bucket extra tiles", totals.bucketExtra],
          ["bucket duplicate tiles", totals.bucketDuplicates],
          ["duplicate selected tile objects", totals.duplicateSelectedObjects],
          ["incomplete snapshots", totals.incompleteSnapshots],
        ]) {
          if ((value || 0) !== 0) {
            failures.push(`terrain ownership audit found ${value} ${name}`);
          }
        }
        if (audit.truncated) {
          failures.push("terrain selection ownership audit was truncated");
        }
        if ((totals.renderSnapshots || 0) < 1) {
          failures.push("terrain selection ownership audit saw no render snapshots");
        }
        if (
          usesMovingPick(workload.action) &&
          (totals.pickSnapshots || 0) < 1
        ) {
          failures.push("terrain selection ownership audit saw no pick snapshots");
        }
        if (usesCameraTrack(workload.action)) {
          const expectedSegments = GLOBE_CAMERA_TRACK.length - 1;
          if (
            audit.routeCoverage?.segmentIndices.length !== expectedSegments ||
            audit.routeCoverage?.segmentsWithCommands.length !== expectedSegments
          ) {
            failures.push(
              "terrain selection ownership audit did not cover emitted terrain work in every camera segment",
            );
          }
        }
      }
    }
    if (
      measurement.mode === "frames" &&
      (browserResult.trace?.samples?.length || 0) !== measurement.frames
    ) {
      failures.push(
        `captured ${browserResult.trace?.samples?.length || 0}/${measurement.frames} trace frames`,
      );
    } else if (
      measurement.mode === "duration" &&
      (browserResult.trace?.samples?.length || 0) === 0
    ) {
      failures.push("captured zero trace frames during duration measurement");
    }
    if (
      usesCameraTrack(workload.action) &&
      (!browserResult.trackMetrics?.aligned ||
        !browserResult.trackMetrics?.coveredAllSegments ||
        !browserResult.trackMetrics?.completedRoute)
    ) {
      failures.push("camera track did not produce aligned full-route evidence");
    }
    if (
      usesMovingPick(workload.action) &&
      (!browserResult.pickMetrics?.aligned ||
        !browserResult.pickMetrics?.continuous ||
        !browserResult.pickMetrics?.cursorMovedAcrossViewport ||
        !browserResult.pickMetrics?.telemetryValid)
    ) {
      failures.push(
        "moving pick did not produce aligned continuous full-viewport fully-drained physical-pick evidence",
      );
    }
    runRecord = {
      result: failures.length ? "fail" : "pass",
      failures,
      renderer,
      workloadId: workload.id,
      repetition,
      requestedMeasurement: measurement,
      measuredFrames: browserResult.trace?.samples?.length || 0,
      startup: {
        navigationUrl: url.href,
        viewerBoot,
        navigationToRendererReadyMs: rendererReady - navigationStart,
        navigationToFirstObservedFrameMs: firstObservedFrame - navigationStart,
        navigationToStableMs:
          firstObservedFrame - navigationStart + browserResult.setupToStableMs,
        settleFrames: browserResult.settleFrames,
      },
      ...browserResult,
      featureFindings:
        usesCameraTrack(workload.action)
          ? {
              requiresPostPerformanceReview:
                pageErrors.length > 0 ||
                (browserResult.deviceErrors?.length || 0) > 0 ||
                consoleErrors.length > 0 ||
                externalRequests.length > 0,
              pageErrors,
              deviceErrors: browserResult.deviceErrors || [],
              consoleErrors: consoleErrors.slice(0, 25),
              externalRequests: externalRequests.slice(0, 25),
            }
          : null,
      pageErrors,
      consoleErrors: consoleErrors.slice(0, 25),
      externalRequests: externalRequests.slice(0, 25),
    };
    return runRecord;
  } catch (error) {
    runRecord = {
      result: "error",
      failures: [String(error?.stack || error)],
      renderer,
      workloadId: workload.id,
      repetition,
      requestedMeasurement: measurement,
      measuredFrames: 0,
      pageErrors,
      consoleErrors: consoleErrors.slice(0, 25),
      externalRequests: externalRequests.slice(0, 25),
    };
    return runRecord;
  } finally {
    // Do not make the browser GC a hidden part of the next repetition.
    // Waiting first keeps destroy() from racing the timestamp/readback tail;
    // Viewer.destroy() then drains Scene/WebGPUContext ownership and releases
    // the pooled GPUDevice lease before the isolated BrowserContext closes.
    let teardown;
    try {
      teardown = await page.evaluate(async () => {
        const viewer = globalThis.viewer;
        if (!viewer || viewer.isDestroyed?.()) {
          return {
            status: "already-destroyed",
            queue: "not-applicable",
            deviceLost: null,
          };
        }
        const device =
          viewer.scene?.context?.device ?? viewer.scene?.context?._device;
        const deviceLost = device?.lost;
        let queue = "not-applicable";
        try {
          if (device?.queue?.onSubmittedWorkDone) {
            queue = await Promise.race([
              device.queue.onSubmittedWorkDone().then(
                () => "resolved",
                () => "rejected",
              ),
              new Promise((resolveTimeout) =>
                setTimeout(() => resolveTimeout("timeout"), 5_000),
              ),
            ]);
          }
        } catch {
          queue = "rejected";
          // Device loss is already reported by the measured run. Teardown must
          // still release every remaining CPU-side ownership edge.
        }
        viewer.destroy();
        if (!deviceLost) {
          return { status: "destroyed", queue, deviceLost: null };
        }
        const loss = await Promise.race([
          deviceLost.then(
            (info) => ({
              status: "resolved",
              reason: info?.reason ?? null,
              message: info?.message ?? "",
            }),
            (error) => ({ status: "rejected", message: String(error) }),
          ),
          new Promise((resolveTimeout) =>
            setTimeout(
              () => resolveTimeout({ status: "timeout" }),
              2_000,
            ),
          ),
        ]);
        return { status: "destroyed", queue, deviceLost: loss };
      });
    } catch (error) {
      // A crashed/closed page has already relinquished its browser resources.
      teardown = { status: "page-unavailable", error: String(error) };
    }
    try {
      await browserContext.close();
    } catch (error) {
      teardown = {
        ...(teardown || {}),
        contextCloseError: String(error),
      };
    }
    if (runRecord) {
      runRecord.teardown = teardown;
      const teardownReasons = [];
      if (!teardown || teardown.status !== "destroyed") {
        teardownReasons.push(
          `viewer teardown ended with ${teardown?.status || "no status"}`,
        );
      }
      if (teardown?.queue === "timeout" || teardown?.queue === "rejected") {
        teardownReasons.push(`GPU queue drain ${teardown.queue}`);
      }
      if (
        renderer === "webgpu" &&
        (teardown?.deviceLost?.status !== "resolved" ||
          teardown.deviceLost.reason !== "destroyed")
      ) {
        teardownReasons.push(
          `WebGPU device destruction was not confirmed (${teardown?.deviceLost?.status || "missing"}/${teardown?.deviceLost?.reason || "no-reason"})`,
        );
      }
      if (teardownReasons.length) {
        runRecord.quality ??= {
          status: "invalid",
          validForAggregation: false,
          validForCpuAggregation: false,
          validForGpuAggregation: false,
          reasons: [],
          warnings: [],
        };
        runRecord.quality.status = "invalid";
        runRecord.quality.validForAggregation = false;
        runRecord.quality.validForCpuAggregation = false;
        runRecord.quality.validForGpuAggregation = false;
        runRecord.quality.reasons ??= [];
        runRecord.quality.reasons.push(...teardownReasons);
      }
    }
  }
}

const options = parseArguments(process.argv.slice(2));
const manifest = JSON.parse(await readFile(options.manifestPath, "utf8"));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.workloads)) {
  throw new Error("Unsupported or invalid performance workload manifest");
}
const bundlePath = resolve(
  repositoryDirectory,
  "Build",
  "CesiumUnminified",
  "Cesium.js",
);
const bundleIdentity = await fileIdentity(bundlePath);
const selectedWorkloads = options.workloads.length
  ? options.workloads.map((id) => {
      const workload = manifest.workloads.find((entry) => entry.id === id);
      if (!workload) throw new Error(`Unknown workload: ${id}`);
      return workload;
    })
  : manifest.workloads;
for (const workload of selectedWorkloads) {
  if (
    usesCameraTrack(workload.action) &&
    workload.trackId !== GLOBE_CAMERA_TRACK_ID
  ) {
    throw new Error(
      `Unsupported camera track ${workload.trackId}; expected ${GLOBE_CAMERA_TRACK_ID}`,
    );
  }
}
const renderers =
  options.renderer === "both" ? ["webgl", "webgpu"] : [options.renderer];
const repetitions = options.repetitions ?? manifest.protocol.repetitions;
const runSchedule = buildCounterbalancedSchedule(renderers, repetitions);

const report = {
  schemaVersion: 1,
  kind: "fork-performance-campaign",
  instrumentation: {
    schemaVersion: 2,
    compatibilityAliases: {
      webgpuTextureBytesCreated: "webgpuTextureEstimatedBytesCreated",
      webgpuRenderPassDrawCalls: "webgpuRenderPassWorkOps",
    },
  },
  generatedAt: new Date().toISOString(),
  manifest: {
    path: options.manifestPath,
    id: manifest.id,
    schemaVersion: manifest.schemaVersion,
  },
  source: {
    commit: command("git", ["rev-parse", "HEAD"]),
    branch: command("git", ["branch", "--show-current"]),
    dirty: Boolean(command("git", ["status", "--porcelain"])),
    runtimeBundle: {
      path: "Build/CesiumUnminified/Cesium.js",
      byteLength: bundleIdentity.byteLength,
      sha256: bundleIdentity.sha256,
    },
  },
  host: {
    platform: process.platform,
    release: os.release(),
    architecture: os.arch(),
    cpu: os.cpus()[0]?.model || null,
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
  },
  protocol: {
    ...manifest.protocol,
    repetitions,
    measuredFramesOverride: options.frames ?? null,
    apiInstrumentation: options.apiInstrumentation,
    gpuTimestamps: options.gpuTimestamps,
    browserIsolation: options.reuseBrowser
      ? "shared-process-isolated-contexts"
      : "fresh-process-per-run",
    selectedRenderers: renderers,
    selectedWorkloads: selectedWorkloads.map((workload) => workload.id),
    runSchedule,
    note: "CPU Scene.render and capability-available GPU timestamp metrics are primary; requestAnimationFrame wall time is diagnostic and may be display-limited.",
  },
  browserVersion: null,
  runs: [],
  aggregates: {},
  result: "pass",
};

let sharedBrowser;
try {
  if (options.reuseBrowser) {
    sharedBrowser = await launchCampaignBrowser(manifest, options);
    report.browserVersion = sharedBrowser.version();
  }
  for (const workload of selectedWorkloads) {
    const runsByRenderer = new Map(renderers.map((renderer) => [renderer, []]));
    for (const scheduled of runSchedule) {
      for (const renderer of scheduled.order) {
        const key = `${renderer}:${workload.id}`;
        console.error(
          `[performance] ${key} repetition ${scheduled.repetition}/${repetitions}`,
        );
        const frames =
          options.frames ??
          workload.measuredFrames ??
          manifest.protocol.measuredFrames;
        const measurement =
          options.frames === undefined &&
          Number.isFinite(workload.measuredSeconds)
            ? {
                mode: "duration",
                durationMs: workload.measuredSeconds * 1000,
                nominalFrames: frames,
              }
            : { mode: "frames", frames };
        const runBrowser =
          sharedBrowser ?? (await launchCampaignBrowser(manifest, options));
        report.browserVersion ??= runBrowser.version();
        let run;
        try {
          run = await runOne(
            runBrowser,
            manifest,
            renderer,
            workload,
            scheduled.repetition,
            measurement,
            options.apiInstrumentation,
            options.gpuTimestamps,
          );
        } finally {
          if (!sharedBrowser) {
            await runBrowser.close();
          }
        }
        report.runs.push(run);
        runsByRenderer.get(renderer).push(run);
        if (
          run.result !== "pass" ||
          run.quality?.validForAggregation === false
        ) {
          report.result = "fail";
        }
      }
    }
    for (const renderer of renderers) {
      const key = `${renderer}:${workload.id}`;
      const aggregate = aggregateRuns(runsByRenderer.get(renderer));
      report.aggregates[key] = aggregate;
      if (!aggregate.stable) {
        report.result = "fail";
      }
    }
  }
} finally {
  await sharedBrowser?.close();
}

await mkdir(dirname(options.output), { recursive: true });
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
console.error(`Wrote ${options.output}`);
if (report.result !== "pass") process.exitCode = 1;
