// moon-onscreen-oracle.spec.mjs — why five probe configurations saw no Moon.
// @purpose Refutes both engine hypotheses behind the blocked lunar pixel legs by showing the two "disagreeing" moon vectors are one ephemeris at two clock times, and pins the camera recipe that puts the eclipsed Moon on screen.
// @status ACTIVE
//
// WHAT THIS SPEC IS FOR. The 2026-08-28 acceptance sweep could not place the
// eclipsed Moon on screen in five configurations and recorded
// `_environmentState.isMoonVisible === false` throughout, on both backends, at
// four fields of view and two camera heights. Its own write-up left two
// hypotheses open: either the Moon is being culled when it should not be — "in
// which case no lunar-eclipse disc work is observable from a viewer at all,
// which would be severe" — or the two published moon vectors are in different
// frames and the diagnostic inherited the wrong one.
//
// Both are refutable from the engine and from the sweep's own recorded numbers,
// with no browser. This spec does that, and then pins the camera recipe the
// next Edge session needs, taken from the eclipse-explorer demo's own
// shared-frame targeting flow rather than reinvented.
//
// THE ANSWER, in short. Neither hypothesis, and one cause for all of it. The
// two vectors are the same Moon at two different CLOCK TIMES, because
// `scene.render()` called with no argument renders at `JulianDate.now()`; the
// diagnostic interleaved bare `scene.render()` calls with the Viewer's own
// frozen-clock frames and took its aim vector from whichever won. The camera
// therefore pointed 146 degrees away from where the Moon was in the frames
// that mattered — which is enough on its own to explain the null window
// coordinates (the Moon is behind the camera), the false `isMoonVisible` on
// WebGL (the command exists and the culling volume rejects it) and the absent
// command on WebGPU (`updateWebGPUMoon` returns early for a Moon fully behind
// the camera).
//
// Nothing here is an engine defect, and the two remaining traps are recorded
// so the next session does not re-derive them: `isMoonVisible` is a cull test
// on an ENVIRONMENT-pass command rather than a "the Moon is on screen" flag,
// and a recomputed aim vector is a third of a degree from the engine's own
// because this process lacks the browser's IAU2006 XYS data.
//
// SOURCE OF THE RECORDED NUMBERS. `Tools/visual-regression/output/
// visual-wave-acceptance-2026-08-28/cluster2-moon-visibility-diag.json`. They
// are transcribed as constants below rather than read from disk: that
// directory is gitignored evidence, and this spec must run in a clean
// checkout.
//
// LINE ENDINGS: this repo checks out CRLF. Every source read below is
// normalised to \n first.
//
// Run: node --test Tools/visual-regression/moon-onscreen-oracle.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      typeof context.parentURL === "string" &&
      context.parentURL.startsWith("file:")
    ) {
      const asJs = new URL(specifier, context.parentURL);
      if (
        asJs.pathname.includes("/packages/engine/Source/Shaders/") &&
        !fs.existsSync(fileURLToPath(asJs))
      ) {
        return {
          url: "data:text/javascript,export default%20%22%22%3B",
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      const source = fs.readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        source: ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            verbatimModuleSyntax: false,
          },
        }).outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

enableEngineTsResolution();

globalThis.GPUTextureUsage ??= Object.freeze({
  STORAGE_BINDING: 1,
  TEXTURE_BINDING: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  RENDER_ATTACHMENT: 16,
});
globalThis.GPUBufferUsage ??= Object.freeze({
  UNIFORM: 1,
  COPY_DST: 2,
  STORAGE: 4,
  VERTEX: 8,
  INDEX: 16,
  COPY_SRC: 32,
});
globalThis.GPUShaderStage ??= Object.freeze({
  VERTEX: 1,
  FRAGMENT: 2,
  COMPUTE: 4,
});

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

async function load(relativePath) {
  return await import(pathToFileURL(path.join(root, relativePath)).href);
}

const engine = (name) => `packages/engine/Source/${name}`;

const sceneSource = read(engine("Scene/Scene.js"));
const moonSource = read(engine("Scene/Moon.js"));
const webgpuEnvironmentSource = read(
  engine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js"),
);

const Cartesian3 = (await load(engine("Core/Cartesian3.js"))).default;
const Ellipsoid = (await load(engine("Core/Ellipsoid.js"))).default;
const JulianDate = (await load(engine("Core/JulianDate.js"))).default;
const CesiumMath = (await load(engine("Core/Math.js"))).default;
const Matrix3 = (await load(engine("Core/Matrix3.js"))).default;
const Simon1994PlanetaryPositions = (
  await load(engine("Core/Simon1994PlanetaryPositions.js"))
).default;
const Transforms = (await load(engine("Core/Transforms.js"))).default;
const { computeMoonPhysicalDepthGap, updateMoonPhysicalDepthDemand } =
  await load(engine("Scene/Moon.js"));
