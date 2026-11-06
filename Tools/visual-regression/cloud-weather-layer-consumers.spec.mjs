import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { preprocess, ShaderDefineHi as H } from "./lib/wgsl-variant.mjs";
import * as math from "./lib/wgsl-mini-eval.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const gpu = "packages/engine/Source/Renderer/WebGPU/";
const scene = "packages/engine/Source/Scene/";
const shaders = "packages/engine/Source/Shaders/WebGPU/Environment/";
const rendererPath = gpu + "WebGPUProceduralCloudRenderer.ts";
const renderer = read(rendererPath);
function block(source, name) {
  const start = source.indexOf("fn " + name + "("),
    body = source.indexOf("{", start);
  assert(start >= 0 && body > start, name);
  let end = body + 1,
    depth = 1;
  for (; depth; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  return source.slice(start, end);
}
function assembled() {
  const source = renderer;
  const imports = new Map(
    [
      ...source.matchAll(/import (\w+) from "([^"]+\/Shaders\/[^"]+\.js)";/g),
    ].map((m) => [
      m[1],
      path.posix.normalize(
        path.posix.join(
          path.posix.dirname(rendererPath),
          m[2].replace(/\.js$/, ".wgsl"),
        ),
      ),
    ]),
  );
  const line = source
    .split(/\r?\n/)
    .find((l) => l.startsWith("const PROCEDURAL_CLOUDS_SOURCE ="));
  return [...line.matchAll(/\$\{(\w+)\}/g)]
    .map((m) => read(imports.get(m[1])))
    .join("\n");
}
const functionNames = (program) =>
  new Set([...program.matchAll(/\bfn\s+(\w+)\s*\(/g)].map((m) => m[1]));
const bindings = (program) =>
  [...program.matchAll(/@group\(\d+\)\s*@binding\(\d+\)[^;]*;/g)].map((m) =>
    m[0].replace(/\s+/g, " "),
  );
// The struct a `var<uniform>` binding is typed with, as normalized text.
const uniformStructs = (program) =>
  [...program.matchAll(/var<uniform>\s+\w+\s*:\s*(\w+)\s*;/g)].map((m) => {
    const body = program.match(
      new RegExp("struct\\s+" + m[1] + "\\s*\\{[^}]*\\}"),
    );
    assert.ok(body, m[1]);
    return body[0].replace(/\/\/[^\n]*/g, "").replace(/\s+/g, "");
  });
async function bundle(contents) {
  const result = await build({
    stdin: { contents, resolveDir: root, loader: "ts" },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(result.outputFiles[0].text).toString("base64")
  );
}
const api = await bundle(
  [
    'export * from "./' + scene + 'Weather/WeatherTexPacker.ts";',
    'export * from "./' + scene + 'Weather/WeatherCloudLayers.ts";',
    'export * from "./' + gpu + 'WebGPUCloudWeatherTransition.ts";',
    'export { default as CloudWeatherState } from "./' +
      scene +
      'CloudWeatherState.js";',
    'export * from "./' + gpu + 'WebGPUCloudMarchFeatures.ts";',
    'export { WEATHER_MAP_TEX_WIDTH as W, WEATHER_MAP_TEX_HEIGHT as T } from "./' +
      scene +
      'Weather/WeatherMapSeam.ts";',
  ].join("\n"),
);
const flags = H.CLOUD_WEATHER_POPULATIONS | H.CLOUD_WEATHER_VERTICAL;
const POPULATION_FUNCTIONS = [
  "marchPopulationClouds",
  "cloudPopulationWeather",
  "cloudPopulationProfile",
  "cloudPopulationDensity",
  "cloudIntegratePopulationMedium",
];
test("population define adds its functions without changing bindings or uniform structs; selected stages validate", async () => {
  const directory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(directory, "naga_wasm_tools.js"))
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(directory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  const program = assembled();
  const recipes = [
    0,
    H.CLOUD_NOISE_BAKED_ONLY | H.CLOUD_MORPHOLOGY_BASE_ONLY,
    H.CLOUD_WEATHER_VERTICAL | H.CLOUD_WEATHER_TRANSITION,
    H.CLOUD_MARCH_EMIT_RECONSTRUCTION,
    H.CLOUD_LIGHTING_PREVIEW,
    H.CLOUD_DIRECTIONAL_LIGHTING | H.CLOUD_DEEP_SHADOW_CACHE,
  ];
  for (const recipe of recipes) {
    const off = preprocess(program, 0, recipe),
      on = preprocess(program, 0, recipe | H.CLOUD_WEATHER_POPULATIONS);
    const without = functionNames(off),
      withDefine = functionNames(on);
    for (const name of without) assert.ok(withDefine.has(name), name);
    for (const name of POPULATION_FUNCTIONS) {
      assert.equal(without.has(name), false, name + " without the define");
      assert.equal(withDefine.has(name), true, name + " with the define");
    }
    assert.deepEqual(bindings(on), bindings(off));
    assert.ok(bindings(off).length > 0);
    assert.deepEqual(uniformStructs(on), uniformStructs(off));
    assert.ok(uniformStructs(off).length > 0);
    naga.validate_wgsl(off);
  }
  for (const recipe of [
    0,
    H.CLOUD_NOISE_BAKED_ONLY | H.CLOUD_MORPHOLOGY_BASE_ONLY,
    H.CLOUD_WEATHER_TRANSITION | H.CLOUD_NOISE_BAKED_ONLY,
    H.CLOUD_MARCH_EMIT_RECONSTRUCTION,
    H.CLOUD_GEOGRAPHIC_WIND |
      H.CLOUD_SINGLE_LEVEL_WIND |
      H.CLOUD_VELOCITY_ONLY_WIND,
  ]) {
    naga.validate_wgsl(preprocess(program, 0, flags | recipe));
  }
});

test("population and vertical requests reach the march defines as their own registry bits", () => {
  const vertical = H.CLOUD_WEATHER_VERTICAL,
    populations = H.CLOUD_WEATHER_POPULATIONS;
  for (const bit of [vertical, populations]) {
    assert.ok(bit > 0 && (bit & (bit - 1)) === 0, "one high-word bit");
  }
  for (const [name, value] of Object.entries(H)) {
    if (typeof value !== "number") continue;
    if (name !== "CLOUD_WEATHER_VERTICAL")
      assert.equal(value & vertical, 0, name);
    if (name !== "CLOUD_WEATHER_POPULATIONS") {
      assert.equal(value & populations, 0, name);
    }
  }
  assert.equal(
    api.cloudMarchFeatureDefines({ populations: true }),
    populations,
  );
  assert.equal(api.cloudMarchFeatureDefines({ vertical: true }), vertical);
  assert.equal(
    api.cloudMarchFeatureDefines({ vertical: true, populations: true }),
    vertical | populations,
  );
  assert.equal(api.cloudMarchFeatureDefines({}), 0);
  const active = api.cloudMarchActiveFeatures({
    weatherPopulationsRequested: true,
  });
  assert.equal(active.populations, true);
  assert.equal(active.vertical, false);
  assert.equal(api.cloudMarchActiveFeatures({}).populations, false);
});

test("shipped medium integration conserves overlapping colored extinction and split intervals", () => {
  const source = math.stripComments(
    preprocess(read(shaders + "CloudPopulationLighting.wgsl"), 0, flags),
  );
  const integrate = math.compileFunction(
    source,
    "cloudIntegratePopulationMedium",
    { __functions: { exp: Math.exp } },
  );
  const medium = Object.assign(math.vec4(2, 0, 1, 3), {
    a: 3,
    rgb: math.vec(2, 0, 1),
  });
  const result = integrate(medium, 2, 1);
  const alpha = 1 - Math.exp(-6);
  assert(Math.abs(result.w - alpha) < 1e-12);
  assert(Math.abs(result.x - (alpha * 2) / 3) < 1e-12);
  assert(Math.abs(result.z - alpha / 3) < 1e-12);
  let transmission = 1,
    red = 0,
    blue = 0;
  for (let i = 0; i < 100; i++) {
    const part = integrate(medium, 0.02, transmission);
    red += part.x;
    blue += part.z;
    transmission *= Math.exp(-3 * 0.02);
  }
  assert(Math.abs(red - result.x) < 1e-12);
  assert(Math.abs(blue - result.z) < 1e-12);
  assert.equal(
    integrate(
      Object.assign(math.vec4(0, 0, 0, 0), { a: 0, rgb: math.vec(0, 0, 0) }),
      2,
      1,
    ).w,
    0,
  );
  const redFirst = 1 - Math.exp(-4);
  assert(
    Math.abs(redFirst - result.x) > 0.1,
    "whole-slab sorting must fail the overlapping-medium oracle",
  );
});

test("shipped population profile preserves regional and partially unknown physical heights", () => {
  const source = math.stripComments(
    preprocess(read(shaders + "CloudPopulationWeather.wgsl"), 0, flags),
  );
  const globals = {
    cloud: { anvilBias: 0 },
    __functions: {
      cloudVerticalGradient: (height) =>
        height < 0 || height > 1 ? 0 : 4 * height * (1 - height),
      mix: (a, b, t) =>
        typeof a === "number"
          ? a + (b - a) * t
          : math.vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t),
    },
  };
  globals.__functions.cloudPopulationFallbackBounds = math.compileFunction(
    source,
    "cloudPopulationFallbackBounds",
    globals,
  );
  const profile = math.compileFunction(
    source,
    "cloudPopulationProfile",
    globals,
  );
  const channels = { baseShiftFrac: 0, perGenusShape: 0 };
  const weather = (base, top, support) => ({
    heights: Object.assign(math.vec(base, top, support), {
      xy: math.vec2(base, top),
    }),
  });
  const known = weather(1000, 3000, 1);
  assert.equal(profile(2000, channels, known, 0).y, 1);
  assert.equal(profile(4000, channels, known, 0).y, 0);
  assert.equal(profile(1000, channels, weather(0, 0, 0), 0).y, 1);
  const partial = profile(2000, channels, weather(250, 750, 0.25), 0);
  assert.equal(partial.y, 0.25);
  assert.equal(partial.x, 0.875);
  assert.equal(profile(4500, channels, weather(0, 0, 0), 1).x, 0.5);
});

// The top-level statements of a function body: each ends at a `;` or at the
// `}` that closes a block, outside any parentheses and braces.
function topLevelStatements(body) {
  const statements = [];
  let brace = 0,
    paren = 0,
    from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "{") brace++;
    else if (c === "}") brace--;
    if (paren === 0 && brace === 0 && (c === ";" || c === "}")) {
      statements.push(body.slice(from, i + 1).trim());
      from = i + 1;
    }
  }
  const rest = body.slice(from).trim();
  if (rest) statements.push(rest);
  return statements;
}
// The brace depth of an offset inside a function body.
function braceDepthAt(body, offset) {
  let depth = 0;
  for (let i = 0; i < offset; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") depth--;
  }
  return depth;
}
// The expression the population march publishes as the deck colour. The last
// `result.hazed = X;` of the function must be an unconditional statement of
// the function body (brace depth 0), written after the `cloudResolveDeck`
// call and directly before `return result;`; otherwise the march can skip it
// or return before it, and the evaluated expression says nothing about what
// the deck publishes.
function populationPublishedColor(marchSource) {
  const { body } = math.extractFunction(marchSource, "marchPopulationClouds");
  const matches = [...body.matchAll(/result\.hazed\s*=\s*([^;]+);/g)];
  assert(matches.length >= 1, "the march assigns result.hazed");
  const last = matches.at(-1);
  assert.equal(
    braceDepthAt(body, last.index),
    0,
    "the published colour is assigned at the top level of the function body",
  );
  const statements = topLevelStatements(body);
  assert.equal(
    statements.at(-1),
    "return result;",
    "the function body ends in return result",
  );
  assert.equal(
    statements.at(-2),
    last[0],
    "the published colour is assigned directly before the return",
  );
  const resolve = statements.findLastIndex((statement) =>
    /\bcloudResolveDeck\s*\(/.test(statement),
  );
  assert(resolve >= 0, "the march calls cloudResolveDeck");
  for (const statement of statements.slice(resolve + 1, -2)) {
    assert.match(
      statement,
      /^result\.(?!hazed\b)\w+\s*=[^;]+;$/,
      "only other result fields are written between the resolve and the publish",
    );
  }
  return last[1];
}

// The population resolve returns the deck's straight colour and opacity. The
// march publishes that colour and the view scales it by the opacity once, so
// the published radiance is the straight colour times alpha. The WGSL runs in
// the mini evaluator: trailing call commas are dropped and the aerial
// look-up-table branch (a bit test the evaluator has no operator for) is
// switched off; the aerial helpers are stubs with known answers.
test("population resolver retains straight colour until the view applies opacity once", () => {
  const defines = H.CLOUD_WEATHER_POPULATIONS;
  const stage = (file) =>
    math.stripComments(preprocess(read(shaders + file), 0, defines));
  const march = stage("CloudPopulationMarch.wgsl");
  const view = stage("CloudViewIntegration.wgsl");
  const resolveSource = stage("CloudDeckResolve.wgsl")
    .replace(/,(\s*)\)/g, "$1)")
    .replace(
      /\(u32\(cloud\.qualityFlags\)\s*&\s*QF_AERIAL_LUT\)\s*!=\s*0u/,
      "false",
    );
  assert.match(resolveSource, /if \(false\)/, "the look-up-table branch");
  const publishedColorExpression = populationPublishedColor(march);
  const publishes = [
    ...math
      .extractFunction(view, "integrateCloudView")
      .body.matchAll(/result\.radiance\s*=\s*([^;]+);/g),
  ].filter((m) => m[1].includes("deck.hazed"));
  assert(publishes.length === 1);
  const selected = (parameter, expression) =>
    math.compileFunction(
      `fn selected(${parameter}) -> vec3<f32> { return ${expression}; }`,
      "selected",
      {},
    );
  const publishedColor = selected(
    "resolved: vec4<f32>",
    publishedColorExpression,
  );
  const publishedRadiance = selected("deck: DeckResult", publishes[0][1]);
  const mix = (a, b, t) => {
    const x = math.laneValues(a),
      y = math.laneValues(b);
    return math.vec(...x.map((v, i) => v + (y[i] - v) * t));
  };
  const exposure = 1.5,
    aerialColor = [0.4, 0.5, 0.6],
    weighted = [0.2, 0.5, 0.8];
  const tone = math.compileFunction(view, "cloudToneMappedRadiance", {});
  const close = (a, b, label) =>
    assert(
      Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * 1e-9),
      `${label}: ${a} against ${b}`,
    );
  for (const aerial of [0, 0.3]) {
    const resolve = math.compileFunction(resolveSource, "cloudResolveDeck", {
      cloud: {
        exposure,
        qualityFlags: 0,
        aerialStrength: 1,
        aerialColor: math.vec(...aerialColor),
      },
      __functions: {
        cloudToneMappedRadiance: tone,
        cloudVisibleAerialSample: () => math.vec2(1, 2),
        cloudShellAxes: () => math.vec(1, 1, 1),
        cloudAirCurvatureRadius: () => 1,
        cloudAerialFraction: () => aerial,
        mix,
      },
    });
    for (const alpha of [0.001, 0.01, 0.1, 0.5, 1]) {
      const resolved = resolve(
        math.vec(0, 0, 0),
        math.vec(0, 0, 1),
        math.vec(0, 1, 0),
        0,
        1,
        0,
        1,
        math.vec(...weighted),
        1 - alpha,
        0.5,
        0.5,
      );
      close(math.laneValues(resolved)[3], alpha, "opacity");
      const [x, y, z, w] = math.laneValues(resolved);
      // The evaluator has no vec4 swizzles: the resolve result is split by hand.
      const hazed = publishedColor({ rgb: math.vec(x, y, z), a: w });
      const radiance = publishedRadiance({ hazed, alpha });
      math.laneValues(radiance).forEach((value, i) => {
        // The straight colour is the exposed radiance over itself plus the
        // opacity, tone mapped; the air fraction blends it toward the aerial
        // colour; the view scales the blend by the opacity once.
        const exposed = weighted[i] * exposure;
        const straight = exposed / (exposed + alpha);
        close(
          value,
          (straight * (1 - aerial) + aerialColor[i] * aerial) * alpha,
          `alpha ${alpha} aerial ${aerial} channel ${i}`,
        );
      });
    }
  }
});

