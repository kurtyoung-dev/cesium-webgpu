// probe-collection-pick.mjs — the INSTRUMENTED acceptance lane for the WebGPU
// collection pick chain (NEW-WEBGPU-POINT-PICK-RESIDUAL, widened to billboards
// 2026-08-07).
// @purpose Instrumented 7-link lane for the collection pick chain, naming the first dead link per target, with a Primitive positive control.
// @status ACTIVE
//
// ── WHY THIS LANE EXISTS ────────────────────────────────────────────────────
//
// Three stacked defects have now been found in this one chain:
//
//   B914  pass binning       — the collapsed color command moved to
//                              Pass.TRANSLUCENT (corrected in B917)
//   B739  pipeline key       — the billboard pick builder read `pipelineEntries`
//                              with a RAW-defines key after C11-149 re-keyed it
//                              to `defines*2+flag`, so it returned BEFORE
//                              pushing the pick command (fixed in B917)
//   ????  the residual       — collection picks STILL return null
//
// Every one of those cost at least a batch of offline argument, for one
// structural reason: between "the feature renderer pushed a pick command" and
// "the readback decoded a pick key" the chain publishes NOTHING observable.
// A null pick is compatible with at least six distinct deaths, and no existing
// probe can tell them apart. This lane makes each link observable and reports
// which one broke, rather than re-asserting the symptom.
//
// ── WHAT IT MEASURES, PER TARGET, AROUND ONE `scene.pick` ───────────────────
//
//   L1 RENDER      does the primitive paint a non-background pixel at the
//                  cursor in a NORMAL frame? ("projected on screen" is a
//                  camera-math claim; it is NOT evidence that anything drew.)
//   L2 REGISTRY    is a pick id registered, what is its key/color, and what
//                  SHAPE is the registered target? (WebGL registers
//                  `{primitive, collection, id}`.)
//   L3 EMIT+BIN    did the pick command reach the pick pass's Pass bin?
//                  (`context._diagPickPassCensus[pass].binned`, and how many
//                  of those carried a dedicated-pick marker.)
//   L4 DISPATCH    was it DRAWN, or dropped by `executePickBatch`'s admission
//                  test — and if dropped, on WHICH clause?
//                  (`dispatched` / `skippedNonNative` / `skippedNoPickVariant`)
//   L5 PIXELS      what bytes are actually in the pick framebuffer at the
//                  cursor after the pick render submitted? (this probe issues
//                  its OWN copyTextureToBuffer — it does not trust the
//                  engine's cached readback)
//   L6 DECODE      does `Color.bytesToRgba(...)` → `getObjectByPickColor`
//                  return the registered target for those bytes?
//   L7 RETURN      what did `scene.pick` / `scene.pickAsync` actually return?
//
// The first link that fails IS the death point. The verdicts below name it.
//
// ── POSITIVE CONTROL (load-bearing) ─────────────────────────────────────────
//
// A `Primitive` (BoxGeometry + PerInstanceColorAppearance) is picked with the
// identical machinery. It emits its pick draw through the geometry-primitive
// path (`_isPickCommand`), NOT the collection feature-renderer path. So:
//
//   control picks  +  collections null  ⇒ COLLECTIONS-SPECIFIC defect
//   control null   +  collections null  ⇒ PICK INFRASTRUCTURE is dead
//                                          (readback / FBO / registry / pass)
//
// Without it a null result cannot distinguish those two, and the last three
// batches of this investigation are exactly what that ambiguity costs.
//
// ── EXIT CODES ──────────────────────────────────────────────────────────────
//   0  every asserted predicate held (all three collections pick, control
//      picks, miss control misses, zero errors)
//   1  a real defect: at least one predicate failed and the lane could
//      attribute it to a named link
//   2  harness/infrastructure failure (browser, navigation, watchdog, no
//      WebGPU device, viewer never came up)
//   3  STRUCTURAL / undecidable: the lane could not reach a verdict because a
//      dependency it needs is absent (e.g. the debug census is missing, which
//      means the page served a RELEASE build with the pragmas stripped)
//
// ── REQUIREMENTS ────────────────────────────────────────────────────────────
//   * Serve an UNMINIFIED build: the L3/L4 census lives behind
//     `//>>includeStart('debug', ...)` and does not exist in a release bundle.
//   * Edge/Chromium only (Playwright's bundled Firefox has no WebGPU).
//
// Usage: node Tools/visual-regression/probe-collection-pick.mjs
// Env:   PROBE_BASE (default http://localhost:8080)
//        PROBE_RENDERER (default webgpu)
//        PROBE_HEADED=1 to watch it

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const RENDERER = process.env.PROBE_RENDERER || "webgpu";
const HEADED = process.env.PROBE_HEADED === "1";

