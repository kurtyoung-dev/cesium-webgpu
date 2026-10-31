// @purpose Executes the shipped physical cloud air light against an independent single-scatter integral: the orbital disc without a seam, the night limb without air light, the flight cell's sky colour, and a representative point the march's sample phase cannot move.
// @status ACTIVE
//
// W2 round 9 (unit 3450, ruling R-2026-10-30-M2: the physical look at orbit
// with the night-limb guard). Every number below comes from the shipped WGSL:
// `cloudFiniteAirTransport` has an eight-node loop, which the shared evaluator
// does not run, so `unrollAirTransport` rewrites that loop into straight-line
// WGSL mechanically and fails closed on any statement shape it does not know.
// The reference is independent of the shader: a 1,200-cell midpoint rule over
// exact sphere geometry, with the sun's optical depth integrated along the sun
// ray instead of the shader's Chapman fallback.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeCloudAirLightUniforms } from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudAirLight.ts";
import {
  compileFunction,
  extractFunction,
  isVec,
  laneValues,
  readConstants,
  stripComments,
  vec,
  vec4,
} from "./lib/wgsl-mini-eval.mjs";
import { defaultVariant } from "./lib/wgsl-variant.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const dir = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment",
);
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
const SHIPPED = Object.freeze({
  air: read("CloudAirLight.wgsl"),
  aerial: read("CloudAerialTransport.wgsl"),
  solar: read("CloudSolarLighting.wgsl"),
  view: read("CloudViewIntegration.wgsl"),
  march: read("ProceduralClouds.wgsl"),
  sampling: read("CloudMarchSampling.wgsl"),
});

// Sphere radius for the whole spec: the shader's curvature radius is passed in
// explicitly, so a sphere keeps the reference's geometry exact.
const R = 6371000;
// The packed defaults the renderer writes before a sky bake publishes its
// parameters (Rayleigh 5.5/13.0/22.4e-6, Mie 21e-6, 8,500/1,200 m, g 0.758,
// intensity 50, no ozone) - executed out of the shipped packer.
const packed = new Float32Array(16);
writeCloudAirLightUniforms(packed, 0, undefined, undefined, 1);
const lanes4 = (o) =>
  vec4(packed[o], packed[o + 1], packed[o + 2], packed[o + 3]);
const CLOUD = Object.freeze({
  aerialStrength: 1,
  exposure: 0.22,
  planetRadius: R,
  planetPolarRadius: R,
  airRayleigh: lanes4(0),
  airMie: lanes4(4),
  airOzonePhase: lanes4(8),
  airLightControl: lanes4(12),
});

const lift =
  (f) =>
  (...args) =>
    isVec(args[0])
      ? vec(
          ...laneValues(args[0]).map((x, i) =>
            f(
              x,
              ...args.slice(1).map((y) => (isVec(y) ? laneValues(y)[i] : y)),
            ),
          ),
        )
      : f(...args);

/**
 * Rewrite the shipped `for` loop of `cloudFiniteAirTransport` into straight
 * WGSL, one function per output: every `let` in the body is renamed per
 * iteration, `CLOUD_AIR_NODES[i]` becomes that node's literal, and the two
 * struct accumulations become fresh bindings. Any other statement throws.
 *
 * @param {string} src The selected, comment-stripped CloudAirLight source.
 * @param {"radiance"|"transmittance"} output Which field the function returns.
 * @returns {string} WGSL of `cloudFiniteAirTransport_<output>`.
 */