// Each mutant rewrites the march's published-colour assignment in memory; the
// liveness check must refuse it, and the shipped march must pass it.
test("the published-colour liveness check accepts the shipped march and refuses an unreachable assignment", () => {
  const march = math.stripComments(
    preprocess(
      read(shaders + "CloudPopulationMarch.wgsl"),
      0,
      H.CLOUD_WEATHER_POPULATIONS,
    ),
  );
  const assignment = "result.hazed = resolved.rgb;";
  assert.equal(march.split(assignment).length, 2, "one assignment to mutate");
  assert.equal(populationPublishedColor(march), "resolved.rgb");
  const wrapped = march.replace(
    assignment,
    "if (false) { " + assignment + " }",
  );
  assert.notEqual(wrapped, march);
  assert.throws(
    () => populationPublishedColor(wrapped),
    /top level of the function body/,
  );
  const closing = /return result;\s*\}\s*$/;
  assert.match(march, closing, "the function ends in a return");
  const moved = march
    .replace(assignment, "")
    .replace(closing, "return result; " + assignment + " }");
  assert.notEqual(moved, march);
  assert.throws(() => populationPublishedColor(moved), /ends in return result/);
  const skipped = march.replace(
    assignment,
    "if (true) { return result; } " + assignment,
  );
  assert.notEqual(skipped, march);
  assert.throws(
    () => populationPublishedColor(skipped),
    /only other result fields/,
  );
  const trailing = march.replace(
    assignment,
    assignment + " result.alpha = 0.0;",
  );
  assert.notEqual(trailing, march);
  assert.throws(
    () => populationPublishedColor(trailing),
    /directly before the return/,
  );
});

