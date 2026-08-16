/**
 * upstream-regression-check.mjs — NEW-UPSTREAM-IMAGERYLAYERS-EMPTY-GUARD +
 * NEW-FORK-MODERNIZATION-REGRESSIONS verification (Batch 232; extended Batch 299
 * with checks 6-8 for the Phase-9 upstream pulls #13366/#13421/#13369).
 * @purpose Standalone Node re-verification of eight ported upstream fixes (imagery-layers guard, parseUrl, octDecode arg order, etc.); exit 0 = all hold.
 * @status ACTIVE
 *
 * Standalone Node check (no browser, no build needed — imports engine source
 * directly) that exercises the four items from
 * migration_doc/FORK_DRIFT_ANALYSIS_2026-06-11.md §1-P1 + §2 against
 * upstream-expected outputs:
 *
 *   1. ModelRuntimePrimitive imagery guard — an EMPTY model.imageryLayers
 *      array must NOT push ImageryPipelineStage (upstream post-v1.142 fix,
 *      ported in Batch 232); a non-empty array must.
 *   2. Resource.parseUrl — the two Session-35 regressions stay fixed:
 *      subpath-base relative resolution (BUG-35.1) and data:/blob: URI
 *      verbatim preservation (BUG-35.2), plus query preservation.
 *   3. TimeIntervalCollection.contains — matches upstream
 *      `indexOf(date) >= 0` semantics (BUG-WEBGL-TIMEINTERVAL-CONTAINS-STALE
 *      stays fixed).
 *   4. Animation.js themeEle.innerHTML — the string-continuation lines are
 *      flush-left so the joined literal has ZERO inter-element text nodes
 *      (the childNodes[0..7] indexing depends on it). Verified by simulating
 *      JS line-continuation join on the actual source literal and comparing
 *      to upstream's exact string.
 *   5. ModelReader.octDecode — upstream #13433 (ported Batch 238) fixed the
 *      argument order of `AttributeCompression.octDecodeInRange` (signature
 *      is `(x, y, rangeMax, result)`; was called `(cart3, range, cart3)` —
 *      threw "result is required") and `Cartesian3.pack` (signature is
 *      `(value, array, index)`; args were swapped). Verified by an
 *      encode→decode round-trip over known unit vectors.
 *
 * Run: node Tools/upstream-regression-check.mjs   (exit 0 = all pass)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { default: ModelRuntimePrimitive } = await import(
  `file://${join(root, "packages/engine/Source/Scene/Model/ModelRuntimePrimitive.js")}`
);
const { default: ImageryPipelineStage } = await import(
  `file://${join(root, "packages/engine/Source/Scene/Model/ImageryPipelineStage.js")}`
);
const { default: ModelType } = await import(
  `file://${join(root, "packages/engine/Source/Scene/Model/ModelType.js")}`
);
const { default: SceneMode } = await import(
  `file://${join(root, "packages/engine/Source/Scene/SceneMode.js")}`
);
const { default: Resource } = await import(
  `file://${join(root, "packages/engine/Source/Core/Resource.js")}`
);
const { default: TimeIntervalCollection } = await import(
  `file://${join(root, "packages/engine/Source/Core/TimeIntervalCollection.js")}`
);
const { default: TimeInterval } = await import(
  `file://${join(root, "packages/engine/Source/Core/TimeInterval.js")}`
);
const { default: JulianDate } = await import(
  `file://${join(root, "packages/engine/Source/Core/JulianDate.js")}`
);

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. ModelRuntimePrimitive imagery-layers empty-array guard
// ---------------------------------------------------------------------------
console.log("\n[1] ModelRuntimePrimitive imagery-layers guard");
{
  const mockPrimitive = { featureIds: [], attributes: [] };
  const mockFrameState = {
    context: { webgl2: true },
    mode: SceneMode.SCENE3D,
    scene3DOnly: false,
    verticalExaggeration: 1.0,
  };
  function stagesFor(imageryLayers) {
    const prim = new ModelRuntimePrimitive({
      primitive: mockPrimitive,
      node: {},
      model: { type: ModelType.GLTF, allowPicking: false, imageryLayers },
    });
    prim.configurePipeline(mockFrameState);
    return prim.pipelineStages;
  }
  check(
    "empty imageryLayers array does NOT add ImageryPipelineStage",
    stagesFor([]).includes(ImageryPipelineStage),
    false,
  );
  check(
    "undefined imageryLayers does NOT add ImageryPipelineStage",
    stagesFor(undefined).includes(ImageryPipelineStage),
    false,
  );
  check(
    "non-empty imageryLayers DOES add ImageryPipelineStage",
    stagesFor([{}]).includes(ImageryPipelineStage),
    true,
  );
}

// ---------------------------------------------------------------------------
// 2. Resource.parseUrl — Session 35 regressions stay fixed
// ---------------------------------------------------------------------------
console.log("\n[2] Resource.parseUrl upstream-equivalent behavior");
{
  // BUG-35.1 — relative URL against a subpath base must keep the base's path
  const base = new Resource({ url: "http://host.invalid/Build/Cesium/" });
  const derived = base.getDerivedResource({
    url: "Assets/approximateTerrainHeights.json",
  });
  check(
    "subpath base preserved for relative derived resource (BUG-35.1)",
    derived.url,
    "http://host.invalid/Build/Cesium/Assets/approximateTerrainHeights.json",
  );

  // BUG-35.2 — data URIs stored verbatim (no "null" origin corruption)
  const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  check(
    "data URI preserved verbatim (BUG-35.2)",
    new Resource({ url: dataUri }).url,
    dataUri,
  );

  // BUG-35.2 — blob URIs stored verbatim
  const blobUri = "blob:http://host.invalid/d9f9bc6b-1234-4f4f-aaaa-bbbbcccc";
  check(
    "blob URI preserved verbatim (BUG-35.2)",
    new Resource({ url: blobUri }).url,
    blobUri,
  );

  // Query preservation round-trip
  check(
    "query string preserved through parse + getUrlComponent",
    new Resource({ url: "http://host.invalid/path?a=1&b=2" }).getUrlComponent(
      true,
    ),
    "http://host.invalid/path?a=1&b=2",
  );

  // Batch 237 fix — protocol-relative URLs must keep their authority
  // (upstream urijs `uri.toString()`; was regressed to "/" — caught by
  // ArcGisMapServerImageryProviderSpec "fromUrl resolves with created
  // provider with Resource parameter").
  check(
    "protocol-relative URL keeps its authority (Batch 237)",
    new Resource({ url: "//tiledArcGisMapServer.invalid/" }).url,
    "//tiledArcGisMapServer.invalid/",
  );
  check(
    "protocol-relative URL with path + query (Batch 237)",
    new Resource({ url: "//host.invalid/a/b?q=1" }).url,
    "//host.invalid/a/b?q=1",
  );

  // Batch 237 fix — bare-relative URLs must NOT gain a leading slash
  // (upstream keeps "Assets/foo.json" verbatim; "/Assets/foo.json" silently
  // re-roots the fetch against the document origin).
  check(
    "bare-relative URL stays relative (Batch 237)",
    new Resource({ url: "Assets/foo.json" }).url,
    "Assets/foo.json",
  );
  check(
    "fragment stripped, relative form kept (Batch 237)",
    new Resource({ url: "a/b#frag" }).url,
    "a/b",
  );
}

// ---------------------------------------------------------------------------
// 3. TimeIntervalCollection.contains — upstream indexOf semantics
// ---------------------------------------------------------------------------
console.log("\n[3] TimeIntervalCollection.contains upstream semantics");
{
  const start = JulianDate.fromIso8601("2026-01-01T00:00:00Z");
  const stop = JulianDate.fromIso8601("2026-01-02T00:00:00Z");
  const inside = JulianDate.fromIso8601("2026-01-01T12:00:00Z");
  const after = JulianDate.fromIso8601("2026-01-03T00:00:00Z");

  const collection = new TimeIntervalCollection([
    new TimeInterval({ start, stop }),
  ]);
  check("date inside interval -> true", collection.contains(inside), true);
  check("date outside interval -> false", collection.contains(after), false);
  check("interval start (inclusive) -> true", collection.contains(start), true);
  check(
    "empty collection -> false",
    new TimeIntervalCollection().contains(inside),
    false,
  );
}

// ---------------------------------------------------------------------------
// 4. Animation.js themeEle.innerHTML — flush-left continuations, no text nodes
// ---------------------------------------------------------------------------
console.log("\n[4] Animation.js themeEle.innerHTML flush-left literal");
{
  const source = readFileSync(
    join(root, "packages/widgets/Source/Animation/Animation.js"),
    "utf8",
  );
  const marker = "themeEle.innerHTML =";
  const idx = source.indexOf(marker);
  check("themeEle.innerHTML assignment found", idx >= 0, true);
  const open = source.indexOf("'", idx);
  const close = source.indexOf("';", open);
  const rawLiteral = source.slice(open + 1, close);
  // Simulate JS string line-continuation: backslash-newline disappears.
  const joined = rawLiteral.replace(/\\\r?\n/g, "");

  const themeNames = [
    "themeNormal",
    "themeHover",
    "themeSelect",
    "themeDisabled",
    "themeKnob",
    "themePointer",
    "themeSwoosh",
    "themeSwooshHover",
  ];
  const expected = themeNames
    .map((n) => `<div class="cesium-animation-${n}"></div>`)
    .join("");
  check(
    "joined literal is byte-identical to upstream (zero inter-element text)",
    joined,
    expected,
  );
  check(
    "no whitespace between elements (childNodes[0..7] are all Elements)",
    /\s/.test(joined.replace(/ class="/g, 'class="')),
    false,
  );
}

// ---------------------------------------------------------------------------
// 5. ModelReader.octDecode — #13433 argument-order fix (Batch 238)
// ---------------------------------------------------------------------------
console.log("\n[5] ModelReader.octDecode round-trip (#13433 arg order)");
{
  const { default: AttributeCompression } = await import(
    `file://${join(root, "packages/engine/Source/Core/AttributeCompression.js")}`
  );
  const { default: Cartesian3 } = await import(
    `file://${join(root, "packages/engine/Source/Core/Cartesian3.js")}`
  );
  const { default: ModelReader } = await import(
    `file://${join(root, "packages/engine/Source/Scene/Model/ModelReader.js")}`
  );

  const vectors = [
    new Cartesian3(1, 0, 0),
    new Cartesian3(0, 1, 0),
    new Cartesian3(0, 0, 1),
    Cartesian3.normalize(new Cartesian3(1, 2, 3), new Cartesian3()),
    Cartesian3.normalize(new Cartesian3(-1, -1, 1), new Cartesian3()),
    Cartesian3.normalize(new Cartesian3(0.3, -0.9, -0.4), new Cartesian3()),
  ];
  const range = 65535;
  const encoded = new Float32Array(vectors.length * 3);
  const scratch2 = { x: 0, y: 0 };
  for (let i = 0; i < vectors.length; i++) {
    AttributeCompression.octEncodeInRange(vectors[i], range, scratch2);
    encoded[i * 3] = scratch2.x;
    encoded[i * 3 + 1] = scratch2.y;
  }
  let threw = false;
  let maxErr = Infinity;
  let wrotePack = false;
  try {
    const decoded = ModelReader.octDecode(
      encoded,
      vectors.length,
      range,
      undefined,
    );
    maxErr = 0;
    for (let i = 0; i < vectors.length; i++) {
      const d = new Cartesian3(
        decoded[i * 3],
        decoded[i * 3 + 1],
        decoded[i * 3 + 2],
      );
      maxErr = Math.max(maxErr, Cartesian3.distance(d, vectors[i]));
    }
    // Cartesian3.pack arg-order regression guard: output must actually be
    // populated (wrong order writes into the scratch Cartesian3 instead).
    wrotePack = decoded.some((v) => v !== 0);
  } catch (e) {
    threw = true;
  }
  check("octDecodeInRange call does not throw", threw, false);
  check("round-trip error < 1e-4", maxErr < 1e-4, true);
  check("Cartesian3.pack wrote the output array", wrotePack, true);
}

// ---------------------------------------------------------------------------
// 6. Ground-primitive batch showsUpdated cleanup — #13366 (Batch 299)
//    Removing an updater must also clear it from showsUpdated, otherwise the
//    next batch update dereferences a stale entry. Source-text guard: both
//    StaticGround*PerMaterialBatch.remove() bodies must call
//    `this.showsUpdated.remove(id)` next to `this.subscriptions.remove(id)`.
// ---------------------------------------------------------------------------
console.log("\n[6] Ground-primitive batch showsUpdated cleanup (#13366)");
{
  for (const file of [
    "packages/engine/Source/DataSources/StaticGroundGeometryPerMaterialBatch.js",
    "packages/engine/Source/DataSources/StaticGroundPolylinePerMaterialBatch.js",
  ]) {
    const src = readFileSync(join(root, file), "utf8");
    // The cleanup must appear inside the unsubscribe block (right after
    // subscriptions.remove(id)).
    const hasCleanup =
      /this\.subscriptions\.remove\(id\);\s*\n\s*this\.showsUpdated\.remove\(id\);/.test(
        src,
      );
    check(
      `${file.split("/").pop()} clears showsUpdated on remove`,
      hasCleanup,
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// 7. EdgeVisibility degenerate-triangle guard — #13421 (Batch 299)
//    Zero-area triangles produce a zero-length cross product; normalizing it
//    threw DeveloperError. The fix guards on magnitudeSquared and skips the
//    triangle. Source-text guard: the face-normal computation must check the
//    cross magnitude before normalizing.
// ---------------------------------------------------------------------------
console.log("\n[7] EdgeVisibility degenerate-triangle guard (#13421)");
{
  const src = readFileSync(
    join(
      root,
      "packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js",
    ),
    "utf8",
  );
  const hasMagCheck =
    /crossMagnitudeSquared\s*===\s*0\.0\s*\|\|\s*!Number\.isFinite\(\s*crossMagnitudeSquared\s*\)/.test(
      src,
    );
  // The unguarded Cartesian3.normalize(scratchCross,...) must be gone from the
  // face-normal loop (replaced by multiplyByScalar(1/sqrt(magSq))).
  const usesScaledNormalize =
    /Cartesian3\.multiplyByScalar\(\s*scratchCross,\s*\n?\s*1\.0\s*\/\s*Math\.sqrt\(crossMagnitudeSquared\)/.test(
      src,
    );
  check("face-normal loop guards on cross magnitude", hasMagCheck, true);
  check(
    "face-normal loop normalizes via 1/sqrt(magSq)",
    usesScaledNormalize,
    true,
  );
}

// ---------------------------------------------------------------------------
// 8. EquirectangularPanorama flat shading — #13369 (Batch 299)
//    The panorama appearance must use flat:true so scene lighting does not
//    darken the equirectangular image.
// ---------------------------------------------------------------------------
console.log("\n[8] EquirectangularPanorama flat shading (#13369)");
{
  const src = readFileSync(
    join(root, "packages/engine/Source/Scene/EquirectangularPanorama.js"),
    "utf8",
  );
  const hasFlat =
    /new MaterialAppearance\(\{[\s\S]*?flat:\s*true[\s\S]*?\}\)/.test(src);
  check("panorama MaterialAppearance uses flat:true", hasFlat, true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