function unrollAirTransport(src, output) {
  const { body } = extractFunction(src, "cloudFiniteAirTransport");
  const nodes =
    /const CLOUD_AIR_NODES = array<vec2<f32>, (\d+)>\(([\s\S]*?)\);/.exec(src);
  assert.ok(nodes, "CLOUD_AIR_NODES not found");
  const nodeList = [...nodes[2].matchAll(/vec2<f32>\(([^)]*)\)/g)].map(
    (m) => `vec2<f32>(${m[1]})`,
  );
  const loop = /for \(var i = 0u; i < (\d+)u; i = i \+ 1u\) \{/.exec(body);
  assert.ok(loop, "the air-transport loop header changed");
  const count = Number(loop[1]);
  assert.equal(nodeList.length, count, "node table and loop disagree");
  let depth = 0;
  let close = loop.index + loop[0].length - 1;
  for (; close < body.length; close++) {
    if (body[close] === "{") {
      depth++;
    } else if (body[close] === "}" && --depth === 0) {
      break;
    }
  }
  const prologue = body.slice(0, loop.index);
  const inner = body.slice(loop.index + loop[0].length, close);
  const epilogue = body.slice(close + 1);
  const statements = (s) =>
    s
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
  const want = output === "radiance" ? "L" : "T";
  const out = [];
  let l = 0;
  let t = 0;
  const sub = (s) =>
    s
      .replace(/result\.radiance/g, `L_${l}`)
      .replace(/result\.transmittance/g, `T_${t}`);
  for (const s of statements(prologue.replace(/\}/g, "};"))) {
    let m;
    if (s === "var result: CloudAirTransport" || s === "}") {
      continue;
    }
    if ((m = /^result\.(radiance|transmittance) = (.+)$/s.exec(s))) {
      out.push(`let ${m[1] === "radiance" ? "L" : "T"}_0 = ${m[2]};`);
    } else if ((m = /^if \((.+)\) \{ return result$/s.exec(s))) {
      out.push(`if (${m[1]}) { return ${want}_0; }`);
    } else if (/^let /.test(s)) {
      out.push(`${sub(s)};`);
    } else {
      throw new Error(`unsupported prologue statement: ${s}`);
    }
  }
  const locals = [...inner.matchAll(/\blet ([A-Za-z_]\w*)/g)].map((m) => m[1]);
  for (let k = 0; k < count; k++) {
    for (let s of statements(inner)) {
      s = s.replace(/CLOUD_AIR_NODES\[i\]/g, nodeList[k]);
      for (const name of locals) {
        s = s.replace(
          new RegExp(`(?<![.\\w])${name}(?!\\w)`, "g"),
          `${name}_${k}`,
        );
      }
      let m;
      if ((m = /^result\.radiance \+= (.+)$/s.exec(s))) {
        out.push(`let L_${l + 1} = L_${l} + (${sub(m[1])});`);
        l++;
      } else if ((m = /^result\.transmittance \*= (.+)$/s.exec(s))) {
        out.push(`let T_${t + 1} = T_${t} * (${sub(m[1])});`);
        t++;
      } else if (/^let /.test(s)) {
        out.push(`${sub(s)};`);
      } else {
        throw new Error(`unsupported loop statement: ${s}`);
      }
    }
  }
  assert.equal(statements(epilogue).join(), "return result");
  out.push(`return ${want}_${want === "L" ? l : t};`);
  const header = /fn cloudFiniteAirTransport\(([\s\S]*?)\)\s*->/.exec(src)[1];
  return `fn cloudFiniteAirTransport_${output}(${header}) -> vec3<f32> {\n${out.join("\n")}\n}`;
}

/**
 * Compile the shipped physical aerial chain out of (possibly mutated) sources.
 *
 * @param {object} [sources] Overrides for SHIPPED's entries.
 * @returns {object} `air`, `color` (cloudPhysicalAerialColor), the visible
 *   sample helpers and the march's two accumulation expressions.
 */
