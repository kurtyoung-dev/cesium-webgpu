/**
 * Campaign 13 C13-06 — cloud shadow / mask / environment-capture / atmosphere
 * RTE contract spec.
 *
 * Pure Node (`node --test`). Covers:
 *
 *  1. the shared frame owner's f64 math (geodetic footprint centre, forward and
 *     inverse eye-relative matrices, round-trip against the absolute form);
 *  2. an f32-faithful oracle showing the WGS84 shell the shadow producer now
 *     marches and the ~21.4 km polar error the spherical producer had;
 *  3. source ownership: the producer and all three consumers must go through the
 *     one owner and must not re-form `matrix * vec4(fullEcefPosition, 1.0)`;
 *  4. the two consumers that were ALREADY on the shared frame (god-ray mask via
 *     `marchDeck`, environment capture via the CPU-f64 origin phases) are pinned
 *     so a later change cannot silently reintroduce a private approximation;
 *  5. naga validation of every shader this row touched.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultVariant } from "./lib/wgsl-variant.mjs";

import {
  CLOUD_SHADOW_WGS84_A,
  CLOUD_SHADOW_WGS84_B,
  computeCloudShadowFrame,
  createCloudShadowFrame,
  scaleToGeodeticSurface,
  writeCloudShadowInverseViewProjectionRelativeToEye,
  writeCloudShadowViewProjection,
  writeCloudShadowViewProjectionRelativeToEye,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudShadowFrame.ts";

const WGS84_A = CLOUD_SHADOW_WGS84_A;
const WGS84_B = CLOUD_SHADOW_WGS84_B;
const DECK_BOTTOM = 1500.0;
const DECK_TOP = 4000.0;
const FOOTPRINT_M = 60000.0;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

const _ownerSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudShadowFrame.ts",
);
const rendererSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);
const cloudShaderSource = read(
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
);
const densityDomainSource = read(
  "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
);
const globeShaderSource = read(
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);
const globeCameraSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
);
const aerialShaderSource = read(
  "packages/engine/Source/Shaders/WebGPU/PostProcess/AerialPerspective.wgsl",
);
const postProcessSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts",
);
const fogShaderSource = read(
  "packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl",
);
const fogRendererSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts",
);
const environmentShaderSource = read(
  "packages/engine/Source/Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl",
);
const environmentManagerSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
);

// ─── small f64 / f32 helpers (same conventions as cloud-temporal-rte.spec.mjs) ───

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function addScaled(a, direction, scale) {
  return [
    a[0] + direction[0] * scale,
    a[1] + direction[1] * scale,
    a[2] + direction[2] * scale,
  ];
}

function normalize(v) {
  const inverse = 1.0 / Math.hypot(v[0], v[1], v[2]);
  return [v[0] * inverse, v[1] * inverse, v[2] * inverse];
}

function divideVector(a, axes) {
  return [a[0] / axes[0], a[1] / axes[1], a[2] / axes[2]];
}

function shellAxes(height) {
  return [WGS84_A + height, WGS84_A + height, WGS84_B + height];
}

function wgs84Cartesian(latitudeDegrees, longitudeDegrees, height) {
  const latitude = (latitudeDegrees * Math.PI) / 180.0;
  const longitude = (longitudeDegrees * Math.PI) / 180.0;
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const eccentricitySquared = 1.0 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
  const primeVerticalRadius =
    WGS84_A / Math.sqrt(1.0 - eccentricitySquared * sinLatitude * sinLatitude);
  return [
    (primeVerticalRadius + height) * cosLatitude * Math.cos(longitude),
    (primeVerticalRadius + height) * cosLatitude * Math.sin(longitude),
    (primeVerticalRadius * (1.0 - eccentricitySquared) + height) * sinLatitude,
  ];
}

/** Multiply a column-major mat4 (Float32Array/array) by (v.xyz, 1). */
function transformPoint(matrix, offset, v) {
  const out = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) {
    out[row] =
      matrix[offset + 0 + row] * v[0] +
      matrix[offset + 4 + row] * v[1] +
      matrix[offset + 8 + row] * v[2] +
      matrix[offset + 12 + row];
  }
  return out;
}

