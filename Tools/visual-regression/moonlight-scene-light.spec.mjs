// moonlight-scene-light.spec.mjs — the Moon as a scene light source.
// @purpose Proves a MoonLight scene light produces a real ephemeris direction through the live UniformState.update, that the moon eye-space direction is unchanged by it, and that the lunar dimming arm downstream is therefore reachable.
// @status ACTIVE
//
// WHAT THIS SPEC IS FOR. `MoonLight` is documented as a marker class: like
// `SunLight` it carries colour and intensity but no per-instance `direction`,
// because the direction is ephemeris rather than user state. `UniformState`
// had a two-way branch — `SunLight`, and everything else — and the else arm
// negates `light.direction`. A `MoonLight` therefore took the frame down on
// its first update, so `scene.light = new Cesium.MoonLight()` halted rendering
// and every consumer downstream of that branch, including the lunar-eclipse
// moonlight dimming, had never executed once.
//
// The lane that landed the dimming pinned it entirely through source text and
// through the pure resolver `getLunarEclipseMoonlightFactor`. Both were true,
// and neither could see that the code path leading to them was unreachable.
// So this spec drives the real `UniformState.update` with a real `MoonLight`
// and asserts what comes out of it.
//
// The things it must establish, in order:
//
//   1. the frame survives — the pre-fix failure was a throw, so any assertion
//      at all past `update()` is the regression guard for it;
//   2. the direction is the Moon's, in the sense `czm_lightDirectionWC` is
//      documented in — TOWARD the light, which is what the `SunLight` arm
//      clones and what the generic arm produces by negating a
//      `DirectionalLight`'s travel direction;
//   3. `moonDirectionEC` — an existing automatic uniform with existing shader
//      consumers — is bit-for-bit what it was before, because the world-space
//      direction is captured from the same intermediate rather than recomputed
//      from a normalised one;
//   4. the dimming arm downstream now multiplies through a live update.
//
// LINE ENDINGS: this repo checks out CRLF. Every source read below is
// normalised to \n first.
//
// Run: node --test Tools/visual-regression/moonlight-scene-light.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

// `LightTypes` is TypeScript, and engine source writes `.js` specifiers even
// between `.ts` files. The shared resolver remaps those; the load hook
// transpiles. Both are the pattern the device-loss specs in this directory
// already use, and neither changes what the engine modules do.
registerHooks({
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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

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
const uniformStateSource = read(engine("Renderer/UniformState.js"));

const UniformState = (await load(engine("Renderer/UniformState.js"))).default;
const Cartesian3 = (await load(engine("Core/Cartesian3.js"))).default;
const Cartographic = (await load(engine("Core/Cartographic.js"))).default;
const Color = (await load(engine("Core/Color.js"))).default;
const Ellipsoid = (await load(engine("Core/Ellipsoid.js"))).default;
const GeographicProjection = (
  await load(engine("Core/GeographicProjection.js"))
).default;
const JulianDate = (await load(engine("Core/JulianDate.js"))).default;
const CesiumMath = (await load(engine("Core/Math.js"))).default;
const Matrix3 = (await load(engine("Core/Matrix3.js"))).default;
const Matrix4 = (await load(engine("Core/Matrix4.js"))).default;
const PerspectiveFrustum = (await load(engine("Core/PerspectiveFrustum.js")))
  .default;
const Simon1994PlanetaryPositions = (
  await load(engine("Core/Simon1994PlanetaryPositions.js"))
).default;
const Transforms = (await load(engine("Core/Transforms.js"))).default;
const SceneMode = (await load(engine("Scene/SceneMode.js"))).default;
const MoonLight = (await load(engine("Scene/MoonLight.js"))).default;
const SunLight = (await load(engine("Scene/SunLight.js"))).default;
const DirectionalLight = (await load(engine("Scene/LightTypes.ts")))
  .DirectionalLight;
const { getLunarEclipseMoonlightFactor } = await load(
  engine("Scene/EclipseState.js"),
);
const { createLunarEclipseState, updateLunarEclipseState } = await load(
  engine("Scene/LunarEclipseState.js"),
);

// The 2026-08-28 deep partial, at greatest and at a pre-eclipse reference.
// The same instants the landed lunar specs and the Edge acceptance leg use.
const GREATEST = "2026-08-28T04:11:30Z";
const BEFORE_FIRST_CONTACT = "2026-08-28T01:00:00Z";

// Porto Velho, the sub-lunar site of that eclipse — the observer the
// eclipse-explorer preset places for it.
const SITE = { longitude: -63.9004, latitude: -8.7612, height: 90.0 };

const lunarState = createLunarEclipseState();
const lunarOptions = {
  sunPositionWC: new Cartesian3(),
  moonPositionWC: new Cartesian3(),
  earthRadius: Ellipsoid.WGS84.maximumRadius,
  moonRadius: CesiumMath.LUNAR_RADIUS,
};

function lunarStateAt(iso) {
  const date = JulianDate.fromIso8601(iso);
  Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
    date,
    lunarOptions.sunPositionWC,
  );
  Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
    date,
    lunarOptions.moonPositionWC,
  );
  return updateLunarEclipseState(lunarState, lunarOptions);
}

