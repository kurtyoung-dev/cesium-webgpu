// eclipse-globe-umbra-rte.spec.mjs — C12-29 S5 regression contract.
// @purpose C12-29 S5 regression contract: CPU fit/composition laws, camera-independent common-ray representation, matching WebGL/WebGPU resource architecture.
// @status ACTIVE
//
// Pins the CPU fit/composition laws, the camera-independent common-ray
// representation, and the matching WebGL/WebGPU resource architecture.
//
// Run: node --test Tools/visual-regression/eclipse-globe-umbra-rte.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const sourceRoot = path.join(root, "packages", "engine", "Source");
const sourcePath = (relativePath) => path.join(sourceRoot, relativePath);
const readSource = (relativePath) =>
  fs.readFileSync(sourcePath(relativePath), "utf8");

const {
  applyLimbDarkeningFit,
  composeGlobeSurfaceFactor,
  compositionReciprocal,
  createEclipseGlobeShadow,
  evaluateFragmentObscuration,
  fitEclipseLimbDarkening,
  surfaceEclipsePossible,
  maximumSurfaceDiscSupport,
  ECLIPSE_BROAD_REJECT_SAFETY_FACTOR,
  PENUMBRA_CONE_SAFETY_METERS,
  TERRAIN_ECLIPSE_BOUND_SAFETY_METERS,
  TERRAIN_ECLIPSE_BOUND_RELATIVE_SAFETY,
  eclipsePenumbraIntersectsBoundingSphere,
  computeRenderedMeshEclipseBoundingSphere,
  selectedTerrainIntersectsPenumbra,
  eclipseSunVisibleAboveEllipsoid,
  updateEclipseGlobeShadow,
  updateEclipseGlobeShadowForFrameState,
} = await import(pathToFileURL(sourcePath("Scene/EclipseGlobeShadow.js")).href);
const {
  ECLIPSE_RADIOMETRIC_FLOOR,
  ECLIPSE_ADAPTATION_EXPONENT,
  eclipseSceneLightCurve,
} = await import(pathToFileURL(sourcePath("Scene/EclipseState.js")).href);
const { computeSolarObscuration } = await import(
  pathToFileURL(sourcePath("Scene/computeSolarObscuration.js")).href
);
const { default: Cartesian3 } = await import(
  pathToFileURL(sourcePath("Core/Cartesian3.js")).href
);
const { default: Ellipsoid } = await import(
  pathToFileURL(sourcePath("Core/Ellipsoid.js")).href
);
const { default: DrawCommand } = await import(
  pathToFileURL(sourcePath("Renderer/DrawCommand.js")).href
);
const { default: GlobeTranslucencyState } = await import(
  pathToFileURL(sourcePath("Scene/GlobeTranslucencyState.js")).href
);
const { createWebGLViewBoundGlobeCommand, pushWebGLViewBoundGlobeCommand } =
  await import(
    pathToFileURL(sourcePath("Scene/GlobeSurfaceTileProviderRendering.js")).href
  );

const SOLAR_RADIUS = 695_700_000.0;
const LUNAR_RADIUS = 1_737_400.0;
const AU = 149_597_870_700.0;
const EARTH_RADIUS = 6_378_137.0;

test("WebGL pick replays isolate the logical View S5 carrier", () => {
  const packedA = new Float32Array(16).fill(1.0);
  const packedB = new Float32Array(16).fill(2.0);
  const shadowA = { webglPackedUniform: packedA };
  const shadowB = { webglPackedUniform: packedB };
  const pooledUniformMap = {
    u_eclipseGlobeShadow() {
      return this.properties.eclipseGlobeShadow.webglPackedUniform;
    },
    u_liveOrdinaryUniform() {
      return this.properties.liveOrdinaryUniform;
    },
    properties: {
      eclipseGlobeShadow: shadowA,
      liveOrdinaryUniform: 7,
    },
  };
  const owner = {};
  const pooledCommand = new DrawCommand({
    owner,
    uniformMap: pooledUniformMap,
  });

  const viewACommand = createWebGLViewBoundGlobeCommand(pooledCommand, shadowA);
  const viewBCommand = createWebGLViewBoundGlobeCommand(pooledCommand, shadowB);

  assert.notEqual(viewACommand, pooledCommand);
  assert.notEqual(viewBCommand, pooledCommand);
  assert.notEqual(viewACommand.uniformMap, viewBCommand.uniformMap);
  assert.equal(
    Object.hasOwn(viewACommand.uniformMap, "u_eclipseGlobeShadow"),
    true,
  );
  assert.equal(
    Object.hasOwn(viewACommand.uniformMap, "u_liveOrdinaryUniform"),
    true,
  );
  assert.equal(
    viewACommand.uniformMap.u_liveOrdinaryUniform,
    pooledUniformMap.u_liveOrdinaryUniform,
  );
  assert.equal(viewACommand.owner, owner);
  assert.equal(viewBCommand.owner, owner);
  assert.equal(pooledUniformMap.properties.eclipseGlobeShadow, shadowA);
  assert.notEqual(
    viewACommand.uniformMap.properties.eclipseGlobeShadow,
    shadowA,
  );
  assert.notEqual(
    viewBCommand.uniformMap.properties.eclipseGlobeShadow,
    shadowB,
  );
  const retainedA = viewACommand.uniformMap.u_eclipseGlobeShadow();
  const retainedB = viewBCommand.uniformMap.u_eclipseGlobeShadow();
  assert.deepEqual(Array.from(retainedA), Array.from(packedA));
  assert.deepEqual(Array.from(retainedB), Array.from(packedB));
  assert.equal(Object.isFrozen(retainedA), true);
  assert.equal(Object.isFrozen(retainedB), true);

  // Preparing B must not change the live getter/value retained by A, while
  // a later mutation of View A's reusable source object cannot rewrite the
  // older preparation. Every unrelated pooled property stays live rather than
  // being copied.
  packedA[0] = 9.0;
  pooledUniformMap.properties.liveOrdinaryUniform = 11;
  assert.equal(viewACommand.uniformMap.u_eclipseGlobeShadow()[0], 1.0);
  assert.equal(viewACommand.uniformMap.u_liveOrdinaryUniform(), 11);
  assert.equal(viewBCommand.uniformMap.u_liveOrdinaryUniform(), 11);

  const descriptor = Object.getOwnPropertyDescriptor(
    viewACommand.uniformMap.properties,
    "eclipseGlobeShadow",
  );
  assert.equal(descriptor.value.webglPackedUniform, retainedA);
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);
  assert.throws(() => {
    viewACommand.uniformMap.properties.eclipseGlobeShadow = shadowB;
  }, TypeError);
});

function createTestGlobeTranslucencyState() {
  const state = new GlobeTranslucencyState();
  const pickFrontFaceType = 9;

  // Exercise GlobeTranslucencyState's real derived-command lifecycle while
  // replacing shader/render-state derivation with identity functions. The
  // derived uniform-map function deliberately invokes combine(), which copies
  // only own uniform-map properties and caught the prototype-only mutant.
  state._frontFaceTranslucent = true;
  state._derivedCommandsDirty = false;
  state._derivedCommandPacks = [];
  state._derivedCommandPacks[pickFrontFaceType] = {
    pass: 71,
    pickOnly: true,
    getShaderProgramFunction: undefined,
    getRenderStateFunction: undefined,
    getUniformMapFunction() {
      return {
        u_translucencySentinel() {
          return 13;
        },
      };
    },
    renderStateCache: {},
  };
  state._derivedCommandsToUpdateLength = 1;
  state._derivedCommandTypesToUpdate[0] = pickFrontFaceType;
  state._derivedPickCommandsLength = 1;
  state._derivedPickCommandTypes[0] = pickFrontFaceType;
  return state;
}

function createTestPickFrame(
  eclipseGlobeShadow,
  globeTranslucencyState,
  frameNumber,
) {
  return {
    eclipseGlobeShadow,
    globeTranslucencyState,
    frameNumber,
    passes: {
      pick: true,
      pickVoxel: false,
    },
    commandList: [],
    context: {
      getFeatureRenderer() {
        return undefined;
      },
    },
  };
}

test("WebGL View-bound replays own translucent pick derivations", () => {
  const packedA = new Float32Array(16).fill(3.0);
  const packedB = new Float32Array(16).fill(5.0);
  const shadowA = { webglPackedUniform: packedA };
  const shadowB = { webglPackedUniform: packedB };
  const pooledUniformMap = {
    u_eclipseGlobeShadow() {
      return this.properties.eclipseGlobeShadow.webglPackedUniform;
    },
    u_liveOrdinaryUniform() {
      return this.properties.liveOrdinaryUniform;
    },
    properties: {
      eclipseGlobeShadow: shadowA,
      liveOrdinaryUniform: 17,
    },
  };
  const pooledCommand = new DrawCommand({
    uniformMap: pooledUniformMap,
    shaderProgram: { id: 19 },
    renderState: { id: 23, blending: { enabled: false } },
  });
  const pooledDerivedCommands = pooledCommand.derivedCommands;
  const translucentState = createTestGlobeTranslucencyState();
  const frameA = createTestPickFrame(shadowA, translucentState, 101);
  const frameB = createTestPickFrame(shadowB, translucentState, 102);

  const viewACommand = pushWebGLViewBoundGlobeCommand(pooledCommand, frameA);
  const viewBCommand = pushWebGLViewBoundGlobeCommand(pooledCommand, frameB);
  const pickA = frameA.commandList[0];
  const pickB = frameB.commandList[0];

  assert.equal(frameA.commandList.length, 1);
  assert.equal(frameB.commandList.length, 1);
  assert.notEqual(pickA, viewACommand);
  assert.notEqual(pickB, viewBCommand);
  assert.equal(
    viewACommand.derivedCommands.globeTranslucency.pickFrontFaceCommand,
    pickA,
  );
  assert.equal(
    viewBCommand.derivedCommands.globeTranslucency.pickFrontFaceCommand,
    pickB,
  );
  assert.notEqual(viewACommand.derivedCommands, viewBCommand.derivedCommands);
  assert.notEqual(
    viewACommand.derivedCommands.globeTranslucency,
    viewBCommand.derivedCommands.globeTranslucency,
  );
  assert.equal(Object.hasOwn(pickA.uniformMap, "u_eclipseGlobeShadow"), true);
  assert.equal(Object.hasOwn(pickA.uniformMap, "u_liveOrdinaryUniform"), true);
  assert.equal(pickA.uniformMap.u_translucencySentinel(), 13);
  assert.equal(pickB.uniformMap.u_translucencySentinel(), 13);
  assert.deepEqual(
    Array.from(pickA.uniformMap.u_eclipseGlobeShadow()),
    new Array(16).fill(3.0),
  );
  assert.deepEqual(
    Array.from(pickB.uniformMap.u_eclipseGlobeShadow()),
    new Array(16).fill(5.0),
  );

  // The derived command keeps A's immutable carrier after B is prepared, but
  // unrelated values continue to resolve through the live pooled properties.
  packedA[0] = 29.0;
  pooledUniformMap.properties.liveOrdinaryUniform = 31;
  assert.equal(pickA.uniformMap.u_eclipseGlobeShadow()[0], 3.0);
  assert.equal(pickA.uniformMap.u_liveOrdinaryUniform(), 31);
  assert.equal(pickB.uniformMap.u_liveOrdinaryUniform(), 31);

  // The ephemeral derived graph must not leak back into the pooled command.
  assert.equal(pooledCommand.uniformMap, pooledUniformMap);
  assert.equal(pooledCommand.derivedCommands, pooledDerivedCommands);
  assert.deepEqual(Object.keys(pooledDerivedCommands), []);

  const opaqueState = new GlobeTranslucencyState();
  const opaqueFrame = createTestPickFrame(shadowA, opaqueState, 103);
  const opaqueReplay = pushWebGLViewBoundGlobeCommand(
    pooledCommand,
    opaqueFrame,
  );
  assert.equal(opaqueFrame.commandList[0], opaqueReplay);
  assert.deepEqual(Object.keys(opaqueReplay.derivedCommands), []);
  assert.deepEqual(Object.keys(pooledDerivedCommands), []);
});