/** The same product with every operand and intermediate rounded to f32. */
function transformPointF32(matrix, offset, v) {
  const x = Math.fround(v[0]);
  const y = Math.fround(v[1]);
  const z = Math.fround(v[2]);
  const out = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) {
    let acc = Math.fround(Math.fround(matrix[offset + 0 + row]) * x);
    acc = Math.fround(
      acc + Math.fround(Math.fround(matrix[offset + 4 + row]) * y),
    );
    acc = Math.fround(
      acc + Math.fround(Math.fround(matrix[offset + 8 + row]) * z),
    );
    acc = Math.fround(acc + Math.fround(matrix[offset + 12 + row]));
    out[row] = acc;
  }
  return out;
}

/** Exact f64 sun-view NDC for a world point, straight from the frame. */
function transformPointF64(frame, world) {
  const d = subtract(world, [frame.eyeX, frame.eyeY, frame.eyeZ]);
  const right = [frame.rightX, frame.rightY, frame.rightZ];
  const up = [frame.upX, frame.upY, frame.upZ];
  const back = [frame.backX, frame.backY, frame.backZ];
  return [
    dot(right, d) / frame.halfExtent,
    dot(up, d) / frame.halfExtent,
    -(dot(back, d) + frame.near) / (frame.far - frame.near),
    1.0,
  ];
}

/** Reference ray/ellipsoid intersection in f64 scaled space. */
function rayEllipsoidIntersect(origin, direction, axes) {
  const scaledOrigin = divideVector(origin, axes);
  const scaledDirection = divideVector(direction, axes);
  const a = dot(scaledDirection, scaledDirection);
  const closestT = -dot(scaledOrigin, scaledDirection) / a;
  const closest = addScaled(scaledOrigin, scaledDirection, closestT);
  const halfChordSquared = (1.0 - dot(closest, closest)) / a;
  if (halfChordSquared < 0.0) {
    return null;
  }
  const halfChord = Math.sqrt(halfChordSquared);
  return [closestT - halfChord, closestT + halfChord];
}

function frameAt(latitudeDegrees, longitudeDegrees, height, sunDirection) {
  const camera = wgs84Cartesian(latitudeDegrees, longitudeDegrees, height);
  const frame = createCloudShadowFrame();
  const ok = computeCloudShadowFrame(
    frame,
    camera[0],
    camera[1],
    camera[2],
    sunDirection[0],
    sunDirection[1],
    sunDirection[2],
    FOOTPRINT_M,
    WGS84_A,
    WGS84_B,
  );
  return { camera, frame, ok };
}

// ─── 1. geodetic footprint centre ───

test("the footprint centre is a WGS84 geodetic surface point, not a sphere point", () => {
  const cases = [
    [0.0, 0.0],
    [45.0, -75.0],
    [89.9, 179.0],
    [-90.0, 0.0],
    [64.5, 180.0],
  ];
  for (const [latitude, longitude] of cases) {
    const { frame, ok } = frameAt(latitude, longitude, 20000.0, [0, 0, 1]);
    assert.ok(ok, `frame must resolve at ${latitude}/${longitude}`);
    const center = [frame.centerX, frame.centerY, frame.centerZ];
    // On the ellipsoid: (x/a)^2 + (y/a)^2 + (z/b)^2 == 1.
    const scaled = divideVector(center, [WGS84_A, WGS84_A, WGS84_B]);
    assert.ok(
      Math.abs(dot(scaled, scaled) - 1.0) < 1e-12,
      `centre must lie on WGS84 at ${latitude}/${longitude}`,
    );
  }
});

test("the retired spherical projection displaced the polar footprint by kilometres", () => {
  const camera = wgs84Cartesian(90.0, 0.0, 20000.0);
  const frame = createCloudShadowFrame();
  computeCloudShadowFrame(
    frame,
    camera[0],
    camera[1],
    camera[2],
    0,
    0,
    1,
    FOOTPRINT_M,
    WGS84_A,
    WGS84_B,
  );
  // The pre-C13-06 producer used `position / |position| * 6378137`.
  const magnitude = Math.hypot(camera[0], camera[1], camera[2]);
  const sphericalCenter = [
    (camera[0] / magnitude) * WGS84_A,
    (camera[1] / magnitude) * WGS84_A,
    (camera[2] / magnitude) * WGS84_A,
  ];
  const geodeticCenter = [frame.centerX, frame.centerY, frame.centerZ];
  const displacement = Math.hypot(...subtract(sphericalCenter, geodeticCenter));
  assert.ok(
    displacement > 21000.0,
    `polar sphere/ellipsoid displacement should exceed 21 km, got ${displacement.toFixed(1)} m`,
  );
  // ...and it is more than a whole cloud deck thick, which is why the shadow
  // pass marched empty space above the rendered deck at high latitude.
  assert.ok(displacement > (DECK_TOP - DECK_BOTTOM) * 8.0);
});

