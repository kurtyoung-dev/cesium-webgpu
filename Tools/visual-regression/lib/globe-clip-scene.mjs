// globe-clip-scene.mjs — the cell body that stages a globe clipping-plane rig for `lib/capture.mjs`.
//
// @purpose Applies a globe rig's clipping-plane, G-buffer overlay, draped-vector and pick-point dials inside one capture cell, so a BEFORE/AFTER pair of `capture()` measures globe clipping, the globe's G-buffer normal and draped picking from rigs alone.
// @status ACTIVE
//
// WHY THIS EXISTS. `capture()` takes a rig and an injected `cellWork`, and the
// default cell body only navigates, waits and captures: it applies no dial. A
// globe clipping rig needs four things staged before its frame means anything
// (a solid offline globe, the plane collection in its local frame, the draped
// subjects, the camera), and a pick rig needs a reading after the frame. This
// module is that staging, read entirely from the rig, so the clipping and pick
// cells are rigs plus this one body rather than a bespoke probe per scene.
//
// WHAT A RIG DECLARES (all under `dials`):
//   terrain            "ellipsoid" pins the ellipsoid terrain provider.
//   baseColor          a `Cesium.Color` name for the solid globe.
//   imageryLayers      0 removes every imagery layer.
//   clippingPlanes     { originDegrees: [lon, lat, height], planes:
//                      [{ normal: [x, y, z], distance }], unionClippingRegions,
//                      edgeWidth, edgeColor } — the planes are authored in the
//                      east-north-up frame at `originDegrees`, which becomes
//                      the collection's `modelMatrix`.
//   useHardwareClipDistances   pinned onto a context that has the switch.
//   debugShowGBufferNormals    true turns on the scene's G-buffer normal
//                      overlay, which on WebGPU paints the eye-space slot-1
//                      normal n as (n + 1) / 2; WebGL has no G-buffer, so a
//                      rig with this dial declares WebGPU only.
//   drape              { polygons: [{ id, westSouthEastNorth, color }],
//                      polylines: [{ id, meridianDegrees, southNorthDegrees,
//                      widthPixels, color }] } — clamped, pickable collections.
//   pickPoints         [{ id, lonLatDegrees }] — read after the capture.
//
// WHAT IT RECORDS. Beside each cell's PNG it writes `<SLOT>.cell.json`: what
// the page reports it staged, every pick point's per-attempt answers with
// their counts and the stability `classifyPick` gives the modal answer, and
// the WebGPU error gate's harvest. It records measurements only; the reading
// against an expectation belongs to whoever runs the pair.
import fs from "node:fs";
import path from "node:path";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../../lib/webgpu-error-gate.mjs";
import {
  decideCellReadinessRefusal,
  describeReadiness,
  summariseCellReadiness,
  waitForCellReadiness,
} from "./capture.mjs";
import {
  PICK_ATTEMPTS,
  classifyPick,
} from "./pick-visibility-matrix-verdicts.mjs";
import { ProbeRefusal, throwForDecision } from "./probe-refusal.mjs";
import { captureElement, decideOriginRefusal } from "./probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./strip-viewer-widgets.mjs";

/**
 * Runs IN THE PAGE: stages the rig's globe, planes, drape and camera.
 *
 * @param {{camera: object|null, dials: object}} input The rig's camera and dials.
 * @returns {Promise<object>} What the page staged.
 */
