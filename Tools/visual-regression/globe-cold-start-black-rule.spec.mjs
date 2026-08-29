import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const probeSource = await readFile(
  path.resolve("Tools/visual-regression/probe-globe-cold-start-readiness.mjs"),
  "utf8",
);

async function liftDecideReadinessVerdict(source) {
  const match = source.match(
    /^export function decideReadinessVerdict\(\{[\s\S]*?^\}\r?$/m,
  );
  assert.ok(match, "decideReadinessVerdict must be independently liftable");

  const moduleSource =
    `${match[0].replace(/^export /, "")}\n` +
    "export { decideReadinessVerdict };\n";
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;

  return (await import(moduleUrl)).decideReadinessVerdict;
}

const decideReadinessVerdict = await liftDecideReadinessVerdict(probeSource);

const unreadyInput = {
  blackFraction: 0.73,
  settledBlackFraction: 0.0,
  commandsDeferred: 0,
  tolerance: 0.005,
};

test("decideReadinessVerdict", async (t) => {
  await t.test("near-black settled scene passes", () => {
    const verdict = decideReadinessVerdict({
      blackFraction: 0.62,
      settledBlackFraction: 0.615,
      commandsDeferred: 0,
      tolerance: 0.005,
    });

    assert.equal(verdict.pass, true);
    assert.equal(verdict.blackFraction, 0.62);
    assert.equal(verdict.settledBlackFraction, 0.615);
    assert.ok(Math.abs(verdict.blackDelta - 0.005) < 1e-12);
    assert.equal(verdict.tolerance, 0.005);
  });

  await t.test("genuinely unready frame fails", () => {
    assert.equal(decideReadinessVerdict(unreadyInput).pass, false);
  });

  await t.test("deferred commands fail despite equal black", () => {
    assert.equal(
      decideReadinessVerdict({
        blackFraction: 0.62,
        settledBlackFraction: 0.62,
        commandsDeferred: 1,
        tolerance: 0.005,
      }).pass,
      false,
    );
  });

  await t.test("flipped-comparison mutant goes red", async () => {
    const originalComparison = "blackDelta <= tolerance + Number.EPSILON";
    const mutantComparison = "blackDelta >= tolerance + Number.EPSILON";

    assert.equal(
      probeSource.split(originalComparison).length - 1,
      1,
      "comparison mutation target must be unique",
    );

    const mutant = await liftDecideReadinessVerdict(
      probeSource.replace(originalComparison, mutantComparison),
    );

    assert.throws(() => assert.equal(mutant(unreadyInput).pass, false), {
      name: "AssertionError",
    });
  });
});