// ───────────────────────────────────────────────────────────────────────────
// A frame state real enough for UniformState.update to run end to end.
//
// Every field here is one `UniformState.update` actually reads. Nothing the
// light path touches is stubbed: the projection, the frustum and the clock are
// the engine's own types, so the ephemeris the light direction comes out of is
// the ephemeris the renderer would use.
// ───────────────────────────────────────────────────────────────────────────

function makeCamera() {
  const position = Cartesian3.fromDegrees(
    SITE.longitude,
    SITE.latitude,
    SITE.height,
  );
  // Looking straight up from the site, which is where the Moon is at greatest
  // for this preset.
  const direction = Ellipsoid.WGS84.geodeticSurfaceNormal(
    position,
    new Cartesian3(),
  );
  const right = Cartesian3.normalize(
    Cartesian3.cross(direction, Cartesian3.UNIT_Z, new Cartesian3()),
    new Cartesian3(),
  );
  return {
    viewMatrix: Matrix4.clone(Matrix4.IDENTITY),
    inverseViewMatrix: Matrix4.clone(Matrix4.IDENTITY),
    positionWC: position,
    directionWC: direction,
    rightWC: right,
    upWC: Cartesian3.normalize(
      Cartesian3.cross(right, direction, new Cartesian3()),
      new Cartesian3(),
    ),
    positionCartographic: Cartographic.fromCartesian(position),
    frustum: new PerspectiveFrustum({
      fov: CesiumMath.toRadians(6.0),
      aspectRatio: 1.0,
      near: 0.1,
      far: 1.0e10,
    }),
  };
}

const camera = makeCamera();

function makeFrameState(overrides) {
  return Object.assign(
    {
      mode: SceneMode.SCENE3D,
      mapProjection: new GeographicProjection(),
      pixelRatio: 1.0,
      camera,
      time: JulianDate.fromIso8601(GREATEST),
      light: undefined,
      lights: undefined,
      fog: { density: 0.0, visualDensityScalar: 0.0, minimumBrightness: 0.0 },
      backgroundColor: Color.BLACK,
      splitPosition: 0.5,
      maximumScreenSpaceError: 2.0,
      minimumDisableDepthTestDistance: 0.0,
      invertClassificationColor: Color.WHITE,
      context: { drawingBufferWidth: 800, drawingBufferHeight: 800 },
    },
    overrides,
  );
}

function updatedWith(overrides) {
  const uniformState = new UniformState();
  uniformState.update(makeFrameState(overrides));
  return uniformState;
}

const vec = (c) => ({ x: c.x, y: c.y, z: c.z });

// ───────────────────────────────────────────────────────────────────────────
// 1. The frame survives, and the direction is the Moon's
// ───────────────────────────────────────────────────────────────────────────

test("a MoonLight scene light completes a frame instead of throwing", () => {
  // Pre-fix this call threw out of `Cartesian3.negate` on an undefined
  // `light.direction`, which is what "rendering has stopped" was.
  const uniformState = updatedWith({ light: new MoonLight() });

  const direction = uniformState.lightDirectionWC;
  assert.ok(
    Number.isFinite(direction.x) &&
      Number.isFinite(direction.y) &&
      Number.isFinite(direction.z),
    "the light direction must be finite, not NaN from an absent source",
  );
  assert.ok(
    Math.abs(Cartesian3.magnitude(direction) - 1.0) < 1.0e-12,
    "the light direction must be a unit vector",
  );

  // Eye space too — the model and globe packers read `lightDirectionEC`.
  assert.ok(
    Math.abs(Cartesian3.magnitude(uniformState.lightDirectionEC) - 1.0) <
      1.0e-12,
    "the eye-space light direction must be a unit vector",
  );
});

