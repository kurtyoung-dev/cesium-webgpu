import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import vm from "node:vm";

describe("cloud radiance opacity contract", () => {
  async function transport() {
    const { compileFunction, evaluate, parseExpression, tokenize, vec } =
      await import("./lib/wgsl-mini-eval.mjs");
    const directory = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../packages/engine/Source/Shaders/WebGPU/Environment",
    );
    const view = fs.readFileSync(
      path.join(directory, "CloudViewIntegration.wgsl"),
      "utf8",
    );
    const march = fs.readFileSync(
      path.join(directory, "CloudDeckResolve.wgsl"),
      "utf8",
    );
    const functions = {
      mix: (a, b, weight) =>
        vec(
          a.x * (1 - weight) + b.x * weight,
          a.y * (1 - weight) + b.y * weight,
          a.z * (1 - weight) + b.z * weight,
        ),
    };
    functions.cloudToneMappedRadiance = compileFunction(
      view,
      "cloudToneMappedRadiance",
      { __functions: functions },
    );
    const expression = (source, regex) => {
      const match = source.match(regex);
      assert.notEqual(
        match,
        null,
        "the shipped transport boundary must remain observable",
      );
      return parseExpression(tokenize(match[1]), 0).node;
    };
    const opacity = expression(march, /let opacity = ([^;]+);/);
    const tone = expression(march, /let toneMapped = ([^;]+);/);
    const haze = expression(march, /var hazed = ([^;]+);/);
    const composite = expression(view, /result\.radiance \+= ([^;]+);/);
    const run = (
      sourceColor,
      alpha,
      exposure,
      transmittance = 1,
      selectedTone = tone,
    ) => {
      const cloud = { exposure, aerialColor: vec(0.1, 0.2, 0.3) };
      const resolvedAlpha = evaluate(opacity, { transmittance: 1 - alpha });
      const toneMapped = evaluate(selectedTone, {
        weightedColor: vec(...sourceColor.map((value) => value * alpha)),
        opacity: resolvedAlpha,
        cloud,
        __functions: functions,
      });
      const hazed = evaluate(haze, {
        toneMapped,
        cloud,
        aerial: 0,
        __functions: functions,
      });
      return evaluate(composite, {
        transmittance,
        deck: { alpha: resolvedAlpha, hazed },
      });
    };
    return { run, vec, expression, march };
  }

  it("maps a homogeneous source independently of opacity and premultiplies exactly once at the actual composite", async () => {
    const { run } = await transport();
    for (const source of [
      [0.01, 0.1, 1],
      [0.5, 1, 4],
      [10, 100, 1000],
    ]) {
      for (const exposure of [0, 0.25, 1, 4]) {
        for (const alpha of [0.00001, 0.01, 0.1, 0.5, 0.9, 1]) {
          const actual = run(source, alpha, exposure);
          for (let channel = 0; channel < 3; channel++) {
            const radiance = source[channel] * exposure;
            const expected = (alpha * radiance) / (radiance + 1);
            assert.ok(
              Math.abs(actual[["x", "y", "z"][channel]] - expected) < 1e-12,
            );
          }
        }
      }
    }
  });

  it("keeps zero opacity finite and zero, and opaque output equal to the historical tone map", async () => {
    const { run } = await transport();
    for (const source of [
      [0, 0, 0],
      [0.25, 2, 200],
    ]) {
      for (const exposure of [0, 0.5, 3]) {
        const clear = run(source, 0, exposure);
        for (const channel of ["x", "y", "z"]) {
          assert.equal(clear[channel], 0);
        }
        const opaque = run(source, 1, exposure);
        for (let i = 0; i < 3; i++) {
          const exposed = source[i] * exposure;
          assert.equal(opaque[["x", "y", "z"][i]], exposed / (exposed + 1));
        }
      }
    }
  });

  it("preserves homogeneous radiance when the same medium is split across decks", async () => {
    const { run } = await transport();
    const source = [0.2, 1, 6],
      a = 0.3,
      b = 0.4;
    const near = run(source, a, 1.2),
      far = run(source, b, 1.2, 1 - a);
    const joined = run(source, a + (1 - a) * b, 1.2);
    for (const channel of ["x", "y", "z"]) {
      assert.ok(
        Math.abs(near[channel] + far[channel] - joined[channel]) < 1e-12,
      );
    }
  });

  it("rejects the historical extra-opacity tone map with the same numeric contract", async () => {
    const { run, expression } = await transport();
    const oldTone = expression(
      "let toneMapped = weightedColor * cloud.exposure / (weightedColor * cloud.exposure + vec3<f32>(1.0));",
      /let toneMapped = ([^;]+);/,
    );
    const source = [1, 1, 1],
      alpha = 0.2;
    const corrected = run(source, alpha, 1);
    const historical = run(source, alpha, 1, 1, oldTone);
    assert.ok(Math.abs(corrected.x - 0.1) < 1e-12);
    assert.throws(() => assert.ok(Math.abs(historical.x - 0.1) < 1e-12));
  });
});

