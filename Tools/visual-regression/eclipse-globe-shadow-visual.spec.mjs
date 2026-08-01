import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  checkEmbeddedCaptureIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";

const source = fs.readFileSync(
  new URL("./probe-eclipse-globe-shadow.mjs", import.meta.url),
  "utf8",
);

test("S5 visual probe embeds the canonical same-task capture implementation", () => {
  assert.deepEqual(checkEmbeddedCaptureIsCanonical(source), []);
  assert.deepEqual(checkFusedCaptureUsage(source), []);
});

test("S5 visual probe isolates both backends at eclipse and control instants", () => {
  assert.match(source, /const ECLIPSE_ISO = "2024-04-08T18:17:16Z";/);
  assert.match(source, /const CONTROL_ISO = "2024-04-09T18:17:16Z";/);
  assert.match(source, /runBackend\(browser, "webgl"\)/);
  assert.match(source, /runBackend\(browser, "webgpu"\)/);
  assert.match(source, /lighting\.enableEclipseGlobeShadow = enabled;/);
  assert.match(source, /const eclipseOff = await capture\(false\);/);
  assert.match(source, /const eclipseOn = await capture\(true\);/);
  assert.match(source, /const controlOff = await capture\(false\);/);
  assert.match(source, /const controlOn = await capture\(true\);/);
});

test("S5 visual probe gates nonblank, localized darkening and inactive identity", () => {
  assert.match(source, /capturesAreNonblank:/);
  assert.match(source, /gpuErrorGateClean:/);
  assert.match(source, /s5ToggleReachedBlock:/);
  assert.match(source, /umbraVisiblyDarkens:/);
  assert.match(source, /umbraIsLocalized:/);
  assert.match(source, /nonEclipseIsIdentity:/);
  assert.match(source, /footprintAligned:/);
  assert.match(source, /control\.on\?\.state\?\.blockActive === false/);
  assert.doesNotMatch(source, /page\.screenshot\(/);
});

test("S5 visual probe certifies selected-terrain correction transitions and one-View allocation", () => {
  assert.match(
    source,
    /const fixedOrbitalPosition = C\.Cartesian3\.fromDegrees/,
  );
  assert.match(source, /const outsideCandidates = \[\];/);
  assert.match(source, /state\?\.selectedTerrain\?\.providerSelectionRevision/);
  assert.match(source, /preparedSelectionRevision:/);
  assert.match(source, /preparedSurfaceRadius:/);
  assert.match(source, /sunInvRange:/);
  assert.match(source, /moonInvRange:/);
  assert.match(source, /uniformAllocator\?\.getStats\?\.\(\)/);
  assert.match(source, /outsideCorrectionVsGate0:/);
  assert.match(source, /insideLocalVsGate0:/);
  assert.match(source, /selectedTerrainTransitionDiscovered:/);
  assert.match(source, /comparedCapturesKeepExactSelection:/);
  assert.match(source, /correctionOnlyHasNoBodyGeometry:/);
  assert.match(source, /correctionRestoresS2OutsideFootprint:/);
  assert.match(source, /s2OnlyIsNonVacuousNegativeControl:/);
  assert.match(source, /firstInsideFrameActivatesLocalGeometry:/);
  assert.match(source, /reverseFirstFrameIsConservativeFallback:/);
  assert.match(source, /reverseSettlesAndClearsLocalGeometry:/);
  assert.match(source, /correctionCarrierIsOneViewAllocation:/);
});