test("the light direction points at the Moon, in the same sense the Sun's does", () => {
  const time = JulianDate.fromIso8601(GREATEST);
  const moon = updatedWith({ light: new MoonLight(), time });
  const sun = updatedWith({ light: new SunLight(), time });

  // The engine's own ephemeris for this instant, in the Earth-fixed frame,
  // derived here independently of UniformState.
  const fixed = new Matrix3();
  Transforms.computeIcrfToCentralBodyFixedMatrix(time, fixed);
  const moonPosition = Matrix3.multiplyByVector(
    fixed,
    Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      time,
      new Cartesian3(),
    ),
    new Cartesian3(),
  );
  const sunPosition = Matrix3.multiplyByVector(
    fixed,
    Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      time,
      new Cartesian3(),
    ),
    new Cartesian3(),
  );

  // `czm_lightDirectionWC` is "the normalized direction to the scene's light
  // source" (AutomaticUniforms.js). Both arms must satisfy that, or the
  // Lambert term inverts for one of them and the lit side of the world is the
  // side facing away from the light.
  const towardMoon = Cartesian3.normalize(moonPosition, new Cartesian3());
  const towardSun = Cartesian3.normalize(sunPosition, new Cartesian3());
  assert.ok(
    Cartesian3.dot(moon.lightDirectionWC, towardMoon) > 0.999,
    "the MoonLight direction must point toward the Moon, not away from it",
  );
  assert.ok(
    Cartesian3.dot(sun.lightDirectionWC, towardSun) > 0.999,
    "control: the SunLight arm points toward the Sun",
  );

  // And the two are genuinely different lights — a MoonLight that silently
  // fell through to the Sun would satisfy every assertion above but this one.
  assert.ok(
    Cartesian3.dot(moon.lightDirectionWC, sun.lightDirectionWC) < 0.9,
    "at a deep lunar eclipse the Moon is near-opposite the Sun; the two light directions must not coincide",
  );

  // The direction is published on its own accessor as well, so a consumer that
  // wants the Moon regardless of `scene.light` has the world-space twin of the
  // existing `moonDirectionEC`.
  assert.deepEqual(vec(moon.lightDirectionWC), vec(moon.moonDirectionWC));
});

test("a published celestial ephemeris sample is the exact source when Scene provides one", () => {
  // Scene's normal path publishes one shared Earth-fixed sample per frame so
  // every celestial consumer reads the same numbers. The light must come from
  // that sample verbatim, not from a second independent ephemeris evaluation.
  const moonPositionWC = new Cartesian3(
    175779477.88,
    -343002679.17,
    -63148967.53,
  );
  const sunPositionWC = new Cartesian3(1.2e11, -8.0e10, -3.4e10);
  const uniformState = updatedWith({
    light: new MoonLight(),
    celestialEphemerisSample: { moonPositionWC, sunPositionWC },
  });

  const expected = Cartesian3.normalize(moonPositionWC, new Cartesian3());
  assert.deepEqual(vec(uniformState.lightDirectionWC), vec(expected));
  assert.deepEqual(vec(uniformState.moonDirectionWC), vec(expected));
});