// Fork Pass enum (packages/engine/Source/Renderer/Pass.js). Mirrored here so
// the census dump is readable without importing engine internals into Node.
const PASS_NAMES = {
  0: "ENVIRONMENT",
  1: "COMPUTE",
  2: "GLOBE",
  3: "TERRAIN_CLASSIFICATION",
  4: "CESIUM_3D_TILE_EDGES",
  5: "CESIUM_3D_TILE_PLANAR_FILL_ID",
  6: "CESIUM_3D_TILE",
  7: "CESIUM_3D_TILE_CLASSIFICATION",
  8: "CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW",
  9: "OPAQUE",
  10: "TRANSLUCENT",
  11: "VOXELS",
  12: "GAUSSIAN_SPLATS",
  13: "CESIUM_3D_TILE_EDGES_DIRECT",
  14: "OVERLAY",
};

const WATCHDOG_MS = 180000;
let browser;
let watchdog;
// Left undefined so an unforeseen escape from the try/catch below still exits
// 2 (harness failure) at the `?? 2` guard, rather than silently exiting 0.
let exitCode;

/** Bounded, allocation-light log helper so the report reads top-down. */
const say = (line) => console.log(line);

try {
  watchdog = setTimeout(() => {
    console.error(
      `[probe-collection-pick] WATCHDOG: no verdict within ${WATCHDOG_MS}ms — forcing exit 2.`,
    );
    // The finally block cannot run from inside a timer callback that exits, so
    // close the browser first on a best-effort basis.
    browser?.close().catch(() => {});
    process.exit(2);
  }, WATCHDOG_MS);
  watchdog.unref?.();

  browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 240)));
  page.on("console", (m) => {
    if (m.type() === "error") {
      pageErrors.push(m.text().slice(0, 240));
    }
  });

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${RENDERER}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const out = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const viewer = window.viewer;
    const scene = viewer.scene;
    const context = scene.context;
    const device = context?._device ?? null;

    const deviceErrors = [];
    if (device) {
      device.onuncapturederror = (ev) =>
        deviceErrors.push(String(ev?.error?.message ?? ev).slice(0, 250));
    }

    // ── offline black scene ────────────────────────────────────────────────
    // Nothing but the four probe primitives may paint, so a non-background
    // pixel at a cursor is attributable and the pick FBO has exactly one
    // candidate writer per query.
    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = C.Color.BLACK.clone();
    scene.requestRenderMode = false;

    // ── targets ────────────────────────────────────────────────────────────
    // Spread over four distinct longitudes at one altitude so each has its own
    // screen position and no two can occlude each other at the pick cursor.
    const alt = 1000.0;
    const at = (lonOffset) =>
      C.Cartesian3.fromDegrees(-75.0 + lonOffset, 40.0, alt);

    const points = scene.primitives.add(new C.PointPrimitiveCollection());
    const point = points.add({
      position: at(-0.03),
      pixelSize: 24,
      color: C.Color.YELLOW,
      id: "probe-collection-point",
    });

    const image = document.createElement("canvas");
    image.width = 32;
    image.height = 32;
    const ictx = image.getContext("2d");
    ictx.fillStyle = "#ffffff";
    ictx.fillRect(0, 0, 32, 32);

    const billboards = scene.primitives.add(new C.BillboardCollection());
    const billboard = billboards.add({
      position: at(-0.01),
      image: image,
      color: C.Color.MAGENTA,
      id: "probe-collection-billboard",
    });

    const polylines = scene.primitives.add(new C.PolylineCollection());
    const polyline = polylines.add({
      positions: [
        C.Cartesian3.fromDegrees(-75.0 + 0.01, 39.99, alt),
        C.Cartesian3.fromDegrees(-75.0 + 0.01, 40.01, alt),
      ],
      width: 16,
      material: C.Material.fromType("Color", {
        color: C.Color.CYAN,
      }),
      id: "probe-collection-polyline",
    });

    // POSITIVE CONTROL — a geometry Primitive. Its pick draw comes from
    // WebGPUPrimitiveCommands (`_isPickCommand`), a DIFFERENT producer from the
    // collection feature renderers, so it separates "pick infrastructure dead"
    // from "collections dead".
    const controlCenter = at(0.03);
    const controlPrimitive = scene.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: C.BoxGeometry.fromDimensions({
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
            dimensions: new C.Cartesian3(400.0, 400.0, 400.0),
          }),
          modelMatrix: C.Transforms.eastNorthUpToFixedFrame(controlCenter),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.LIME),
          },
          id: "probe-collection-control",
        }),
        appearance: new C.PerInstanceColorAppearance({
          closed: true,
          translucent: false,
        }),
        asynchronous: false,
      }),
    );

    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.0, 40.0, 12000.0),
      orientation: { heading: 0.0, pitch: -C.Math.PI_OVER_TWO, roll: 0.0 },
    });

    // Bounded warm-up: async pipeline materialization means the FIRST pick pass
    // that sees a new (defines) tuple skips its draw. 120 frames is far past
    // every collection's first resolve and is a hard bound, not a wait-loop.
    const renderN = async (n) => {
      for (let i = 0; i < n; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    };
    await renderN(120);

    // ── L1 RENDER — same-task canvas census ────────────────────────────────
    // The read MUST happen in the same synchronous task as `scene.render()`:
    // a read across a rAF yield is invalid on BOTH backends.
    const win = (world) => {
      const p = C.SceneTransforms.worldToWindowCoordinates(
        scene,
        world,
        new C.Cartesian2(),
      );
      return p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
    };
    const positions = {
      point: win(point.position),
      billboard: win(billboard.position),
      polyline: win(
        C.Cartesian3.fromDegrees(-75.0 + 0.01, 40.0, alt), // segment midpoint
      ),
      control: win(controlCenter),
    };
    const missAt = { x: 24, y: 24 };

    const sampleCanvas = () => {
      scene.render();
      const cw = scene.canvas.width;
      const ch = scene.canvas.height;
      const scratch = document.createElement("canvas");
      scratch.width = cw;
      scratch.height = ch;
      const sctx = scratch.getContext("2d", { willReadFrequently: true });
      sctx.drawImage(scene.canvas, 0, 0);
      const dpr = cw / (scene.canvas.clientWidth || cw);
      const read = (p) => {
        if (!p) return null;
        const px = Math.round(p.x * dpr);
        const py = Math.round(p.y * dpr);
        if (px < 0 || py < 0 || px >= cw || py >= ch) return null;
        const d = sctx.getImageData(px, py, 1, 1).data;
        return { r: d[0], g: d[1], b: d[2], a: d[3] };
      };
      return {
        point: read(positions.point),
        billboard: read(positions.billboard),
        polyline: read(positions.polyline),
        control: read(positions.control),
        miss: read(missAt),
      };
    };
    const renderedPixels = sampleCanvas();

    // ── L2 REGISTRY helpers ────────────────────────────────────────────────
    const describeRegistration = (pickId) => {
      if (!pickId) return { registered: false };
      const target = pickId.object;
      const shape =
        target && typeof target === "object"
          ? {
              hasPrimitive: "primitive" in target,
              hasCollection: "collection" in target,
              hasId: "id" in target,
              ctor: target?.constructor?.name ?? null,
            }
          : { ctor: null };
      return {
        registered: true,
        key: pickId.key,
        colorBytes: [
          Math.round(pickId.color.red * 255),
          Math.round(pickId.color.green * 255),
          Math.round(pickId.color.blue * 255),
          Math.round(pickId.color.alpha * 255),
        ],
        // WebGL registers `{primitive, collection, id}`; a BARE primitive here
        // is NEW-WEBGPU-COLLECTION-PICKID-OBJECT-SHAPE.
        isWrapperShape:
          !!shape.hasPrimitive && !!shape.hasCollection && !!shape.hasId,
        targetCtor: shape.ctor,
      };
    };

    // ── L5 PIXELS — this probe's OWN readback of the pick FBO ───────────────
    // Deliberately independent of `WebGPUPickFramebuffer`'s cached readback:
    // if the engine's cache is the broken link, trusting it would hide that.
    const readPickFBO = async () => {
      const fbo = scene._view?.pickFramebuffer;
      const tex = fbo?._colorTexture ?? null;
      if (!device || !tex) {
        return {
          available: false,
          reason: !device ? "no-device" : "no-texture",
        };
      }
      const w = Math.max(1, fbo._pickWidth | 0);
      const h = Math.max(1, fbo._pickHeight | 0);
      const ox = Math.max(0, fbo._copyOriginX | 0);
      const oy = Math.max(0, fbo._copyOriginTopY | 0);
      const cw = Math.max(1, fbo._copyWidth | 0);
      const ch = Math.max(1, fbo._copyHeight | 0);
      const bytesPerRow = Math.ceil((cw * 4) / 256) * 256;
      const buffer = device.createBuffer({
        size: bytesPerRow * ch,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const enc = device.createCommandEncoder({
          label: "probe-collection-pick readback",
        });
        enc.copyTextureToBuffer(
          { texture: tex, origin: [ox, oy, 0] },
          { buffer, bytesPerRow, rowsPerImage: ch },
          [cw, ch],
        );
        device.queue.submit([enc.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const src = new Uint8Array(buffer.getMappedRange());
        // Centre texel of the copied block — the same texel the engine's
        // spiral decode starts from.
        const centreRow = Math.floor(ch / 2);
        const centreCol = Math.floor(cw / 2);
        const base = centreRow * bytesPerRow + centreCol * 4;
        const centre = [src[base], src[base + 1], src[base + 2], src[base + 3]];
        // Non-zero census over the whole block: proves SOMETHING drew even if
        // the exact centre texel missed.
        let nonZero = 0;
        const distinct = new Set();
        for (let row = 0; row < ch; row++) {
          for (let col = 0; col < cw; col++) {
            const i = row * bytesPerRow + col * 4;
            const packed =
              src[i] |
              (src[i + 1] << 8) |
              (src[i + 2] << 16) |
              (src[i + 3] << 24);
            if (packed !== 0) {
              nonZero++;
              if (distinct.size < 8) distinct.add(packed >>> 0);
            }
          }
        }
        const bgra = fbo._colorFormat === "bgra8unorm";
        const r = bgra ? centre[2] : centre[0];
        const g = centre[1];
        const b = bgra ? centre[0] : centre[2];
        const a = centre[3];
        const key = C.Color.bytesToRgba(r, g, b, a);
        return {
          available: true,
          format: fbo._colorFormat,
          logicalRect: { x: fbo._pickOriginX, topY: fbo._pickOriginTopY, w, h },
          copyRect: { x: ox, topY: oy, w: cw, h: ch },
          centreBytesRaw: centre,
          centreKey: key,
          nonZeroTexels: nonZero,
          totalTexels: cw * ch,
          distinctKeys: [...distinct],
          // L6 DECODE — round-trip the bytes THIS probe read through the
          // engine's own registry. Isolates decode from readback.
          decodedCtor:
            key !== 0
              ? (context.getObjectByPickColor(key)?.constructor?.name ?? null)
              : null,
          decodedIsRegistered: key !== 0 && !!context.getObjectByPickColor(key),
        };
      } finally {
        try {
          buffer.unmap();
        } catch {
          /* not mapped — nothing to release */
        }
        buffer.destroy();
      }
    };

    const snapshotCensus = () => {
      const census = context._diagPickPassCensus;
      if (!census) return null;
      const passes = {};
      for (const k of Object.keys(census.passes)) {
        passes[k] = { ...census.passes[k] };
      }
      return {
        generation: census.generation,
        frustums: census.frustums,
        passes,
      };
    };

    const describeHit = (hit, expected) => {
      if (hit === undefined || hit === null) return { found: false };
      return {
        found: true,
        // Accept BOTH registration shapes so this predicate cannot itself
        // become the thing that fails.
        isExpected: hit === expected || hit.primitive === expected,
        id: hit?.id ?? null,
        hasPrimitive: "primitive" in hit,
        hasCollection: "collection" in hit,
        ctor: hit?.constructor?.name ?? null,
      };
    };

    // ── the ONE instrumented pick, per target ──────────────────────────────
    const probeTarget = async (label, pos, expected) => {
      if (!pos) {
        return { label, structural: "off-screen: no window coordinate" };
      }
      const cursor = new C.Cartesian2(pos.x, pos.y);

      // `scene.pick` on WebGPU is one readback behind by construction
      // (WebGPUPickFramebuffer.end publishes the PREVIOUS copy). Bounded
      // repeat so a stale-by-N result is reported as a LATENCY figure, not
      // mistaken for a dead chain. Hard bound: 6.
      let syncResolvedAt = -1;
      let syncHit;
      for (let attempt = 0; attempt < 6; attempt++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        syncHit = scene.pick(cursor, 9, 9);
        if (syncHit !== undefined && syncHit !== null) {
          syncResolvedAt = attempt;
          break;
        }
      }

      // The AUTHORITATIVE leg: `pickAsync` submits the pick render (via
      // completePickFrame) BEFORE arming its copy, so it carries no staleness
      // and a null here is a real null.
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      const asyncHit = await scene.pickAsync(cursor, 9, 9);
      // Census + pixels describe the mini-frame `pickAsync` just ran.
      const census = snapshotCensus();
      const pixels = await readPickFBO();

      return {
        label,
        cursor: pos,
        registration: describeRegistration(expected?._pickId ?? null),
        census,
        pixels,
        sync: {
          ...describeHit(syncHit, expected),
          resolvedAtAttempt: syncResolvedAt,
        },
        async: describeHit(asyncHit, expected),
      };
    };

    const registeredBefore = context._pickObjects?.size ?? null;

    const results = {
      control: await probeTarget(
        "control-primitive",
        positions.control,
        controlPrimitive,
      ),
      point: await probeTarget("point", positions.point, point),
      billboard: await probeTarget("billboard", positions.billboard, billboard),
      polyline: await probeTarget("polyline", positions.polyline, polyline),
    };

    // MISS control — an empty corner must resolve to nothing. A "hit"
    // everywhere would make every other PASS meaningless.
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    const missHit = await scene.pickAsync(
      new C.Cartesian2(missAt.x, missAt.y),
      9,
      9,
    );

    return {
      renderer: scene.context?.rendererType ?? null,
      hasDevice: !!device,
      censusAvailable: !!context._diagPickPassCensus,
      registeredPickIds: {
        before: registeredBefore,
        after: context._pickObjects?.size ?? null,
      },
      positions,
      renderedPixels,
      results,
      miss: describeHit(missHit, null),
      deviceErrors,
    };
  });

  await browser.close();
  browser = undefined;

  // ── report ──────────────────────────────────────────────────────────────
  say(JSON.stringify(out, null, 2));
  say("");
  say("── pick-pass census (Pass bins visited by the LAST pick mini-frame) ──");
  const censusOf = (r) => r?.census ?? null;
  for (const key of ["control", "point", "billboard", "polyline"]) {
    const census = censusOf(out.results?.[key]);
    if (!census) {
      say(`  ${key}: <no census>`);
      continue;
    }
    const rows = Object.keys(census.passes)
      .map(
        (p) =>
          `${PASS_NAMES[p] ?? p}{binned=${census.passes[p].binned} dispatched=${census.passes[p].dispatched} dedicated=${census.passes[p].dedicatedPickBinned} skipNonNative=${census.passes[p].skippedNonNative} skipNoVariant=${census.passes[p].skippedNoPickVariant}}`,
      )
      .join(" ");
    say(
      `  ${key}: gen=${census.generation} frustums=${census.frustums} ${rows}`,
    );
  }

  const relevantPageErrors = pageErrors.filter(
    (m) =>
      m !== "RequestErrorEvent" &&
      !m.includes("net::ERR_NETWORK_ACCESS_DENIED") &&
      !m.includes("Failed to load resource"),
  );

  // A target the camera never put on screen is a SETUP failure, not a pick
  // defect. Reporting it as FAIL would repeat exactly the error this lane
  // exists to end — treating an unmeasured link as a measured one.
  const offScreen = ["control", "point", "billboard", "polyline"].filter(
    (k) => out.results?.[k]?.structural !== undefined,
  );

  // ── structural gates (exit 3): the lane cannot decide ────────────────────
  if (!out.hasDevice) {
    say("STRUCTURAL: no WebGPU device on the page — nothing to decide.");
    exitCode = 3;
  } else if (offScreen.length > 0) {
    say(
      `STRUCTURAL: ${offScreen.join(", ")} produced no window coordinate — the ` +
        `camera setup, not the pick chain, is what failed. No pick verdict is available.`,
    );
    exitCode = 3;
  } else if (!out.censusAvailable) {
    say(
      "STRUCTURAL: `context._diagPickPassCensus` is absent. The page served a " +
        "RELEASE build (debug pragmas stripped), so links L3/L4 are unobservable " +
        "and a null pick cannot be attributed. Serve Build/CesiumUnminified.",
    );
    exitCode = 3;
  } else {
    // ── named predicates ──────────────────────────────────────────────────
    const P = {};
    const target = (k) => out.results?.[k] ?? {};

    const drew = (k) => {
      const px = out.renderedPixels?.[k];
      return !!px && (px.r > 8 || px.g > 8 || px.b > 8);
    };
    const opaqueRow = (k) => target(k).census?.passes?.["9"] ?? null;
    const dispatchedAny = (k) => {
      const passes = target(k).census?.passes ?? {};
      let n = 0;
      for (const p of Object.keys(passes)) n += passes[p].dispatched;
      return n;
    };
    const painted = (k) => (target(k).pixels?.nonZeroTexels ?? 0) > 0;
    const picked = (k) => target(k).async?.found === true;
    const pickedRight = (k) => target(k).async?.isExpected === true;

    P.controlRendersAtCursor = drew("control");
    P.controlPickDispatched = dispatchedAny("control") > 0;
    P.controlPickPaintsPickFBO = painted("control");
    P.controlPicks = picked("control") && pickedRight("control");

    for (const k of ["point", "billboard", "polyline"]) {
      P[`${k}RendersAtCursor`] = drew(k);
      P[`${k}PickDispatched`] = dispatchedAny(k) > 0;
      P[`${k}PickPaintsPickFBO`] = painted(k);
      P[`${k}PickDecodes`] = target(k).pixels?.decodedIsRegistered === true;
      P[`${k}Picks`] = picked(k) && pickedRight(k);
      // NEW-WEBGPU-COLLECTION-PICKID-OBJECT-SHAPE — the registered target must
      // be WebGL's `{primitive, collection, id}` wrapper, not a bare primitive.
      P[`${k}RegistrationIsWrapperShape`] =
        target(k).registration?.isWrapperShape === true;
    }
    P.missControlMisses = out.miss?.found !== true;
    P.noDeviceErrors = (out.deviceErrors?.length ?? 0) === 0;
    P.noPageErrors = relevantPageErrors.length === 0;

    say("");
    say("── predicates ──");
    for (const [name, value] of Object.entries(P)) {
      say(`  ${value ? "PASS" : "FAIL"}  ${name}`);
    }

    // ── attribution: name the first broken link ───────────────────────────
    say("");
    say("── attribution ──");
    const collections = ["point", "billboard", "polyline"];
    const anyCollectionPicks = collections.some((k) => P[`${k}Picks`]);
    if (!P.controlPicks && !anyCollectionPicks) {
      say(
        "  PICK INFRASTRUCTURE IS DEAD — the geometry-Primitive control fails too. " +
          "The defect is NOT collection-specific: look at the pick FBO / readback / " +
          "registry / pass wiring, not at the collection feature renderers.",
      );
    } else if (P.controlPicks && !anyCollectionPicks) {
      say(
        "  COLLECTIONS-SPECIFIC — the control picks and no collection does. " +
          "The chain below names the link:",
      );
    }
    for (const k of collections) {
      if (P[`${k}Picks`]) {
        say(`  ${k}: OK (async pick resolved to the expected primitive)`);
        continue;
      }
      if (!P[`${k}RendersAtCursor`]) {
        say(
          `  ${k}: DEATH AT L1 (RENDER) — nothing painted at the cursor in a NORMAL frame, ` +
            `so the pick query is aimed at empty space. Fix the color path (or the cursor) first; ` +
            `every downstream reading is void.`,
        );
      } else if (!target(k).registration?.registered) {
        say(
          `  ${k}: DEATH AT L2 (REGISTRY) — no pick id was ever created for the primitive.`,
        );
      } else if ((opaqueRow(k)?.binned ?? 0) === 0) {
        say(
          `  ${k}: DEATH AT L3 (EMIT/BIN) — Pass.OPAQUE bin is EMPTY in the pick mini-frame. ` +
            `The feature renderer either never pushed the pick command (a guard returned early) ` +
            `or View.createPotentiallyVisibleSet culled it against the tightened pick frustum.`,
        );
      } else if ((opaqueRow(k)?.dedicatedPickBinned ?? 0) === 0) {
        say(
          `  ${k}: DEATH AT L3 (EMIT/BIN) — commands are binned but NONE carries a dedicated-pick ` +
            `marker, i.e. only the COLOR command reached the bin; the pick command was not pushed.`,
        );
      } else if (!P[`${k}PickDispatched`]) {
        const row = opaqueRow(k);
        say(
          `  ${k}: DEATH AT L4 (DISPATCH) — binned but never drawn. ` +
            `skippedNonNative=${row?.skippedNonNative} skippedNoPickVariant=${row?.skippedNoPickVariant}. ` +
            `A non-zero skippedNonNative means selectCommandVariant resolved a WebGL DrawCommand.`,
        );
      } else if (!P[`${k}PickPaintsPickFBO`]) {
        say(
          `  ${k}: DEATH AT L5 (PIXELS) — the pick draw was DISPATCHED but the pick framebuffer is ` +
            `all-zero over the whole query block. The draw produced no surviving fragment: clip/depth ` +
            `(log frag_depth encode), scissor/viewport, blend, or a shader discard.`,
        );
      } else if (!P[`${k}PickDecodes`]) {
        say(
          `  ${k}: DEATH AT L6 (DECODE) — the pick FBO carries key ${target(k).pixels?.centreKey} ` +
            `(distinct keys in block: ${JSON.stringify(target(k).pixels?.distinctKeys)}) but ` +
            `getObjectByPickColor does not resolve it. Registry/encode mismatch.`,
        );
      } else {
        say(
          `  ${k}: DEATH AT L7 (RETURN) — the bytes decode to a registered object, yet ` +
            `scene.pickAsync returned ${JSON.stringify(target(k).async)}. The loss is between ` +
            `pickObjectsFromPixels and Scene.pickAsync (region/limit/spiral or the readback cache).`,
        );
      }
    }

    const pass = Object.values(P).every(Boolean);
    if (relevantPageErrors.length > 0) {
      say("");
      say(`page errors (${relevantPageErrors.length}):`);
      for (const m of relevantPageErrors.slice(0, 12)) say(`  ${m}`);
    }
    say("");
    say(pass ? "PROBE PASS" : "PROBE FAIL");
    exitCode = pass ? 0 : 1;
  }
} catch (error) {
  console.error(
    `[probe-collection-pick] HARNESS FAILURE: ${error?.stack ?? error}`,
  );
  exitCode = 2;
} finally {
  clearTimeout(watchdog);
  try {
    await browser?.close();
  } catch {
    /* already closed */
  }
}

process.exit(exitCode ?? 2);
