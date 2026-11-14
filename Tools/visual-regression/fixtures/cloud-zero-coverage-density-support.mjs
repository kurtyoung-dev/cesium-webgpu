/** @purpose Spec support for cloud-zero-coverage-density: the engine shader subjects, the zero-coverage oracles and the arithmetic-evaluator adapter calibration the spec drives. @status ACTIVE */
import assert from "node:assert/strict";
import {
  preprocess,
  shaderDefines,
  readEngineShader,
} from "../lib/wgsl-variant.mjs";
import * as mini from "../lib/wgsl-mini-eval.mjs";
export { assert };
export const f = Math.fround;
export const shaderPaths = Object.freeze({
  domain: "Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
  formation: "Shaders/WebGPU/Environment/CloudDensityFormation.wgsl",
  clouds: "Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
  ibl: "Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl",
  fog: "Shaders/WebGPU/Compute/VolumetricFog.wgsl",
});
export function subjects() {
  return Object.fromEntries(
    Object.entries(shaderPaths).map(([k, p]) => [k, readEngineShader(p)]),
  );
}
export function functionText(source, name) {
  const start = source.search(new RegExp("\\bfn\\s+" + name + "\\s*\\("));
  assert(start >= 0, "actual function " + name + " must exist");
  const open = source.indexOf("{", start);
  let end = open + 1,
    depth = 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  assert.equal(depth, 0);
  return source.slice(start, end);
}
const normalize = (s) => mini.stripComments(s).replace(/,\s*\)/g, ")");
function expression(tokens, env) {
  assert(tokens.length > 0, "empty expression");
  const parsed = mini.parseExpression(tokens, 0);
  assert.equal(parsed.next, tokens.length, "unsupported expression remainder");
  return mini.evaluate(parsed.node, env);
}
function matching(tokens, start, open, close) {
  assert.equal(tokens[start]?.text, open);
  let depth = 1,
    end = start + 1;
  for (; depth && end < tokens.length; end++) {
    if (tokens[end].text === open) depth++;
    if (tokens[end].text === close) depth--;
  }
  assert.equal(depth, 0, "unterminated block");
  return end;
}
function statement(tokens, env) {
  const kind = tokens[0]?.text;
  if (kind === "let" || kind === "var") {
    const name = tokens[1];
    assert.equal(name?.kind, "id");
    const at = tokens.findIndex((t) => t.text === "=");
    env[name.text] = at < 0 ? undefined : expression(tokens.slice(at + 1), env);
    return;
  }
  const at = tokens.findIndex((t) => t.text === "=");
  assert(at > 0, "unsupported statement");
  let operator = at > 1 ? tokens[at - 1].text : undefined;
  if (!["*", "+", "-", "/"].includes(operator)) operator = undefined;
  const lhs = tokens.slice(0, operator ? at - 1 : at);
  assert.equal(lhs.length, 1, "only local assignment is supported");
  assert.equal(lhs[0].kind, "id");
  const name = lhs[0].text;
  let owner = env;
  while (!Object.hasOwn(owner, name) && Object.getPrototypeOf(owner))
    owner = Object.getPrototypeOf(owner);
  assert(Object.hasOwn(owner, name), "assignment to undeclared variable");
  const value = expression(tokens.slice(at + 1), env);
  owner[name] = operator
    ? expression(
        mini.tokenize("left " + operator + " right"),
        Object.assign(Object.create(env), { left: owner[name], right: value }),
      )
    : value;
}
function execute(tokens, env) {
  for (let at = 0; at < tokens.length;) {
    const kind = tokens[at].text;
    if (kind === "if") {
      const conditionEnd = matching(tokens, at + 1, "(", ")"),
        open = conditionEnd,
        end = matching(tokens, open, "{", "}");
      const selected = expression(tokens.slice(at + 2, conditionEnd - 1), env);
      let next = end,
        other;
      if (tokens[next]?.text === "else") {
        assert.equal(tokens[next + 1]?.text, "{", "else-if unsupported");
        const otherEnd = matching(tokens, next + 1, "{", "}");
        other = tokens.slice(next + 2, otherEnd - 1);
        next = otherEnd;
      }
      const body = selected ? tokens.slice(open + 1, end - 1) : other;
      if (body) {
        const result = execute(body, Object.create(env));
        if (result) return result;
      }
      at = next;
      continue;
    }
    assert(
      !["for", "while", "loop", "switch", "break", "continue"].includes(kind),
      "unsupported control flow",
    );
    let end = at;
    for (; end < tokens.length && tokens[end].text !== ";"; end++);
    assert(end < tokens.length, "unterminated statement");
    if (kind === "return")
      return { value: expression(tokens.slice(at + 1, end), env) };
    statement(tokens.slice(at, end), env);
    at = end + 1;
  }
  return undefined;
}
// Main's parser/evaluator owns every expression, builtin and f32 operation.
// This adapter adds only local statements and branches used by actual callers.
export function compileCaller(source, name, globals) {
  const selected = mini.extractFunction(normalize(source), name),
    tokens = mini.tokenize(selected.body);
  return (...args) => {
    const env = Object.create(globals);
    selected.params.forEach((p, i) => (env[p] = args[i]));
    const result = execute(tokens, env);
    assert(result, "actual function must return");
    return result.value;
  };
}
export function smooth(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return f(t * t * (3 - 2 * t));
}
export function fixture({
  coverage = 0,
  noise = 0.5,
  moments = false,
  population,
  weather = false,
  strength = 0,
  aspect = 1,
  bakedOnly = true,
  baked = true,
  sources = subjects(),
  mutate,
} = {}) {
  const H = shaderDefines.ShaderDefineHi,
    hi =
      (bakedOnly ? H.CLOUD_NOISE_BAKED_ONLY : 0) |
      (moments ? H.CLOUD_DENSITY_MOMENTS : 0) |
      (population !== undefined
        ? H.CLOUD_WEATHER_POPULATIONS | H.CLOUD_WEATHER_VERTICAL
        : 0);
  let source = [
    sources.domain,
    sources.formation,
    sources.clouds,
    sources.ibl,
    sources.fog,
  ]
    .map((s) => preprocess(s, 0, hi, 0))
    .join("\n");
  if (mutate) source = mutate(source);
  const v = mini.vec,
    v2 = mini.vec2,
    v4 = mini.vec4,
    coordinates = {
      canonical: v(0, 0, 0),
      shape: v(0, 0, 0),
      warp: v(0, 0, 0),
      detail: v(0, 0, 0),
      population: population ?? 0,
    },
    calls = [],
    boundary = { noise: 0, weather: 0, populations: [] },
    weatherTex = {};
  const channels = (densityScale, baseShiftFrac, perGenusShape) => ({
    densityScale,
    baseShiftFrac,
    perGenusShape,
  });
  const cloud = {
    coverage: f(coverage),
    weatherMapEnabled: Number(weather || population !== undefined),
    weatherStrength: 1,
    profileShape: 0,
    windDirection: v2(0, 0),
    windSpeed: 0,
    time: 0,
    genusFibreStrength: f(strength),
    genusFibreAnisotropy: f(aspect),
    densityMultiplier: 1,
    profileDensityScale: 1,
    curlAmplitude: 0,
    erosionStrength: 0,
    puffSize: 1,
    anvilBias: 0,
  };
  const control = () => ({ r: f(coverage), gba: v(0.5, 0, 0.5) }),
    readNoise = () => {
      boundary.noise++;
      return f(noise);
    };
  const g = {
    cloud,
    weatherTex,
    weatherSampler: {},
    cloudDetailTex: {},
    cloudNoiseSampler: {},
    __round: f,
    true: true,
    false: false,
    u: {
      cloudCoverage: f(coverage),
      cloudDensityMult: 1,
      cloudShadow: v4(1, 1, 3, f(coverage)),
      cloudShadowHiFi: v4(0, 1, 1, 0),
      sunDirectionAndIntensity: v4(0, 1, 0, 1),
      cameraAndPlanet: v4(0, 0, 0, 10),
      cloudWindAndTime: v4(0, 0, 0, 0),
      cloudDensityShape: v4(1, 1, 1, 0),
    },
    __functions: {
      exp: Math.exp,
      mix: (a, b, t) => f(f(a) + f(f(b - a) * f(t))),
      smoothstep: (a, b, x) => {
        calls.push({ a, b, x, equal: a === b });
        return a === b ? 1 : smooth(a, b, x);
      },
      step: (edge, x) => (x < edge ? 0 : 1),
      WeatherChannels: channels,
      decodeWeatherChannels: () => channels(1, 0, 0),
      CloudNoiseMipLevels: (shape, warp, detail) => ({ shape, warp, detail }),
      CloudMacroSample: (
        preErosion,
        densityFactor,
        coordinates,
        morphologyCoordinate,
        detailMipLevel,
        profileHeight = 0.5,
      ) => ({
        preErosion,
        densityFactor,
        coordinates,
        morphologyCoordinate,
        detailMipLevel,
        profileHeight,
      }),
      noiseBakedEnabled: () => baked,
      bakedBase: readNoise,
      legacyBakedBase: readNoise,
      fbmNoise: readNoise,
      worleyF1: () => 0,
      cloudDensityMipLevels: () => ({ shape: 0, warp: 0, detail: 0 }),
      cloudDensityCoordinatesIBL: () => coordinates,
      cloudDensityMipLevelsIBL: () => ({ shape: 0, warp: 0, detail: 0 }),
      cloudBakedBaseIBL: readNoise,
      textureSampleLevel: (t) => {
        if (t === weatherTex) {
          boundary.weather++;
          return control();
        }
        return { r: 1 };
      },
      worldToWeatherUV: () => v2(0.5, 0.5),
      cloudPopulationWeather: (_position, p) => {
        boundary.populations.push(p);
        return { control: control() };
      },
      cloudPopulationProfile: () => v2(0.5, 1),
      cloudRegionalProfile: () => v2(0.5, 1),
      heightGradientFor: () => 1,
      genusFibreFactor: () => 1,
      mammatusFactor: () => 1,
      speciesFactor: () => 1,
      featureFactor: () => 1,
      genusErosionDepthScale: () => 1,
      genusErosionHeightWeight: () => 1,
      remap: (x, a, b, c, d) => c + ((x - a) * (d - c)) / (b - a),
      fbm3d: () => f(noise * 2 - 1),
    },
  };
  for (const m of source.matchAll(
    /^const\s+([A-Z][A-Z0-9_]*):\s*f32\s*=\s*([0-9.eE+-]+)\s*;/gm,
  ))
    g[m[1]] = f(Number(m[2]));
  const names = [
    "cloudEffectiveCoverage",
    "cloudCoverageGate",
    "applyGenusBaseVarianceBudget",
    "cloudErodedDensity",
    "cloudMacroSampleAt",
    "cloudDensityFromMacro",
    "cloudBaseFromMacro",
    "cloudDensityAtCoordinates",
    "legacyCloudDensity",
    "legacyCloudBaseDensity",
    "cloudDensityIBL",
    "sampleCloudShadow",
    "normalizeFogCheapCloudField",
  ];
  for (const name of names)
    if (source.includes("fn " + name + "("))
      g.__functions[name] = compileCaller(source, name, g);
  const api = g.__functions,
    args = [v(0, 0, 0), coordinates, v(0, 0, 0), 0.5, 0, 10000, 0];
  return {
    source,
    api,
    calls,
    boundary,
    threshold: () => f(1 - api.cloudEffectiveCoverage(f(coverage))),
    run(name) {
      if (name === "macro") return api.cloudMacroSampleAt(...args).preErosion;
      if (name === "densityAt") return api.cloudDensityAtCoordinates(...args);
      if (name === "base")
        return api.legacyCloudBaseDensity(v(0, 0, 0), 0.5, 0, 10000);
      if (name === "legacy")
        return api.legacyCloudDensity(v(0, 0, 0), 0.5, 0, 10000);
      if (name === "ibl") return api.cloudDensityIBL(v(0, 0, 0), 0.5, 0);
      if (name === "fog") return api.sampleCloudShadow(v(0, 10, 0), v(0, 0, 0));
      if (name === "genus")
        return api.applyGenusBaseVarianceBudget(0, this.threshold());
      throw Error(name);
    },
  };
}
export function zeroOracle(subject, name) {
  const value = subject.run(name);
  assert.equal(
    value,
    name === "fog" ? 1 : 0,
    "coverage stage structural-zero law",
  );
  assert.equal(
    subject.calls.filter((c) => c.equal).length,
    0,
    "no equal-edge builtin invocation",
  );
  return value;
}
export function inertGuard(source) {
  const text = functionText(source, "cloudCoverageGate"),
    condition = text.match(/if\s*\(([^)]*)\)/);
  assert(condition, "guard must be executable");
  return source.replace(
    text,
    text.replace(condition[0], "if (false && (" + condition[1] + "))"),
  );
}
export function bypassCaller(source) {
  const text = functionText(source, "cloudMacroSampleAt"),
    call = "cloudCoverageGate(density, coverageThreshold)";
  assert.equal(text.split(call).length, 2);
  return source.replace(
    text,
    text.replace(call, "smoothstep(coverageThreshold, 1.0, density)"),
  );
}
export function adapterCalibration() {
  const source = "fn leaf(x: f32) -> f32 { let a = x * 2.0; return a + 1.0; }",
    g = { __round: f },
    a = compileCaller(source, "leaf", g),
    b = mini.compileFunction(source, "leaf", g);
  for (const x of [0, 0.2, 1, 100000]) assert.equal(a(f(x)), b(f(x)));
  const branch =
      "fn branch(x: f32, flag: bool) -> f32 { var value = x * 2.0; if (flag) { let temp = value + 1.0; value = temp; } else { value -= 1.0; } return value; }",
    c = compileCaller(branch, "branch", g);
  for (const flag of [false, true])
    for (const x of [0, 0.2, 1])
      assert.equal(c(f(x), flag), f(f(f(x) * 2) + (flag ? 1 : -1)));
  assert.throws(
    () => compileCaller("fn bad() -> f32 { loop { return 0.0; } }", "bad", g)(),
    /unsupported control flow/,
  );
}
