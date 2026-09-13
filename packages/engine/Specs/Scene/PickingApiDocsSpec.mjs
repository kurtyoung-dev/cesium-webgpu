import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import test from "node:test";

const sceneSource = readSource("../../Source/Scene/Scene.js");
const rayHelpersSource = readSource("../../Source/Scene/PickingRayHelpers.js");

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(
    /\r\n?/g,
    "\n",
  );
}

function getMethodDoc(source, methodName) {
  const methodStart = source.indexOf(`  ${methodName}(`);
  assert.notEqual(methodStart, -1, `${methodName} must exist`);

  const docStart = source.lastIndexOf("/**", methodStart);
  assert.notEqual(docStart, -1, `${methodName} must have a JSDoc block`);
  const docEnd = source.indexOf("*/", docStart) + 2;
  assert.ok(docEnd > docStart, `${methodName} JSDoc must terminate`);
  assert.equal(
    source.slice(docEnd, methodStart).trim(),
    "",
    `${methodName} JSDoc must immediately precede the method`,
  );
  return source.slice(docStart, docEnd);
}

function assertGuardedExamples(source) {
  const sampleHeightDoc = getMethodDoc(source, "sampleHeight");
  assert.match(
    sampleHeightDoc,
    /const\s+height\s*=\s*viewer\.scene\.sampleHeight\(position\);\s*\*\s+if\s*\(Cesium\.defined\(height\)\)\s*\{[\s\S]*?console\.log\(height\);[\s\S]*?\}/,
    "sampleHeight example must guard the returned height before using it",
  );

  const clampToHeightDoc = getMethodDoc(source, "clampToHeight");
  assert.doesNotMatch(
    clampToHeightDoc,
    /entity\.position\s*=\s*viewer\.scene\.clampToHeight\(/,
    "clampToHeight example must not assign an unchecked result",
  );
  assert.match(
    clampToHeightDoc,
    /const\s+clampedPosition\s*=\s*viewer\.scene\.clampToHeight\(position\);\s*\*\s+if\s*\(Cesium\.defined\(clampedPosition\)\)\s*\{[\s\S]*?entity\.position\s*=\s*clampedPosition;[\s\S]*?\}/,
    "clampToHeight example must guard the result before assigning it",
  );
}

function assertWebGpuGuidance(scene, rayHelpers) {
  for (const methodName of ["pickPosition", "sampleHeight", "clampToHeight"]) {
    const methodDoc = getMethodDoc(scene, methodName);
    assert.match(methodDoc, /<b>WebGPU note:<\/b>/);
    assert.match(methodDoc, /asynchronously/);
    assert.match(methodDoc, /return <code>undefined<\/code>/);
  }
  assert.match(
    getMethodDoc(scene, "pickPosition"),
    /@returns \{Cartesian3 \| undefined\}/,
  );

  assert.doesNotMatch(
    scene,
    /(?:sampleHeight|clampToHeight)MostDetailed\}?\s+variant\s+is\s+always\s+supported/i,
    "MostDetailed picking docs must not claim unconditional support",
  );

  for (const supportedProperty of [
    "get sampleHeightSupported",
    "get clampToHeightSupported",
  ]) {
    const propertyDoc = getMethodDoc(scene, supportedProperty);
    assert.match(propertyDoc, /does not indicate support/);
    assert.doesNotMatch(
      propertyDoc,
      /and \{@link Scene#(?:sampleHeight|clampToHeight)MostDetailed\} functions are supported/,
    );
    // The MostDetailed variant's support is a SEPARATE question from this
    // getter's, and the doc must point at the getter that answers it. Until
    // Batch 1482 it instead declared the variant unsupported on
    // asynchronous-readback backends, which stopped being true when the
    // offscreen ray-depth producer shipped -- a doc that tells users a working
    // feature does not work is the failure this guard now catches.
    assert.match(
      propertyDoc,
      /MostDetailedSupported[}] reports that separately/,
    );
    assert.doesNotMatch(
      propertyDoc,
      /and is unsupported on asynchronous-readback backends/,
      "the support getters must not declare the MostDetailed variant unsupported",
    );
    assert.match(propertyDoc, /sampleTerrainMostDetailed/);
  }

  assert.doesNotMatch(
    rayHelpers,
    /use the \*MostDetailed async variants/i,
    "runtime guidance must not recommend the unsupported picking variants",
  );
  // The runtime warning names the ONE thing still unavailable -- a synchronous
  // pickFromRay position -- and says so without sweeping the MostDetailed
  // height queries in with it, because those now work here.
  assert.match(rayHelpers, /[*]MostDetailed height queries are/);
  assert.doesNotMatch(
    rayHelpers,
    /[*]MostDetailed picking variants are also unsupported on/,
    "the warning must not claim the MostDetailed variants are unsupported",
  );
  // The recommendation itself, not a contiguous phrase: the warning is built
  // from concatenated string literals and prettier decides where the joins
  // fall, so pinning "use sampleTerrainMostDetailed" as one run makes the
  // guard fail on a reflow that changed no words.
  assert.match(rayHelpers, /sampleTerrainMostDetailed/);
}