const Scene = (await load(engine("Scene/Scene.js"))).default;

// ── The sweep's own recorded numbers ───────────────────────────────────────
//
// `moonDirectionWC` as the diagnostic read it. Row 1 of the WebGL backend
// recorded one vector; rows 2-4 of the same run, and every WebGPU row,
// recorded a different one. That is the observation the "different frames"
// hypothesis was built on.
const RECORDED_ROW_1 = new Cartesian3(
  0.054189757566286,
  0.9934615000289722,
  -0.10048740286768153,
);
const RECORDED_ROWS_2_TO_4 = new Cartesian3(
  0.4500704417284394,
  -0.8782331657422201,
  -0.16168829293664344,
);

// The pinned eclipse instant, and the site the preset places the observer at.
const GREATEST = "2026-08-28T04:12:00Z";
const SITE = { longitude: -63.9004, latitude: -8.7612, height: 90.0 };

function moonDirectionAt(iso) {
  const date = JulianDate.fromIso8601(iso);
  const icrfToFixed = new Matrix3();
  Transforms.computeIcrfToCentralBodyFixedMatrix(date, icrfToFixed);
  const position =
    Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      date,
      new Cartesian3(),
    );
  Matrix3.multiplyByVector(icrfToFixed, position, position);
  return Cartesian3.normalize(position, position);
}

function moonPositionAt(iso) {
  const date = JulianDate.fromIso8601(iso);
  const icrfToFixed = new Matrix3();
  Transforms.computeIcrfToCentralBodyFixedMatrix(date, icrfToFixed);
  const position =
    Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      date,
      new Cartesian3(),
    );
  return Matrix3.multiplyByVector(icrfToFixed, position, position);
}

// ───────────────────────────────────────────────────────────────────────────
// 1. The two vectors are one ephemeris at two clock times
// ───────────────────────────────────────────────────────────────────────────

test("the two recorded moon vectors are the same Moon, hours apart", () => {
  const atGreatest = moonDirectionAt(GREATEST);

  // The vector the diagnostic recorded for rows 2-4 IS the eclipse instant,
  // to within a third of a degree. That residual is the ICRF transform, not
  // the ephemeris: the browser has the IAU2006 XYS data loaded and this
  // process falls back to the TEME pseudo-fixed matrix. It is also why the
  // prescription at the bottom of this file takes the aim vector from the
  // engine's own published sample rather than recomputing one — a third of a
  // degree is most of a lunar diameter.
  const rowsMatch = Cartesian3.dot(RECORDED_ROWS_2_TO_4, atGreatest);
  assert.ok(rowsMatch > 0.9999, `rows 2-4 vs greatest: ${rowsMatch}`);

  // Row 1 is not a different FRAME of the same instant. It is 146 degrees away
  // — a different TIME. A frame disagreement (fixed vs inertial, say) would
  // show as a rotation about the polar axis of at most one Earth rotation and
  // would preserve the vector's declination; this does not.
  const disagreement = Cartesian3.dot(RECORDED_ROW_1, atGreatest);
  assert.ok(
    disagreement < -0.8,
    `row 1 vs greatest: ${disagreement} — expected near-opposite`,
  );

  // And it is a specific time: the wall clock during the sweep. Scanning the
  // day at one-minute resolution, the closest match is unambiguous.
  let best = { dot: -2.0, iso: undefined };
  for (let minutes = 0; minutes < 24 * 60; minutes++) {
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    const iso = `2026-08-28T${hh}:${mm}:00Z`;
    const dot = Cartesian3.dot(RECORDED_ROW_1, moonDirectionAt(iso));
    if (dot > best.dot) {
      best = { dot, iso };
    }
  }
  assert.ok(
    best.dot > 0.9999,
    `row 1 matched no instant on the day better than ${best.dot}`,
  );
  // Mid-afternoon US Eastern on the day the sweep ran, which is when it ran.
  // The window absorbs the same ICRF residual as above: a third of a degree of
  // Earth rotation is about ninety seconds.
  const minutesFromMatch = Math.abs(
    JulianDate.secondsDifference(
      JulianDate.fromIso8601(best.iso),
      JulianDate.fromIso8601("2026-08-28T18:37:00Z"),
    ) / 60.0,
  );
  assert.ok(minutesFromMatch <= 5.0, `row 1 best match was ${best.iso}`);
});

