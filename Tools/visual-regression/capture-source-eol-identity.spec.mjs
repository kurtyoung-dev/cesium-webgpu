// capture-source-eol-identity.spec.mjs — capture-source EOL identity
// @purpose Materializes the real capture library as both a CRLF and an LF checkout, imports each, and evaluates whether the published sampler and runtime-attestor digests and the analyzer's verdict on the real probe source are the same from either, with an absence and an inertness mutant required to break all three signals.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no device.
//
// WHY THIS EXISTS
// ---------------
// The sampler and runtime-attestor sources come from Function#toString(), so a
// CRLF checkout can otherwise leak carriage returns into their published text
// and change its digest relative to an LF checkout. Capture-source identity must
// belong to the source text, not to the checkout's line endings.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const visualRegressionDirectory = fileURLToPath(new URL(".", import.meta.url));
const captureLibraryPath = path.join(
  visualRegressionDirectory,
  "lib",
  "c12-29-s5-replacement-device-capture.mjs",
);
const sameTaskCapturePath = path.join(
  visualRegressionDirectory,
  "lib",
  "same-task-capture.mjs",
);
const probePath = path.join(
  visualRegressionDirectory,
  "probe-c12-29-s5-replacement-device.mjs",
);
const outputDirectory = path.join(visualRegressionDirectory, "output");
const outputDirectoryExisted = existsSync(outputDirectory);

if (!outputDirectoryExisted) {
  mkdirSync(outputDirectory, { recursive: true });
}

after(() => {
  if (!outputDirectoryExisted) {
    // Another probe may legitimately have written here in the meantime;
    // this cleanup is a courtesy, never a reason to fail the run.
    try {
      rmdirSync(outputDirectory);
    } catch {
      // The directory is in use or not empty. Leave it.
    }
  }
});

function rewriteLineEndings(source, lineEnding) {
  const lfSource = source.replace(/\r\n?|\n/g, "\n");

  if (lineEnding === "lf") {
    return lfSource;
  }

  assert.equal(lineEnding, "crlf", `unsupported line ending: ${lineEnding}`);
  return lfSource.replace(/\n/g, "\r\n");
}

async function materializeCaptureLibrary(
  t,
  lineEnding,
  sourceTransform = (source) => source,
) {
  const materializedDirectory = mkdtempSync(
    path.join(outputDirectory, "capture-source-eol-identity-"),
  );
  t.after(() => {
    rmSync(materializedDirectory, { force: true, recursive: true });
  });

  const captureLibrarySource = sourceTransform(
    rewriteLineEndings(readFileSync(captureLibraryPath, "utf8"), "lf"),
  );
  const materializedCaptureLibraryPath = path.join(
    materializedDirectory,
    path.basename(captureLibraryPath),
  );
  const materializedSameTaskCapturePath = path.join(
    materializedDirectory,
    path.basename(sameTaskCapturePath),
  );

  writeFileSync(
    materializedCaptureLibraryPath,
    rewriteLineEndings(captureLibrarySource, lineEnding),
    "utf8",
  );
  writeFileSync(
    materializedSameTaskCapturePath,
    rewriteLineEndings(readFileSync(sameTaskCapturePath, "utf8"), lineEnding),
    "utf8",
  );

  return import(pathToFileURL(materializedCaptureLibraryPath).href);
}

function removeCanonicalExecutableSourceNormalization(source) {
  const anchor = '  return fn.toString().replace(/\\r\\n/g, "\\n");';
  const anchorCount = source.split(anchor).length - 1;

  assert.equal(anchorCount, 1, "absence mutation anchor count");
  return source.replace(anchor, "  return fn.toString();");
}

function makeCanonicalExecutableSourceNormalizationInert(source) {
  const anchor = '  return fn.toString().replace(/\\r\\n/g, "\\n");';
  const anchorCount = source.split(anchor).length - 1;

  assert.equal(anchorCount, 1, "inertness mutation anchor count");
  return source.replace(
    anchor,
    '  return fn.toString().replace(/\\r\\n/g, "\\r\\n");',
  );
}

function digestComparisonMessage(label, crlfDigest, lfDigest) {
  return `${label} digests: CRLF=${crlfDigest}, LF=${lfDigest}`;
}

test("canonical executable sources carry no carriage returns on a CRLF checkout", async (t) => {
  const crlfModule = await materializeCaptureLibrary(t, "crlf");

  assert.doesNotMatch(crlfModule.C12_29_S5_REPLACEMENT_SAMPLER_SOURCE, /\r/);
  assert.doesNotMatch(
    crlfModule.C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE,
    /\r/,
  );
});

test("the published digests are identical from a CRLF and an LF checkout", async (t) => {
  const crlfModule = await materializeCaptureLibrary(t, "crlf");
  const lfModule = await materializeCaptureLibrary(t, "lf");

  assert.equal(
    crlfModule.C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
    lfModule.C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
    digestComparisonMessage(
      "sampler",
      crlfModule.C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
      lfModule.C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
    ),
  );
  assert.equal(
    crlfModule.C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
    lfModule.C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
    digestComparisonMessage(
      "runtime-attestor",
      crlfModule.C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
      lfModule.C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
    ),
  );
});

test("the CRLF-checkout analyzer accepts the real probe source read verbatim", async (t) => {
  const crlfModule = await materializeCaptureLibrary(t, "crlf");
  const probeSource = readFileSync(probePath, "utf8");
  const { failures } =
    crlfModule.analyzeC1229S5ReplacementCaptureSource(probeSource);
  const identityFailures = failures.filter((failure) =>
    /canonical|sampler|fused/i.test(failure),
  );

  assert.deepEqual(identityFailures, []);
});

test("both required mutants are red", async (t) => {
  const lfModule = await materializeCaptureLibrary(t, "lf");
  const probeSource = readFileSync(probePath, "utf8");
  const expectedSamplerDigest =
    lfModule.C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256;
  const mutations = [
    {
      name: "absence",
      transform: removeCanonicalExecutableSourceNormalization,
    },
    {
      name: "inertness",
      transform: makeCanonicalExecutableSourceNormalizationInert,
    },
  ];
  const survivors = [];

  for (const mutation of mutations) {
    const mutantModule = await materializeCaptureLibrary(
      t,
      "crlf",
      mutation.transform,
    );
    const containsCarriageReturn =
      mutantModule.C12_29_S5_REPLACEMENT_SAMPLER_SOURCE.includes("\r");
    const digestChanged =
      mutantModule.C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256 !==
      expectedSamplerDigest;
    // The signal that matters operationally: the analyzer's verdict on the
    // real probe source. A mutant that only perturbs a constant would leave
    // the false red this fix exists to remove unreproduced.
    const verdictBroken = mutantModule
      .analyzeC1229S5ReplacementCaptureSource(probeSource)
      .failures.some((failure) => /canonical|sampler|fused/i.test(failure));

    if (!containsCarriageReturn || !digestChanged || !verdictBroken) {
      const missingSignals = [];

      if (!containsCarriageReturn) {
        missingSignals.push("sampler source has no carriage return");
      }
      if (!digestChanged) {
        missingSignals.push("sampler digest matches the LF baseline");
      }
      if (!verdictBroken) {
        missingSignals.push("the analyzer still accepts the probe source");
      }
      survivors.push(`${mutation.name} (${missingSignals.join(", ")})`);
    }
  }

  assert.equal(
    survivors.length,
    0,
    `mutant survivors: ${survivors.join("; ")}`,
  );
});