test("S5 CPU laws retain exact endpoints, fitted support, and composition", () => {
  assert.equal(applyLimbDarkeningFit(0.0, 7.0, -3.0, 11.0), 0.0);
  assert.equal(applyLimbDarkeningFit(1.0, 7.0, -3.0, 11.0), 1.0);

  const rs = 0.00465;
  const ro = 0.00483;
  const anchorSeparation = 0.55 * (rs + ro);
  const anchorObscuration = computeSolarObscuration(rs, ro, anchorSeparation);
  const fit = fitEclipseLimbDarkening(
    rs,
    ro,
    anchorSeparation,
    anchorObscuration,
    {},
  );
  assert.ok(Number.isFinite(fit.c1));
  assert.ok(Number.isFinite(fit.c2));
  assert.ok(Number.isFinite(fit.c3));
  assert.ok(fit.anchorWeight > 0.99);
  assert.ok(
    Math.abs(
      evaluateFragmentObscuration(
        rs,
        ro,
        anchorSeparation,
        fit.c1,
        fit.c2,
        fit.c3,
        fit.annularLift,
      ) - anchorObscuration,
    ) < 1.0e-12,
    "the camera anchor must survive the fitted shader law",
  );
  let maxFitError = 0.0;
  const supportStart = Math.abs(rs - ro);
  const supportEnd = rs + ro;
  for (let i = 1; i < 20; i++) {
    const separation = supportStart + ((supportEnd - supportStart) * i) / 20.0;
    maxFitError = Math.max(
      maxFitError,
      Math.abs(
        evaluateFragmentObscuration(
          rs,
          ro,
          separation,
          fit.c1,
          fit.c2,
          fit.c3,
          fit.annularLift,
        ) - computeSolarObscuration(rs, ro, separation),
      ),
    );
  }
  assert.ok(maxFitError < 0.006, `limb-fit error ${maxFitError}`);
  assert.equal(
    evaluateFragmentObscuration(
      rs,
      ro,
      rs + ro,
      fit.c1,
      fit.c2,
      fit.c3,
      fit.annularLift,
    ),
    0.0,
  );
  assert.equal(
    evaluateFragmentObscuration(
      rs,
      ro,
      0.0,
      fit.c1,
      fit.c2,
      fit.c3,
      fit.annularLift,
    ),
    1.0,
  );

  assert.equal(eclipseSceneLightCurve(0.0, false), 1.0);
  assert.equal(
    eclipseSceneLightCurve(1.0, false),
    Math.pow(ECLIPSE_RADIOMETRIC_FLOOR, ECLIPSE_ADAPTATION_EXPONENT),
  );
  const sceneFactor = 0.37;
  const obscuration = 0.73;
  const absolute = eclipseSceneLightCurve(obscuration, false);
  const reciprocal = compositionReciprocal(sceneFactor);
  assert.ok(
    Math.abs(
      composeGlobeSurfaceFactor(
        sceneFactor,
        reciprocal,
        obscuration,
        false,
        true,
      ) - absolute,
    ) <= Number.EPSILON,
    "S5 must replace S2, not double-dim the terrain",
  );
  assert.equal(
    composeGlobeSurfaceFactor(1.0, 1.0, obscuration, false, false),
    absolute,
  );
});

test("surface activation includes elevated terrain that the base ellipsoid misses", () => {
  const sun = new Cartesian3(AU, 0.0, 0.0);
  const moonRange = 384_400_000.0;
  const centreSeparation = 0.027;
  const moon = new Cartesian3(
    moonRange * Math.cos(centreSeparation),
    moonRange * Math.sin(centreSeparation),
    0.0,
  );
  const elevatedRadius = EARTH_RADIUS + 500_000.0;
  const elevatedPosition = [0.0, elevatedRadius, 0.0];

  assert.equal(
    surfaceEclipsePossible(sun, moon, EARTH_RADIUS),
    false,
    "the deliberately chosen footprint is outside the base ellipsoid",
  );
  assert.equal(
    surfaceEclipsePossible(sun, moon, elevatedRadius),
    true,
    "the selected-terrain radius must retain the elevated footprint",
  );

  const local = referenceF64(
    [sun.x, sun.y, sun.z],
    [moon.x, moon.y, moon.z],
    elevatedPosition,
  );
  assert.ok(
    local.separation < local.rs + local.ro,
    "the +500 km observer must see a real partial eclipse",
  );
  assert.equal(
    localDiscSupportRejectF32(
      [sun.x, sun.y, sun.z],
      [moon.x, moon.y, moon.z],
      elevatedPosition,
    ),
    false,
    "the exact local f32 support test must not clip the elevated penumbra",
  );

  const maxSupport = maximumSurfaceDiscSupport(AU, moonRange, elevatedRadius);
  assert.ok(maxSupport > 0.009);
  assert.ok(maxSupport < 0.011);
});

test("the CPU broad reject is exactly conservative across the footprint edge", () => {
  const sun = new Cartesian3(AU, 0.0, 0.0);
  const moonRange = 384_400_000.0;
  const radii = [
    EARTH_RADIUS,
    EARTH_RADIUS + 10_000.0,
    EARTH_RADIUS + 500_000.0,
  ];

  function exactSurfaceResult(moon, surfaceRadius) {
    const sunRange = Cartesian3.magnitude(sun);
    const currentMoonRange = Cartesian3.magnitude(moon);
    const sunUnit = Cartesian3.normalize(sun, new Cartesian3());
    const moonUnit = Cartesian3.normalize(moon, new Cartesian3());
    const chord = Cartesian3.magnitude(
      Cartesian3.subtract(sunUnit, moonUnit, new Cartesian3()),
    );
    const centreSeparation = 2.0 * Math.asin(Math.min(1.0, 0.5 * chord));
    const support =
      maximumSurfaceDiscSupport(sunRange, currentMoonRange, surfaceRadius) +
      Math.asin(Math.min(1.0, surfaceRadius / sunRange)) +
      Math.asin(Math.min(1.0, surfaceRadius / currentMoonRange));
    return centreSeparation < support;
  }

  // Dense samples span totality, the exact footprint boundary, and clearly
  // disjoint ordinary frames. Any false negative would remove a real feature.
  for (const surfaceRadius of radii) {
    for (let i = 0; i <= 4000; i++) {
      const centreSeparation = (0.06 * i) / 4000.0;
      const moon = new Cartesian3(
        moonRange * Math.cos(centreSeparation),
        moonRange * Math.sin(centreSeparation),
        0.0,
      );
      assert.equal(
        surfaceEclipsePossible(sun, moon, surfaceRadius),
        exactSurfaceResult(moon, surfaceRadius),
        `classification mismatch at radius=${surfaceRadius}, separation=${centreSeparation}`,
      );
    }
  }
});