test("picking examples guard synchronous results before use", () => {
  assertGuardedExamples(sceneSource);
});

test("picking docs and warning describe asynchronous-readback limits", () => {
  assertWebGpuGuidance(sceneSource, rayHelpersSource);
});

test("controls reject the old unguarded examples", () => {
  const mutatedSample = sceneSource.replace(
    "if (Cesium.defined(height)) {\n   *     console.log(height);\n   * }",
    "console.log(height);",
  );
  assert.notEqual(
    mutatedSample,
    sceneSource,
    "sample control mutation must apply",
  );
  assert.throws(() => assertGuardedExamples(mutatedSample));

  const mutatedClamp = sceneSource.replace(
    "entity.position = clampedPosition;",
    "entity.position = viewer.scene.clampToHeight(position);",
  );
  assert.notEqual(
    mutatedClamp,
    sceneSource,
    "clamp control mutation must apply",
  );
  assert.throws(() => assertGuardedExamples(mutatedClamp));
});

test("controls reject both forms of old MostDetailed guidance", () => {
  const mutatedScene = `${sceneSource}\n* {@link Scene#sampleHeightMostDetailed} variant is always supported.`;
  assert.throws(() => assertWebGpuGuidance(mutatedScene, rayHelpersSource));

  const mutatedSupportClaim = sceneSource.replace(
    "if the synchronous {@link Scene#sampleHeight}\n   * function is supported. This property does not indicate support for\n   * {@link Scene#sampleHeightMostDetailed}.",
    "if the {@link Scene#sampleHeight} and {@link Scene#sampleHeightMostDetailed} functions are supported.",
  );
  assert.notEqual(
    mutatedSupportClaim,
    sceneSource,
    "support-claim control mutation must apply",
  );
  assert.throws(() =>
    assertWebGpuGuidance(mutatedSupportClaim, rayHelpersSource),
  );

  const mutatedHelpers = `${rayHelpersSource}\nuse the *MostDetailed async variants`;
  assert.throws(() => assertWebGpuGuidance(sceneSource, mutatedHelpers));

  // Controls for the two Batch-1482 assertions: re-introducing either retired
  // claim must be rejected, so the guard is pinned against a revert and not
  // merely against absence.
  const revivedHelperClaim = [
    rayHelpersSource,
    "*MostDetailed picking variants are also unsupported on this backend",
  ].join(String.fromCharCode(10));
  assert.throws(() => assertWebGpuGuidance(sceneSource, revivedHelperClaim));

  const revivedSceneClaim = sceneSource.replace(
    "{@link Scene#sampleHeightMostDetailedSupported} reports that separately.",
    "and is unsupported on asynchronous-readback backends.",
  );
  assert.notEqual(
    revivedSceneClaim,
    sceneSource,
    "scene support-doc control mutation must apply",
  );
  assert.throws(() =>
    assertWebGpuGuidance(revivedSceneClaim, rayHelpersSource),
  );
});