async function stageGlobeClipScene({ camera, dials }) {
  const Cesium = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  scene.sun.show = false;
  scene.moon.show = false;
  scene.fog.enabled = false;
  scene.backgroundColor = Cesium.Color.BLACK.clone();
  scene.globe.showGroundAtmosphere = false;
  scene.globe.enableLighting = false;
  if (dials.terrain === "ellipsoid") {
    scene.globe.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  }
  if (dials.imageryLayers === 0) {
    viewer.imageryLayers.removeAll();
  }
  if (typeof dials.baseColor === "string") {
    scene.globe.baseColor = Cesium.Color[dials.baseColor].clone();
  }
  const context = scene.context;
  if (
    typeof dials.useHardwareClipDistances === "boolean" &&
    "useHardwareClipDistances" in context
  ) {
    context.useHardwareClipDistances = dials.useHardwareClipDistances;
  }
  if (dials.debugShowGBufferNormals === true) {
    scene.debugShowGBufferNormals = true;
  }

  const clip = dials.clippingPlanes;
  if (clip !== undefined && clip !== null) {
    const [lon, lat, height] = clip.originDegrees;
    scene.globe.clippingPlanes = new Cesium.ClippingPlaneCollection({
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
        Cesium.Cartesian3.fromDegrees(lon, lat, height),
      ),
      planes: clip.planes.map(
        (plane) =>
          new Cesium.ClippingPlane(
            new Cesium.Cartesian3(...plane.normal),
            plane.distance,
          ),
      ),
      unionClippingRegions: clip.unionClippingRegions === true,
      edgeWidth: clip.edgeWidth ?? 0,
      edgeColor: Cesium.Color[clip.edgeColor ?? "WHITE"].clone(),
    });
  }

  // Pick subjects by id, so the reading can name what a pick returned.
  const subjects = [];
  const drape = dials.drape ?? {};
  const ringAround = ([west, south, east, north]) => {
    // Densified along each side: a four-corner ring in degrees does not
    // follow the ellipsoid between its corners.
    const ring = [];
    const push = (lo, la) => {
      const p = Cesium.Cartesian3.fromDegrees(lo, la, 0.0);
      ring.push(p.x, p.y, p.z);
    };
    const steps = 24;
    for (let i = 0; i < steps; i++) {
      push(west + ((east - west) * i) / steps, south);
    }
    for (let i = 0; i < steps; i++) {
      push(east, south + ((north - south) * i) / steps);
    }
    for (let i = 0; i < steps; i++) {
      push(east - ((east - west) * i) / steps, north);
    }
    for (let i = 0; i < steps; i++) {
      push(west, north - ((north - south) * i) / steps);
    }
    return new Float64Array(ring);
  };
  const meridian = (lon, [south, north]) => {
    const line = [];
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const p = Cesium.Cartesian3.fromDegrees(
        lon,
        south + ((north - south) * i) / steps,
        0.0,
      );
      line.push(p.x, p.y, p.z);
    }
    return new Float64Array(line);
  };
  if (Array.isArray(drape.polygons) && drape.polygons.length > 0) {
    const polygons = new Cesium.BufferPolygonCollection({
      primitiveCountMax: drape.polygons.length,
      vertexCountMax: 128 * drape.polygons.length,
      holeCountMax: 1,
      triangleCountMax: 256 * drape.polygons.length,
      allowPicking: true,
      heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN,
    });
    drape.polygons.forEach((polygon, index) => {
      polygons.add({
        positions: ringAround(polygon.westSouthEastNorth),
        material: new Cesium.BufferPolygonMaterial({
          color: new Cesium.Color(...polygon.color),
        }),
      });
      subjects.push({ id: polygon.id, collection: polygons, index });
    });
    scene.primitives.add(polygons);
  }
  if (Array.isArray(drape.polylines) && drape.polylines.length > 0) {
    const polylines = new Cesium.BufferPolylineCollection({
      primitiveCountMax: drape.polylines.length,
      vertexCountMax: 128 * drape.polylines.length,
      allowPicking: true,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    });
    drape.polylines.forEach((polyline, index) => {
      polylines.add({
        positions: meridian(
          polyline.meridianDegrees,
          polyline.southNorthDegrees,
        ),
        material: new Cesium.BufferPolylineMaterial({
          color: new Cesium.Color(...polyline.color),
          width: polyline.widthPixels,
        }),
      });
      subjects.push({ id: polyline.id, collection: polylines, index });
    });
    scene.primitives.add(polylines);
  }
  window.__globeClipSceneSubjects = subjects;

  if (camera !== null && camera !== undefined) {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        camera.lon,
        camera.lat,
        camera.height,
      ),
      orientation: {
        heading: camera.heading ?? 0,
        pitch: camera.pitch ?? -Math.PI / 2,
        roll: camera.roll ?? 0,
      },
    });
  }
  return {
    rendererType: context.rendererType ?? null,
    useHardwareClipDistances:
      "useHardwareClipDistances" in context
        ? context.useHardwareClipDistances
        : null,
    debugShowGBufferNormals: scene.debugShowGBufferNormals === true,
    hasVertexNormals: scene.globe.terrainProvider?.hasVertexNormals ?? null,
    clippingPlaneCount: scene.globe.clippingPlanes?.length ?? 0,
    unionClippingRegions:
      scene.globe.clippingPlanes?.unionClippingRegions ?? null,
    subjects: subjects.map((subject) => subject.id),
  };
}

