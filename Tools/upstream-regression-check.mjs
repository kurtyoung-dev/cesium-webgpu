/**
 * upstream-regression-check.mjs — NEW-UPSTREAM-IMAGERYLAYERS-EMPTY-GUARD +
 * NEW-FORK-MODERNIZATION-REGRESSIONS verification (Batch 232).
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