function compileChain(sources = {}, table = undefined) {
  const src = { ...SHIPPED, ...sources };
  const fns = {
    exp: lift(Math.exp),
    acos: Math.acos,
    asin: Math.asin,
    // The unbaked table: alpha 0 keeps the shipped fallback, as on first frame.
    textureSampleLevel: table ?? (() => ({ a: 0, rgb: vec(0, 0, 0) })),
  };
  const selected = stripComments(defaultVariant(src.air));
  const aerial = stripComments(src.aerial);
  const env = {
    PI: Math.PI,
    cloud: table
      ? {
          ...CLOUD,
          airLightControl: vec4(
            CLOUD.airLightControl.x,
            1,
            CLOUD.airLightControl.z,
            0,
          ),
        }
      : CLOUD,
    cloudTransmittanceLut: {},
    cloudLutSampler: {},
    ...readConstants(aerial),
    __functions: fns,
  };
  fns.cloudSolarDiskVisibility = compileFunction(
    stripComments(src.solar),
    "cloudSolarDiskVisibility",
    env,
  );
  for (const name of [
    "cloudCurvedAirInterval",
    "cloudCurvedAirHeight",
    "cloudCurvedAirDensity",
    "cloudCurvedAirPair",
    "cloudCurvedAirColumnMeters",
    "cloudAirCurvatureRadius",
    "cloudAerialFraction",
    "cloudVisibleAerialSample",
    "cloudVisibleIntervalDistance",
  ]) {
    fns[name] = compileFunction(aerial, name, env);
  }
  for (const name of [
    "cloudAirSegmentWeight",
    "cloudAirRayleighPhase",
    "cloudAirMiePhase",
    "cloudAirSunColumn",
    "cloudAirSolarVisibility",
    "cloudAirSunTransmittance",
  ]) {
    fns[name] = compileFunction(selected, name, env);
  }
  const radiance = compileFunction(
    unrollAirTransport(selected, "radiance"),
    "cloudFiniteAirTransport_radiance",
    env,
  );
  const transmittance = compileFunction(
    unrollAirTransport(selected, "transmittance"),
    "cloudFiniteAirTransport_transmittance",
    env,
  );
  fns.cloudFiniteAirTransport = (...a) => ({
    radiance: radiance(...a),
    transmittance: transmittance(...a),
  });
  fns.cloudToneMappedRadiance = compileFunction(
    stripComments(src.view),
    "cloudToneMappedRadiance",
    env,
  );
  fns.cloudMarchIntervalBoundary = compileFunction(
    stripComments(src.sampling),
    "cloudMarchIntervalBoundary",
    env,
  );
  // The march's own accumulation arguments, read out of marchDeck and run as
  // expressions, so a call-site change is executed rather than pattern-matched.
  const march = extractFunction(
    stripComments(defaultVariant(src.march)),
    "marchDeck",
  ).body;
  const grab = (re, what) => {
    const m = re.exec(march);
    assert.ok(m, `${what} not found in marchDeck`);
    return m[1];
  };
  const params =
    "t: f32, curStep: f32, marchSamplePhase: f32, deckBottom: f32, heightFraction: f32, layerThickness: f32";
  const expressions = `
fn __sampleDistance(${params}) -> f32 { return ${grab(/let sampleDistance = ([^;]+);/, "sampleDistance")}; }
fn __visibleDistance(${params}, sampleDistance: f32) -> f32 { return ${grab(/visibleDistanceSum \+= sampleWeight \* ([^;]+);/, "the distance accumulation")}; }
fn __visibleAltitude(${params}, sampleDistance: f32) -> f32 { return ${grab(/visibleAltitudeSum \+= sampleWeight \* ([^;]+);/, "the altitude accumulation")}; }
`;
  return {
    fns,
    air: fns.cloudFiniteAirTransport,
    color: compileFunction(selected, "cloudPhysicalAerialColor", env),
    sampleDistance: compileFunction(expressions, "__sampleDistance", env),
    visibleDistance: compileFunction(expressions, "__visibleDistance", env),
    visibleAltitude: compileFunction(expressions, "__visibleAltitude", env),
  };
}

// ── The independent reference ────────────────────────────────────────────────

const AIR_TOP = 111000;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const along = (p, d, s) => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => a.map((x) => x / norm(a));
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const referenceCache = new Map();

/**
 * Single-scatter air light and transmittance from a cloud toward the camera.
 * Memoised: the mutants re-run the same scenes against the same reference.
 */
function referenceAir(cloudPos, toward, pathLength, sun) {
  const key = JSON.stringify([cloudPos, toward, pathLength, sun]);
  if (!referenceCache.has(key)) {
    referenceCache.set(
      key,
      integrateReference(cloudPos, toward, pathLength, sun),
    );
  }
  return referenceCache.get(key);
}