/**
 * Runs IN THE PAGE: picks each declared point `attempts` times and names what
 * every attempt returned (a subject id, "globe", "other" or "none").
 *
 * @param {{points: object[], attempts: number}} input The points and count.
 * @returns {Promise<object[]>} One record per point.
 */
async function readGlobeClipPicks({ points, attempts }) {
  const Cesium = await import("/Build/CesiumUnminified/index.js");
  const scene = window.viewer.scene;
  const subjects = window.__globeClipSceneSubjects ?? [];
  const nameOf = (picked) => {
    if (picked === undefined || picked === null) {
      return "none";
    }
    for (const subject of subjects) {
      if (
        picked.collection === subject.collection &&
        picked.index === subject.index
      ) {
        return subject.id;
      }
    }
    if (picked.primitive === scene.globe || picked.id === scene.globe) {
      return "globe";
    }
    return "other";
  };
  const records = [];
  for (const point of points) {
    const [lon, lat] = point.lonLatDegrees;
    const screen = scene.cartesianToCanvasCoordinates(
      Cesium.Cartesian3.fromDegrees(lon, lat, 0.0),
    );
    if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) {
      records.push({ id: point.id, resolved: false, why: "no canvas point" });
      continue;
    }
    const position = new Cesium.Cartesian2(
      Math.round(screen.x),
      Math.round(screen.y),
    );
    const answers = [];
    for (let i = 0; i < attempts; i++) {
      scene.render();
      // pickAsync where the scene has it: a synchronous WebGPU pick leaves
      // the pick buffer mapped and spoils the next one.
      const picked =
        typeof scene.pickAsync === "function"
          ? await scene.pickAsync(position)
          : scene.pick(position);
      answers.push(nameOf(picked));
    }
    records.push({
      id: point.id,
      resolved: true,
      x: position.x,
      y: position.y,
      answers,
    });
  }
  return records;
}

/**
 * Counts each point's answers and rates the modal one with `classifyPick`.
 * Pure, so it can be driven without a browser.
 *
 * @param {object[]} records The page's per-point records.
 * @param {number} attempts Attempts per point.
 * @returns {object[]} Per point: counts, the modal answer and its stability.
 */
export function summariseGlobeClipPicks(records, attempts) {
  return records.map((record) => {
    if (record.resolved !== true) {
      return { ...record, modal: null, stability: "indeterminate" };
    }
    const counts = {};
    for (const answer of record.answers) {
      counts[answer] = (counts[answer] ?? 0) + 1;
    }
    let modal = null;
    for (const [answer, count] of Object.entries(counts)) {
      if (modal === null || count > counts[modal]) {
        modal = answer;
      }
    }
    return {
      ...record,
      counts,
      modal,
      stability: classifyPick(modal === null ? 0 : counts[modal], attempts),
    };
  });
}