test("moonDirectionEC is bit-for-bit what it was before the world-space capture", () => {
  // `moonDirectionEC` is an existing automatic uniform with existing shader
  // consumers. The world-space direction is taken from the same unrotated
  // intermediate rather than recomputed, so this is exact equality and not a
  // tolerance: normalising before the view rotation instead of after would
  // move the low bits of every fragment that samples it.
  const time = JulianDate.fromIso8601(GREATEST);
  const uniformState = updatedWith({ light: new MoonLight(), time });

  const fixed = new Matrix3();
  Transforms.computeIcrfToCentralBodyFixedMatrix(time, fixed);
  const position =
    Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      time,
      new Cartesian3(),
    );
  Matrix3.multiplyByVector(fixed, position, position);
  // Exactly the pre-change expression: rotate the UNNORMALISED fixed-frame
  // position into eye space, then normalise once.
  Matrix3.multiplyByVector(uniformState.viewRotation3D, position, position);
  Cartesian3.normalize(position, position);

  assert.deepEqual(vec(uniformState.moonDirectionEC), vec(position));
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Colour and intensity, honoured the way every other light's are
// ───────────────────────────────────────────────────────────────────────────

test("MoonLight colour and intensity reach the scene light colour", () => {
  const dim = updatedWith({ light: new MoonLight() });
  const defaults = new MoonLight();
  // The default MoonLight is faint (intensity 0.05), so no channel exceeds 1
  // and the LDR clamp is the identity: both colour slots carry colour times
  // intensity.
  const expectedHdr = {
    x: defaults.color.red * defaults.intensity,
    y: defaults.color.green * defaults.intensity,
    z: defaults.color.blue * defaults.intensity,
  };
  assert.deepEqual(vec(dim.lightColorHdr), expectedHdr);
  assert.deepEqual(vec(dim.lightColor), expectedHdr);

  // A bright MoonLight exercises the renormalisation: `lightColorHdr` keeps
  // the raw product, `lightColor` is scaled so its brightest channel is 1.
  const bright = updatedWith({
    light: new MoonLight({
      color: new Color(0.5, 0.25, 1.0, 1.0),
      intensity: 4.0,
    }),
  });
  assert.deepEqual(vec(bright.lightColorHdr), { x: 2.0, y: 1.0, z: 4.0 });
  assert.deepEqual(vec(bright.lightColor), { x: 0.5, y: 0.25, z: 1.0 });
});

test("a DirectionalLight is untouched by the new arm", () => {
  // The generic arm still owns every light that carries its own direction,
  // and it still negates it.
  const uniformState = updatedWith({
    light: new DirectionalLight({
      direction: new Cartesian3(0.0, 0.0, -2.0),
    }),
  });
  assert.equal(uniformState.lightDirectionWC.z, 1.0);
  assert.equal(Math.abs(uniformState.lightDirectionWC.x), 0.0);
  assert.equal(Math.abs(uniformState.lightDirectionWC.y), 0.0);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. The dimming arm downstream is reachable — the whole point
// ───────────────────────────────────────────────────────────────────────────

test("the lunar dimming arm actually multiplies through a live update", () => {
  const atGreatest = lunarStateAt(GREATEST);
  assert.equal(atGreatest.inProgress, true);
  const factor = getLunarEclipseMoonlightFactor(atGreatest, undefined);
  assert.ok(factor > 0.04 && factor < 0.05, `factor ${factor}`);

  const light = new MoonLight();
  const base = updatedWith({ light });
  const dimmed = updatedWith({ light, lunarEclipse: atGreatest });

  // Exact: the arm is one multiply by a scalar on both colour slots, and a
  // float multiply is reproducible.
  assert.deepEqual(vec(dimmed.lightColorHdr), {
    x: base.lightColorHdr.x * factor,
    y: base.lightColorHdr.y * factor,
    z: base.lightColorHdr.z * factor,
  });
  assert.deepEqual(vec(dimmed.lightColor), {
    x: base.lightColor.x * factor,
    y: base.lightColor.y * factor,
    z: base.lightColor.z * factor,
  });

  // The magnitude the Edge leg is measured against: more than an order of
  // magnitude, or the effect is not visible and this test proves nothing.
  assert.ok(base.lightColor.z / dimmed.lightColor.z > 20.0);
});

test("outside the umbral window a MoonLight frame is exactly undimmed", () => {
  const before = lunarStateAt(BEFORE_FIRST_CONTACT);
  assert.equal(before.inProgress, false);

  const light = new MoonLight();
  const base = updatedWith({ light });
  const outside = updatedWith({ light, lunarEclipse: before });
  assert.deepEqual(vec(outside.lightColor), vec(base.lightColor));
  assert.deepEqual(vec(outside.lightColorHdr), vec(base.lightColorHdr));
});

test("the lighting toggle is the sensitivity anchor and it reaches the arm", () => {
  const atGreatest = lunarStateAt(GREATEST);
  const light = new MoonLight();
  const base = updatedWith({ light });
  const off = updatedWith({
    light,
    lunarEclipse: atGreatest,
    atmosphericConditions: { lighting: { enableLunarEclipse: false } },
  });
  assert.deepEqual(vec(off.lightColor), vec(base.lightColor));

  // ...and the same frame with the toggle absent does dim, so the assertion
  // above is a rejection rather than a path that never dims at all.
  const on = updatedWith({ light, lunarEclipse: atGreatest });
  assert.ok(on.lightColor.z < base.lightColor.z * 0.1);
});

test("a lunar eclipse leaves a SunLight scene byte-identical", () => {
  // The two arms are mutually exclusive by light type. A lunar eclipse must
  // not darken a sunlit world, and the new direction branch must not have
  // leaked the lunar factor into the solar path.
  const atGreatest = lunarStateAt(GREATEST);
  const light = new SunLight();
  const plain = updatedWith({ light });
  const during = updatedWith({ light, lunarEclipse: atGreatest });
  assert.deepEqual(vec(during.lightColor), vec(plain.lightColor));
  assert.deepEqual(vec(during.lightColorHdr), vec(plain.lightColorHdr));
  assert.deepEqual(vec(during.lightDirectionWC), vec(plain.lightDirectionWC));
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Both backends reach the fix through the same uniform source
// ───────────────────────────────────────────────────────────────────────────

test("the WebGPU globe and model packers take the scene light direction, not the sun's", () => {
  // This is why the fix is one branch in `UniformState` rather than a branch
  // per backend. WebGL's shaders read `czm_lightDirectionEC`, which is
  // `_lightDirectionEC` verbatim; the two WebGPU packers below read the same
  // accessor. A MoonLight direction therefore reaches the WGSL globe, the WGSL
  // model PBR and every GLSL consumer from this one place.
  //
  // If either packer were switched to `sunDirectionEC`, that backend would
  // light a moonlit scene from the Sun while the other lit it from the Moon —
  // a divergence no assertion on `UniformState` alone would see.
  assert.match(
    read(engine("Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts")),
    /const lightDir = uniformState[.]lightDirectionEC;/,
  );
  assert.match(
    read(engine("Renderer/WebGPU/WebGPUModelRenderer.ts")),
    /const sunDir =[\n][\s]*frameState[.]context[?][.]uniformState[?][.]lightDirectionEC [|][|]/,
  );
  assert.match(
    read(engine("Renderer/AutomaticUniforms.js")),
    /czm_lightDirectionEC: new AutomaticUniform[(][{][\s\S]{0,300}?return uniformState[.]lightDirectionEC;/,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 5. The shadow-map camera, the other consumer that dereferenced .direction
// ───────────────────────────────────────────────────────────────────────────

test("the shadow-map light direction has a MoonLight arm, and the failure it prevents is silent", () => {
  // Scene's shadow-map branch is inside a module-private function, so it
  // cannot be driven from here. What CAN be driven is the failure mode: the
  // generic arm calls `Cartesian3.clone`, which returns undefined for an
  // undefined source rather than throwing, so a MoonLight would have left the
  // shadow camera pointing wherever the previous light left it.
  const stale = new Cartesian3(1.0, 2.0, 3.0);
  assert.equal(Cartesian3.clone(undefined, stale), undefined);
  assert.deepEqual(vec(stale), { x: 1.0, y: 2.0, z: 3.0 });

  // The arm, and its source: the negation of the world direction, because the
  // shadow camera looks ALONG the light's travel while `lightDirectionWC`
  // points back at the light.
  const armAt = sceneSource.indexOf(
    "} else if (scene.light instanceof MoonLight) {",
  );
  assert.ok(
    armAt > 0,
    "Scene must carry a MoonLight arm for the shadow camera",
  );
  const arm = sceneSource.slice(armAt, armAt + 900);
  assert.match(arm, /Cartesian3\.negate\(\n\s*uniformState\.moonDirectionWC,/);
  assert.match(sceneSource, /import MoonLight from "\.\/MoonLight\.js";/);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Where the branch lives, so a future edit cannot re-order it into vacuity
// ───────────────────────────────────────────────────────────────────────────

test("the direction branch precedes the colour arm it feeds", () => {
  const directionArm = uniformStateSource.indexOf(
    "} else if (light instanceof MoonLight) {",
  );
  const colourArm = uniformStateSource.indexOf(
    "if (light instanceof MoonLight) {\n      const moonlightFactor",
  );
  assert.ok(directionArm > 0, "the direction arm must exist");
  assert.ok(
    colourArm > directionArm,
    "the colour arm must follow the direction arm",
  );

  // The direction arm must not negate. The moon direction is already in the
  // "toward the light" sense; negating it would light the world from below.
  const arm = uniformStateSource.slice(directionArm, colourArm);
  assert.equal(/Cartesian3\.negate\(\s*this\._moonDirection/.test(arm), false);
});