function integrateReference(cloudPos, toward, pathLength, sun) {
  const rayleigh = laneValues(CLOUD.airRayleigh);
  const mie = laneValues(CLOUD.airMie);
  const g = CLOUD.airOzonePhase.w;
  const intensity = CLOUD.airLightControl.x;
  const extinction = (h) =>
    [0, 1, 2].map(
      (i) =>
        rayleigh[i] * Math.exp(-h / CLOUD.airRayleigh.w) +
        mie[i] * Math.exp(-h / CLOUD.airMie.w),
    );
  const shellExit = (p, d) => {
    const b = dot(p, d);
    const disc = b * b - (dot(p, p) - (R + AIR_TOP) ** 2);
    return disc < 0 ? 0 : -b + Math.sqrt(disc);
  };
  const sunDepth = (p) => {
    const length = shellExit(p, sun);
    const depth = [0, 0, 0];
    for (let k = 0; k < 120; k++) {
      const h = norm(along(p, sun, ((k + 0.5) / 120) * length)) - R;
      if (h < 0) {
        return [Infinity, Infinity, Infinity];
      }
      extinction(h).forEach((e, i) => (depth[i] += (e * length) / 120));
    }
    return depth;
  };
  const length = Math.min(pathLength, shellExit(cloudPos, toward));
  const cosine = -dot(toward, sun);
  const pr = (3 * (1 + cosine * cosine)) / (16 * Math.PI);
  const pm =
    (1 - g * g) / (4 * Math.PI * Math.pow(1 + g * g - 2 * g * cosine, 1.5));
  const radiance = [0, 0, 0];
  const transmittance = [1, 1, 1];
  const cells = 1200;
  const ds = length / cells;
  // March from the camera end: each cell's light is attenuated by the air
  // between it and the camera.
  for (let k = cells - 1; k >= 0; k--) {
    const q = along(cloudPos, toward, (k + 0.5) * ds);
    const h = norm(q) - R;
    if (h < 0) {
      continue;
    }
    const e = extinction(h);
    const sunT = sunDepth(q).map((x) => Math.exp(-x));
    for (let i = 0; i < 3; i++) {
      const scatter =
        rayleigh[i] * Math.exp(-h / CLOUD.airRayleigh.w) * pr +
        mie[i] * Math.exp(-h / CLOUD.airMie.w) * pm;
      radiance[i] +=
        transmittance[i] *
        Math.exp(-0.5 * e[i] * ds) *
        scatter *
        intensity *
        sunT[i] *
        ds;
      transmittance[i] *= Math.exp(-e[i] * ds);
    }
  }
  return { radiance, transmittance };
}

/** Run the shipped transport at a cloud point given in sphere-centred metres. */
function shippedAir(chain, cloudPos, toward, pathLength, sun) {
  const up = unit(cloudPos);
  const air = chain.air(
    norm(cloudPos) - R,
    vec(...toward),
    vec(...up),
    pathLength,
    R,
    vec(...sun),
  );
  return {
    radiance: laneValues(air.radiance),
    transmittance: laneValues(air.transmittance),
  };
}

// ── Scenes ───────────────────────────────────────────────────────────────────

// E-O: camera 6,608,426.573 m over the disc centre, cloud at mid-deck 2,750 m.
const ORBIT_H = 6608426.573306667;
const DECK_MID = 2750;
const CAMERA_ORBIT = [0, 0, R + ORBIT_H];
const LIMB_DEG = (Math.acos(R / (R + ORBIT_H)) * 180) / Math.PI; // 60.6

/** A disc point `theta` degrees from the sub-camera point, azimuth `phi`. */
function discPoint(thetaDeg, phiDeg) {
  const th = (thetaDeg * Math.PI) / 180;
  const ph = (phiDeg * Math.PI) / 180;
  const n = [
    Math.sin(th) * Math.cos(ph),
    Math.sin(th) * Math.sin(ph),
    Math.cos(th),
  ];
  const pos = n.map((x) => x * (R + DECK_MID));
  const offset = CAMERA_ORBIT.map((x, i) => x - pos[i]);
  return { pos, toward: unit(offset), distance: norm(offset), up: n };
}