test("selected terrain spheres conservatively classify the solid penumbra cone", () => {
  const sun = new Cartesian3(AU, 0.0, 0.0);
  const moonRange = 384_400_000.0;
  const moon = new Cartesian3(moonRange, 0.0, 0.0);
  const radiiSum = SOLAR_RADIUS + LUNAR_RADIUS;
  const bodySeparation = AU - moonRange;
  const sinHalfAngle = radiiSum / bodySeparation;
  const cosHalfAngle = Math.sqrt(1.0 - sinHalfAngle * sinHalfAngle);
  const tanHalfAngle = sinHalfAngle / cosHalfAngle;
  const apexX = AU - (SOLAR_RADIUS / radiiSum) * bodySeparation;
  const earthPlaneRadius = apexX * tanHalfAngle;
  const tileRadius = 100_000.0;

  assert.equal(
    eclipsePenumbraIntersectsBoundingSphere(sun, moon, {
      center: new Cartesian3(0.0, 0.0, 0.0),
      radius: 0.0,
    }),
    true,
    "the cone axis at Earth must intersect",
  );
  assert.equal(
    eclipsePenumbraIntersectsBoundingSphere(sun, moon, {
      center: new Cartesian3(
        0.0,
        earthPlaneRadius + tileRadius / cosHalfAngle,
        0.0,
      ),
      radius: tileRadius,
    }),
    true,
    "an exact tangent must survive the outward safety margin",
  );
  assert.equal(
    eclipsePenumbraIntersectsBoundingSphere(sun, moon, {
      center: new Cartesian3(
        0.0,
        earthPlaneRadius + tileRadius / cosHalfAngle + 10.0,
        0.0,
      ),
      radius: tileRadius,
    }),
    false,
    "a sphere beyond the one-metre cone safety must reject",
  );

  // The relevant nappe opens from the apex toward the Moon and Earth. A
  // behind-apex sphere rejects unless it actually contains the apex.
  const apex = new Cartesian3(apexX, 0.0, 0.0);
  const axis = new Cartesian3(-1.0, 0.0, 0.0);
  assert.equal(
    eclipsePenumbraIntersectsBoundingSphere(sun, moon, {
      center: Cartesian3.subtract(
        apex,
        Cartesian3.multiplyByScalar(axis, tileRadius * 2.0, new Cartesian3()),
        new Cartesian3(),
      ),
      radius: tileRadius,
    }),
    false,
  );
  assert.equal(
    eclipsePenumbraIntersectsBoundingSphere(sun, moon, {
      center: Cartesian3.subtract(
        apex,
        Cartesian3.multiplyByScalar(axis, tileRadius * 0.5, new Cartesian3()),
        new Cartesian3(),
      ),
      radius: tileRadius,
    }),
    true,
  );

  // A rotated collinear body pair catches accidental world-X assumptions.
  const rotatedDirection = Cartesian3.normalize(
    new Cartesian3(0.3, -0.4, 0.866),
    new Cartesian3(),
  );
  const rotatedSun = Cartesian3.multiplyByScalar(
    rotatedDirection,
    AU,
    new Cartesian3(),
  );
  const rotatedMoon = Cartesian3.multiplyByScalar(
    rotatedDirection,
    moonRange,
    new Cartesian3(),
  );
  assert.equal(
    eclipsePenumbraIntersectsBoundingSphere(rotatedSun, rotatedMoon, {
      center: Cartesian3.ZERO,
      radius: 0.0,
    }),
    true,
  );
  const rotatedTangent = tangentTo([
    rotatedDirection.x,
    rotatedDirection.y,
    rotatedDirection.z,
  ]);
  assert.equal(
    eclipsePenumbraIntersectsBoundingSphere(rotatedSun, rotatedMoon, {
      center: new Cartesian3(
        rotatedTangent[0] * 10_000_000.0,
        rotatedTangent[1] * 10_000_000.0,
        rotatedTangent[2] * 10_000_000.0,
      ),
      radius: 10_000.0,
    }),
    false,
  );

  assert.equal(PENUMBRA_CONE_SAFETY_METERS, 1.0);
});

test("penumbra sphere rejects have no sampled exact-disc false negatives", () => {
  const sun = new Cartesian3(AU, 0.0, 0.0);
  const moon = new Cartesian3(384_400_000.0, 0.0, 0.0);
  const sunArray = [sun.x, sun.y, sun.z];
  const moonArray = [moon.x, moon.y, moon.z];
  const sampleDirections = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (x !== 0 || y !== 0 || z !== 0) {
          sampleDirections.push(normalize64([x, y, z]));
        }
      }
    }
  }

  let randomState = 0x51f15e5;
  const randomUnit = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x1_0000_0000;
  };
  let rejectedSpheres = 0;
  for (let i = 0; i < 512; i++) {
    const z = randomUnit() * 2.0 - 1.0;
    const longitude = randomUnit() * Math.PI * 2.0 - Math.PI;
    const xy = Math.sqrt(Math.max(0.0, 1.0 - z * z));
    const shellRadius = EARTH_RADIUS + randomUnit() * 500_000.0;
    const center = new Cartesian3(
      shellRadius * xy * Math.cos(longitude),
      shellRadius * xy * Math.sin(longitude),
      shellRadius * z,
    );
    const radius = 5_000.0 + randomUnit() * 295_000.0;
    if (
      eclipsePenumbraIntersectsBoundingSphere(sun, moon, {
        center,
        radius,
      })
    ) {
      continue;
    }
    rejectedSpheres++;

    for (const direction of sampleDirections) {
      const point = [
        center.x + direction[0] * radius,
        center.y + direction[1] * radius,
        center.z + direction[2] * radius,
      ];
      const exact = referenceF64(sunArray, moonArray, point);
      assert.ok(
        exact.separation >= exact.rs + exact.ro,
        "a rejected terrain sphere contained a sampled exact disc overlap",
      );
    }
  }
  assert.ok(
    rejectedSpheres > 350,
    `expected broad spatial coverage, got ${rejectedSpheres} rejects`,
  );
});

test("rendered mesh bounds include skirts, exaggeration, and safe fallbacks", () => {
  // Unit-cube -> ECEF AABB. This represents an arbitrary/custom ellipsoid
  // placement; the classifier must consume the mesh's actual ECEF transform,
  // never rebuild a WGS84-specific bound.
  const fromScaledENU = [
    20.0, 0.0, 0.0, 0.0, 0.0, 40.0, 0.0, 0.0, 0.0, 0.0, 100.0, 0.0, -10.0,
    -20.0, -100.0, 1.0,
  ];
  const skirtedMesh = {
    boundingSphere3D: {
      center: new Cartesian3(),
      radius: 10.0,
    },
    indices: new Uint16Array(6),
    indexCountWithoutSkirts: 3,
    encoding: {
      fromScaledENU,
      minimumHeight: -100.0,
      maximumHeight: 300.0,
    },
  };
  const result = {
    center: new Cartesian3(),
    radius: 0.0,
  };
  computeRenderedMeshEclipseBoundingSphere(skirtedMesh, 1.0, 0.0, result);
  const baseRadius = 0.5 * Math.hypot(20.0, 40.0, 100.0);
  assert.deepEqual(result.center, new Cartesian3(0.0, 0.0, -50.0));
  assert.ok(
    Math.abs(
      result.radius - (baseRadius + TERRAIN_ECLIPSE_BOUND_SAFETY_METERS),
    ) < 1.0e-12,
    "the skirt-inclusive encoding AABB must replace the tiny server sphere",
  );
  for (const x of [-10.0, 10.0]) {
    for (const y of [-20.0, 20.0]) {
      for (const z of [-100.0, 0.0]) {
        assert.ok(
          Cartesian3.distance(result.center, new Cartesian3(x, y, z)) <=
            result.radius,
        );
      }
    }
  }

  computeRenderedMeshEclipseBoundingSphere(skirtedMesh, 3.0, 50.0, result);
  assert.ok(
    Math.abs(
      result.radius -
        (baseRadius + 500.0 + TERRAIN_ECLIPSE_BOUND_SAFETY_METERS),
    ) < 1.0e-12,
    "the larger endpoint displacement must enclose exaggerated terrain",
  );

  const invalidSkirtedMesh = {
    boundingSphere3D: {
      center: new Cartesian3(),
      radius: 10.0,
    },
    indices: new Uint16Array(6),
    indexCountWithoutSkirts: 3,
    encoding: {},
  };
  assert.equal(
    computeRenderedMeshEclipseBoundingSphere(
      invalidSkirtedMesh,
      1.0,
      0.0,
      result,
    ),
    undefined,
    "a server sphere cannot silently stand in for unknown client skirts",
  );
  assert.equal(
    computeRenderedMeshEclipseBoundingSphere(
      {
        ...invalidSkirtedMesh,
        indices: new Uint16Array(3),
        indexCountWithoutSkirts: 6,
      },
      1.0,
      0.0,
      result,
    ),
    undefined,
    "malformed index counts cannot prove that the server sphere includes all draws",
  );
  assert.equal(
    selectedTerrainIntersectsPenumbra(
      {
        sunPositionWC: new Cartesian3(AU, 0.0, 0.0),
        moonPositionWC: new Cartesian3(384_400_000.0, 0.0, 0.0),
      },
      [{ data: { renderedMesh: invalidSkirtedMesh } }],
      1.0,
      0.0,
    ),
    true,
    "unknown drawing bounds must remain conservative-active",
  );

  const largeCustomMesh = {
    boundingSphere3D: {
      center: new Cartesian3(1_000_000_000.0, 0.0, 0.0),
      radius: 10.0,
    },
    indices: new Uint16Array(3),
    indexCountWithoutSkirts: 3,
  };
  computeRenderedMeshEclipseBoundingSphere(largeCustomMesh, 1.0, 0.0, result);
  assert.ok(
    result.radius - largeCustomMesh.boundingSphere3D.radius > 32.0,
    "large custom ellipsoids need more than an Earth-specific metre floor",
  );
  assert.equal(TERRAIN_ECLIPSE_BOUND_RELATIVE_SAFETY, 8.0 * Math.pow(2.0, -23));
});

test("selected terrain refinement preserves correction-only and ordinary O(1) paths", () => {
  const eclipseState = {
    enabled: true,
    valid: true,
    sunAngularRadius: 0.00465,
    moonAngularRadius: 0.00483,
    sunPositionWC: new Cartesian3(AU, 0.0, 0.0),
    moonPositionWC: new Cartesian3(384_400_000.0, 0.0, 0.0),
    moonSeparation: 0.0,
    moonObscuration: 1.0,
    autoExposure: false,
  };
  const farMesh = {
    boundingSphere3D: {
      center: new Cartesian3(0.0, 6_000_000.0, 0.0),
      radius: 10_000.0,
    },
    indices: new Uint16Array(3),
    indexCountWithoutSkirts: 3,
  };
  const nearMesh = {
    boundingSphere3D: {
      center: new Cartesian3(),
      radius: 10_000.0,
    },
    indices: new Uint16Array(3),
    indexCountWithoutSkirts: 3,
  };
  assert.equal(
    selectedTerrainIntersectsPenumbra(eclipseState, [], 1.0, 0.0),
    false,
  );
  assert.equal(
    selectedTerrainIntersectsPenumbra(eclipseState, [{ data: {} }], 1.0, 0.0),
    false,
  );
  assert.equal(
    selectedTerrainIntersectsPenumbra(
      eclipseState,
      [{ data: { renderedMesh: farMesh } }],
      1.0,
      0.0,
    ),
    false,
  );
  assert.equal(
    selectedTerrainIntersectsPenumbra(
      eclipseState,
      [
        { data: { renderedMesh: farMesh } },
        { data: { renderedMesh: nearMesh } },
      ],
      1.0,
      0.0,
    ),
    true,
  );

  const shadow = createEclipseGlobeShadow();
  const frameState = {
    view: { _eclipseGlobeShadow: shadow },
    eclipseState,
    atmosphericConditions: { lighting: {} },
    eclipseSceneLightFactor: 0.37,
    mode: 3,
    light: undefined,
    verticalExaggeration: 1.0,
    verticalExaggerationRelativeHeight: 0.0,
  };
  updateEclipseGlobeShadowForFrameState(
    frameState,
    EARTH_RADIUS + 20_000.0,
    [{ data: { renderedMesh: farMesh } }],
    1,
  );
  assert.equal(
    shadow.params.x,
    3.0,
    "an all-far selection keeps S2 correction without local eclipse geometry",
  );

  const ordinaryState = {
    ...eclipseState,
    moonPositionWC: new Cartesian3(0.0, 384_400_000.0, 0.0),
    moonSeparation: Math.PI * 0.5,
    moonObscuration: 0.0,
  };
  frameState.eclipseState = ordinaryState;
  frameState.eclipseGlobeShadowPrepared = false;
  const inaccessibleTiles = new Proxy([], {
    get() {
      throw new Error("ordinary broad rejection touched the selected list");
    },
  });
  updateEclipseGlobeShadowForFrameState(
    frameState,
    EARTH_RADIUS,
    inaccessibleTiles,
    2,
  );
  assert.equal(shadow.params.x, 0.0);
});