test("scaleToGeodeticSurface rejects a degenerate input instead of emitting NaN", () => {
  const out = { x: 0, y: 0, z: 0 };
  assert.equal(scaleToGeodeticSurface(out, 0, 0, 0, WGS84_A, WGS84_B), false);
  const frame = createCloudShadowFrame();
  assert.equal(
    computeCloudShadowFrame(
      frame,
      0,
      0,
      0,
      0,
      0,
      1,
      FOOTPRINT_M,
      WGS84_A,
      WGS84_B,
    ),
    false,
  );
  assert.equal(frame.valid, false);
  // A zero sun vector is equally inert.
  const camera = wgs84Cartesian(0, 0, 10000);
  assert.equal(
    computeCloudShadowFrame(
      frame,
      camera[0],
      camera[1],
      camera[2],
      0,
      0,
      0,
      FOOTPRINT_M,
      WGS84_A,
      WGS84_B,
    ),
    false,
  );
  assert.equal(frame.valid, false);
});

// ─── 2. eye-relative matrices are the absolute map, without the big numbers ───

test("the eye-relative forward matrix reproduces the absolute projection", () => {
  const sun = normalize([0.3, -0.8, 0.5]);
  const { camera, frame, ok } = frameAt(48.0, 11.0, 2000.0, sun);
  assert.ok(ok);

  const absolute = new Float32Array(16);
  writeCloudShadowViewProjection(absolute, 0, frame);
  const relative = new Float32Array(16);
  writeCloudShadowViewProjectionRelativeToEye(
    relative,
    0,
    frame,
    camera[0],
    camera[1],
    camera[2],
  );

  // Sample fragments spread across the footprint, including the corners.
  const offsets = [
    [0, 0, 0],
    [FOOTPRINT_M, 0, -2000],
    [-FOOTPRINT_M, FOOTPRINT_M, 500],
    [12345.6, -54321.7, -1999.9],
  ];
  for (const offset of offsets) {
    const world = [
      frame.centerX + offset[0],
      frame.centerY + offset[1],
      frame.centerZ + offset[2],
    ];
    const fromAbsolute = transformPoint(absolute, 0, world);
    const fromRelative = transformPoint(relative, 0, subtract(world, camera));
    for (let i = 0; i < 3; i++) {
      assert.ok(
        Math.abs(fromAbsolute[i] - fromRelative[i]) < 2e-4,
        `NDC component ${i} must agree (abs ${fromAbsolute[i]}, rte ${fromRelative[i]})`,
      );
    }
  }
});

test("no eye-relative matrix entry carries a planet-scale magnitude", () => {
  const sun = normalize([0.0, 0.2, 1.0]);
  for (const height of [0.0, 2000.0, 20000.0, 800_000.0, 18_000_000.0]) {
    const { camera, frame } = frameAt(78.0, 15.0, height, sun);
    const relative = new Float32Array(16);
    writeCloudShadowViewProjectionRelativeToEye(
      relative,
      0,
      frame,
      camera[0],
      camera[1],
      camera[2],
    );
    // Consumer side: every entry is an NDC-scale quantity, never a radius.
    for (let i = 0; i < 16; i++) {
      assert.ok(
        Math.abs(relative[i]) < 1.0e3,
        `forward entry ${i} = ${relative[i]} must stay far below the ~6.4e6 m ECEF scale`,
      );
    }

    // Producer side: the inverse's translation column is `orthoEye - camera`,
    // so it is bounded by the camera's own distance to the footprint plus the
    // ortho push-back. That is the RTE frame's inherent resolution — the same
    // limit the visible march's own `rayDir * t` samples have — and it is never
    // the raw planet radius the pre-C13-06 matrix carried at every altitude.
    const inverse = new Float32Array(16);
    writeCloudShadowInverseViewProjectionRelativeToEye(
      inverse,
      0,
      frame,
      camera[0],
      camera[1],
      camera[2],
    );
    const cameraToCenter = Math.hypot(
      ...subtract(camera, [frame.centerX, frame.centerY, frame.centerZ]),
    );
    const bound = cameraToCenter + frame.distance + frame.far;
    for (let i = 0; i < 16; i++) {
      assert.ok(
        Math.abs(inverse[i]) <= bound,
        `inverse entry ${i} = ${inverse[i]} exceeds the camera-relative bound ${bound}`,
      );
    }
    if (height <= 800_000.0) {
      for (let i = 0; i < 16; i++) {
        assert.ok(
          Math.abs(inverse[i]) < 1.0e6,
          `inverse entry ${i} = ${inverse[i]} must stay sub-planet-scale in the near-ground regime the footprint targets`,
        );
      }
    }
  }
});