function populations(width, height) {
  const plane = width * height * 4;
  return {
    bytes: new Uint8Array(plane * 9),
    bounds: [
      { minimumBase: 1000, maximumTop: 14000 },
      { minimumBase: 4500, maximumTop: 7000 },
      undefined,
    ],
  };
}
function fixture() {
  const textures = [],
    writes = [],
    context = { retired: 0 };
  const device = {
    queue: {
      writeTexture(...args) {
        writes.push(args);
      },
    },
    createTexture(description) {
      const texture = {
        description,
        createView() {
          return { texture };
        },
        destroy() {
          texture.dead = true;
        },
      };
      textures.push(texture);
      return texture;
    },
  };
  return { textures, writes, context, device };
}

test("actual current/prior upload paths reuse complete population epochs and invalidate layer-only changes", async () => {
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1, COPY_DST: 2 };
  const ensureSource = block(
    renderer.replace("function ensureWeatherView(", "fn ensureWeatherView("),
    "ensureWeatherView",
  ).replace(/^fn /, "function ");
  const current = await bundle(
    [
      'import { validPackedWeatherVertical } from "./' +
        scene +
        'Weather/WeatherVerticalField.ts";',
      'import { validPackedWeatherCloudLayers } from "./' +
        scene +
        'Weather/WeatherCloudLayers.ts";',
      "const WEATHER_TEX_W=4,WEATHER_TEX_H=3,CLOUD_TEMPORAL_RESET_RESOURCE=2;",
      "const GPUTextureUsage={TEXTURE_BINDING:1,COPY_DST:2};",
      "function verifyCloudMutationLease(){}",
      "function requestCloudWeatherPreparation(){}",
      "function destroyCloudGpuResource(context,texture){texture.destroy();context.retired++;}",
      ensureSource,
      "export {ensureWeatherView};",
    ].join("\n"),
  );
  const { device, writes, context } = fixture();
  const cache = {
    weatherTexture: null,
    weatherTextureLayers: 0,
    temporalHistoryPendingResetReasons: 0,
    observability: {
      weatherLiveBytes: 0,
      weatherCacheHits: 0,
      weatherCacheMisses: 0,
      weatherUploads: 0,
      weatherUploadBytes: 0,
    },
  };
  const bytes = new Uint8Array(48),
    layers = populations(4, 3);
  const vertical = {
    bytes: bytes.slice(),
    minimumBase: 1000,
    maximumTop: 14000,
  };
  const first = current.ensureWeatherView(
    context,
    device,
    cache,
    true,
    bytes,
    1,
    {},
    false,
    undefined,
    1,
    vertical,
    layers,
  );
  assert.equal(first.texture.description.size.depthOrArrayLayers, 11);
  assert.equal(cache.observability.weatherLiveBytes, 48 * 11);
  assert.equal(writes.at(-1)[0].origin.z, 2);
  assert.equal(writes.at(-1)[1], layers.bytes);
  assert.equal(writes.at(-1)[3].depthOrArrayLayers, 9);
  const count = writes.length;
  assert.equal(
    current.ensureWeatherView(
      context,
      device,
      cache,
      true,
      bytes,
      2,
      {},
      false,
      undefined,
      1,
      vertical,
      layers,
    ),
    first,
  );
  assert.equal(writes.length, count);
  const replacement = { ...layers, bytes: layers.bytes.slice() };
  replacement.bytes[2] = 7;
  current.ensureWeatherView(
    context,
    device,
    cache,
    true,
    bytes,
    2,
    {},
    false,
    undefined,
    1,
    vertical,
    replacement,
  );
  assert.equal(writes.length, count + 3);
  assert.equal(cache.weatherPopulations, replacement);
  assert.equal(
    current.ensureWeatherView(context, device, cache, true, null, 3, {}, true),
    first,
  );
  assert.equal(cache.weatherPopulations, replacement);
  const ordinary = current.ensureWeatherView(
    context,
    device,
    cache,
    true,
    bytes,
    3,
    {},
    false,
    undefined,
    1,
    vertical,
  );
  assert.equal(ordinary.texture.description.size.depthOrArrayLayers, 2);
  assert.equal(context.retired, 1);
  const previous = new api.CloudWeatherTransitionResources(),
    value = { width: 4, height: 3, bytes, vertical, layers };
  const old = previous.prepareWeather(device, value, true, true),
    before = writes.length;
  assert.equal(old.texture.description.size[2], 11);
  assert.equal(previous.prepareWeather(device, value, true, true), old);
  assert.equal(writes.length, before);
  previous.prepareWeather(
    device,
    { ...value, layers: replacement },
    true,
    true,
  );
  assert.equal(writes.length, before + 3);
  previous.destroy();
  assert.equal(old.texture.dead, true);
});