test("WebGL's packed carrier tracks the shared four-vector block", () => {
  const shadow = createEclipseGlobeShadow();
  assert.deepEqual(Array.from(shadow.webglPackedUniform), [
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    1.0,
    0.0,
    0.0,
    ECLIPSE_RADIOMETRIC_FLOOR,
    ECLIPSE_ADAPTATION_EXPONENT,
    0.0,
    0.0,
  ]);

  const state = {
    enabled: true,
    valid: true,
    sunAngularRadius: 0.00465,
    moonAngularRadius: 0.00483,
    sunPositionWC: new Cartesian3(AU, 0.0, 0.0),
    moonPositionWC: new Cartesian3(384_400_000.0, 0.0, 0.0),
    moonSeparation: 0.0,
    moonObscuration: 1.0,
    autoExposure: false,
  };
  updateEclipseGlobeShadow(shadow, {
    eclipseState: state,
    sceneLightFactor: 0.5,
    active: true,
    surfaceRadius: EARTH_RADIUS,
    sceneLightDimmed: true,
  });
  assert.deepEqual(Array.from(shadow.webglPackedUniform), [
    ...Object.values(shadow.sunDirectionAndInvRange),
    ...Object.values(shadow.moonDirectionDeltaAndInvRange),
    ...Object.values(shadow.params),
    ...Object.values(shadow.params2),
  ]);

  updateEclipseGlobeShadow(shadow, { active: false });
  const inertRevision = shadow.revision;
  const inertPacked = Array.from(shadow.webglPackedUniform);
  updateEclipseGlobeShadow(shadow, { active: false });
  assert.equal(
    shadow.revision,
    inertRevision,
    "an already-inert ordinary frame must not rotate renderer state",
  );
  assert.deepEqual(Array.from(shadow.webglPackedUniform), inertPacked);
});

test("camera-only S2 dimming uses gates 3/4 to cancel without local shadow ALU", () => {
  const moonRange = 384_400_000.0;
  const centreSeparation = 0.027;
  const state = {
    enabled: true,
    valid: true,
    sunAngularRadius: 0.00465,
    moonAngularRadius: 0.00452,
    sunPositionWC: new Cartesian3(AU, 0.0, 0.0),
    moonPositionWC: new Cartesian3(
      moonRange * Math.cos(centreSeparation),
      moonRange * Math.sin(centreSeparation),
      0.0,
    ),
    moonSeparation: 0.003,
    moonObscuration: 0.42,
    autoExposure: false,
  };
  const sceneLightFactor = 0.37;
  const shadow = createEclipseGlobeShadow();

  updateEclipseGlobeShadow(shadow, {
    active: true,
    eclipseState: state,
    sceneLightDimmed: true,
    sceneLightFactor,
    surfaceRadius: EARTH_RADIUS,
  });
  assert.equal(shadow.active, true);
  assert.equal(shadow.params.x, 3.0);
  assert.equal(shadow.params.y, compositionReciprocal(sceneLightFactor));
  assert.deepEqual(
    [
      shadow.sunDirectionAndInvRange.x,
      shadow.sunDirectionAndInvRange.y,
      shadow.sunDirectionAndInvRange.z,
      shadow.sunDirectionAndInvRange.w,
      shadow.moonDirectionDeltaAndInvRange.x,
      shadow.moonDirectionDeltaAndInvRange.y,
      shadow.moonDirectionDeltaAndInvRange.z,
      shadow.moonDirectionDeltaAndInvRange.w,
    ],
    new Array(8).fill(0.0),
    "correction-only must not publish body rays that invite local ALU",
  );
  assert.ok(
    Math.abs(sceneLightFactor * shadow.params.y - 1.0) < 1.0e-15,
    "the relative factor restores an S2-dimmed terrain term to identity",
  );

  updateEclipseGlobeShadow(shadow, {
    active: true,
    eclipseState: state,
    sceneLightDimmed: false,
    sceneLightFactor,
    surfaceRadius: EARTH_RADIUS,
  });
  assert.equal(
    shadow.params.x,
    4.0,
    "a custom light keeps the surface absolute while correcting atmosphere",
  );
  const customLightUsesRelativeSurface =
    shadow.params.x > 1.5 && shadow.params.x < 3.5;
  assert.equal(customLightUsesRelativeSurface, false);

  updateEclipseGlobeShadow(shadow, {
    active: true,
    eclipseState: state,
    sceneLightDimmed: true,
    sceneLightFactor,
    surfaceRadius: EARTH_RADIUS + 500_000.0,
  });
  assert.equal(
    shadow.params.x,
    2.0,
    "a selected elevated footprint must retain the full relative S5 path",
  );
  assert.ok(shadow.sunDirectionAndInvRange.w > 0.0);
});

const f32 = Math.fround;
const add32 = (a, b) => f32(f32(a) + f32(b));
const sub32 = (a, b) => f32(f32(a) - f32(b));
const mul32 = (a, b) => f32(f32(a) * f32(b));
const div32 = (a, b) => f32(f32(a) / f32(b));
const add3 = (a, b) => [
  add32(a[0], b[0]),
  add32(a[1], b[1]),
  add32(a[2], b[2]),
];
const sub3 = (a, b) => [
  sub32(a[0], b[0]),
  sub32(a[1], b[1]),
  sub32(a[2], b[2]),
];
const scale3 = (v, scale) => [
  mul32(v[0], scale),
  mul32(v[1], scale),
  mul32(v[2], scale),
];
const dot32 = (a, b) =>
  add32(add32(mul32(a[0], b[0]), mul32(a[1], b[1])), mul32(a[2], b[2]));
const cross32 = (a, b) => [
  sub32(mul32(a[1], b[2]), mul32(a[2], b[1])),
  sub32(mul32(a[2], b[0]), mul32(a[0], b[2])),
  sub32(mul32(a[0], b[1]), mul32(a[1], b[0])),
];
const length32 = (v) => f32(Math.sqrt(dot32(v, v)));

const dot64 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross64 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length64 = (v) => Math.sqrt(dot64(v, v));
const normalize64 = (v) => {
  const inverseLength = 1.0 / length64(v);
  return v.map((component) => component * inverseLength);
};
const scale64 = (v, scale) => v.map((component) => component * scale);
const add64 = (a, b) => a.map((component, i) => component + b[i]);
const sub64 = (a, b) => a.map((component, i) => component - b[i]);

// Mirrors the direct-position common-ray construction in both globe shaders.
// Every payload/varying value is quantized before its first shader operation,
// and every arithmetic operation is rounded back to f32.
function commonRayVectorsF32(sun, moon, position) {
  const sunRange = length64(sun);
  const moonRange = length64(moon);
  const sunUnit64 = normalize64(sun);
  const moonUnit64 = normalize64(moon);
  const sunUnit = sunUnit64.map(f32);
  const directionDelta = moonUnit64.map((value, i) =>
    f32(value - sunUnit64[i]),
  );
  const invSunRange = f32(1.0 / sunRange);
  const invMoonRange = f32(1.0 / moonRange);
  const positionMC = position.map(f32);

  const pScaledSun = scale3(positionMC, invSunRange);
  const s = sub3(sunUnit, pScaledSun);
  const invRangeDelta = sub32(invSunRange, invMoonRange);
  const D = add3(directionDelta, scale3(positionMC, invRangeDelta));
  const s2 = dot32(s, s);
  const sDotD = dot32(s, D);
  const moon2 = add32(add32(s2, mul32(2.0, sDotD)), dot32(D, D));
  return {
    D,
    invMoonRange,
    invSunRange,
    moon2,
    s,
    s2,
    sDotD,
  };
}

function localDiscSupportRejectF32(sun, moon, position) {
  const { invMoonRange, invSunRange, moon2, s2, sDotD } = commonRayVectorsF32(
    sun,
    moon,
    position,
  );
  if (!(s2 > 0.0) || !(moon2 > 0.0)) {
    return true;
  }

  const dotSunMoon = add32(s2, sDotD);
  const sunAngularScale = mul32(SOLAR_RADIUS, invSunRange);
  const moonAngularScale = mul32(LUNAR_RADIUS, invMoonRange);
  const supportDot = add32(
    dotSunMoon,
    mul32(sunAngularScale, moonAngularScale),
  );
  const sunRadicand = Math.max(
    sub32(s2, mul32(sunAngularScale, sunAngularScale)),
    0.0,
  );
  const moonRadicand = Math.max(
    sub32(moon2, mul32(moonAngularScale, moonAngularScale)),
    0.0,
  );
  const supportRadicand = mul32(sunRadicand, moonRadicand);
  return (
    supportDot <= 0.0 ||
    mul32(supportDot, supportDot) <=
      mul32(ECLIPSE_BROAD_REJECT_SAFETY_FACTOR, supportRadicand)
  );
}