test("the frame owner matches Cesium's geodetic surface projection everywhere", async () => {
  // Cross-validation against the shipped Core implementation. The owner
  // re-implements the algorithm in scalars (no Cartesian3 allocation on the
  // per-frame path); this pins it to the engine's own answer rather than to a
  // hand-written expectation.
  const { default: Ellipsoid } = await import(
    pathToFileURL(path.join(root, "packages/engine/Source/Core/Ellipsoid.js"))
      .href
  );
  const { default: Cartesian3 } = await import(
    pathToFileURL(path.join(root, "packages/engine/Source/Core/Cartesian3.js"))
      .href
  );

  let worst = 0.0;
  const out = { x: 0, y: 0, z: 0 };
  for (const latitude of [-90, -64.5, -33.9, 0, 45, 64, 89.9, 90]) {
    for (const longitude of [-180, -21, 0, 11, 179.9]) {
      for (const height of [-500, 0, 1500, 20000, 800000, 18000000, 4e8]) {
        const position = wgs84Cartesian(latitude, longitude, height);
        const ok = scaleToGeodeticSurface(
          out,
          position[0],
          position[1],
          position[2],
          WGS84_A,
          WGS84_B,
        );
        assert.ok(ok, `owner must resolve ${latitude}/${longitude}/${height}`);
        const expected = Ellipsoid.WGS84.scaleToGeodeticSurface(
          new Cartesian3(position[0], position[1], position[2]),
        );
        assert.ok(expected, "Cesium reference must resolve");
        worst = Math.max(
          worst,
          Math.hypot(
            out.x - expected.x,
            out.y - expected.y,
            out.z - expected.z,
          ),
        );
      }
    }
  }
  assert.ok(
    worst < 1e-6,
    `owner must track Cesium's projection to well under a micrometre, got ${worst}`,
  );
});

test("the eye-relative projection is far more accurate in f32 than the absolute one", () => {
  // End-to-end f32 oracle: the defect the RTE law names is not the matrix alone,
  // it is `matrix * vec4(position, 1.0)` where BOTH operands are planet-scale.
  const sun = normalize([0.2, 0.15, 0.97]);
  const { camera, frame } = frameAt(64.0, -21.0, 1500.0, sun);

  const absolute = new Float32Array(16);
  writeCloudShadowViewProjection(absolute, 0, frame);
  const relative = new Float32Array(16);
  writeCloudShadowViewProjectionRelativeToEye(
    relative,
    0,
    frame,
    camera[0],
    camera[1],
    camera[2],
  );

  let worstAbsolute = 0.0;
  let worstRelative = 0.0;
  const footprintOffsets = [
    [0, 0, 0],
    [37_000, -21_000, -1200],
    [-52_000, 8_000, 400],
    [11_111, 47_777, -900],
  ];
  for (const offset of footprintOffsets) {
    const world = [
      frame.centerX + offset[0],
      frame.centerY + offset[1],
      frame.centerZ + offset[2],
    ];
    const reference = transformPointF64(frame, world);
    const viaAbsolute = transformPointF32(absolute, 0, world);
    const viaRelative = transformPointF32(relative, 0, subtract(world, camera));
    for (let i = 0; i < 2; i++) {
      worstAbsolute = Math.max(
        worstAbsolute,
        Math.abs(viaAbsolute[i] - reference[i]) * frame.halfExtent,
      );
      worstRelative = Math.max(
        worstRelative,
        Math.abs(viaRelative[i] - reference[i]) * frame.halfExtent,
      );
    }
  }

  assert.ok(
    worstRelative < 0.02,
    `eye-relative footprint error should be sub-centimetre, got ${worstRelative.toFixed(4)} m`,
  );
  assert.ok(
    worstAbsolute > worstRelative * 10.0,
    `the absolute form should be an order of magnitude worse (abs ${worstAbsolute.toFixed(4)} m vs rte ${worstRelative.toFixed(4)} m)`,
  );
});