// E-F: camera 2,500 m, 1920x1080, 60 deg horizontal fov, pitched 12 deg down.
const FLIGHT_H = 2500;
const FOCAL = 540 / Math.tan((18 * Math.PI) / 180);
function flightRay(row) {
  const e = (-12 * Math.PI) / 180 + Math.atan((540 - row) / FOCAL);
  return [0, Math.cos(e), Math.sin(e)];
}
const flightPoint = (dir, d) => [
  dir[0] * d,
  dir[1] * d,
  R + FLIGHT_H + dir[2] * d,
];
const sunAt = (azDeg, elDeg) => {
  const a = (azDeg * Math.PI) / 180;
  const e = (elDeg * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
};

// ── Checks (each is also run against mutants below) ──────────────────────────

const SUB_SOLAR = [0, 0, 1];
const ORBIT_THETAS = [0, 0.05, 0.5, 5, 15, 25, 35, 45, 50, 55, 58, 59.5, 60.3];

/** E-O: shipped air light = reference at every radius, and no step anywhere. */
function checkOrbitalDisc(chain) {
  const profile = [];
  for (const theta of ORBIT_THETAS) {
    const p = discPoint(theta, 0);
    const shipped = shippedAir(chain, p.pos, p.toward, p.distance, SUB_SOLAR);
    const ref = referenceAir(p.pos, p.toward, p.distance, SUB_SOLAR);
    const ratio = luma(shipped.radiance) / luma(ref.radiance);
    assert.ok(
      Math.abs(ratio - 1) < 0.01,
      `E-O theta ${theta}: shipped air light ${luma(shipped.radiance)} vs reference ${luma(ref.radiance)}`,
    );
    for (let i = 0; i < 3; i++) {
      assert.ok(
        Math.abs(shipped.transmittance[i] - ref.transmittance[i]) < 0.005,
        `E-O theta ${theta}: transmittance lane ${i}`,
      );
    }
    profile.push(luma(shipped.radiance));
  }
  // Sub-solar, the air light grows monotonically from the nadir to the limb:
  // no annulus may fall back, and the nadir is its own limit.
  for (let k = 1; k < profile.length; k++) {
    assert.ok(
      profile[k] >= profile[k - 1] - 1e-9,
      `E-O air light steps down at theta ${ORBIT_THETAS[k]}`,
    );
  }
  assert.ok(Math.abs(profile[1] - profile[0]) < 1e-4 * profile[0]);
  return profile;
}

const NIGHT_LIMB = [
  [58, 180],
  [45, 180],
  [30, 180],
  [15, 180],
];

/**
 * The guard: a cloud on the night side, out to the limb, gets no air light, so
 * its composite is its own transported tone map. Terminator through the disc
 * centre (sun along +x), so the half-disc at phi 180 is night.
 */
function checkNightLimb(chain) {
  const sun = [1, 0, 0];
  for (const [theta, phi] of NIGHT_LIMB) {
    const p = discPoint(theta, phi);
    const shipped = shippedAir(chain, p.pos, p.toward, p.distance, sun);
    assert.equal(
      luma(shipped.radiance),
      0,
      `night theta ${theta}: air light ${luma(shipped.radiance)} on a cloud with the sun ${(-Math.asin(dot(p.up, sun)) * 180) / Math.PI} deg down`,
    );
    // A night cloud at the reviewer's tone-mapped T0 band (0.02-0.03) stays
    // at or below it after the composite.
    for (const t0 of [0.02, 0.03]) {
      const straight = t0 / (1 - t0) / CLOUD.exposure;
      const opacity = 0.9;
      const hazed = laneValues(
        chain.color(
          vec(straight * opacity, straight * opacity, straight * opacity),
          opacity,
          vec(0.8, 0.62, 0.5),
          DECK_MID,
          vec(...p.toward),
          vec(...p.up),
          p.distance,
          R,
          vec(...sun),
        ),
      );
      assert.ok(
        luma(hazed) <= t0 + 1e-12,
        `night theta ${theta}: composite ${luma(hazed)} above the cloud's own ${t0}`,
      );
    }
  }
  // Not vacuous: the mirrored day-side points do carry air light.
  for (const [theta] of NIGHT_LIMB) {
    const p = discPoint(theta, 0);
    const day = shippedAir(chain, p.pos, p.toward, p.distance, sun);
    assert.ok(
      luma(day.radiance) > 0.05,
      `day theta ${theta} carries air light`,
    );
  }
}

const FLIGHT_SUNS = [
  [240, 45],
  [0, 10],
  [180, 10],
];
const FLIGHT_ROWS = [0, 60, 120, 160, 180, 200, 220];
const FLIGHT_DISTANCES = [3000, 15000, 40000, 90000];

/**
 * E-F (line 119 of the round-8 review, re-targeted): the air light behind a
 * flight-cell cloud, and the composite it makes, equal the sky's own single
 * scatter along that ray - per ray, per sun azimuth, per elevation.
 */
function checkFlightSky(chain) {
  let checked = 0;
  for (const [az, el] of FLIGHT_SUNS) {
    const sun = sunAt(az, el);
    for (const row of FLIGHT_ROWS) {
      const dir = flightRay(row);
      const toward = dir.map((x) => -x);
      for (const d of FLIGHT_DISTANCES) {
        const pos = flightPoint(dir, d);
        const h = norm(pos) - R;
        if (h < 1500 || h > 4000) {
          continue;
        }
        const ref = referenceAir(pos, toward, d, sun);
        const weighted = [0.9, 0.85, 0.8].map((x) => x * 4 * 0.6);
        const opacity = 0.6;
        const hazed = laneValues(
          chain.color(
            vec(...weighted),
            opacity,
            vec(0.62, 0.72, 0.85),
            h,
            vec(...toward),
            vec(...unit(pos)),
            d,
            R,
            vec(...sun),
          ),
        );
        const expected = weighted.map((w, i) => {
          const x =
            (w * ref.transmittance[i] + opacity * ref.radiance[i]) *
            CLOUD.exposure;
          return x / (x + opacity);
        });
        for (let i = 0; i < 3; i++) {
          assert.ok(
            Math.abs(hazed[i] - expected[i]) < 0.006,
            `E-F sun ${az}/${el} row ${row} d ${d} lane ${i}: ${hazed[i]} vs the sky's own ${expected[i]}`,
          );
        }
        checked++;
      }
    }
  }
  assert.ok(checked >= 40, `only ${checked} E-F points checked`);
}

/**
 * The representative point under the march's sample phase. A fixed lattice
 * (the shipped interval law) with fixed extinction weights is accumulated
 * through marchDeck's own argument expressions for phases 0 .. 0.999; the
 * representative distance must not move, and the composite the physical
 * branch makes from it must move by less than `budget` /255.
 */
function phaseSpread(chain, row, budget) {
  const dir = flightRay(row);
  const toward = dir.map((x) => -x);
  // Chord through the 1,500-4,000 m deck from the camera (inside it).
  let chord = 0;
  for (let s = 0; s < 400000; s += 50) {
    const h = norm(flightPoint(dir, s)) - R;
    if (h < 1500 || h > 4000) {
      break;
    }
    chord = s;
  }
  const steps = 96;
  const bounds = [];
  for (let k = 0; k <= steps; k++) {
    bounds.push(
      chain.fns.cloudMarchIntervalBoundary(k, steps, chord, 0, 2500, 0),
    );
  }
  const sun = sunAt(240, 45);
  const results = [];
  for (const phase of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 0.999]) {
    let transmittance = 1;
    let distanceSum = 0;
    let altitudeSum = 0;
    for (let k = 0; k < steps; k++) {
      const t = bounds[k];
      const curStep = bounds[k + 1] - t;
      // A cloud mass over the middle third of the chord, constant density.
      const centre = t + 0.5 * curStep;
      if (centre < chord / 3 || centre > (2 * chord) / 3) {
        continue;
      }
      const sampleT = Math.exp(-curStep * 2e-5);
      const weight = (1 - sampleT) * transmittance;
      const sampleDistance = chain.sampleDistance(
        t,
        curStep,
        phase,
        1500,
        0,
        2500,
      );
      const heightFraction =
        (norm(flightPoint(dir, sampleDistance)) - R - 1500) / 2500;
      const args = [
        t,
        curStep,
        phase,
        1500,
        heightFraction,
        2500,
        sampleDistance,
      ];
      distanceSum += weight * chain.visibleDistance(...args);
      altitudeSum += weight * chain.visibleAltitude(...args);
      transmittance *= sampleT;
    }
    const opacity = 1 - transmittance;
    const visible = laneValues(
      chain.fns.cloudVisibleAerialSample(
        distanceSum,
        altitudeSum,
        opacity,
        0,
        chord,
        1500,
        4000,
      ),
    );
    const pos = flightPoint(dir, visible[0]);
    const hazed = laneValues(
      chain.color(
        vec(2.4 * opacity, 2.2 * opacity, 2 * opacity),
        opacity,
        vec(0.62, 0.72, 0.85),
        visible[1],
        vec(...toward),
        vec(...unit(pos)),
        visible[0],
        R,
        vec(...sun),
      ),
    );
    const fraction = chain.fns.cloudAerialFraction(
      visible[1],
      vec(...toward),
      vec(...unit(pos)),
      visible[0],
      1,
      R,
    );
    results.push({ distance: visible[0], luma: luma(hazed) * 255, fraction });
  }
  const spread = (key) =>
    Math.max(...results.map((r) => r[key])) -
    Math.min(...results.map((r) => r[key]));
  assert.ok(
    spread("distance") < 1e-6,
    `row ${row}: the representative distance moved ${spread("distance")} m with the sample phase`,
  );
  assert.ok(
    spread("luma") < budget,
    `row ${row}: the composite moved ${spread("luma")}/255 with the sample phase`,
  );
  assert.ok(
    spread("fraction") < 1e-3,
    `row ${row}: the aerial fraction moved ${spread("fraction")} with the sample phase`,
  );
  return {
    chord,
    spreadLuma: spread("luma"),
    spreadFraction: spread("fraction"),
  };
}