test("a bare scene.render() renders at the wall clock, which is how that happened", () => {
  // The diagnostic set `viewer.clock.currentTime` and then called
  // `scene.render()` with no argument, interleaved with the Viewer's own
  // frozen-clock frames, and read its aim vector straight afterwards.
  assert.match(
    sceneSource,
    /if \(!defined\(time\)\) \{\n\s*time = JulianDate\.now\(\);\n\s*\}/,
    "Scene.render must still default the frame time to now for this to be the explanation",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The two published moon fields cannot disagree about frame
// ───────────────────────────────────────────────────────────────────────────

test("moonDirectionWC is the normalization of the very sample a probe reads", () => {
  // Moon.update takes the shared Earth-fixed sample when Scene publishes one...
  assert.match(
    moonSource,
    /const celestialEphemerisSample = frameState\.celestialEphemerisSample;\n\s*let translation;\n\s*if \(defined\(celestialEphemerisSample\)\) \{\n\s*translation = Cartesian3\.clone\(\n\s*celestialEphemerisSample\.moonPositionWC,/,
  );
  // ...and publishes its normalization under the other name. One frame, one
  // quantity, two spellings — they are parallel by construction.
  assert.match(
    moonSource,
    /const moonDirWC = Cartesian3\.normalize\(translation, scratchMoonDirWC\);/,
  );
  assert.match(
    moonSource,
    /frameState\.moonDirectionWC = Cartesian3\.clone\(\n\s*moonDirWC,/,
  );
});

test("a hidden Moon leaves moonDirectionWC at whatever the last visible frame left", () => {
  // The other way that field goes stale, and the reason a scene light must not
  // source its direction from it: Moon.update returns before publishing.
  const guard = moonSource.indexOf("if (!this.show) {");
  const publish = moonSource.indexOf("frameState.moonDirectionWC = ");
  assert.ok(guard > 0 && publish > guard);
  const earlyReturn = moonSource.slice(guard, guard + 160);
  assert.match(earlyReturn, /return;/);
  // Scene resets the phase before the update but not the direction, so the
  // vector survives a hidden frame while the phase does not.
  assert.match(sceneSource, /frameState\.moonPhaseFraction = 0\.0;/);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. isMoonVisible is not an on-screen oracle
// ───────────────────────────────────────────────────────────────────────────

test("an absent command reads as not visible, and a present one does not", () => {
  // The real predicate. `environmentState.isMoonVisible` is exactly this call
  // with `environmentState.moonCommand`.
  const host = Object.create(Scene.prototype);
  assert.equal(
    Scene.prototype.isVisible.call(host, undefined, undefined),
    false,
  );
  assert.equal(
    Scene.prototype.isVisible.call(host, undefined, { cull: false }),
    true,
    "control: a command that opts out of culling is visible, so the false above is about absence",
  );
});

test("both WebGPU routes do emit a command, so the flag is not structurally dead", () => {
  // Worth stating explicitly, because the tempting shortcut is to declare
  // `isMoonVisible` meaningless on WebGPU and stop looking. It is not: the
  // legacy route ends in a real `commandList.push`, and the physical route
  // hands its command to the scene list instead.
  const update = webgpuEnvironmentSource.slice(
    webgpuEnvironmentSource.indexOf("function updateWebGPUMoon("),
  );
  const body = update.slice(0, update.indexOf("\nfunction ", 1));
  assert.match(body, /\n\s{2}commandList\.push\(cache\.command\);\n/);
  assert.match(
    body,
    /pushPhysicalMoonCommand\(moon, frameState, commandList, cache\);/,
  );

  // What the routing then does with it: exactly one command becomes the
  // environment command, and the physical route deliberately returns undefined
  // because it has already pushed to the scene list.
  assert.match(
    moonSource,
    /const command =\n\s*scratchCommandList\.length === 1 \? scratchCommandList\[0\] : undefined;/,
  );
  assert.match(
    sceneSource,
    /environmentState\.moonCommand = defined\(this\.moon\)\n\s*\? this\.moon\.update\(frameState, environmentState\.moonDepthRouteState\)/,
  );
  assert.match(
    sceneSource,
    /environmentState\.isMoonVisible = this\.isVisible\(\n\s*cullingVolume,\n\s*environmentState\.moonCommand,/,
  );
});

test("the recorded misaim reaches updateWebGPUMoon's behind-the-camera return", () => {
  // The WebGPU rows recorded `hasMoonCommand: false` where WebGL recorded
  // true. That asymmetry is not a backend defect either: WebGPU carries one
  // guard the WebGL EllipsoidPrimitive path does not, and the recorded aim
  // trips it.
  const update = webgpuEnvironmentSource.slice(
    webgpuEnvironmentSource.indexOf("function updateWebGPUMoon("),
  );
  assert.match(
    update.slice(0, update.indexOf("\nfunction ", 1)),
    /if \(dotForward < -maxRadius\) \{\n\s*return; \/\/ moon is fully behind the camera/,
  );

  // The predicate, evaluated on the sweep's own numbers: camera aimed at the
  // wall-clock Moon, frame rendered at the eclipse instant.
  const eye = Cartesian3.fromDegrees(
    SITE.longitude,
    SITE.latitude,
    SITE.height,
  );
  const cameraDirection = Cartesian3.normalize(
    Cartesian3.subtract(
      moonPositionAt("2026-08-28T18:37:00Z"),
      eye,
      new Cartesian3(),
    ),
    new Cartesian3(),
  );
  const cameraToMoon = Cartesian3.subtract(
    moonPositionAt(GREATEST),
    eye,
    new Cartesian3(),
  );
  assert.ok(
    Cartesian3.dot(cameraToMoon, cameraDirection) <
      -Ellipsoid.MOON.maximumRadius,
    "the recorded aim must put the eclipsed Moon fully behind the camera",
  );

  // And with the aim taken from the same instant as the frame, it does not.
  const correctDirection = Cartesian3.normalize(
    Cartesian3.clone(cameraToMoon, new Cartesian3()),
    new Cartesian3(),
  );
  assert.ok(
    Cartesian3.dot(cameraToMoon, correctDirection) >
      Ellipsoid.MOON.maximumRadius,
  );
});

test("Porto Velho is nowhere near the physical-depth route, so that is not the explanation", () => {
  // The other way moonCommand becomes undefined is the physical route, which
  // hands its command to the scene list instead and returns undefined. Rule it
  // out numerically for the sweep's own geometry rather than by inspection.
  const moonRadius = Ellipsoid.MOON.maximumRadius;
  const earthRadius = Ellipsoid.WGS84.maximumRadius;
  const moon = moonPositionAt(GREATEST);

  for (const height of [90.0, 1.0e7]) {
    const camera = Cartesian3.fromDegrees(
      SITE.longitude,
      SITE.latitude,
      height,
    );
    const gap = computeMoonPhysicalDepthGap(
      camera,
      moon,
      moonRadius,
      earthRadius,
    );
    assert.ok(gap > 3.0e8, `gap at ${height} m was ${gap}`);
    // Both hysteresis states agree: not on the physical route.
    assert.equal(updateMoonPhysicalDepthDemand(false, gap, moonRadius), false);
    assert.equal(updateMoonPhysicalDepthDemand(true, gap, moonRadius), false);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The recipe that does put the Moon on screen
// ───────────────────────────────────────────────────────────────────────────

test("the demo's own targeting maths puts the eclipsed Moon inside a 6-degree view", () => {
  // `pointCameraAtSharedSample` in packages/sandcastle/gallery/eclipse-explorer
  // aims from the observer AT the sample's moonPositionWC — a position, not a
  // direction — with up taken from the site's geodetic surface normal, and a
  // 6-degree telescope field of view.
  const eye = Cartesian3.fromDegrees(
    SITE.longitude,
    SITE.latitude,
    SITE.height,
  );
  const moon = moonPositionAt(GREATEST);
  const direction = Cartesian3.normalize(
    Cartesian3.subtract(moon, eye, new Cartesian3()),
    new Cartesian3(),
  );

  // The gate the WebGPU moon renderer applies, satisfied: the Moon is in
  // front of the camera by more than its own radius.
  const cameraToMoon = Cartesian3.subtract(moon, eye, new Cartesian3());
  assert.ok(
    Cartesian3.dot(cameraToMoon, direction) > Ellipsoid.MOON.maximumRadius,
  );

  // The Moon is essentially overhead at this site and instant, which is the
  // published circumstance for the preset and the reason it was chosen.
  const up = Ellipsoid.WGS84.geodeticSurfaceNormal(eye, new Cartesian3());
  const fromZenith = CesiumMath.toDegrees(
    Math.acos(Cartesian3.dot(direction, up)),
  );
  assert.ok(fromZenith < 3.0, `Moon was ${fromZenith} degrees from the zenith`);

  // And it subtends far more than a pixel at 6 degrees across an 800 px canvas.
  const distance = Cartesian3.distance(moon, eye);
  const angularDiameter = CesiumMath.toDegrees(
    2.0 * Math.asin(Ellipsoid.MOON.maximumRadius / distance),
  );
  assert.ok(angularDiameter > 0.45 && angularDiameter < 0.6);
  assert.ok(
    (800.0 * angularDiameter) / 6.0 > 60.0,
    "disc must be tens of pixels wide",
  );
});

test("aiming from a wall-clock sample puts the Moon behind the camera", () => {
  // The failure the sweep actually hit, stated as a number: aim taken at the
  // wall clock, frame rendered at the eclipse instant.
  const eye = Cartesian3.fromDegrees(
    SITE.longitude,
    SITE.latitude,
    SITE.height,
  );
  const aimed = Cartesian3.normalize(
    Cartesian3.subtract(
      moonPositionAt("2026-08-28T18:37:00Z"),
      eye,
      new Cartesian3(),
    ),
    new Cartesian3(),
  );
  const actual = Cartesian3.normalize(
    Cartesian3.subtract(moonPositionAt(GREATEST), eye, new Cartesian3()),
    new Cartesian3(),
  );
  const separation = CesiumMath.toDegrees(
    Math.acos(CesiumMath.clamp(Cartesian3.dot(aimed, actual), -1.0, 1.0)),
  );
  assert.ok(
    separation > 90.0,
    `expected the Moon behind the camera, got ${separation} degrees off axis`,
  );
});

test("Scene.render takes the frame time, so the prescription below is executable", () => {
  // The whole failure reduces to a frame whose time the probe did not choose.
  // The public API to choose it is the argument this asserts exists, plus its
  // `forceRender` twin, which is the one a request-render probe needs.
  assert.match(sceneSource, /^ {2}render\(time\) \{$/m);
  assert.match(
    sceneSource,
    /^ {2}forceRender\(time\) \{\n {4}this\._renderRequested = true;\n {4}this\.render\(time\);$/m,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 5. THE PRESCRIPTION — what the next Edge session must do differently
// ───────────────────────────────────────────────────────────────────────────
//
// Every assertion above is a fact about the engine or about the sweep's own
// recorded numbers. This block is the operational consequence, written out so
// the next session spends its Edge budget on the lunar legs rather than on
// re-deriving why five configurations saw nothing.
//
//  1. PIN THE CLOCK, AND PASS IT. Set
//     `viewer.clock.shouldAnimate = false` and
//     `viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(GREATEST)`,
//     and then drive frames with `viewer.scene.forceRender(time)` — the same
//     `time` — never with a bare `scene.render()`. A bare call renders at
//     `JulianDate.now()`, and interleaving the two is what produced a camera
//     aimed 146 degrees off the Moon while the frames themselves were at the
//     eclipse instant.
//
//  2. TAKE THE AIM FROM THE PUBLISHED SAMPLE, NOT FROM A RECOMPUTED VECTOR.
//     Read `moonPositionWC` off the same shared frame sample the frame used.
//     A vector recomputed outside the browser is about a third of a degree
//     out — most of a lunar diameter — because this process lacks the
//     IAU2006 XYS data the page has.
//
//  3. AIM AT A POSITION, WITH THE SITE'S UP. `pointCameraAtSharedSample` in
//     packages/sandcastle/gallery/eclipse-explorer is the reference flow:
//     eye = `Cartesian3.fromDegrees(longitude, latitude, observerHeight)`;
//     direction = `normalize(moonPositionWC - eye)`; right =
//     `cross(direction, geodeticSurfaceNormal(eye))`, falling back to UNIT_Z
//     when that degenerates; up = `normalize(cross(right, direction))`; then
//     `camera.setView({ destination: eye, orientation: { direction, up } })`
//     and `camera.frustum.fov = toRadians(6.0)`. Aiming along a DIRECTION
//     from the globe's centre instead of at the POSITION from the site is a
//     second way to miss.
//
//  4. RE-AIM AFTER EVERY CLOCK CHANGE. The aim is a function of the sample,
//     and the sample is a function of the frame time. Stepping the eclipse
//     without re-aiming walks the Moon out of a six-degree field within
//     minutes of simulated time.
//
//  5. DO NOT USE `isMoonVisible` AS THE ORACLE. It is `Scene#isVisible` on
//     the environment-pass moon command: false both when the command is
//     absent and when the culling volume rejects it, and undefined-by-design
//     on the physical-depth route, which hands its command to the scene list
//     instead. The oracle is pixels — count canvas pixels above the sky
//     background inside the expected disc footprint, with the disc's own
//     predicted angular diameter (about half a degree, tens of pixels at a
//     six-degree field on an 800 px canvas) as the sanity bound.
//
//  6. CARRY A VACUITY CONTROL. `moon.show = false` on the same frame must
//     take that pixel count to zero. Without it a bright limb or a star
//     field reads as a Moon.