test("only the scene-owned procedural source changes its layer request policy", async () => {
  const state = new api.CloudWeatherState(),
    frame = { afterRender: [] };
  state.update({ cloudWeatherMap: true, cloudWeatherSeed: 7 }, frame);
  const ordinary = state.provider;
  state.update(
    {
      cloudWeatherMap: true,
      cloudWeatherSeed: 7,
      cloudIndependentWeatherLayers: true,
    },
    frame,
  );
  const independent = state.provider;
  assert.notEqual(independent, ordinary);
  independent.useWorkers = false;
  independent.tickSceneTime(Date.parse("2026-10-19T12:00:00Z"));
  const deadline = Date.now() + 10000;
  let publication;
  while (!publication) {
    publication = independent.getPackedPublication(8, 5);
    assert(
      Date.now() < deadline,
      independent.lastError ?? "owned layered weather timeout",
    );
    if (!publication) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert(publication.current.layers);
  state.update(
    {
      cloudWeatherMap: true,
      cloudWeatherSeed: 7,
      cloudIndependentWeatherLayers: true,
    },
    frame,
  );
  assert.equal(state.provider, independent);
  const external = {
    getTimeMode() {
      return null;
    },
  };
  state.update(
    { weatherProvider: external, cloudIndependentWeatherLayers: true },
    frame,
  );
  assert.equal(state.provider, external);
  state.destroy();
});