const PHASE_ROWS = [120, 160, 180, 200, 210];
// The altitude accumulation still reads the jittered sample's height; on these
// rays that alone moves the composite by at most about 0.10/255 (row 200),
// against about 0.7/255 from the jittered distance before this round.
const PHASE_BUDGET = 0.15;
function checkPhaseFree(chain) {
  return PHASE_ROWS.map((row) => phaseSpread(chain, row, PHASE_BUDGET));
}

// ── Behaviour ───────────────────────────────────────────────────────────────

const shipped = compileChain();

test("E-O: the orbital air light equals an independent single-scatter integral from the nadir to the limb, with no step", () => {
  const profile = checkOrbitalDisc(shipped);
  // The limb carries several times the nadir's air light: the physical look
  // the ruling chose, not a flat tint.
  assert.ok(profile.at(-1) > 5 * profile[0]);
  assert.ok(LIMB_DEG > ORBIT_THETAS.at(-1));
});

// The baked table branch with full sun transmittance (alpha 1, rgb 1): the upper
// bound of the bake's ground-truncated law, so only the visibility gate can keep
// the night limb dark on device.
const SUN_TABLE = () => ({ a: 1, rgb: vec(1, 1, 1) });

test("night-limb guard: a night-side cloud out to the limb gets no air light, so it composites at or below its own tone map", () => {
  checkNightLimb(shipped);
  checkNightLimb(compileChain({}, SUN_TABLE));
});

