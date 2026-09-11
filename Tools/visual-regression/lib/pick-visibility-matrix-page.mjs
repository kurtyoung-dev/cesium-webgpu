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
//
// EXTENT KEEPERS — why every collection carries an off-screen member.
//
// The subjects sit 60 km BELOW the ellipsoid, which is what makes them "behind
// terrain" (see `depthTestAgainstTerrain` below). That also puts them INSIDE the
// horizon occluder `View.createPotentiallyVisibleSet` tests every command
// against: the occluder sphere has radius `Ellipsoid.minimumRadius`
// (6356.75 km), while the ellipsoid surface at lat 40 is ~6369.35 km, so a
// subject at -60 km sits ~47 km inside it. A collection's command survives only
// if the collection's BOUNDING SPHERE pokes back out, and that radius is
// `pixelSize x <the collection's largest on-screen extent>` — roughly 500 m/px
// at this camera.
//
// Job 10 (2026-09-06) is the measurement that produced this rule. Its
// collections cleared the occluder only by accident, and the two that did not
// were silently absent from every one of its sixteen cell-measurements:
//
//   billboard  one 32 px billboard      ~16 km   CULLED - 0 hue px everywhere
//   label      background bb ~100 px    ~50 km   survived, barely
//   point      SHARES the collection with the control at +120 km   survived
//   polyline   0.7 deg span             ~30 km   CULLED on WebGL in all four
//                                                cells (WebGPU drew it only
//                                                because its command carried no
//                                                bounding volume before Batch
//                                                1447)
//
// A probe whose subjects appear or vanish according to which other primitive
// happens to share their collection is not measuring `AR-001`. So every
// collection now carries one KEEPER: a member of the same type at the scene
// centre's longitude plus `keeperDLon` degrees — outside the viewport at this
// camera, whose half-width is about 1.9 deg of longitude AT THE KEEPER'S OWN
// HEIGHT (Cesium's default 60 deg fov is the HORIZONTAL one at aspect > 1, so
// half-width = tan(30 deg) x 280 km / 85.3 km per degree at lat 40), and about
// 2.7 deg at the surface — and at `controlHeight` ABOVE the
// surface. It lifts the collection's bounding sphere clear of the occluder for
// every collection uniformly, it is never inside any sample window, and its id
// is distinct so a stray pick of one is a loud wrong-id result rather than a
// silent pass. `subjectRenderabilityChecks` then asserts what the keepers make
// possible: that each collection's draw command actually reached execution.

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
    // EXTENT KEEPERS. One per collection, off-screen and above the surface, so
    // no collection's command depends on which other primitive happens to share
    // it. See this file's header for the measurement that produced the rule.
    const keeperAt = (dLat) => at(cfg.keeperDLon, dLat, cfg.controlHeight);
    billboards.add({
      id: "matrix-keeper-billboard",
      position: keeperAt(0.0),
      image: swatch,
    });
    labels.add({
      id: "matrix-keeper-label",
      position: keeperAt(0.0),
      text: "KEEP",
      font: "bold 22px sans-serif",
      showBackground: true,
      backgroundColor: C.Color.fromBytes(0, 255, 255, 255),
    });
    points.add({
      id: "matrix-keeper-point",
      position: keeperAt(0.0),
      pixelSize: 30,
      color: C.Color.fromBytes(255, 255, 0, 255),
    });
    polylines.add({
      id: "matrix-keeper-polyline",
      positions: [keeperAt(-0.05), keeperAt(0.05)],
      width: 14,
      // THIS COLOUR MUST MATCH `matrix-polyline`'s. `createMaterialId`
      // (`PolylineCollection.js:1236-1250`) keys a bucket by material type AND
      // uniform VALUES, so a keeper of a different colour lands in a different
      // bucket with its own bounding volume on WebGL, the subject's volume is
      // horizon-culled again, and `commandExecuted` — which is owner-granular —
      // would still read true off the keeper's command. The renderability check
      // would go green over the very defect it exists to catch.
      material: C.Material.fromType("Color", {
        color: C.Color.fromBytes(255, 0, 255, 255),
      }),
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

    // ONE pick, rendered and read in order. Shared by the measured sequence and
    // by the warm-up so both see exactly the same call.
    const pickOnce = async (windowPosition) => {
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
        return `ERROR:${String(error).slice(0, 80)}`;
      }
      if (picked === undefined || picked === null) {
        return null;
      }
      if (typeof picked.id === "string") {
        return picked.id;
      }
      if (picked.id && typeof picked.id.id === "string") {
        return picked.id.id;
      }
      return `other:${picked.primitive?.constructor?.name ?? "unknown"}`;
    };

    // WHY A WARM-UP EXISTS AT ALL. WebGPU resolves a pick pipeline through
    // `createRenderPipelineAsync` and SKIPS the pick draw while the variant is
    // still materializing (`WebGPUPointPrimitiveRenderer.js:1468-1472`, and the
    // same shape in the label and billboard renderers), so the first pick
    // sequence after a NEW define variant reads an empty pick buffer. A
    // `disableDepthTestDistance` leg change is exactly such a variant change
    // (`ShaderDefine.DISABLE_DEPTH_DISTANCE`), and the control is always a
    // leg's first measured pick — which is why job 10 read the control at 0/5,
    // 1/5 or 2/5 on WebGPU in all sixteen measurements with the nulls on the
    // earliest attempts, while every LATER sequence in the same leg picked 5/5.
    // WebGL builds its shader programs synchronously and pays none of this.
    //
    // The discarded attempts are COUNTED and published, not swallowed: the cook
    // cost stays visible with numbers, and a warm-up that never resolves still
    // turns the run red through `pickWarmupChecks`.
    const warmUpPick = async (windowPosition) => {
      const budget = cfg.pickWarmupAttempts;
      const ids = [];
      if (windowPosition === null) {
        return { attempts: 0, resolved: false, ids, budget };
      }
      for (let attempt = 0; attempt < budget; attempt++) {
        const id = await pickOnce(windowPosition);
        ids.push(id);
        // A THROW is not a resolution. `pickOnce` reports an exception as an
        // `ERROR:` string, which is non-null, so a pick path that threw on
        // every attempt would otherwise publish `resolved: true` — the one
        // reading that would overstate what the warm-up proves. The control
        // verdict would still red (its ids never match), but `resolved` is
        // published on its own and has to mean what it says.
        if (id !== null && !String(id).startsWith("ERROR:")) {
          return { attempts: attempt + 1, resolved: true, ids, budget };
        }
      }
      return { attempts: budget, resolved: false, ids, budget };
    };

    const pickAt = async (windowPosition, expectedId) => {
      let hits = 0;
      const ids = [];
      for (let attempt = 0; attempt < cfg.pickAttempts; attempt++) {
        const id = await pickOnce(windowPosition);
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

    // WHICH COLLECTIONS' COMMANDS SURVIVED CULLING. `debugCommandFilter` is
    // consulted by BOTH backends (`SceneRenderer.js:62`,
    // `WebGPUSceneRenderer.ts:328`) only for commands that already passed the
    // frustum and horizon-occluder tests, so a collection absent from this
    // tally had its command culled before it could draw. That is precisely
    // job 10's billboard defect, and without this it read as occlusion.
    const executedOwners = new Set();
    s.debugCommandFilter = (command) => {
      const owner = command?.owner;
      if (owner) {
        executedOwners.add(owner);
      }
      return true;
    };
    await renderN(4);
    s.debugCommandFilter = undefined;

    // The label's own pixels come from its BACKGROUND billboard collection, so
    // that is the collection whose command has to have executed.
    const labelBackground = labels._backgroundBillboardCollection;
    const ownerFor = {
      billboard: billboards,
      label: labelBackground,
      point: points,
      polyline: polylines,
    };
    const subjectFor = {
      billboard,
      label,
      point,
      polyline,
    };
    const containerFor = {
      billboard: billboards,
      label: labels,
      point: points,
      polyline: polylines,
    };
    const renderability = {};
    for (const item of cfg.items) {
      const subject = subjectFor[item];
      const container = containerFor[item];
      renderability[item] = {
        present:
          typeof container?.contains === "function"
            ? container.contains(subject) === true
            : subject !== undefined && subject !== null,
        show: subject?.show === true,
        // Only the billboard owns an image that has to reach a texture atlas.
        // `null` here means "this type has no such gate", and
        // `subjectRenderabilityChecks` reads only an explicit `false` as a fail.
        imageReady: item === "billboard" ? subject.ready === true : null,
        commandExecuted:
          ownerFor[item] !== undefined && executedOwners.has(ownerFor[item]),
        windowPosition: itemWindows[item],
      };
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
      // Spend the pipeline cook BEFORE the first measured pick of the leg, and
      // record what it cost. See `warmUpPick` for why the leg boundary is
      // exactly where WebGPU pays it.
      const warmup = await warmUpPick(controlWindow);
      controls[leg] = {
        ...(await measureAt(controlWindow, hues.control, "matrix-control")),
        pickWarmup: warmup,
      };
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
      renderability,
      controls,
      legs,
    };
  }, config);
}