// The deck resolve runs in one place: marchDeck hands the accumulated deck to
// cloudResolveDeck, which the population march calls too. These tests execute
// the shipped call site and the shipped resolve, and hold the result against the
// resolve marchDeck computed inline before it shared the function.
describe("shared deck resolve", () => {
  const environment = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../packages/engine/Source/Shaders/WebGPU/Environment",
  );
  const read = (name) =>
    fs.readFileSync(path.join(environment, `${name}.wgsl`), "utf8");
  const PLANET_RADIUS = 6371000;

  // The inline resolve, as an executable reference: the same statements in the
  // same order, with the quality-flag branch written as a guarded return.
  const INLINE_RESOLVE = `
fn inlineDeckResolve(rayOrigin: vec3<f32>, rayDir: vec3<f32>, sunDir: vec3<f32>,
  tStart: f32, tEnd: f32, deckBottom: f32, deckTop: f32, weightedColor: vec3<f32>,
  transmittance: f32, visibleDistanceSum: f32, visibleAltitudeSum: f32) -> vec4<f32> {
  if (transmittance >= 1.0) { return vec4<f32>(0.0); }
  let opacity = 1.0 - transmittance;
  let toneMapped = cloudToneMappedRadiance(weightedColor, opacity, cloud.exposure);
  let visible = cloudVisibleAerialSample(
    visibleDistanceSum, visibleAltitudeSum, opacity,
    tStart, tEnd, deckBottom, deckTop);
  let visiblePos = rayOrigin + rayDir * visible.x;
  let surfaceAxes = cloudShellAxes(0.0);
  let visibleUp = normalize(visiblePos / (surfaceAxes * surfaceAxes));
  let aerial = cloudAerialFraction(
    visible.y, -rayDir, visibleUp, visible.x, cloud.aerialStrength,
    cloudAirCurvatureRadius(visibleUp, -rayDir));
  let hazed = mix(toneMapped, cloud.aerialColor, aerial);
  if (cloudPhysicalAerialEnabled()) {
    return vec4<f32>(cloudPhysicalAerialColor(weightedColor, opacity, hazed,
      visible.y, -rayDir, visibleUp, visible.x,
      cloudAirCurvatureRadius(visibleUp, -rayDir), sunDir), opacity);
  }
  return vec4<f32>(hazed, opacity);
}`;

  // The march source marchDeck is compiled from at the default recipe: the
  // renderer's own module template, preprocessed with no defines.
  async function composedMarch() {
    const { defaultVariant } = await import("./lib/wgsl-variant.mjs");
    const { composeRendererTemplate } =
      await import("./lib/engine-shader-source.mjs");
    return defaultVariant(
      composeRendererTemplate(
        "Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
        "PROCEDURAL_CLOUDS_SOURCE",
      ),
    );
  }

  // The body of marchDeck within the composed march, as [first, end) offsets.
  function marchDeckBody(march) {
    const start = march.indexOf("fn marchDeck(");
    assert.notEqual(start, -1, "marchDeck must be part of the composed march");
    const open = march.indexOf("{", march.indexOf("-> DeckResult", start));
    let depth = 0;
    let end = open;
    for (; end < march.length; end++) {
      if (march[end] === "{") depth++;
      else if (march[end] === "}" && --depth === 0) break;
    }
    return [open + 1, end];
  }

  // The same march with one replacement made inside marchDeck only.
  function mutateMarchDeck(march, from, to) {
    const [first, end] = marchDeckBody(march);
    const body = march.slice(first, end);
    const mutated = body.replace(from, to);
    assert.notEqual(mutated, body, "the mutation matched nothing in marchDeck");
    return march.slice(0, first) + mutated + march.slice(end);
  }

  // The statements after the march loop: those that resolve the deck and fill
  // the DeckResult the march returns.
  function resolveCallSite(march) {
    const [first, end] = marchDeckBody(march);
    const body = march.slice(first, end);
    const call = body.lastIndexOf("let resolved = cloudResolveDeck(");
    assert.notEqual(
      call,
      -1,
      "marchDeck must resolve its deck through cloudResolveDeck",
    );
    const loopClose = "\n  }\n";
    const loopEnd = body.lastIndexOf(loopClose, call);
    assert.notEqual(loopEnd, -1, "the resolve must follow the march loop");
    return body.slice(loopEnd + loopClose.length);
  }

  async function load({ march, resolve = read("CloudDeckResolve") } = {}) {
    const math = await import("./lib/wgsl-mini-eval.mjs");
    const { defaultVariant } = await import("./lib/wgsl-variant.mjs");
    const marchSource = march ?? (await composedMarch());
    const cloud = {
      exposure: 1.3,
      qualityFlags: 0,
      aerialStrength: 1,
      aerialColor: math.vec(0.1, 0.2, 0.3),
    };
    const state = { fixedAerial: null, airCalls: 0 };
    const air = {
      transmittance: math.vec(0.5, 0.7, 0.9),
      radiance: math.vec(0.03, 0.06, 0.12),
    };
    const lanes = math.laneValues;
    const functions = {
      mix: (a, b, weight) =>
        math.vec(
          ...lanes(a).map((v, i) => v * (1 - weight) + lanes(b)[i] * weight),
        ),
      cloudShellAxes: () =>
        math.vec(PLANET_RADIUS, PLANET_RADIUS, PLANET_RADIUS),
      cloudAirCurvatureRadius: () => PLANET_RADIUS,
      // Reads its inputs, so a call that mixes its arguments up changes the haze.
      cloudAerialFraction: (altitude, toward, up, path, strength) =>
        state.fixedAerial ??
        Math.min(0.85, (path / 60000) * strength) *
          (1 - 0.4 * Math.min(altitude / 8000, 1)) *
          (0.75 + 0.25 * Math.abs(lanes(toward)[0])),
      cloudFiniteAirTransport: () => {
        state.airCalls++;
        return air;
      },
    };
    const globals = { cloud, QF_AERIAL_LUT: 1, __functions: functions };
    functions.cloudToneMappedRadiance = math.compileFunction(
      read("CloudViewIntegration"),
      "cloudToneMappedRadiance",
      globals,
    );
    functions.cloudVisibleAerialSample = math.compileFunction(
      read("CloudAerialTransport"),
      "cloudVisibleAerialSample",
      globals,
    );
    functions.cloudPhysicalAerialColor = math.compileFunction(
      math.stripComments(defaultVariant(read("CloudAirLight"))),
      "cloudPhysicalAerialColor",
      globals,
    );
    functions.cloudPhysicalAerialEnabled = () =>
      (Math.trunc(cloud.qualityFlags) & globals.QF_AERIAL_LUT) !== 0;

    // The shipped resolve: its quality-flag branch becomes a guarded return and
    // its flag test is evaluated from the shipped expression.
    const shared = math.stripComments(resolve).replace(/,\s*\)/g, ")");
    const gate = shared.match(/if \(([^\n]*cloud\.qualityFlags[^\n]+)\) \{/);
    assert.ok(gate, "the resolve must test the aerial quality flag");
    const flag = vm.compileFunction(
      `return ${gate[1].replace(/\b(\d+)u\b/g, "$1")}`,
      ["cloud", "u32", "QF_AERIAL_LUT"],
    );
    const executable = shared
      .replace(gate[1], "cloudPhysicalAerialEnabledShipped()")
      .replace(
        /hazed = (cloudPhysicalAerialColor\([\s\S]*?\));/,
        "return vec4<f32>($1, opacity);",
      );
    const resolveShader = math.compileFunction(executable, "cloudResolveDeck", {
      ...globals,
      __functions: {
        ...functions,
        cloudPhysicalAerialEnabledShipped: () =>
          flag(cloud, Math.trunc, globals.QF_AERIAL_LUT),
      },
    });
    const inlineShader = math.compileFunction(
      INLINE_RESOLVE.replace(/,\s*\)/g, ")"),
      "inlineDeckResolve",
      globals,
    );
    const names = [
      "rayOrigin",
      "rayDir",
      "sunDir",
      "tStart",
      "tEnd",
      "deckBottom",
      "deckTop",
      "weightedColor",
      "transmittance",
      "visibleDistanceSum",
      "visibleAltitudeSum",
      "cloudResolveDeck",
      "zero",
    ];
    const callSite = vm.compileFunction(
      `let result = { hazed: zero, alpha: 0 };\n${resolveCallSite(marchSource)}\nreturn result;`,
      names,
    );
    return {
      cloud,
      state,
      math,
      // marchDeck's tail, handed the shipped resolve.
      march: (...inputs) =>
        callSite(
          ...inputs,
          (...args) => {
            const value = resolveShader(...args);
            return { rgb: value.xyz, a: value.w };
          },
          math.vec(0, 0, 0),
        ),
      inline: (...inputs) => {
        const value = inlineShader(...inputs);
        return { hazed: value.xyz, alpha: value.w };
      },
    };
  }

  const inputsFor = (math, { alpha, source, direction, height, deck }) => [
    math.vec(PLANET_RADIUS + height, 0, 0),
    math.vec(...direction),
    math.vec(0, 1, 0),
    deck.start,
    deck.end,
    deck.bottom,
    deck.top,
    math.vec(...source.map((value) => value * alpha)),
    1 - alpha,
    alpha * (deck.start + 0.4 * (deck.end - deck.start)),
    alpha * (deck.bottom + 0.6 * (deck.top - deck.bottom)),
  ];

  const DECKS = [
    { start: 100, end: 10000, bottom: 1000, top: 4000 },
    { start: 20000, end: 90000, bottom: 8000, top: 12000 },
  ];

  function grid(math) {
    const cases = [];
    for (const alpha of [0, 0.00001, 0.2, 0.7, 1])
      for (const source of [
        [0.2, 2, 20],
        [0.01, 0.1, 1],
      ])
        for (const direction of [
          [1, 0, 0],
          [0.6, 0.8, 0],
          [0, 0.28, 0.96],
        ])
          for (const height of [0, 1500, 120000])
            for (const deck of DECKS)
              cases.push(
                inputsFor(math, { alpha, source, direction, height, deck }),
              );
    return cases;
  }

  const lanesOf = (deck, math) => [...math.laneValues(deck.hazed), deck.alpha];

  // The largest difference between marchDeck's result and the inline resolve
  // over the whole grid, with the physical aerial branch off and on.
  function deviation(rig) {
    let worst = 0;
    let physicalRuns = 0;
    for (const qualityFlags of [0, 1]) {
      rig.cloud.qualityFlags = qualityFlags;
      for (const inputs of grid(rig.math)) {
        const calls = rig.state.airCalls;
        const got = lanesOf(rig.march(...inputs), rig.math);
        physicalRuns += rig.state.airCalls - calls;
        const want = lanesOf(rig.inline(...inputs), rig.math);
        for (let i = 0; i < want.length; i++)
          worst = Math.max(worst, Math.abs(got[i] - want[i]));
      }
    }
    return { worst, physicalRuns };
  }

  it("returns from marchDeck the values the inline resolve produced, in both aerial modes", async () => {
    const rig = await load();
    const { worst, physicalRuns } = deviation(rig);
    assert.ok(
      worst < 1e-12,
      `marchDeck differs from the inline resolve by ${worst}`,
    );
    // The comparison is not vacuous: the physical air integral ran, and the
    // grid produced visible pixels.
    assert.ok(
      physicalRuns > 0,
      "the physical aerial branch was never exercised",
    );
    rig.cloud.qualityFlags = 0;
    const visible = grid(rig.math).find((inputs) => inputs[8] < 1);
    const result = rig.march(...visible);
    assert.ok(result.alpha > 0);
    assert.ok(rig.math.laneValues(result.hazed).every((value) => value > 0));
  });

  it("composes the deck from the tone-mapped radiance, the aerial haze and the finite air", async () => {
    const rig = await load();
    const { math, cloud, state } = rig;
    const source = [0.2, 2, 20];
    const tone = (radiance) =>
      (radiance * cloud.exposure) / (radiance * cloud.exposure + 1);
    for (const physical of [0, 1]) {
      for (const fraction of [0, 0.6, 0.85]) {
        cloud.qualityFlags = physical;
        state.fixedAerial = fraction;
        for (const alpha of [0, 0.00001, 0.2, 0.7, 1]) {
          const calls = state.airCalls;
          const result = rig.march(
            ...inputsFor(math, {
              alpha,
              source,
              direction: [1, 0, 0],
              height: 0,
              deck: DECKS[0],
            }),
          );
          assert.ok(Math.abs(result.alpha - alpha) < 1e-12);
          assert.equal(state.airCalls - calls, physical && alpha > 0 ? 1 : 0);
          for (const [i, value] of math.laneValues(result.hazed).entries()) {
            const transported =
              source[i] * [0.5, 0.7, 0.9][i] + [0.03, 0.06, 0.12][i];
            const expected = physical
              ? tone(transported)
              : tone(source[i]) * (1 - fraction) +
                [0.1, 0.2, 0.3][i] * fraction;
            assert.ok(Math.abs(value - (alpha > 0 ? expected : 0)) < 1e-10);
          }
        }
      }
    }
  });

  it("mutant: a resolve that skips the aerial term is not the inline resolve", async () => {
    const original = read("CloudDeckResolve");
    const mutated = original.replace(
      "var hazed = mix(toneMapped, cloud.aerialColor, aerial);",
      "var hazed = toneMapped;",
    );
    assert.notEqual(mutated, original);
    const { worst } = deviation(await load({ resolve: mutated }));
    assert.ok(
      worst > 1e-3,
      `the skipped aerial term moved it by only ${worst}`,
    );
  });

  it("mutant: a call that swaps two resolve arguments is not the inline resolve", async () => {
    const mutated = mutateMarchDeck(
      await composedMarch(),
      /let resolved = cloudResolveDeck\(\s*rayOrigin, rayDir, sunDir, tStart, tEnd,/,
      "let resolved = cloudResolveDeck(rayOrigin, rayDir, sunDir, tEnd, tStart,",
    );
    const { worst } = deviation(await load({ march: mutated }));
    assert.ok(worst > 1e-3, `the swapped bounds moved it by only ${worst}`);
  });

  it("mutant: a march that returns before the resolve is not the inline resolve", async () => {
    const mutated = mutateMarchDeck(
      await composedMarch(),
      "let resolved = cloudResolveDeck(",
      "if (true) { return result; }\n  let resolved = cloudResolveDeck(",
    );
    const { worst } = deviation(await load({ march: mutated }));
    assert.ok(worst > 1e-3, `the unreached resolve moved it by only ${worst}`);
  });

  it("mutant: a march that no longer calls the resolve has no call site to execute", async () => {
    const mutated = mutateMarchDeck(
      await composedMarch(),
      "let resolved = cloudResolveDeck(",
      "let resolved = cloudResolveDeckGone(",
    );
    await assert.rejects(load({ march: mutated }), assert.AssertionError);
  });
});

