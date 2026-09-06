// pick-visibility-matrix-page.mjs — `AR-837`'s in-page capture, as its own module.
// @purpose The two page.evaluate bodies of probe-pick-visibility-matrix.mjs — the matrix scene and the AR-M30 snap grid — kept out of the probe so neither file exceeds the fork's 1,000-line rule, and so the browser half has one home.
// @status ACTIVE
//
// WHY THIS IS A SEPARATE MODULE. Two reasons, and only the first is the size
// rule. The probe and this file have genuinely different audiences: the probe
// is what runs in Node (options, refusals, page lifecycle, verdicts, receipt),
// and everything here runs in the BROWSER, inside a `page.evaluate` callback
// that closes over nothing but its own serialized `cfg`. That constraint is
// load-bearing — a callback that captured a module binding would be a
// `ReferenceError` at runtime and nothing in Node would catch it — so keeping
// the browser half in one file makes the constraint reviewable in one place.
//
// This module imports NOTHING, which is deliberate: `probe-fleet-contract.spec.mjs`
// scans `lib/` for the prohibited live-canvas reader exactly as it scans probes
// (`prohibitedReaderFiles` = probes + `lib/*.mjs`), so moving the capture here
// does not move it out of that guard's reach. The canonical
// `same-task-capture` block below is pinned by
// `pick-visibility-matrix-verdicts.spec.mjs` against
// `lib/same-task-capture.mjs`'s own text.

/**
 * Builds the matrix scene and measures every item at both
 * `disableDepthTestDistance` legs. Runs inside the page.
 *
 * @param {object} page Playwright page.
 * @param {object} config Scene configuration for this leg.
 * @returns {Promise<object>} Per-leg, per-item measurements plus the control.
 */