test("the inverse eye-relative matrix reconstructs camera-relative columns", () => {
  const sun = normalize([0.6, 0.1, 0.79]);
  const { camera, frame } = frameAt(-33.9, 151.2, 5000.0, sun);
  const forward = new Float32Array(16);
  writeCloudShadowViewProjectionRelativeToEye(
    forward,
    0,
    frame,
    camera[0],
    camera[1],
    camera[2],
  );
  const inverse = new Float32Array(16);
  writeCloudShadowInverseViewProjectionRelativeToEye(
    inverse,
    0,
    frame,
    camera[0],
    camera[1],
    camera[2],
  );

  for (const ndc of [
    [0, 0, 0],
    [-1, -1, 0],
    [1, 1, 0],
    [0.37, -0.62, 0],
  ]) {
    const columnRelative = transformPoint(inverse, 0, ndc);
    assert.ok(
      Math.abs(columnRelative[3] - 1.0) < 1e-6,
      "the inverse ortho map must stay affine",
    );
    // Round-trip: projecting the reconstructed column must return the same NDC.
    const back = transformPoint(forward, 0, [
      columnRelative[0],
      columnRelative[1],
      columnRelative[2],
    ]);
    assert.ok(Math.abs(back[0] - ndc[0]) < 1e-4);
    assert.ok(Math.abs(back[1] - ndc[1]) < 1e-4);
    // The reconstructed column is a SMALL camera-relative vector, not ECEF.
    const magnitude = Math.hypot(
      columnRelative[0],
      columnRelative[1],
      columnRelative[2],
    );
    assert.ok(
      magnitude < 1.0e6,
      `column ${magnitude} must be camera-relative, not full ECEF`,
    );
  }
});

// ─── 3. the shell the shadow producer marches is the one the march renders ───

test("the shadow sun ray meets the WGS84 deck the visible march renders", () => {
  // Polar case: the spherical shell the producer used to intersect sits ~21.4 km
  // outside the WGS84 shell, so the shadow column met no cloud at all.
  const sun = normalize([0.0, 0.0, 1.0]);
  const { frame } = frameAt(89.0, 0.0, 3000.0, sun);
  const column = [frame.centerX, frame.centerY, frame.centerZ + 40000.0];
  const rayDirection = [-sun[0], -sun[1], -sun[2]];

  const outer = rayEllipsoidIntersect(
    column,
    rayDirection,
    shellAxes(DECK_TOP),
  );
  const inner = rayEllipsoidIntersect(
    column,
    rayDirection,
    shellAxes(DECK_BOTTOM),
  );
  assert.ok(
    outer !== null && inner !== null,
    "the polar column must hit both shells",
  );

  const enter = Math.max(outer[0], 0.0);
  const exit = inner[0] > 0.0 ? Math.min(outer[1], inner[0]) : outer[1];
  assert.ok(exit > enter, "the marched span must be non-empty");

  // Every sample inside the span must have a geodetic height inside the deck.
  for (let i = 0; i < 8; i++) {
    const t = enter + ((i + 0.5) * (exit - enter)) / 8;
    const sample = addScaled(column, rayDirection, t);
    const innerScaled = divideVector(sample, shellAxes(DECK_BOTTOM));
    const outerScaled = divideVector(sample, shellAxes(DECK_TOP));
    assert.ok(
      dot(innerScaled, innerScaled) >= 1.0 - 1e-9,
      "sample must be at or above the deck bottom shell",
    );
    assert.ok(
      dot(outerScaled, outerScaled) <= 1.0 + 1e-9,
      "sample must be at or below the deck top shell",
    );
  }

  // The retired spherical shell is nowhere near this span at the pole.
  const sphericalTop = WGS84_A + DECK_TOP;
  const sampleRadius = Math.hypot(
    ...addScaled(column, rayDirection, 0.5 * (enter + exit)),
  );
  assert.ok(
    sphericalTop - sampleRadius > 15000.0,
    "the equatorial-sphere shell was more than a deck thickness away at the pole",
  );
});