function commonRayF32(sun, moon, position) {
  const { D, invMoonRange, invSunRange, moon2, s, s2, sDotD } =
    commonRayVectorsF32(sun, moon, position);
  const sunLength = f32(Math.sqrt(s2));
  const moonLength = f32(Math.sqrt(moon2));
  const rs = f32(
    Math.asin(
      Math.min(1.0, div32(mul32(SOLAR_RADIUS, invSunRange), sunLength)),
    ),
  );
  const ro = f32(
    Math.asin(
      Math.min(1.0, div32(mul32(LUNAR_RADIUS, invMoonRange), moonLength)),
    ),
  );
  const separation = f32(Math.atan2(length32(cross32(s, D)), add32(s2, sDotD)));
  return { ro, rs, separation };
}

function referenceF64(sun, moon, position) {
  const toSun = sub64(sun, position);
  const toMoon = sub64(moon, position);
  const sunRange = length64(toSun);
  const moonRange = length64(toMoon);
  const sunUnit = scale64(toSun, 1.0 / sunRange);
  const moonUnit = scale64(toMoon, 1.0 / moonRange);
  return {
    rs: Math.asin(SOLAR_RADIUS / sunRange),
    ro: Math.asin(LUNAR_RADIUS / moonRange),
    separation: Math.atan2(
      length64(cross64(sunUnit, moonUnit)),
      dot64(sunUnit, moonUnit),
    ),
  };
}

function classify({ rs, ro, separation }) {
  if (separation >= rs + ro) {
    return "clear";
  }
  if (separation + rs <= ro) {
    return "umbra";
  }
  return "partial";
}

function tangentTo(direction) {
  const seed = Math.abs(direction[2]) < 0.8 ? [0.0, 0.0, 1.0] : [0.0, 1.0, 0.0];
  return normalize64(cross64(direction, seed));
}

test("exact local f32 support reject is conservative and removes clear samples", () => {
  const sun = [AU, 0.0, 0.0];
  const moonObserverRange = 384_400_000.0;
  const observerPositions = [
    [EARTH_RADIUS, 0.0, 0.0],
    [0.0, EARTH_RADIUS + 500_000.0, 0.0],
    [0.0, 0.0, 42_164_000.0],
    normalize64([-0.61, 0.73, 0.31]).map(
      (component) => component * 100_000_000.0,
    ),
  ];

  let nearEdgeOverlaps = 0;
  for (const position of observerPositions) {
    const toSun = normalize64(sub64(sun, position));
    const tangent = tangentTo(toSun);
    const rs = Math.asin(SOLAR_RADIUS / length64(sub64(sun, position)));
    const ro = Math.asin(LUNAR_RADIUS / moonObserverRange);
    for (const supportFraction of [0.0, 0.25, 0.9, 0.999, 0.99999]) {
      const separation = supportFraction * (rs + ro);
      const moonDirection = add64(
        scale64(toSun, Math.cos(separation)),
        scale64(tangent, Math.sin(separation)),
      );
      const moon = add64(position, scale64(moonDirection, moonObserverRange));
      const expected = referenceF64(sun, moon, position);
      assert.ok(expected.separation < expected.rs + expected.ro);
      assert.equal(
        localDiscSupportRejectF32(sun, moon, position),
        false,
        `f32 reject clipped overlap at radius ${length64(position)} ` +
          `and support fraction ${supportFraction}`,
      );
      nearEdgeOverlaps++;
    }
  }
  assert.equal(nearEdgeOverlaps, observerPositions.length * 5);

  // Fixed-seed spherical coverage exercises different dot-product signs,
  // altitudes, lunar parallax, poles, and the antimeridian reproducibly.
  let randomState = 0x6d2b79f5;
  const randomUnit = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x1_0000_0000;
  };
  let trueOverlaps = 0;
  let clearSamples = 0;
  let rejectedClearSamples = 0;
  for (const radius of [
    EARTH_RADIUS,
    EARTH_RADIUS + 500_000.0,
    42_164_000.0,
    100_000_000.0,
  ]) {
    for (const centreSeparation of [0.0, 0.008, 0.02, 0.027, 0.05]) {
      const moon = [
        moonObserverRange * Math.cos(centreSeparation),
        moonObserverRange * Math.sin(centreSeparation),
        0.0,
      ];
      for (let i = 0; i < 256; i++) {
        const z = randomUnit() * 2.0 - 1.0;
        const longitude = randomUnit() * Math.PI * 2.0 - Math.PI;
        const xy = Math.sqrt(Math.max(1.0 - z * z, 0.0));
        const position = [
          radius * xy * Math.cos(longitude),
          radius * xy * Math.sin(longitude),
          radius * z,
        ];
        const expected = referenceF64(sun, moon, position);
        const overlaps = expected.separation < expected.rs + expected.ro;
        const rejected = localDiscSupportRejectF32(sun, moon, position);
        if (overlaps) {
          trueOverlaps++;
          assert.equal(
            rejected,
            false,
            `f32 support rejected a true overlap at radius ${radius}`,
          );
        } else {
          clearSamples++;
          if (rejected) {
            rejectedClearSamples++;
          }
        }
      }
    }
  }
  assert.ok(trueOverlaps > 100);
  assert.ok(clearSamples > 3_000);
  assert.ok(
    rejectedClearSamples / clearSamples > 0.95,
    "the algebraic reject should remove almost all clear fragments",
  );
});

function elevatedTangentRay(radii, altitude) {
  const scaledRadius = (radii.x + altitude) / radii.x;
  const tangentX = -Math.sqrt(scaledRadius * scaledRadius - 1.0) / scaledRadius;
  const tangentY = 1.0 / scaledRadius;
  return new Cartesian3(tangentX * radii.x, tangentY * radii.y, 0.0);
}

test("ray/ellipsoid horizon supports WGS84, custom globes, and stable grazing rays", () => {
  for (const [ellipsoid, altitude] of [
    [Ellipsoid.WGS84, 500_000.0],
    [new Ellipsoid(4_000_000.0, 2_000_000.0, 1_000_000.0), 250_000.0],
  ]) {
    const radii = ellipsoid.radii;
    const position = new Cartesian3(radii.x + altitude, 0.0, 0.0);
    const tangentRay = elevatedTangentRay(radii, altitude);

    assert.equal(
      eclipseSunVisibleAboveEllipsoid(
        position,
        tangentRay,
        ellipsoid.oneOverRadii,
      ),
      true,
      "an elevated tangent ray must clear the rendered ellipsoid",
    );
    assert.equal(
      eclipseSunVisibleAboveEllipsoid(
        position,
        new Cartesian3(tangentRay.x, tangentRay.y * 0.99, tangentRay.z),
        ellipsoid.oneOverRadii,
      ),
      false,
      "a ray below the ellipsoid limb must be occluded",
    );
    assert.equal(
      eclipseSunVisibleAboveEllipsoid(
        position,
        new Cartesian3(1.0, 0.0, 0.0),
        ellipsoid.oneOverRadii,
      ),
      true,
      "an outward ray is immediately visible",
    );
    assert.equal(
      eclipseSunVisibleAboveEllipsoid(
        position,
        new Cartesian3(-1.0, 0.0, 0.0),
        ellipsoid.oneOverRadii,
      ),
      false,
      "an inward central ray intersects the globe",
    );
  }

  // At high elevation, |p|² - dot(p,d)²/|d|² catastrophically cancels in
  // f32. The mathematically equivalent cross-product form remains exactly
  // conditioned for a tangent ray and is the form both shaders must retain.
  const scaledPosition = [f32(10_000.0), 0.0, 0.0];
  const scaledRay = [
    f32(-Math.sqrt(10_000.0 * 10_000.0 - 1.0) / 10_000.0),
    f32(1.0 / 10_000.0),
    0.0,
  ];
  const rayLengthSquared = dot32(scaledRay, scaledRay);
  const positionDotRay = dot32(scaledPosition, scaledRay);
  const limb = cross32(scaledPosition, scaledRay);
  const closestCross = div32(dot32(limb, limb), rayLengthSquared);
  const closestSubtractive = sub32(
    dot32(scaledPosition, scaledPosition),
    div32(mul32(positionDotRay, positionDotRay), rayLengthSquared),
  );
  assert.ok(closestCross >= ECLIPSE_BROAD_REJECT_SAFETY_FACTOR);
  assert.equal(closestSubtractive, 0.0);
});

test("direct-position f32 common rays agree with f64 and are camera-independent", () => {
  const positions = [
    [EARTH_RADIUS, 0.0, 0.0],
    [-2_112_000.0, 5_802_000.0, 2_514_000.0], // LEO, oblique longitude
    [0.0, 42_164_000.0, 0.0], // GEO
    [0.0, 0.0, EARTH_RADIUS], // north pole
    [-EARTH_RADIUS, 11.0, -7.0], // antimeridian seam
  ];
  const sunDirections = [
    normalize64([0.371, -0.812, 0.451]),
    normalize64([-0.667, 0.229, 0.709]),
  ];
  const moonObserverRange = 360_000_000.0;
  let maxSeparationError = 0.0;
  let maxRadiusError = 0.0;

  for (const [positionIndex, position] of positions.entries()) {
    for (const [directionIndex, sunDirection] of sunDirections.entries()) {
      const sun = scale64(sunDirection, AU);
      const toSun = normalize64(sub64(sun, position));
      const tangent = tangentTo(toSun);
      const rs = Math.asin(SOLAR_RADIUS / length64(sub64(sun, position)));
      const ro = Math.asin(LUNAR_RADIUS / moonObserverRange);
      const innerSupport = Math.abs(ro - rs);
      const outerSupport = rs + ro;
      const separations = [
        0.0,
        0.5 * innerSupport,
        1.5 * innerSupport,
        0.55 * outerSupport,
        0.999 * outerSupport,
        1.001 * outerSupport,
        1.2 * outerSupport,
      ];

      for (const targetSeparation of separations) {
        const moonDirection = add64(
          scale64(toSun, Math.cos(targetSeparation)),
          scale64(tangent, Math.sin(targetSeparation)),
        );
        const moon = add64(position, scale64(moonDirection, moonObserverRange));
        const expected = referenceF64(sun, moon, position);
        const actual = commonRayF32(sun, moon, position);
        // Render, pick, and six-face capture cameras can all consume the same
        // per-View astronomical block. The numerical construction has no
        // camera input, so changing camera altitude/direction is byte-inert.
        for (const ignoredCamera of [
          add64(position, [17_321.25, -51_777.5, 93_211.75]),
          [0.0, 0.0, 42_164_000.0],
          scale64(sunDirection, EARTH_RADIUS + 100.0),
        ]) {
          void ignoredCamera;
          assert.deepEqual(commonRayF32(sun, moon, position), actual);
        }
        maxSeparationError = Math.max(
          maxSeparationError,
          Math.abs(actual.separation - expected.separation),
        );
        maxRadiusError = Math.max(
          maxRadiusError,
          Math.abs(actual.rs - expected.rs),
          Math.abs(actual.ro - expected.ro),
        );
        assert.equal(
          classify(actual),
          classify(expected),
          `classification drift at position ${positionIndex}, direction ${directionIndex}`,
        );
      }
    }
  }

  assert.ok(
    maxSeparationError < 2.0e-7,
    `common-ray separation error ${maxSeparationError} rad`,
  );
  assert.ok(
    maxRadiusError < 2.0e-8,
    `common-ray angular-radius error ${maxRadiusError} rad`,
  );
});