/**
 * Runs the wide-aperture snap grid over a local glTF model. Runs in the page.
 *
 * WHY THE SUBJECT CARRIES `EXT_mesh_primitive_edge_visibility`. Job 10's snap
 * leg returned zero `isEdge` results over 81 cursors on both backends and both
 * trees, and the cause is the ASSET, not the cursor pattern. `isEdge` is a
 * fragment flag written only by a model's EDGE PASS: `ModelFS.glsl:68` declares
 * it false and sets it true only at `:202-203`, inside
 * `#ifdef HAS_EDGE_VISIBILITY` under `u_isEdgePass`;
 * `PickingPipelineStage.js:43` packs it into the snap payload and
 * `SnapFramebuffer.js:56` is the ONLY place it is ever derived. The edge stage
 * is added only when `defined(primitive.edgeVisibility)`
 * (`ModelRuntimePrimitive.js:269,357-363`), populated only from the glTF
 * primitive's `EXT_mesh_primitive_edge_visibility` (`GltfLoader.js:1415-1418`).
 * Job 10's `CesiumMilkTruck.glb` carries no extensions at all, so no fragment
 * in that scene could set the flag at ANY aperture, pitch or cursor pattern.
 * The subject is now an asset that declares the extension, and the probe's
 * companion spec decodes it and refuses one that does not.
 *
 * WHY `edgeDisplayMode` IS PASSED, AND WHICH BACKEND NEEDS IT. WebGL does not:
 * its snap pass pushes `_edgeSnapCommand` REGARDLESS of the display mode
 * (`ModelDrawCommand.js:250-258`), and `pushEdgeCommands` is called
 * unconditionally (`ModelSceneGraph.js:1243-1245`). WebGPU does: its whole edge
 * emitter, INCLUDING the snap variant that sets the payload's edge bit
 * (`WebGPUEdgeVisibilityEmitter.ts:352-366`), sits inside a block gated on
 * `edgeDisplayMode !== SURFACES_ONLY` (`WebGPUModelRenderer.ts:8514-8517`). At
 * the `SURFACES_ONLY` default this leg would read edge hits on WebGL and none
 * on WebGPU and publish a CONFIGURATION difference as an `AR-030` finding.
 *
 * WHY THE CURSORS ARE A RING AND NOT A GRID. `AR-M30`'s population is edge hits
 * MORE than 2 px from the cursor, and `scene.snap` only reports `isEdge` when
 * its aperture actually straddles a silhouette. A grid on a fixed pixel pitch
 * has no relation to the subject's screen size — job 10's spanned +/-36 px
 * inside a model ~237 px long — so the cursors are now placed on concentric
 * rings scaled to the MODEL'S OWN measured projected radius, from well inside
 * the silhouette to just outside it, and the camera range is derived from the
 * model's bounding sphere so that radius is a known number rather than a
 * property of the asset's units.
 *
 * WHY THE SCENE IS PINNED. On the BEFORE tree, job 10's WebGL snap page rendered
 * a completely different scene from the WebGPU one — imagery-covered real
 * terrain with no model in view, 81/81 undefined — because its model sat at
 * 100 m ellipsoidal height under ~1500 m of terrain at (-105, 40) once terrain
 * loads, and `modelReady`/`projected` both still reported true. The page now
 * pins `EllipsoidTerrainProvider` and removes imagery exactly as the matrix page
 * does, so no tile request can change the scene under the measurement, and the
 * model is placed well above the ellipsoid.
 *
 * WHY THE READINESS GUARD PICKS. "The model loaded" and "the model is in frame,
 * in front of the globe" are different claims, and only the second makes the leg
 * meaningful. A `pickAsync` at the model's own centre is a rendering-derived
 * answer to the second — it resolves to the model only if the model actually
 * drew there — and it needs no canvas read, so this page keeps exactly one
 * pixel reader (the canonical same-task block lives in `captureMatrix`). The
 * pick is warmed first for the same WebGPU pipeline-cook reason the matrix legs
 * warm theirs.
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
    s.globe.depthTestAgainstTerrain = true;
    s.skyBox.show = false;
    s.sun.show = false;
    s.moon.show = false;
    s.skyAtmosphere.show = false;
    s.fog.enabled = false;

    const renderN = async (n) => {
      for (let i = 0; i < n; i++) {
        s.requestRender();
        s.render();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    };

    const centerWorld = C.Cartesian3.fromDegrees(cfg.lon, cfg.lat, cfg.height);
    // WebGPU suppresses its ENTIRE edge emitter, snap variant included, under
    // the `SURFACES_ONLY` default; WebGL's snap pass does not. Without an
    // edge-drawing mode the leg reads edges on one backend only, so the mode is
    // resolved explicitly and REPORTED — never silently dropped into the
    // default. `cfg.edgeModeValues` is the numeric fallback for a bundle whose
    // barrel does not re-export the enum; `probe-edge-display-mode-tri.mjs` and
    // `probe-edge-percolor.mjs` already drive this feature by number, and a
    // spec pins the table against `Scene/EdgeDisplayMode.js` itself, so it is
    // not a second source of truth. Refusing here would cost a whole Edge slot.
    const edgeDisplayMode =
      C.EdgeDisplayMode?.[cfg.edgeDisplayMode] ??
      cfg.edgeModeValues?.[cfg.edgeDisplayMode];
    const surfacesOnly = C.EdgeDisplayMode?.SURFACES_ONLY ?? 0;
    if (edgeDisplayMode === undefined || edgeDisplayMode === surfacesOnly) {
      return { edgeModeResolved: false, edgeDisplayMode: cfg.edgeDisplayMode };
    }
    const model = await C.Model.fromGltfAsync({
      url: cfg.modelUrl,
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(centerWorld),
      scale: cfg.scale,
      edgeDisplayMode,
    });
    // Set it again on the instance, the way the two shipped edge probes do, and
    // read it back: "the option was accepted" is a different claim from "the
    // option was passed", and only the first makes the leg able to measure.
    model.edgeDisplayMode = edgeDisplayMode;
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
      return { edgeModeResolved: true, modelReady: false };
    }
    if (model.edgeDisplayMode !== edgeDisplayMode) {
      return {
        edgeModeResolved: false,
        edgeDisplayMode: cfg.edgeDisplayMode,
        effectiveEdgeDisplayMode: model.edgeDisplayMode,
      };
    }

    // FRAME FROM THE MODEL, NOT FROM A TUNED CONSTANT. A fixed camera range
    // makes the subject's projected size a property of the asset's units and
    // of `scale`, so swapping the subject silently re-tunes the rings. Looking
    // at the model's own bounding sphere from `rangeFactor` radii away fixes
    // the projected radius at `(H/2) / (tan(fovy/2) * rangeFactor)` for every
    // asset. The sphere is read after `ready`, and a degenerate one falls back
    // to the placement point so the guards below refuse rather than throw.
    const sphere = model.boundingSphere;
    // Cloned, not aliased: `model.boundingSphere` is the live instance the
    // model updates each frame, and this centre is read again after the settle
    // renders below.
    const sphereCenter = sphere?.center
      ? C.Cartesian3.clone(sphere.center, new C.Cartesian3())
      : centerWorld;
    const sphereRadius = sphere?.radius ?? 0.0;
    const range = sphereRadius > 0.0 ? sphereRadius * cfg.rangeFactor : 300.0;
    v.camera.lookAt(sphereCenter, new C.HeadingPitchRange(0.3, -0.4, range));
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);
    await renderN(cfg.settleFrames);

    const screen = C.SceneTransforms.worldToWindowCoordinates(s, sphereCenter);
    if (screen === undefined) {
      return { edgeModeResolved: true, modelReady: true, projected: false };
    }

    // The model's own projected radius, measured rather than assumed: the
    // bounding sphere's centre and a point one radius away along the camera's
    // right vector, both projected, and the pixel distance between them.
    const edgeWorld = C.Cartesian3.add(
      sphereCenter,
      C.Cartesian3.multiplyByScalar(
        v.camera.right,
        sphereRadius,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const centerScreen = screen;
    const edgeScreen = C.SceneTransforms.worldToWindowCoordinates(s, edgeWorld);
    const screenRadius =
      edgeScreen === undefined
        ? 0.0
        : Math.hypot(
            edgeScreen.x - centerScreen.x,
            edgeScreen.y - centerScreen.y,
          );

    // "In frame" is a rendering claim, so it is answered by a pick. Warm first:
    // a WebGPU pick pipeline cooks asynchronously and its first attempts read an
    // empty pick buffer (see `warmUpPick` in `captureMatrix`).
    const centreCursor = new C.Cartesian2(
      Math.round(centerScreen.x),
      Math.round(centerScreen.y),
    );
    let modelInFrame = false;
    let inFrameAttempts = 0;
    for (let attempt = 0; attempt < cfg.inFrameAttempts; attempt++) {
      inFrameAttempts = attempt + 1;
      s.requestRender();
      s.render();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      let picked;
      try {
        picked = await s.pickAsync(centreCursor, 3, 3);
      } catch {
        continue;
      }
      if (picked && picked.primitive === model) {
        modelInFrame = true;
        break;
      }
    }

    const framing = {
      screenRadius,
      sphereRadius,
      range,
      rangeFactor: cfg.rangeFactor,
      centerScreen: { x: centerScreen.x, y: centerScreen.y },
      modelInFrame,
      inFrameAttempts,
      minScreenRadius: cfg.minScreenRadius,
    };
    if (!modelInFrame || !(screenRadius >= cfg.minScreenRadius)) {
      return {
        edgeModeResolved: true,
        modelReady: true,
        projected: true,
        framing,
        inFrame: false,
      };
    }

    let edgeHits = 0;
    let farEdgeHits = 0;
    let surfaceDefined = 0;
    let undefinedResults = 0;
    let cursors = 0;
    const samples = [];
    const cursorPositions = [{ x: centerScreen.x, y: centerScreen.y }];
    for (const fraction of cfg.ringFractions) {
      const ringRadius = screenRadius * fraction;
      for (let step = 0; step < cfg.ringSteps; step++) {
        const angle = (2.0 * Math.PI * step) / cfg.ringSteps;
        cursorPositions.push({
          x: centerScreen.x + ringRadius * Math.cos(angle),
          y: centerScreen.y + ringRadius * Math.sin(angle),
        });
      }
    }

    for (const position of cursorPositions) {
      cursors++;
      const cursorX = Math.round(position.x);
      const cursorY = Math.round(position.y);
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

    return {
      edgeModeResolved: true,
      modelReady: true,
      projected: true,
      inFrame: true,
      framing,
      modelUrl: cfg.modelUrl,
      edgeDisplayMode: cfg.edgeDisplayMode,
      effectiveEdgeDisplayMode: model.edgeDisplayMode,
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