export async function captureMatrix(page, config) {
  return page.evaluate(async (cfg) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const s = v.scene;

    // The log-depth leg is set BEFORE the settle so the dirty flag's rebuild
    // happens inside it rather than inside the measurement.
    s.logarithmicDepthBuffer = cfg.logDepth;

    v.terrainProvider = new C.EllipsoidTerrainProvider();
    try {
      v.imageryLayers.removeAll();
    } catch {
      // An app variant without imagery layers is already in the state we want.
    }
    s.globe.show = true;
    s.globe.baseColor = C.Color.fromBytes(30, 30, 30, 255);
    s.globe.showGroundAtmosphere = false;
    s.globe.enableLighting = false;
    // LOAD-BEARING, not scene tidying. `Scene.js:4037-4041` sets
    // `clearGlobeDepth = !globe.depthTestAgainstTerrain`, and
    // `SceneRenderer.js:852-856` then CLEARS the globe's depth after the globe
    // pass — in the PICK pass as well as the colour pass — leaving only the
    // depth plane, whose quad is the HORIZON plane (`DepthPlane.js:185-230`;
    // `DepthPlaneFS.glsl` discards, it never writes a surface depth). At this
    // camera that plane sits ~376 km BELOW the surface, ~776 km from the eye,
    // while the subjects sit 60 km below the surface at ~464 km — so at
    // `false` nothing would occlude them and every `ddtd = 0` cell would
    // measure a scene with no terrain in it. `true` keeps globe depth in both
    // targets, which is what makes the subjects "behind terrain" and what
    // `AR-001`'s pick fragment loses less-equal against.
    s.globe.depthTestAgainstTerrain = true;
    s.skyBox.show = false;
    s.sun.show = false;
    s.moon.show = false;
    s.skyAtmosphere.show = false;
    s.fog.enabled = false;
    s.highDynamicRange = false;
    s.backgroundColor = C.Color.BLACK;

    v.entities.removeAll();
    v.dataSources.removeAll();
    const prims = s.primitives;
    const collectionNames = [
      "BillboardCollection",
      "LabelCollection",
      "PointPrimitiveCollection",
      "PolylineCollection",
    ];
    for (let i = prims.length - 1; i >= 0; i--) {
      const p = prims.get(i);
      if (p && p.constructor && collectionNames.includes(p.constructor.name)) {
        prims.remove(p);
      }
    }

    const swatch = document.createElement("canvas");
    swatch.width = 32;
    swatch.height = 32;
    const swatchContext = swatch.getContext("2d");
    swatchContext.fillStyle = "rgb(255,0,0)";
    swatchContext.fillRect(0, 0, 32, 32);

    const billboards = prims.add(new C.BillboardCollection());
    const labels = prims.add(new C.LabelCollection());
    const points = prims.add(new C.PointPrimitiveCollection());
    const polylines = prims.add(new C.PolylineCollection());

    // `coarseDepthTestDistance` defaults to `Ellipsoid.default.minimumRadius /
    // 10` (~637 km) and switches billboards and labels BEYOND that distance to
    // an ellipsoid-approximation depth test instead of the depth buffer. This
    // scene sits at ~460 km, comfortably inside the default, but the margin is
    // an unstated dependency on an ellipsoid constant. Setting it to infinity
    // ("never applied") pins every cell in the full-depth-buffer regime — the
    // one `AR-001` is about — on both backends, so a backend that implements
    // the coarse path differently cannot surface here as an `AR-001` result.
    // (`threePointDepthTestDistance` needs no pin: it applies only to
    // `HeightReference.CLAMP_TO_*`, and every subject here is `NONE`.)
    billboards.coarseDepthTestDistance = Number.POSITIVE_INFINITY;
    labels.coarseDepthTestDistance = Number.POSITIVE_INFINITY;

    const at = (dLon, dLat, height) =>
      C.Cartesian3.fromDegrees(cfg.lon + dLon, cfg.lat + dLat, height);

    const billboard = billboards.add({
      id: "matrix-billboard",
      position: at(
        cfg.layout.billboard.dLon,
        cfg.layout.billboard.dLat,
        cfg.itemHeight,
      ),
      image: swatch,
      width: 32,
      height: 32,
      disableDepthTestDistance: 0.0,
    });
    const label = labels.add({
      id: "matrix-label",
      position: at(
        cfg.layout.label.dLon,
        cfg.layout.label.dLat,
        cfg.itemHeight,
      ),
      text: "AR837",
      font: "bold 22px sans-serif",
      fillColor: C.Color.BLACK,
      outlineWidth: 0,
      style: C.LabelStyle.FILL,
      showBackground: true,
      backgroundColor: C.Color.fromBytes(0, 255, 255, 255),
      backgroundPadding: new C.Cartesian2(16, 12),
      horizontalOrigin: C.HorizontalOrigin.CENTER,
      verticalOrigin: C.VerticalOrigin.CENTER,
      disableDepthTestDistance: 0.0,
    });
    const point = points.add({
      id: "matrix-point",
      position: at(
        cfg.layout.point.dLon,
        cfg.layout.point.dLat,
        cfg.itemHeight,
      ),
      pixelSize: 30,
      color: C.Color.fromBytes(255, 255, 0, 255),
      outlineWidth: 0,
      disableDepthTestDistance: 0.0,
    });
    // The control shares the point collection deliberately: when a subject
    // raises DISABLE_DEPTH_DISTANCE the whole collection recompiles with the
    // define, and the control — which sets no per-instance value and meets a
    // frame minimum of 0 — must still be depth-tested. If the define alone
    // lifted primitives to the near plane, the control would say so.
    const control = points.add({
      id: "matrix-control",
      position: at(0.0, 0.0, cfg.controlHeight),
      pixelSize: 30,
      color: C.Color.fromBytes(0, 255, 0, 255),
      outlineWidth: 0,
    });
    const polyline = polylines.add({
      id: "matrix-polyline",
      positions: [
        at(
          cfg.layout.polyline.dLon - 0.35,
          cfg.layout.polyline.dLat,
          cfg.itemHeight,
        ),
        at(
          cfg.layout.polyline.dLon + 0.35,
          cfg.layout.polyline.dLat,
          cfg.itemHeight,
        ),
      ],
      width: 14,
      material: C.Material.fromType("Color", {
        color: C.Color.fromBytes(255, 0, 255, 255),
      }),
    });
    polyline.disableDepthTestDistance = 0.0;

    const samplePositions = {
      billboard: billboard.position,
      label: label.position,
      point: point.position,
      polyline: at(
        cfg.layout.polyline.dLon,
        cfg.layout.polyline.dLat,
        cfg.itemHeight,
      ),
    };

    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(cfg.lon, cfg.lat, cfg.cameraHeight),
      orientation: { heading: 0.0, pitch: -Math.PI / 2.0, roll: 0.0 },
    });

    // ==BEGIN same-task-capture==
    const makeSameTaskCapture = (scene, canvas, timeFn) => {
      const renderNow = () => scene.render(timeFn());
      const tmp = document.createElement("canvas");
      const ctx = tmp.getContext("2d", { willReadFrequently: true });
      const decodeSnapshot = async (snapshot) => {
        const image = new Image();
        const loaded = new Promise((resolve, reject) => {
          const decodeFailed = "same-task PNG decode failed";
          image.onload = resolve;
          image.onerror = () => reject(new Error(decodeFailed));
        });
        image.src = snapshot;
        await loaded;
        tmp.width = image.naturalWidth;
        tmp.height = image.naturalHeight;
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, tmp.width, tmp.height);
      };
      const snapshotNow = () => {
        renderNow();
        return canvas.toDataURL("image/png");
      };
      const captureNow = () => {
        const snapshot = snapshotNow();
        return decodeSnapshot(snapshot);
      };
      const grabNow = snapshotNow;
      const settleThen = async (maxFrames, done, capture) => {
        let settled = false;
        for (let k = 0; k < maxFrames; k++) {
          if (typeof done === "function" && done() === true) {
            settled = true;
            break;
          }
          renderNow();
          await new Promise((r) => requestAnimationFrame(r));
        }
        if (!settled && typeof done === "function") {
          settled = done() === true;
        }
        const hasCapture = typeof capture === "function";
        const result = hasCapture ? await capture() : undefined;
        return { settled, result };
      };
      return { renderNow, captureNow, grabNow, settleThen };
    };
    // ==END same-task-capture==

    // Every pixel measurement below goes through `captureNow`: it renders and
    // freezes a PNG in ONE task, then decodes that immutable snapshot. A
    // `drawImage` of the live scene canvas after a yield reads a cleared WebGL
    // drawing buffer or an invalidated WebGPU swap-chain texture, and this
    // probe's whole finding is "the item is not there" — the one claim that
    // failure mode manufactures for free.
    const { renderNow, captureNow } = makeSameTaskCapture(
      s,
      s.canvas,
      () => undefined,
    );

    const renderN = async (n) => {
      for (let i = 0; i < n; i++) {
        s.requestRender();
        renderNow();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    };

    // Six mutually exclusive hue classifiers over a dark-grey globe and a
    // black background, so no item's disappearance can be masked by another's.
    const hues = {
      billboard: (r, g, b) => r > 150 && g < 80 && b < 80,
      label: (r, g, b) => r < 80 && g > 150 && b > 150,
      point: (r, g, b) => r > 150 && g > 150 && b < 80,
      polyline: (r, g, b) => r > 150 && g < 80 && b > 150,
      control: (r, g, b) => r < 80 && g > 150 && b < 80,
    };

    // Observed, never asserted. The label's `visible` cell counts CYAN, which
    // is the BACKGROUND billboard, drawn by `BillboardCollection.wgsl`; its
    // glyphs are drawn by `BillboardCollectionSDF.wgsl`, a different one of the
    // five shaders Batch 1439 changed. An SDF-only regression would leave the
    // cyan count green — healthier, even, since fewer black glyph pixels means
    // more background — so the glyph coverage is measured beside it and
    // published as `glyphPixels`. It carries no verdict: `AR-001`'s per-shader
    // mutant clause is discharged by `collection-depth-override-law.spec.mjs`,
    // not here, and a threshold invented for glyph coverage would be a bar this
    // lane never measured.
    const labelGlyphHue = (r, g, b) => r < 60 && g < 60 && b < 60;

    const readFrame = async () => {
      const snapshot = await captureNow();
      const canvas = s.canvas;
      return {
        pixels: snapshot.data,
        width: snapshot.width,
        height: snapshot.height,
        scaleX: snapshot.width / Math.max(canvas.clientWidth, 1),
        scaleY: snapshot.height / Math.max(canvas.clientHeight, 1),
      };
    };

    const countHue = (frame, windowPosition, test) => {
      const cx = Math.round(windowPosition.x * frame.scaleX);
      const cy = Math.round(windowPosition.y * frame.scaleY);
      const half = cfg.sampleHalfWidth;
      let count = 0;
      for (let y = cy - half; y <= cy + half; y++) {
        if (y < 0 || y >= frame.height) {
          continue;
        }
        for (let x = cx - half; x <= cx + half; x++) {
          if (x < 0 || x >= frame.width) {
            continue;
          }
          const i = (y * frame.width + x) * 4;
          if (test(frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2])) {
            count++;
          }
        }
      }
      return count;
    };

    const pickAt = async (windowPosition, expectedId) => {
      let hits = 0;
      const ids = [];
      for (let attempt = 0; attempt < cfg.pickAttempts; attempt++) {
        s.requestRender();
        s.render();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        let picked;
        try {
          picked = await s.pickAsync(
            new C.Cartesian2(windowPosition.x, windowPosition.y),
            3,
            3,
          );
        } catch (error) {
          ids.push(`ERROR:${String(error).slice(0, 80)}`);
          continue;
        }
        let id = null;
        if (picked !== undefined && picked !== null) {
          if (typeof picked.id === "string") {
            id = picked.id;
          } else if (picked.id && typeof picked.id.id === "string") {
            id = picked.id.id;
          } else {
            id = `other:${picked.primitive?.constructor?.name ?? "unknown"}`;
          }
        }
        ids.push(id);
        if (id === expectedId) {
          hits++;
        }
      }
      return { hits, attempts: cfg.pickAttempts, ids };
    };

    const setDisableDepthTestDistance = (value) => {
      billboard.disableDepthTestDistance = value;
      label.disableDepthTestDistance = value;
      point.disableDepthTestDistance = value;
      polyline.disableDepthTestDistance = value;
    };

    await renderN(cfg.settleFrames);

    const windowFor = (worldPosition) => {
      const projected = C.SceneTransforms.worldToWindowCoordinates(
        s,
        worldPosition,
      );
      return projected === undefined
        ? null
        : { x: projected.x, y: projected.y };
    };

    const controlWindow = windowFor(control.position);
    const itemWindows = {};
    for (const item of cfg.items) {
      itemWindows[item] = windowFor(samplePositions[item]);
    }

    const measureAt = async (windowPosition, hueTest, expectedId, extraHue) => {
      if (windowPosition === null) {
        return {
          centre: null,
          huePixels: null,
          glyphPixels: null,
          pickHits: null,
          pickAttempts: cfg.pickAttempts,
          pickIds: [],
        };
      }
      // A `pickAsync` renders its own pick frame. Two colour frames put the
      // canvas back in the scene's own state before the hue count is taken,
      // so one item's pick pass cannot be read as the next item's pixels.
      await renderN(2);
      const frame = await readFrame();
      const huePixels = countHue(frame, windowPosition, hueTest);
      const glyphPixels =
        extraHue === undefined
          ? null
          : countHue(frame, windowPosition, extraHue);
      const picked = await pickAt(windowPosition, expectedId);
      return {
        centre: windowPosition,
        huePixels,
        glyphPixels,
        pickHits: picked.hits,
        pickAttempts: picked.attempts,
        pickIds: picked.ids,
      };
    };

    const legs = {};
    const controls = {};
    for (const leg of cfg.ddtdLegs) {
      setDisableDepthTestDistance(
        leg === "infinity" ? Number.POSITIVE_INFINITY : 0.0,
      );
      await renderN(cfg.legSettleFrames);
      // The control is re-measured in EVERY leg, including the one where a
      // subject has raised DISABLE_DEPTH_DISTANCE for the whole collection: if
      // the define alone lifted primitives to the near plane, the control —
      // which sets no per-instance value — would stop being depth-tested and
      // would say so here rather than silently validating the subjects.
      controls[leg] = await measureAt(
        controlWindow,
        hues.control,
        "matrix-control",
      );
      const measurements = {};
      for (const item of cfg.items) {
        measurements[item] = await measureAt(
          itemWindows[item],
          hues[item],
          `matrix-${item}`,
          item === "label" ? labelGlyphHue : undefined,
        );
      }
      legs[leg] = measurements;
    }

    return {
      rendererType: String(
        s.context?.rendererType ?? (s.context?.isWebGPU ? "webgpu" : "webgl"),
      ).toLowerCase(),
      logarithmicDepthBuffer: s.logarithmicDepthBuffer,
      canvasWidth: s.canvas.width,
      canvasHeight: s.canvas.height,
      controls,
      legs,
    };
  }, config);
}