test("E-F: the air light behind a flight-cell cloud is the sky's own single scatter along that ray, for every sun azimuth tried", () => {
  checkFlightSky(shipped);
});

test("N5: the march's sample phase moves neither the representative distance nor the air light near the flight horizon", () => {
  // The midpoint itself: an interval-start or interval-end law is phase-free too.
  assert.equal(shipped.fns.cloudVisibleIntervalDistance(1000, 200), 1100);
  const spreads = checkPhaseFree(shipped);
  assert.equal(spreads.length, PHASE_ROWS.length);
});

test("N3/H1 have no subject on this tree: the aerial reads no sky-view row, and the march reads the table only on the ambient axis", () => {
  const selected = stripComments(defaultVariant(SHIPPED.air));
  assert.doesNotMatch(selected, /cloudSampleSkyViewLut|cloudSkyViewLut/);
  const march = stripComments(defaultVariant(SHIPPED.march));
  const reads = [...march.matchAll(/cloudSampleSkyViewLut\(([^)]*)\)/g)].map(
    (m) => m[1].replace(/\s+/g, " ").trim(),
  );
  // The definition's own parameter list, then the up and down ambient reads
  // (V exactly 1 and 0: edge rows, never a half texel).
  assert.deepEqual(reads.slice(1).sort(), [
    "localUp, -localUp, sunDir",
    "localUp, localUp, sunDir",
  ]);
});

// ── Inertness mutants: each puts a defect back and must turn a check red ────

function mutate(name, from, to) {
  const source = SHIPPED[name];
  const count = source.split(from).length - 1;
  assert.equal(
    count,
    1,
    `mutant anchor ${JSON.stringify(from)} matched ${count} times`,
  );
  return { [name]: source.replace(from, to) };
}

