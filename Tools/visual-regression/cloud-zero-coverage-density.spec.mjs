/** @purpose Pin the zero-coverage stage in actual main cloud callers without prototype-only helpers. @status ACTIVE */
import test from "node:test";
import {
  assert,
  f,
  fixture,
  smooth,
  zeroOracle,
  inertGuard,
  bypassCaller,
  adapterCalibration,
} from "./fixtures/cloud-zero-coverage-density-support.mjs";
test(
  "main arithmetic adapter is calibrated and rejects unsupported control flow",
  adapterCalibration,
);
for (const name of ["macro", "densityAt", "legacy", "base", "ibl"])
  test(
    "actual main " +
      name +
      " has defined zero coverage even after f32 threshold rounding",
    () => {
      for (const coverage of [-1, 0, f(2 ** -149)])
        for (const noise of [-3, -0, 0, 0.5, 1, 2, f(3.4e38)])
          zeroOracle(fixture({ coverage, noise }), name);
    },
  );
test("actual main live-noise and weather-map routes keep the same zero stage", () => {
  for (const name of ["macro", "densityAt", "legacy", "base"])
    for (const options of [
      { bakedOnly: false, baked: false },
      { weather: true },
    ])
      for (const coverage of [0, -1, f(2 ** -149)])
        zeroOracle(fixture({ ...options, coverage }), name);
});
test("actual main moments and genus pivot preserve zero under directional species", () => {
  for (const moments of [false, true])
    for (const strength of [0, 0.5, 1])
      for (const aspect of [1, 2, 32]) {
        zeroOracle(fixture({ moments, strength, aspect }), "macro");
        zeroOracle(fixture({ moments, strength, aspect }), "genus");
      }
});
test("actual main population branches consume all three finite control boundaries and preserve zero", () => {
  for (const population of [0, 1, 2])
    for (const moments of [false, true])
      for (const coverage of [0, -1, f(2 ** -149)]) {
        const s = fixture({
          population,
          moments,
          coverage,
          strength: 1,
          aspect: 32,
        });
        zeroOracle(s, "macro");
        assert.deepEqual(s.boundary.populations, [population]);
      }
});
test("actual main Fog retains its existing lawful zero early-return without builtin calls", () => {
  for (const coverage of [-1, 0, f(2 ** -149), 0.001])
    zeroOracle(fixture({ coverage }), "fog");
});
test("ordinary positive coverage preserves the old smoothstep expression with modeled f32 equality", () => {
  for (const coverage of [0.01, 0.08, 0.35, 0.55, 1])
    for (const noise of [-1, 0, 0.25, 0.5, 0.75, 1, 2])
      for (const name of ["macro", "densityAt", "legacy", "base", "ibl"]) {
        const s = fixture({ coverage, noise });
        assert.equal(s.run(name), smooth(s.threshold(), 1, f(noise)));
        assert.equal(s.calls.filter((c) => c.equal).length, 0);
      }
});
test("ordinary directional genus preserves the existing budget expression", () => {
  for (const coverage of [0.01, 0.35, 0.55, 1])
    for (const strength of [0, 0.5, 1])
      for (const aspect of [1, 2, 32])
        for (const raw of [0, 0.2, 0.7, 1]) {
          const s = fixture({ coverage, strength, aspect }),
            density = f(raw),
            pivot = smooth(s.threshold(), 1, f(0.484375)),
            direction = f(1 - f(1 / f(Math.max(aspect, 1)))),
            budget = f(
              Math.min(Math.max(f(f(0.55) * f(strength)) * direction, 0), 1),
            ),
            weight = pivot < density ? f(budget * f(0.25)) : budget,
            expected = f(density + f(f(pivot - density) * weight));
          assert.equal(
            s.api.applyGenusBaseVarianceBudget(density, s.threshold()),
            expected,
          );
        }
});
test("ordinary main Fog preserves its normalization and Beer result", () => {
  for (const coverage of [0.01, 0.35, 0.55, 1])
    for (const noise of [0, 0.5, 1]) {
      const s = fixture({ coverage, noise }),
        n = f(f(f(noise * 2 - 1) * 0.5) + 0.5),
        density = smooth(
          s.threshold(),
          1,
          s.api.normalizeFogCheapCloudField(n),
        );
      assert.equal(s.run("fog"), f(Math.exp(-f(density * 2))));
    }
});
for (const [name, mutate] of [
  ["guard-inert", inertGuard],
  ["caller-bypass", bypassCaller],
])
  test(
    name +
      " loses the SAME zero oracle while the positive inverse remains healthy",
    () => {
      zeroOracle(fixture(), "macro");
      const mutant = fixture({ mutate });
      assert.throws(() => zeroOracle(mutant, "macro"), /structural-zero law/);
      assert.equal(mutant.calls.filter((c) => c.equal).length, 1);
      const positive = fixture({ coverage: 0.55, noise: 0.75, mutate });
      assert.equal(
        positive.run("macro"),
        smooth(positive.threshold(), 1, f(0.75)),
      );
    },
  );
test("ordinary positive macro remains live in every tested moments, population, noise and weather route", () => {
  const variants = [
    { moments: false },
    { moments: true },
    { bakedOnly: false, baked: false },
    { weather: true },
    ...[0, 1, 2].flatMap((population) =>
      [false, true].map((moments) => ({ population, moments })),
    ),
  ];
  for (const options of variants) {
    const subject = fixture({ ...options, coverage: 0.55, noise: 0.75 });
    assert.equal(subject.run("macro"), smooth(subject.threshold(), 1, f(0.75)));
    if (options.population !== undefined)
      assert.deepEqual(subject.boundary.populations, [options.population]);
  }
});