/**
 * Runs the wide-aperture snap grid over a local glTF model. Runs in the page.
 *
 * @param {object} page Playwright page.
 * @param {object} config Snap configuration.
 * @returns {Promise<object>} Edge-hit counts and the `surfacePosition` rate.
 */
export async function captureSnap(page, config) {
  return page.evaluate(async (cfg) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const s = v.scene;
    s.globe.show = true;
    s.globe.depthTestAgainstTerrain = true;
    s.skyBox.show = false;
    s.sun.show = false;
    s.moon.show = false;
    s.skyAtmosphere.show = false;

    const renderN = async (n) => {
      for (let i = 0; i < n; i++) {
        s.requestRender();
        s.render();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    };

    const centerWorld = C.Cartesian3.fromDegrees(cfg.lon, cfg.lat, cfg.height);
    const model = await C.Model.fromGltfAsync({
      url: cfg.modelUrl,
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(centerWorld),
      scale: cfg.scale,
    });
    s.primitives.add(model);
    for (let i = 0; i < cfg.readyFrames; i++) {
      s.requestRender();
      s.render();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (model.ready) {
        break;
      }
    }
    if (!model.ready) {
      return { modelReady: false };
    }

    v.camera.lookAt(centerWorld, new C.HeadingPitchRange(0.3, -0.4, 300.0));
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);
    await renderN(cfg.settleFrames);

    const screen = C.SceneTransforms.worldToWindowCoordinates(s, centerWorld);
    if (screen === undefined) {
      return { modelReady: true, projected: false };
    }

    let edgeHits = 0;
    let farEdgeHits = 0;
    let surfaceDefined = 0;
    let undefinedResults = 0;
    let cursors = 0;
    const samples = [];
    for (let gy = -cfg.gridSpan; gy <= cfg.gridSpan; gy++) {
      for (let gx = -cfg.gridSpan; gx <= cfg.gridSpan; gx++) {
        cursors++;
        const cursorX = Math.round(screen.x + gx * cfg.gridStep);
        const cursorY = Math.round(screen.y + gy * cfg.gridStep);
        const windowPosition = new C.Cartesian2(cursorX, cursorY);
        let hit;
        for (let attempt = 0; attempt < cfg.retries; attempt++) {
          hit = s.snap(windowPosition, { width: cfg.snapWidth });
          if (hit) {
            break;
          }
          s.requestRender();
          s.render();
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        if (!hit) {
          undefinedResults++;
          continue;
        }
        if (hit.isEdge !== true) {
          continue;
        }
        edgeHits++;
        const dx = hit.screenPosition.x - cursorX;
        const dy = hit.screenPosition.y - cursorY;
        const offset = Math.sqrt(dx * dx + dy * dy);
        if (offset <= cfg.minOffset) {
          continue;
        }
        farEdgeHits++;
        const hasSurface =
          hit.surfacePosition !== undefined && hit.surfacePosition !== null;
        if (hasSurface) {
          surfaceDefined++;
        }
        if (samples.length < 32) {
          samples.push({
            cursor: { x: cursorX, y: cursorY },
            offset: Number(offset.toFixed(2)),
            surfacePosition: hasSurface,
          });
        }
      }
    }

    return {
      modelReady: true,
      projected: true,
      rendererType: String(
        s.context?.rendererType ?? (s.context?.isWebGPU ? "webgpu" : "webgl"),
      ).toLowerCase(),
      snapWidth: cfg.snapWidth,
      cursors,
      edgeHits,
      farEdgeHits,
      surfaceDefined,
      undefinedResults,
      definedRate: farEdgeHits > 0 ? surfaceDefined / farEdgeHits : null,
      samples,
    };
  }, config);
}