test("MUTANT N1: daylight forced to 1 (no solar visibility) lights the night limb", () => {
  const chain = compileChain(
    mutate(
      "air",
      "let visibility = cloudAirSolarVisibility(height, sunCosine, radius);",
      "let visibility = 1.0;",
    ),
  );
  assert.throws(() => checkNightLimb(chain), /night theta/);
  const baked = compileChain(
    mutate(
      "air",
      "let visibility = cloudAirSolarVisibility(height, sunCosine, radius);",
      "let visibility = 1.0;",
    ),
    SUN_TABLE,
  );
  assert.throws(() => checkNightLimb(baked), /night theta/);
});

test("MUTANT N2: the representative point's own daylight in place of each node's (the camera-keyed shape) is red on the disc or the night limb", () => {
  const chain = compileChain(
    mutate(
      "air",
      "let sunCosine = clamp(dot(localUp, sunDir), -1.0, 1.0);",
      "let sunCosine = clamp(dot(normalize(cloud.planetRadius * vec3<f32>(0.0, 0.0, 1.0) + vec3<f32>(0.0)), sunDir), -1.0, 1.0);",
    ),
  );
  assert.throws(() => {
    checkNightLimb(chain);
    checkOrbitalDisc(chain);
  });
});

test("MUTANT S1: a clamp on the view cosine (round 8's horizon clamp, moved to the path) breaks the disc toward the limb", () => {
  const chain = compileChain(
    mutate(
      "air",
      "let mu = clamp(dot(towardCamera, upAtCloud), -1.0, 1.0);",
      "let mu = clamp(dot(towardCamera, upAtCloud), 0.3, 1.0);",
    ),
  );
  assert.throws(() => checkOrbitalDisc(chain), /E-O theta/);
});

test("MUTANT S2: a readiness select back to the flat-tint baseline (the TIP(4) seam) is red on the composite", () => {
  const chain = compileChain(
    mutate(
      "air",
      "return cloudToneMappedRadiance(transported, opacity, cloud.exposure);",
      "return select(baselineColor, cloudToneMappedRadiance(transported, opacity, cloud.exposure), dot(air.radiance, vec3<f32>(0.2126, 0.7152, 0.0722)) > 2.0);",
    ),
  );
  assert.throws(() => checkFlightSky(chain), /E-F sun/);
});

test("MUTANT H3: the sun azimuth ignored (phase cosine fixed) is red on the flight sky", () => {
  const chain = compileChain(
    mutate(
      "air",
      "let cosine = clamp(dot(-towardCamera, sunDir), -1.0, 1.0);",
      "let cosine = 0.0;",
    ),
  );
  assert.throws(() => checkFlightSky(chain), /E-F sun/);
});

test("MUTANT H5: the elevation ignored (every path horizontal) is red on the flight sky", () => {
  const chain = compileChain(
    mutate(
      "air",
      "let mu = clamp(dot(towardCamera, upAtCloud), -1.0, 1.0);",
      "let mu = 0.0;",
    ),
  );
  assert.throws(() => {
    checkFlightSky(chain);
    checkOrbitalDisc(chain);
  });
});

test("MUTANT H2: the air light dropped from the composite is red on the flight sky", () => {
  const chain = compileChain(
    mutate(
      "air",
      "weightedRadiance * air.transmittance + opacity * air.radiance",
      "weightedRadiance * air.transmittance",
    ),
  );
  assert.throws(() => checkFlightSky(chain), /E-F sun/);
});

test("MUTANT P1: the jittered sample distance back at the call site moves the range with the phase", () => {
  const chain = compileChain(
    mutate(
      "march",
      "visibleDistanceSum += sampleWeight * cloudVisibleIntervalDistance(t, curStep);",
      "visibleDistanceSum += sampleWeight * sampleDistance;",
    ),
  );
  assert.throws(() => checkPhaseFree(chain), /representative distance moved/);
});

test("MUTANT P2: the fix made unreachable (a select that always takes the sample) is red", () => {
  const chain = compileChain(
    mutate(
      "march",
      "visibleDistanceSum += sampleWeight * cloudVisibleIntervalDistance(t, curStep);",
      "visibleDistanceSum += sampleWeight * select(cloudVisibleIntervalDistance(t, curStep), sampleDistance, true);",
    ),
  );
  assert.throws(() => checkPhaseFree(chain), /representative distance moved/);
});