test("WebGL and WebGPU pin direct rays, exact support, ellipsoid limb, and floor", () => {
  const glsl = readSource("Shaders/GlobeFS.glsl");
  const wgsl = readSource("Shaders/WebGPU/Globe/GlobeTerrain.wgsl");
  const eclipseCpu = readSource("Scene/EclipseGlobeShadow.js");
  const webgpuEclipse = readSource(
    "Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
  );
  // Anchored on the first eclipse declaration rather than on a comment banner,
  // so the slice survives comment rewrites.
  const glslEclipseStart = glsl.indexOf("float eclipseGeometricObscuration(");
  const glslEclipse = glsl.slice(
    glslEclipseStart,
    glsl.indexOf("void main()", glslEclipseStart),
  );
  const wgslEclipseStart = wgsl.indexOf("fn globe_eclipseGeometricObscuration");
  const wgslEclipse = wgsl.slice(
    wgslEclipseStart,
    wgsl.indexOf("@fragment", wgslEclipseStart),
  );
  assert.ok(glslEclipseStart >= 0 && wgslEclipseStart >= 0);

  assert.match(glsl, /uniform mat4 u_eclipseGlobeShadow;/);
  for (const name of [
    "SunDirectionAndInvRange",
    "MoonDirectionDeltaAndInvRange",
    "Params",
    "Params2",
  ]) {
    assert.match(
      glsl,
      new RegExp(`#define u_eclipse${name} u_eclipseGlobeShadow\\[[0-3]\\]`),
    );
    const wgslName = name[0].toLowerCase() + name.slice(1);
    assert.match(wgsl, new RegExp(`${wgslName}: vec4<f32>`));
  }
  assert.match(wgsl, /@group\(0\) @binding\(2\).*eclipseUniforms/);

  assert.equal(
    ECLIPSE_BROAD_REJECT_SAFETY_FACTOR,
    Math.fround(1.0 - 32.0 * 2.0 ** -23),
  );
  assert.match(
    glslEclipse,
    /const float eclipseF32SafetyFactor = 0\.999996185302734375;/,
  );
  assert.match(
    wgslEclipse,
    /GLOBE_ECLIPSE_F32_SAFETY_FACTOR \* supportRadicand/,
  );

  // Both backends consume the fragment's direct exaggerated ECEF position.
  // The astronomical subtraction is conditioned by scaling P first; no
  // capture/pick camera high-low reconstruction is allowed in this section.
  assert.match(glslEclipse, /positionMC \* invSunRange/);
  assert.match(glslEclipse, /positionMC \* rangeDelta/);
  assert.match(wgslEclipse, /positionMC \* sunInvRange/);
  assert.match(wgslEclipse, /positionMC \* invRangeDelta/);
  assert.match(glsl, /rangeDelta = invSunRange - invMoonRange/);
  assert.match(wgsl, /invRangeDelta = sunInvRange - moonInvRange/);
  assert.doesNotMatch(glslEclipse, /encodedCamera|center3D|positionRTE/);
  assert.doesNotMatch(wgslEclipse, /encodedCamera|center3D|positionRTE/);

  // q² > (|s|²-ks²)(|m|²-km²) is the exact local angular-support test.
  for (const shader of [glslEclipse, wgslEclipse]) {
    assert.match(shader, /supportDot/);
    assert.match(shader, /supportRadicand/);
    assert.match(shader, /sunAngularScale \* moonAngularScale/);
    assert.match(shader, /supportDot \* supportDot/);
  }
  assert.match(
    glslEclipse,
    /max\(sunLength2 - sunAngularScale \* sunAngularScale, 0\.0\)/,
  );
  assert.match(
    wgslEclipse,
    /max\(s2 - sunAngularScale \* sunAngularScale, 0\.0\)/,
  );
  assert.doesNotMatch(
    glslEclipse,
    /u_eclipseParams2\.x \* sunLength2 \* moonLength2/,
  );
  assert.doesNotMatch(
    wgslEclipse,
    /eclipseUniforms\.params2\.x \* s2 \* moon2/,
  );

  // The horizon test transforms the ray to the ellipsoid's unit sphere and
  // retains the stable cross-product closest-distance form.
  assert.match(glslEclipse, /positionMC \* czm_ellipsoidInverseRadii/);
  assert.match(glslEclipse, /toSunScaled \* czm_ellipsoidInverseRadii/);
  assert.match(
    glslEclipse,
    /ellipsoidLimb =\s*cross\(ellipsoidPosition, ellipsoidSunRay\)/,
  );
  assert.match(
    wgslEclipse,
    /camera\.ellipsoidInverseRadiiX[\s\S]*camera\.ellipsoidInverseRadiiY[\s\S]*camera\.ellipsoidInverseRadiiZ/,
  );
  assert.match(
    wgslEclipse,
    /ellipsoidLimb = cross\(ellipsoidPosition, ellipsoidSunRay\)/,
  );
  for (const shader of [glslEclipse, wgslEclipse]) {
    assert.doesNotMatch(
      shader,
      /dot\(ellipsoidPosition,\s*ellipsoidPosition\)\s*-/,
    );
  }

  // Rejects remain ahead of inverse trig/square roots on clear pixels.
  assert.ok(
    glslEclipse.indexOf("supportDot * supportDot") <
      glslEclipse.indexOf("inversesqrt(sunLength2)"),
  );
  assert.ok(
    wgslEclipse.indexOf("supportDot * supportDot") <
      wgslEclipse.indexOf("sqrt(s2)"),
  );

  // params2.x is exclusively the shared radiometric floor, not a geometry
  // threshold. The CPU block, inert WebGPU bytes, and both shaders agree.
  assert.match(eclipseCpu, /shadow\.params2\.x = ECLIPSE_RADIOMETRIC_FLOOR;/);
  assert.match(
    webgpuEclipse,
    /params2\.x retains EclipseState's 5e-5[\s\S]*radiometric floor/,
  );
  assert.match(
    glslEclipse,
    /visible \+ u_eclipseParams2\.x \* \(1\.0 - visible\)/,
  );
  assert.match(
    wgslEclipse,
    /visible \+ eclipseUniforms\.params2\.x \* \(1\.0 - visible\)/,
  );

  assert.ok(
    glslEclipse.indexOf("supportRadicand") <
      glslEclipse.indexOf("ellipsoidPosition"),
  );
  assert.match(
    glslEclipse,
    /length\(cross\(toSunScaled, moonMinusSunScaled\)\)/,
  );
  assert.match(wgslEclipse, /atan2\(length\(cross\(s, D\)\), dotSunMoon\)/);
  assert.doesNotMatch(wgslEclipse, /normalize\(.*sun.*-.*position/i);
  assert.doesNotMatch(glslEclipse.replace(/\/\/.*$/gm, ""), /acos\s*\(\s*dot/);

  // Gate 3 is correction-only in lockstep: it computes a reciprocal relative
  // factor while bypassing the expensive local function in both shaders.
  assert.match(
    eclipseCpu,
    /setCorrectionOnlyEclipseGlobeShadow\(\s*shadow,\s*invSceneLightFactor,\s*sceneLightDimmed,\s*\)/,
  );
  assert.match(eclipseCpu, /const gate = sceneLightDimmed \? 3\.0 : 4\.0;/);
  assert.match(
    glsl,
    /if \(u_eclipseParams\.x < 2\.5\)[\s\S]*eclipseFragmentFactor\(v_positionMC\)/,
  );
  assert.match(
    wgsl,
    /if \(eclipseUniforms\.params\.x < 2\.5\)[\s\S]*globe_eclipseFragmentFactor\(input\.v_positionMC\)/,
  );
  assert.match(glsl, /u_eclipseParams\.x > 1\.5 && u_eclipseParams\.x < 3\.5/);
  assert.match(
    wgsl,
    /eclipseUniforms\.params\.x > 1\.5 &&\s*eclipseUniforms\.params\.x < 3\.5/,
  );
});

test("WebGL excludes S5 from inactive globe shader variants", () => {
  const glsl = readSource("Shaders/GlobeFS.glsl");
  const shaderSet = readSource("Scene/GlobeSurfaceShaderSet.js");
  const tileRendering = readSource(
    "Scene/GlobeSurfaceTileProviderRendering.js",
  );

  assert.match(
    glsl,
    /#ifdef ENABLE_ECLIPSE_GLOBE_SHADOW\s+uniform mat4 u_eclipseGlobeShadow;[\s\S]*?#endif/,
  );
  const helperMarker = glsl.indexOf(
    "// Paired with the eclipse globe shadow in",
  );
  const helperGuard = glsl.lastIndexOf(
    "#ifdef ENABLE_ECLIPSE_GLOBE_SHADOW",
    helperMarker,
  );
  const helperEnd = glsl.indexOf("#endif", helperMarker);
  const mainStart = glsl.indexOf("void main()", helperEnd);
  assert.ok(helperGuard >= 0 && helperGuard < helperMarker);
  assert.ok(helperEnd > helperMarker && helperEnd < mainStart);
  const helperBlock = glsl.slice(helperGuard, helperEnd);
  assert.match(helperBlock, /float eclipseGeometricObscuration\(/);
  assert.match(helperBlock, /float eclipseFragmentFactor\(vec3 positionMC\)/);

  const applicationMarker = glsl.indexOf(
    "float eclipseAbsolute = 1.0;",
    mainStart,
  );
  const applicationGuard = glsl.lastIndexOf(
    "#ifdef ENABLE_ECLIPSE_GLOBE_SHADOW",
    applicationMarker,
  );
  const glowMarker = glsl.indexOf(
    "float terminatorGlowStrength",
    applicationMarker,
  );
  const glowGuard = glsl.lastIndexOf(
    "#if defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING)",
    glowMarker,
  );
  const applicationEnd = glsl.lastIndexOf("#endif", glowGuard);
  assert.ok(
    applicationGuard >= 0 &&
      applicationGuard < applicationMarker &&
      applicationEnd > applicationMarker &&
      applicationEnd < glowGuard,
  );
  const applicationBlock = glsl.slice(applicationGuard, applicationEnd);
  assert.match(applicationBlock, /finalColor\.rgb \*= eclipseAbsolute;/);
  assert.match(applicationBlock, /terminatorGlowEclipse = eclipseAbsolute;/);
  assert.match(
    glsl,
    /#ifdef ENABLE_ECLIPSE_GLOBE_SHADOW\s+groundAtmosphereColor\.rgb \*= eclipseRelative;\s+#endif/,
  );

  assert.match(shaderSet, /\(enableEclipseGlobeShadow \? 0x200000000 : 0\)/);
  assert.match(
    shaderSet,
    /if \(enableEclipseGlobeShadow\) \{\s*fs\.defines\.push\("ENABLE_ECLIPSE_GLOBE_SHADOW"\);\s*\}/,
  );
  assert.match(
    tileRendering,
    /surfaceShaderSetOptions\.enableEclipseGlobeShadow =\s*frameState\.eclipseGlobeShadow\?\.active === true;/,
  );
});

test("WebGPU uses a dedicated third dynamic UBO without widening CameraUniforms", () => {
  const layouts = readSource("Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts");
  const renderer = readSource("Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts");
  const types = readSource("Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts");
  const cameraUB = readSource("Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts");
  const terrainShader = readSource("Shaders/WebGPU/Globe/GlobeTerrain.wgsl");
  const eclipseUniforms = readSource(
    "Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
  );
  const ringAllocator = readSource(
    "Renderer/WebGPU/WebGPURingBufferAllocator.ts",
  );

  assert.match(
    layouts,
    /uniformBuffer\(2, Stage\.FRAGMENT, \{\s*hasDynamicOffset: true,\s*minBindingSize: ECLIPSE_UNIFORM_BYTES,/,
  );
  assert.match(
    renderer,
    /binding: 2,\s*resource: \{\s*buffer: eclipseUB\.buffer/,
  );
  assert.match(
    renderer,
    /dynamicOffsets: \[cameraUB\.offset, tileUB\.offset, eclipseUB\.offset\]/,
  );
  assert.match(eclipseUniforms, /export const ECLIPSE_UNIFORM_FLOATS = 16;/);
  assert.match(eclipseUniforms, /allocator\?\.allocationEpoch/);
  assert.match(ringAllocator, /get allocationEpoch\(\): number/);
  assert.match(types, /export const CAMERA_UNIFORM_FLOATS = 232;/);
  assert.doesNotMatch(types, /CAMERA_UNIFORM_FLOATS = 248/);

  // Three formerly-padding f32 lanes after vec3 fields are offsets 51, 55,
  // and 59. Reusing them keeps the 232-float layout and every tail offset
  // stable while supplying the rendered ellipsoid to the fragment stage.
  assert.deepEqual([3 * 16 + 3, 3 * 16 + 7, 3 * 16 + 11], [51, 55, 59]);
  const wgslCameraStart = terrainShader.indexOf("struct CameraUniforms");
  const wgslCameraEnd = terrainShader.indexOf("};", wgslCameraStart);
  const wgslCamera = terrainShader.slice(wgslCameraStart, wgslCameraEnd);
  for (const field of [
    "encodedCameraHigh: vec3<f32>",
    "ellipsoidInverseRadiiX: f32",
    "encodedCameraLow: vec3<f32>",
    "ellipsoidInverseRadiiY: f32",
    "center3DHigh: vec3<f32>",
    "ellipsoidInverseRadiiZ: f32",
    "center3DLow: vec3<f32>",
  ]) {
    assert.ok(
      wgslCamera.includes(field),
      `CameraUniforms must contain ${field}`,
    );
  }
  assert.ok(
    [
      "encodedCameraHigh: vec3<f32>",
      "ellipsoidInverseRadiiX: f32",
      "encodedCameraLow: vec3<f32>",
      "ellipsoidInverseRadiiY: f32",
      "center3DHigh: vec3<f32>",
      "ellipsoidInverseRadiiZ: f32",
      "center3DLow: vec3<f32>",
    ]
      .map((field) => wgslCamera.indexOf(field))
      .every(
        (offset, index, offsets) => index === 0 || offset > offsets[index - 1],
      ),
  );
  assert.match(
    cameraUB,
    /data\[offset\+\+\] = camHigh\.z;[\s\S]*data\[offset\+\+\] = ellipsoidInverseRadii\.x;[\s\S]*data\[offset\+\+\] = camLow\.z;[\s\S]*data\[offset\+\+\] = ellipsoidInverseRadii\.y;[\s\S]*data\[offset\+\+\] = czHigh;[\s\S]*data\[offset\+\+\] = ellipsoidInverseRadii\.z;/,
  );
});

test("logical View, selection refinement, capture, and pick stay integrated", () => {
  const view = readSource("Scene/View.js");
  const scene = readSource("Scene/Scene.js");
  const frameState = readSource("Scene/FrameState.js");
  const conditions = readSource("Scene/AtmosphericConditions.js");
  const tileProvider = readSource("Scene/GlobeSurfaceTileProvider.js");
  const tileRendering = readSource(
    "Scene/GlobeSurfaceTileProviderRendering.js",
  );
  const capture = readSource(
    "Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
  );

  assert.match(
    view,
    /this\._eclipseGlobeShadow = createEclipseGlobeShadow\(\);/,
  );
  assert.match(frameState, /this\.eclipseGlobeShadow = undefined;/);
  assert.match(conditions, /enableEclipseGlobeShadow: true,/);
  assert.match(scene, /function prepareLogicalViewEclipse\(scene\)/);
  assert.match(
    scene,
    /frameState\.eclipseGlobeShadow = undefined;[\s\S]*frameState\.eclipseGlobeShadowPrepared = false;[\s\S]*frameState\.eclipseGlobeShadowSurfaceRadius = undefined;[\s\S]*frameState\.eclipseGlobeShadowSelectionRevision = undefined;/,
  );
  assert.doesNotMatch(
    scene,
    /updateEclipseGlobeShadowForFrameState/,
    "Scene must leave exact-set S5 preparation to capture, terrain, and pick owners",
  );
  assert.match(
    frameState,
    /this\.eclipseGlobeShadowSelectionRevision = undefined;/,
  );
  assert.match(
    tileRendering,
    /u_eclipseGlobeShadow: function \(\) \{\s*return this\.properties\.eclipseGlobeShadow\.webglPackedUniform;\s*\}/,
  );
  assert.doesNotMatch(
    tileRendering,
    /u_eclipseSunDirectionAndInvRange: function|u_eclipseMoonDirectionDeltaAndInvRange: function|u_eclipseParams2?: function|u_eclipseEllipsoidInverseRadii: function/,
    "WebGL must not restore the five per-draw manual eclipse uniforms",
  );

  const prepareStart = scene.indexOf(
    "function prepareLogicalViewEclipse(scene)",
  );
  const prepareEnd = scene.indexOf("\nfunction render(scene)", prepareStart);
  const prepare = scene.slice(prepareStart, prepareEnd);
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  assert.doesNotMatch(
    prepare,
    /updateEclipseGlobeShadowForFrameState|forEachLoadedTile|_tilesToRender|computeRenderedGlobeSurfaceRadius|_eclipseSurfaceRadius/,
    "logical View preparation must reset S5 and defer exact-set classification to command owners",
  );

  const updateStart = scene.indexOf("updateFrameState() {");
  const prepareCall = scene.indexOf(
    "prepareLogicalViewEclipse(this)",
    updateStart,
  );
  const nextMethod = scene.indexOf("isVisible(", prepareCall);
  assert.ok(updateStart >= 0 && prepareCall > updateStart);
  assert.ok(nextMethod > prepareCall);

  const beginUpdateStart = tileProvider.indexOf("beginUpdate(frameState)");
  const endUpdateStart = tileProvider.indexOf("endUpdate(frameState)");
  const showTileStart = tileProvider.indexOf(
    "showTileThisFrame(tile, frameState)",
  );
  const updateForPickStart = tileProvider.indexOf("updateForPick(frameState)");
  assert.doesNotMatch(
    tileProvider.slice(beginUpdateStart, endUpdateStart),
    /_eclipse/,
    "ordinary frame setup must not initialize selected-tile eclipse accumulation",
  );
  const showTileEnd = tileProvider.indexOf(
    "computeDistanceToTile(tile, frameState)",
    showTileStart,
  );
  assert.doesNotMatch(
    tileProvider.slice(showTileStart, showTileEnd),
    /eclipse|Eclipse/,
    "ordinary tile selection/command bucketing must do zero eclipse work",
  );
  const loadTileStart = tileProvider.indexOf("loadTile(frameState, tile)");
  const loadTileEnd = tileProvider.indexOf(
    "computeTileVisibility(tile, frameState, occluders)",
    loadTileStart,
  );
  assert.match(
    tileProvider.slice(loadTileStart, loadTileEnd),
    /observeTerrainMeshForEclipse\(this, tile\.data\?\.mesh\);/,
    "terrain height bounds must move to the one-time resource publication edge",
  );
  assert.match(
    tileProvider,
    /const ECLIPSE_FILL_SKIRT_ALLOWANCE_METERS = 1000\.0;[\s\S]*VerticalExaggeration\.getHeight\([\s\S]*_eclipseKnownMinimumHeight -\s*ECLIPSE_FILL_SKIRT_ALLOWANCE_METERS[\s\S]*_eclipseKnownMaximumHeight/,
  );
  assert.match(
    tileProvider,
    /indexLength === mesh\.indexCountWithoutSkirts;[\s\S]*if \(!noSkirtsProven\) \{\s*tileProvider\._eclipseKnownBoundsValid = false;/,
    "unknown or malformed skirt bounds must disable rejection conservatively",
  );
  assert.match(
    tileProvider,
    /set terrainProvider\(terrainProvider\)[\s\S]*this\._eclipseSurfaceRadius = undefined;[\s\S]*resetKnownTerrainEclipseBounds\(this\);/,
    "a terrain-provider swap must discard the old resource envelope",
  );
  assert.match(
    tileProvider.slice(endUpdateStart, showTileStart),
    /this\._eclipseSurfaceRadius = computeKnownTerrainEclipseSurfaceRadius\(\s*this,\s*frameState,\s*\);[\s\S]*this\._eclipseSelectionRevision\+\+;[\s\S]*updateEclipseGlobeShadowForFrameState\(\s*frameState,\s*this\._eclipseSurfaceRadius,\s*this\._quadtree\._tilesToRender,\s*this\._eclipseSelectionRevision,\s*\);/,
  );
  const mainRefinement = tileProvider.indexOf(
    "updateEclipseGlobeShadowForFrameState(",
    endUpdateStart,
  );
  const firstTileCommand = tileProvider.indexOf(
    "addDrawCommandsForTile(this, tile, frameState)",
    mainRefinement,
  );
  assert.ok(mainRefinement >= 0 && firstTileCommand > mainRefinement);

  const pickSource = tileProvider.slice(
    updateForPickStart,
    tileProvider.indexOf("cancelReprojections()", updateForPickStart),
  );
  const pickViewCarrier = pickSource.indexOf("pushWebGLViewBoundGlobeCommand(");
  const pickRefinement = pickSource.indexOf(
    "updateEclipseGlobeShadowForFrameState(",
  );
  assert.ok(
    pickRefinement >= 0 && pickViewCarrier > pickRefinement,
    "pick must prepare its rebuilt terrain set before creating and pushing a View-bound command",
  );
  assert.match(
    pickSource,
    /pushWebGLViewBoundGlobeCommand\(drawCommands\[i\], frameState\)/,
  );
  assert.match(
    pickSource,
    /const webGPUHandled = updateWebGPUForPick\(this, frameState\);\s*if \(!webGPUHandled\) \{[\s\S]*pushWebGLViewBoundGlobeCommand\(drawCommands\[i\], frameState\);/,
    "the View-bound WebGL replay must remain behind the WebGPU handled branch",
  );
  assert.doesNotMatch(
    pickSource,
    /_uniformMaps\[i\]\.properties\.eclipseGlobeShadow\s*=/,
    "a pick/offscreen View must not mutate the pooled command carrier",
  );
  assert.match(
    tileRendering,
    /function pushWebGLViewBoundGlobeCommand\([\s\S]*globeTranslucencyState\.updateDerivedCommands\(viewCommand, frameState\);[\s\S]*pushCommand\(viewCommand, frameState\);/,
    "a translucent replay must populate its ephemeral derived graph before push",
  );
  assert.match(
    pickSource,
    /updateEclipseGlobeShadowForFrameState\(\s*frameState,\s*this\._eclipseSurfaceRadius,\s*this\._quadtree\._tilesToRender,\s*this\._eclipseSelectionRevision,\s*\);/,
  );

  const captureRun = capture.indexOf("export function runSceneCapture(");
  const captureOptInGate = capture.indexOf(
    "ctx.sceneCaptureReflections !== true",
    captureRun,
  );
  const captureOptInReturn = capture.indexOf(
    "return SceneCaptureResult.FAILED;",
    captureOptInGate,
  );
  const captureSourceGate = capture.indexOf(
    "!hasRenderableSceneCaptureSources(frameState)",
    captureOptInReturn,
  );
  const captureSourceReturn = capture.indexOf(
    "return SceneCaptureResult.FAILED;",
    captureSourceGate,
  );
  const captureRefinement = capture.indexOf(
    "updateEclipseGlobeShadowForFrameState(",
    captureRun,
  );
  const captureFaceLoop = capture.indexOf(
    "for (let face = 0; face < 6; face++)",
    captureRun,
  );
  assert.ok(
    captureOptInGate > captureRun &&
      captureOptInReturn > captureOptInGate &&
      captureSourceGate > captureOptInReturn &&
      captureSourceReturn > captureSourceGate &&
      captureRefinement > captureSourceReturn &&
      captureFaceLoop > captureRefinement,
    "retained tiles must refine S5 before any face command snapshots the block",
  );
  assert.match(
    capture.slice(captureRun, captureFaceLoop),
    /retainedBoundsCurrent \? tiles : undefined,[\s\S]*tileProvider\._eclipseSelectionRevision/,
  );
});

test("private capture flushes staged UBO bytes before its mid-frame submit", () => {
  const context = readSource("Renderer/WebGPU/WebGPUContext.ts");
  const capture = readSource(
    "Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
  );

  assert.match(
    context,
    /flushPendingUniformUploads\(\): void \{\s*this\._uniformAllocator\?\.flush\(\);\s*\}/,
  );
  const uniformFlush = capture.indexOf("ctx.flushPendingUniformUploads?.()");
  const mipFlush = capture.indexOf(
    "ctx.flushPendingTextureMipJobs?.()",
    uniformFlush,
  );
  const captureSubmit = capture.indexOf(
    "device.queue.submit([encoder.finish()])",
    mipFlush,
  );
  assert.ok(uniformFlush >= 0);
  assert.ok(mipFlush > uniformFlush);
  assert.ok(
    captureSubmit > mipFlush,
    "queue order must be uniforms -> imagery mips -> capture command buffer",
  );
});

test("uniform ring and retained capture snapshots cannot survive device teardown", () => {
  const context = readSource("Renderer/WebGPU/WebGPUContext.ts");

  const createStart = context.indexOf("  static async create(");
  const initializeStart = context.indexOf(
    "  private async _initialize(): Promise<void>",
    createStart,
  );
  const create = context.slice(createStart, initializeStart);
  assert.match(
    create,
    /catch \(error\) \{[\s\S]*try \{\s*context\?\.destroy\(\);\s*\} catch \{[\s\S]*\}\s*throw error;/,
    "failed initialization must preserve its primary error after best-effort teardown",
  );

  const destroyStart = context.indexOf(
    "  destroy(): void {",
    context.indexOf("override createPickFramebuffer"),
  );
  const destroyEnd = context.indexOf(
    "\n  // ====================================================================================",
    destroyStart,
  );
  const destroy = context.slice(destroyStart, destroyEnd);
  assert.ok(destroyStart >= 0 && destroyEnd > destroyStart);
  assert.match(
    destroy,
    /const uniformAllocator = this\._uniformAllocator;\s*this\._uniformAllocator = null;\s*continueFinalCleanupAfter\(\(\) => uniformAllocator\?\.destroy\(\)\);/,
  );
  const uniformAllocatorDestroy = destroy.indexOf(
    "uniformAllocator?.destroy()",
  );
  const pooledDeviceRelease = destroy.indexOf(
    "WebGPUDevicePool.instance.releaseDevice(device)",
    uniformAllocatorDestroy,
  );
  const isolatedDeviceDestroy = destroy.indexOf(
    "device.destroy()",
    uniformAllocatorDestroy,
  );
  assert.ok(
    uniformAllocatorDestroy >= 0 &&
      pooledDeviceRelease > uniformAllocatorDestroy &&
      isolatedDeviceDestroy > uniformAllocatorDestroy,
    "ring pages must be destroyed before either pooled-device release or isolated-device destruction",
  );
  assert.match(
    destroy,
    /const device = this\._device;\s*const deviceFromPool = this\._deviceFromPool;\s*const terminallyLost = this\._isTerminallyLost;\s*this\._device = null;\s*this\._deviceFromPool = false;\s*continueFinalCleanupAfter\(\(\) => \{\s*if \(deviceFromPool\) \{\s*WebGPUDevicePool\.instance\.releaseDevice\(device\);\s*\} else if \(!terminallyLost\) \{\s*device\.destroy\(\);\s*\}\s*\}\);/,
    "pooled release and isolated destruction must remain exclusive, guarded, and detach-first",
  );
  assert.match(
    destroy,
    /this\._pendingTextureMipJobs\.length = 0;\s*this\._pendingTextureMipJobKeys = new WeakMap\(\);\s*this\._isDestroyed = true;/,
    "terminal state and pending mip ownership must detach before cleanup can throw",
  );
  assert.match(
    destroy,
    /this\._isTerminallyLost = false;[\s\S]*if \(hasFinalCleanupError\) \{\s*throw firstFinalCleanupError;\s*\}/,
    "guarded teardown must drain the final cleanup tail before reporting its first error",
  );

  const registryStart = context.indexOf(
    "private _registerResourceCaches(): void",
  );
  const registryEnd = context.indexOf("public _clearAllCaches(", registryStart);
  const registry = context.slice(registryStart, registryEnd);
  const uniformRegistryStart = registry.indexOf('.register("uniformAllocator"');
  const uniformRegistryEnd = registry.indexOf(
    '.register("depthTexture"',
    uniformRegistryStart,
  );
  const uniformRegistry = registry.slice(
    uniformRegistryStart,
    uniformRegistryEnd,
  );
  assert.match(
    uniformRegistry,
    /this\._uniformAllocator\?\.destroy\(\);[\s\S]*this\._uniformAllocator = null;/,
  );

  const clearStart = registryEnd;
  const clearEnd = context.indexOf(
    "\n  /**",
    context.indexOf("_fireDeviceInvalidated", clearStart),
  );
  const clearCaches = context.slice(clearStart, clearEnd);
  assert.match(clearCaches, /\)._webgpuSceneCaptureSources = null;/);
  assert.match(clearCaches, /\)._webgpuSceneCaptureModels = null;/);
});