// The resolve compiles into every program of the march, so every recipe a
// pipeline can request has to validate with it present.
describe("march variants with the shared deck resolve", () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );

  async function loadNaga() {
    const directory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
    const naga = await import(
      pathToFileURL(path.join(directory, "naga_wasm_tools.js")).href
    );
    await naga.default({
      module_or_path: fs.readFileSync(
        path.join(directory, "naga_wasm_tools_bg.wasm"),
      ),
    });
    return naga;
  }

  const template = async (read) => {
    const { composeRendererTemplate } =
      await import("./lib/engine-shader-source.mjs");
    return composeRendererTemplate(
      "Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
      "PROCEDURAL_CLOUDS_SOURCE",
      read,
    );
  };

  // The recipes the renderer requests: the features object a request names,
  // turned into defines by the renderer's own function, with each feature's
  // prerequisite. The march is then also compiled for the emission and preview.
  async function variants() {
    const { shaderDefines } = await import("./lib/wgsl-variant.mjs");
    const { cloudMarchFeatureDefines } = await import(
      pathToFileURL(
        path.join(
          root,
          "packages/engine/Source/Renderer/WebGPU/WebGPUCloudMarchFeatures.ts",
        ),
      ).href
    );
    const flags = shaderDefines.ShaderDefineHi;
    const baked =
      flags.CLOUD_NOISE_BAKED_ONLY | flags.CLOUD_MORPHOLOGY_BASE_ONLY;
    const requests = [
      ["no feature", {}],
      ["moments", { moments: true }],
      ["occupancy", { spatial: true }],
      ["occupancy with weather bounds", { spatial: true, bounds: true }],
      ["density cache", { density: true }],
      ["primary density cache", { density: true, primary: true }],
      ["directional lighting", { directional: true }],
      ["deep shadow cache", { directional: true, deep: true }],
      ["contribution lighting", { directional: true, contribution: true }],
      ["weather transition", { transition: true }],
      ["weather vertical", { vertical: true }],
      ["weather populations", { vertical: true, populations: true }],
      [
        "every feature",
        {
          moments: true,
          spatial: true,
          bounds: true,
          density: true,
          primary: true,
          directional: true,
          deep: true,
          contribution: true,
          transition: true,
          vertical: true,
          populations: true,
        },
      ],
    ];
    const out = [];
    for (const [label, request] of requests) {
      const bits = cloudMarchFeatureDefines(request);
      assert.equal(typeof bits, "number");
      out.push([label, bits], [`${label} baked`, bits | baked]);
      out.push([
        `${label} with the emission`,
        bits | flags.CLOUD_MARCH_EMIT_RECONSTRUCTION,
      ]);
    }
    out.push(["lighting preview", flags.CLOUD_LIGHTING_PREVIEW]);
    return out;
  }

  it("validates with naga at the default recipe, with each march feature and in the emission and preview recipes", async () => {
    const { preprocess } = await import("./lib/wgsl-variant.mjs");
    const naga = await loadNaga();
    const march = await template();
    for (const [label, bits] of await variants())
      assert.doesNotThrow(
        () => naga.validate_wgsl(preprocess(march, 0, bits)),
        `naga rejected ${label}`,
      );
  });

  it("mutant: a resolve compiled only into the population recipe fails the default recipe", async () => {
    const { preprocess } = await import("./lib/wgsl-variant.mjs");
    const naga = await loadNaga();
    const march = await template((relativePath) => {
      const text = fs.readFileSync(
        path.join(root, "packages/engine/Source", relativePath),
        "utf8",
      );
      return relativePath.endsWith("/CloudDeckResolve.wgsl")
        ? `//>>ifdef CLOUD_WEATHER_POPULATIONS\n${text}\n//>>endif\n`
        : text;
    });
    assert.throws(() => naga.validate_wgsl(preprocess(march, 0, 0)));
  });
});
