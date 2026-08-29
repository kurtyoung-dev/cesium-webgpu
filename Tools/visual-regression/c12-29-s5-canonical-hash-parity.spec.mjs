import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const { analyzeC1229S5ReplacementCaptureSource } = await import(
  pathToFileURL(
    resolve(
      "Tools/visual-regression/lib/c12-29-s5-replacement-device-capture.mjs",
    ),
  ).href
);

const FunctionToString = Function.prototype.toString;
const ReflectApply = Reflect.apply;
// The page attestor evaluates the shipped slice with the global eval; the spec
// must construct the function the same way to hash the same bytes.
// eslint-disable-next-line no-eval
const GlobalEval = globalThis.eval;
const encoder = new TextEncoder();
const subtleDigest = webcrypto.subtle.digest.bind(webcrypto.subtle);

const digestHex = async (bytes) =>
  Array.from(
    new Uint8Array(
      await ReflectApply(subtleDigest, undefined, ["SHA-256", bytes]),
    ),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");

const digestText = (source) => digestHex(encoder.encode(source));

const pageSourceSha256 = (value) =>
  digestText(ReflectApply(FunctionToString, value, []));

const constructAsPageEvaluate = (source) =>
  ReflectApply(GlobalEval, undefined, [`(${source})`]);

const PROBE_SOURCE = `
function defineMeasurement() {
const MEASURE_C1229_S5_REPLACEMENT_SESSION =
  async function MEASURE_C1229_S5_REPLACEMENT_SESSION(contract) {
    function makeFusedSnapshotCapture() {
      return null;
    }
    function sampleC1229S5ReplacementRgba() {
      return null;
    }
    const readCaptureFrame = () => ({});
    return contract;
  };
return MEASURE_C1229_S5_REPLACEMENT_SESSION;
}

async function runBrowserSession() {}
`;

test("replacement measurement canonical hash parity", async (t) => {
  const analysis = analyzeC1229S5ReplacementCaptureSource(PROBE_SOURCE);
  assert.ok(analysis.proof?.measurement, analysis.failures.join("\n"));

  // Mirrors the page-side Function constructor path; see the note on GlobalEval.
  // eslint-disable-next-line no-new-func
  const hostMeasurement = Function(
    `${PROBE_SOURCE}\nreturn defineMeasurement();`,
  )();
  const serializedMeasurement = ReflectApply(
    FunctionToString,
    hostMeasurement,
    [],
  );
  const executedMeasurement = constructAsPageEvaluate(serializedMeasurement);
  const shippedMeasurementSha256 = analysis.proof.measurement.executedSha256;

  await t.test("page hashes the exact source Node ships", async () => {
    assert.equal(
      ReflectApply(FunctionToString, executedMeasurement, []),
      serializedMeasurement,
    );
    assert.equal(
      await pageSourceSha256(executedMeasurement),
      shippedMeasurementSha256,
    );
  });

  await t.test("mutant: Node-only dedent breaks parity", async () => {
    const dedentedNodeCopy = serializedMeasurement
      .split("\n")
      .map((line, index) =>
        index > 0 && line.startsWith("  ") ? line.slice(2) : line,
      )
      .join("\n");

    assert.notEqual(dedentedNodeCopy, serializedMeasurement);

    const mutantShippedMeasurementSha256 = await digestText(dedentedNodeCopy);

    assert.notEqual(
      await pageSourceSha256(executedMeasurement),
      mutantShippedMeasurementSha256,
    );
  });
});
