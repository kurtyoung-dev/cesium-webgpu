import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

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
      path.join(directory, "ProceduralClouds.wgsl"),
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