// ─── 4. source ownership — one frame owner, no planet-scale products ───

test("the producer builds its sun frame through the shared owner only", () => {
  assert.match(rendererSource, /computeCloudShadowFrame\s*\(/);
  assert.match(
    rendererSource,
    /writeCloudShadowInverseViewProjectionRelativeToEye\s*\(/,
    "the shadow FS must receive an eye-relative inverse VP",
  );
  assert.doesNotMatch(
    rendererSource,
    /buildSunViewOrthoVP\s*\(/,
    "the retired f32 sun-view builder must not come back",
  );
  assert.doesNotMatch(
    rendererSource,
    /const surf = 6378137/,
    "the spherical footprint-centre projection must not come back",
  );
  // The shell radii the WGSL reads and the radii the frame projects onto must be
  // one value, or the map lands on a different deck than the render.
  assert.match(
    rendererSource,
    /const WGS84_EQUATORIAL_RADIUS = CLOUD_SHADOW_WGS84_A;/,
  );
  assert.match(
    rendererSource,
    /const WGS84_POLAR_RADIUS = CLOUD_SHADOW_WGS84_B;/,
  );
  // A degenerate frame must not publish an active shadow.
  assert.match(rendererSource, /cache\.shadowActive = frameOk;/);
  assert.match(rendererSource, /cache\.shadowCascadeActive = frameOk;/);
});

test("the shadow entry point is WGS84 and camera-relative on both branches", () => {
  const start = cloudShaderSource.indexOf("fn cloudShadowMain(");
  assert.ok(start > 0, "cloudShadowMain must exist");
  const body = cloudShaderSource.slice(start);

  // WGS84 shells on BOTH the high-precision and the explicit A/B branch.
  assert.match(body, /cloudShellAxes\(deckBottom\)/);
  assert.match(body, /cloudShellAxes\(deckTop\)/);
  assert.match(body, /rayEllipsoidIntersectRTE\(/);
  assert.match(body, /rayEllipsoidIntersect\(/);
  assert.doesNotMatch(
    body,
    /raySphereIntersect\(/,
    "the shadow shell must not be a sphere",
  );
  assert.doesNotMatch(
    body,
    /length\(samplePos\) - cloud\.planetRadius/,
    "radial altitude is not a geodetic height",
  );

  // The RTE branch reconstructs a camera-relative column and stays relative.
  assert.match(body, /sunViewInvVpRelativeToEye \* vec4<f32>\(ndc, 1\.0\)/);
  assert.match(body, /let columnCenterLow = centerLow - columnRelative;/);
  assert.match(body, /ellipsoidShellHeightFractionRTE\(/);
  assert.match(body, /cloudDensityRelativeWithFootprint\(/);
  // ...and the legacy escape route is preserved, not deleted.
  assert.match(body, /highPrecisionEnabled\(\)/);
  assert.match(body, /ellipsoidShellHeightFraction\(/);
  assert.match(body, /cloudDensityWithFootprint\(/);
});

test("the shadow density route reads the same origin phases as the visible march", () => {
  assert.match(
    cloudShaderSource,
    /fn cloudDensityRelativeWithFootprint\(/,
    "C13-06 must add the camera-relative density twin",
  );
  const start = cloudShaderSource.indexOf(
    "fn cloudDensityRelativeWithFootprint(",
  );
  const end = cloudShaderSource.indexOf("\nfn ", start + 1);
  const body = cloudShaderSource.slice(start, end);
  assert.match(body, /cloudDensityCoordinatesAtRelative\(relativePos\)/);
  assert.match(body, /cloudMorphologyCoordinateAtRelative\(relativePos\)/);
  assert.doesNotMatch(
    body,
    /cloudDensityCoordinatesAtWorld\(/,
    "the RTE route must not rebuild domains from a raw ECEF coordinate",
  );
  // The world position is reconstructed for the geographic weather lookup ONLY,
  // in the established high-then-low order.
  assert.match(
    body,
    /let worldPos = \(relativePos - centerHigh\) - centerLow;/,
  );
  // The two helpers the earlier batches scaffolded for C13-06 are now live, so
  // their SCAFFOLDING markers must be gone (Principle 7 bookkeeping).
  const relativeCoordDoc = densityDomainSource + cloudShaderSource;
  const scaffoldMarkers = [
    ...relativeCoordDoc.matchAll(/SCAFFOLDING \(Principle 7\)[^]{0,400}?\n/g),
  ].map((m) => m[0]);
  for (const marker of scaffoldMarkers) {
    assert.ok(
      !marker.includes("cloudDensityCoordinatesAtRelative") &&
        !marker.includes("cloudMorphologyCoordinateAtRelative"),
      "the camera-relative density helpers are wired now; drop their scaffolding marker",
    );
  }
});

test("every cloud-shadow consumer projects a camera-relative operand", () => {
  // Globe terrain.
  assert.match(globeShaderSource, /fn cloudShadowPositionOperand\(/);
  assert.match(
    globeShaderSource,
    /cloudShadowPositionOperand\(input\.v_positionRTE, input\.v_positionMC\)/,
  );
  assert.doesNotMatch(
    globeShaderSource,
    /sampleCloudGroundShadow\(input\.v_positionMC\)/,
    "SCENE3D must not project the full-ECEF fragment position",
  );
  assert.match(
    globeCameraSource,
    /writeCloudShadowViewProjectionRelativeToEye\(/,
  );
  assert.match(
    globeCameraSource,
    /const cloudShadowRelativeToEye =\s*\n?\s*sceneMode === 3 &&\s*\n?\s*cloudShadowFrame\?\.valid === true &&/,
    "the eye-relative branch requires SCENE3D (v_positionRTE is zero elsewhere) and a valid frame",
  );
  assert.match(
    globeCameraSource,
    /cloudShadowCascadeFrames\.every\(\(frame\) => frame\.valid\)/,
    "the flag is all-or-nothing: every emitted cascade matrix must share the frame",
  );

  // Aerial perspective.
  assert.match(
    aerialShaderSource,
    /fn sampleCloudInscatterShadow\(offsetFromCamera: vec3<f32>\)/,
  );
  assert.match(
    aerialShaderSource,
    /uniforms\.cloudShadowVP \* vec4<f32>\(offsetFromCamera, 1\.0\)/,
  );
  assert.match(aerialShaderSource, /let fragOffsetWC = rayDir \* eyeDistance;/);
  assert.doesNotMatch(
    aerialShaderSource,
    /sampleCloudInscatterShadow\(fragWC\)/,
    "the inscatter shadow must consume the camera-relative offset",
  );
  assert.match(
    postProcessSource,
    /writeCloudShadowViewProjectionRelativeToEye\(/,
  );

  // Volumetric fog.
  assert.match(fogShaderSource, /fn froxelOffsetFromCamera\(gid: vec3<u32>\)/);
  assert.match(
    fogShaderSource,
    /u\.cloudShadowSunViewVP \* vec4<f32>\(offsetFromCamera, 1\.0\)/,
  );
  assert.match(
    fogShaderSource,
    /sampleCloudShadow\(worldPos, froxelOffsetFromCamera\(gid\)\)/,
  );
  assert.match(
    fogRendererSource,
    /writeCloudShadowViewProjectionRelativeToEye\(/,
  );
  assert.match(
    fogRendererSource,
    /cloudCacheForFog\.shadowFrame\?\.valid === true/,
    "the hi-fi fog branch must not open without a valid eye-relative frame",
  );

  // The froxel path shares the same operand as the analytic path.
  assert.match(
    aerialShaderSource,
    /froxelInscatter \* sampleCloudInscatterShadow\(fragOffsetWC\)/,
  );
});

test("the eye-relative flag is published for every globe branch", () => {
  // Both the cascade tail and the single-map tail must carry the flag, or the FS
  // would project v_positionRTE through an absolute matrix (or vice versa).
  const cascadeTail = globeCameraSource.slice(
    globeCameraSource.indexOf("cascade tail (196-231)"),
  );
  const flagWrites = [
    ...cascadeTail.matchAll(/cloudShadowRelativeToEye \? 1\.0 : 0\.0/g),
  ];
  assert.equal(
    flagWrites.length,
    2,
    "both the cascade and the non-cascade tail must publish the flag",
  );
  assert.match(
    globeShaderSource,
    /camera\.cloudShadowCascadeParams\.y > 0\.5/,
    "the FS gate must read the published flag",
  );
});

// ─── 5. the consumers that were ALREADY on the owner stay there ───

test("the god-ray transmittance mask stays on the primary marchDeck RTE frame", () => {
  const start = cloudShaderSource.indexOf("fn fragmentCloudMaskMain(");
  assert.ok(start > 0);
  const end = cloudShaderSource.indexOf("\n@fragment", start);
  const body = cloudShaderSource.slice(start, end > start ? end : undefined);
  assert.match(body, /let centerHigh = -cloud\.encodedCameraHigh;/);
  assert.match(body, /let centerLow = -cloud\.encodedCameraLow;/);
  assert.match(body, /marchDeck\(/);
  assert.doesNotMatch(
    body,
    /raySphereIntersect\(/,
    "the mask must inherit marchDeck's WGS84 shells, not roll its own",
  );
  assert.doesNotMatch(
    body,
    /cloudDensityCoordinatesAtWorld\(/,
    "the mask must not build a private density coordinate",
  );
  // The mask still reuses the SAME per-frame bind group as the visible march, so
  // it cannot drift onto a different uniform frame.
  assert.match(rendererSource, /maskPass\.setBindGroup\(0, bindGroup\);/);
});

test("environment capture stays on the CPU-f64 origin phases and a geodetic radius", () => {
  assert.match(
    environmentShaderSource,
    /cloudDensityCoordinatesFromOriginPhases\(/,
    "the reflected-cloud march must read the shared planet-stable domain",
  );
  assert.match(
    environmentShaderSource,
    /let captureOriginLocal =\s*\n?\s*vec3<f32>\(0\.0, u\.innerRadius \+ u\.ellipsoidHeight, 0\.0\);/,
  );
  assert.doesNotMatch(
    environmentShaderSource,
    /cloudDensityCoordinatesFromWorldNoise\(/,
    "the capture must not rebuild domains from a raw world coordinate",
  );
  assert.match(
    environmentManagerSource,
    /writeCloudDensityAdvectedOriginPhases\(/,
  );
  assert.match(
    environmentManagerSource,
    /scaleToGeodeticSurface\?\.\(/,
    "the capture frame's surface radius must be geodetic, not an equatorial sphere",
  );
});

// ─── 6. naga ───

test("every shader C13-06 touched passes naga validation", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });

  assert.doesNotThrow(() =>
    naga.validate_wgsl(
      `${densityDomainSource}\n${defaultVariant(cloudShaderSource)}`,
    ),
  );
  assert.doesNotThrow(() =>
    naga.validate_wgsl(defaultVariant(aerialShaderSource)),
  );
  // CLOUD-LOW-COVERAGE-CUTOFF (fog arm) — VolumetricFog now consumes the
  // shared `cloudEffectiveCoverage` from the density-domain chunk, so its
  // compiled unit is the composition, exactly as the visible march's is.
  // `WebGPUVolumetricFogResources` prepends the same chunk at module scope.
  assert.doesNotThrow(() =>
    naga.validate_wgsl(
      `${densityDomainSource}\n${defaultVariant(fogShaderSource)}`,
    ),
  );
  // GlobeTerrain carries //>>ifdef blocks; validate the defines = 0 expansion
  // (the historical //>>else branch of every block), matching the shipped
  // preprocessor's zero-mask contract.
  assert.doesNotThrow(() =>
    naga.validate_wgsl(expandZeroDefines(globeShaderSource)),
  );
});

// C13-10 — this used to be a hand-rolled re-implementation of the preprocessor
// living in one spec. Three cloud shaders gained `//>>ifdef` variants in that
// row, so several specs suddenly needed the same expansion, and six divergent
// approximations of the engine's preprocessor is exactly the CPU-twin drift
// this fleet has been burned by before. `defaultVariant` in
// `lib/wgsl-variant.mjs` calls the ENGINE's `preprocess` at `definesHi = 0`,
// which is the same expansion this function performed and is guaranteed to
// track the real one.
const expandZeroDefines = defaultVariant;