/**
 * A `cellWork` for `capture()` that stages each cell's rig from its dials.
 *
 * @param {object[]} rigs The rigs the capture was given; cells name theirs by id.
 * @returns {Function} `(cell, {browser, now, scope}) => Promise<object>`.
 */
export function makeGlobeClipCellWork(rigs) {
  const byId = new Map(rigs.map((rig) => [rig.id, rig]));
  return async function globeClipCellWork(cell, { browser, now, scope }) {
    const rig = byId.get(cell.rigId);
    if (rig === undefined) {
      throw new ProbeRefusal(
        "globe-clip-rig-unknown",
        `cell ${cell.key} names rig ${cell.rigId}, which this cell body was not given`,
        { rigId: cell.rigId },
      );
    }
    const work = async (context) => {
      const page = await context.newPage();
      await page.addInitScript(errorGateInit);
      await page.goto(cell.url, {
        waitUntil: "load",
        timeout: cell.navigationTimeoutMs,
      });
      throwForDecision(
        decideOriginRefusal({
          requestedOrigin: cell.origin,
          actualUrl: page.url(),
          label: cell.key,
        }),
        `cell ${cell.key} navigated off the origin it was pointed at`,
      );
      await page.waitForFunction(() => !!window.viewer?.scene, null, {
        timeout: cell.readinessTimeoutMs,
      });
      await armWebGPUDevices(page);
      const staged = await page.evaluate(stageGlobeClipScene, {
        camera: rig.camera ?? null,
        dials: rig.dials ?? {},
      });

      const readiness = await waitForCellReadiness(page, cell, now);
      throwForDecision(
        decideCellReadinessRefusal(readiness),
        `cell ${cell.key} was not ready to capture: ${describeReadiness(readiness)}`,
      );

      const chrome = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
      if (!Array.isArray(chrome?.leftovers) || chrome.leftovers.length > 0) {
        throw new ProbeRefusal(
          "capture-chrome-over-canvas",
          `cell ${cell.key}: elements were still stacked over the scene canvas after the strip (${chrome?.leftovers?.join(", ") ?? "no strip report"})`,
          { chrome: chrome ?? null, cell: cell.key },
        );
      }
      const captured = await captureElement({
        page,
        selector: cell.selector,
        name: cell.captureName,
        outputDirectory: cell.outputDirectory,
      });

      const points = rig.dials?.pickPoints ?? [];
      const picks =
        points.length > 0
          ? summariseGlobeClipPicks(
              await page.evaluate(readGlobeClipPicks, {
                points,
                attempts: PICK_ATTEMPTS,
              }),
              PICK_ATTEMPTS,
            )
          : [];
      const gate = await collectGateErrors(page);

      fs.mkdirSync(cell.outputDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(cell.outputDirectory, `${cell.captureName}.cell.json`),
        `${JSON.stringify(
          {
            rigId: cell.rigId,
            renderer: cell.renderer,
            slot: cell.slot,
            staged,
            chromeRemoved: chrome.removed,
            pickAttempts: PICK_ATTEMPTS,
            picks,
            gate,
          },
          null,
          2,
        )}\n`,
      );
      return {
        buffer: captured.buffer,
        byteLength: captured.byteLength,
        sha256: captured.sha256,
        matchCount: captured.matchCount,
        url: page.url(),
        capturedAt: new Date(now()).toISOString(),
        readiness: summariseCellReadiness(readiness),
      };
    };

    const newContext = () =>
      browser.newContext({ viewport: { ...cell.viewport } });
    if (scope === undefined || scope === null) {
      const context = await newContext();
      try {
        return await work(context);
      } finally {
        await context.close();
      }
    }
    let closed = false;
    return scope.withResource(
      {
        kind: "context",
        label: `globe clip context ${cell.key}`,
        parent: browser,
        acquire: newContext,
        close: async (context) => {
          await context.close();
          closed = true;
        },
        isClosed: () => closed,
      },
      work,
    );
  };
}
