// globe-night-imagery-option.spec.mjs
// @purpose Pins the night-imagery option: default on, never injected into an application-managed imagery stack, off is upstream, and the bundled pyramid's level range is the one its provider will derive.
// @status ACTIVE
//
// THE BEHAVIOUR, STATED WITHOUT REFERENCE TO ANY IMPLEMENTATION SHAPE.
//
//   A globe that built its own default imagery stack blends a night layer past
//   the terminator without being asked. A globe whose stack came from the
//   application does not — not until the application asks by name. Turning the
//   option off leaves the stack exactly as upstream builds it.
//
// The three bounds are not decoration; each is a way the default can go wrong:
//
//   • OFF IS UPSTREAM. No layer, no define, no flag. A default-on feature that
//     cannot be fully turned off is a fork of the library, not an option on it.
//   • NO INJECTION. An application that supplies its own base layer, or builds
//     the stack itself, has made a decision about what is on its globe. A layer
//     appearing in that stack is a bug however good it looks.
//   • BOTH BACKENDS. The layer's whole mechanism is the day/night alpha pair,
//     which both backends already read; the pair is what raises WebGL's define
//     and WebGPU's per-tile flag. A layer configured with unit alphas would be
//     silently invisible on both.
//
// WHAT THIS SPEC IS FOR. The decision logic is a leaf module with no rendering
// dependencies, so this spec IMPORTS AND RUNS it over the whole state space
// rather than reading it. What cannot be imported without a build — Globe and
// the widget, which pull the shader modules — is pinned structurally, and the
// bundled asset is checked against the file system rather than against prose.
//
// A NOTE ON MUTANTS. Section F mutates the leaf ON DISK and re-imports it, so
// the mutant is the module the runtime would load rather than a string. Every
// mutation restores from the original bytes in a `finally` and asserts the
// SHA-256 matches, and the last test re-checks the digest independently.
//
// LINE ENDINGS: this repo checks out CRLF. Every source read is normalised to
// `\n` first — a spec anchored on a bare `\n` false-greens on a CRLF checkout.
//
// Run: node --test Tools/visual-regression/globe-night-imagery-option.spec.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BUNDLED_NIGHT_IMAGERY_PATH,
  NIGHT_DARKNESS_DEFAULT,
  NIGHT_DARKNESS_IDENTITY,
  NIGHT_IMAGERY_LAYER_OPTIONS,
  NightImagerySource,
  nightImageryAction,
  nightImageryIsArmed,
  resolveNightDarkness,
  resolveNightImageryRequest,
} from "../../packages/engine/Source/Scene/GlobeNightImagery.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

const LEAF_PATH = "packages/engine/Source/Scene/GlobeNightImagery.js";
const GLOBE_PATH = "packages/engine/Source/Scene/Globe.js";
const WIDGET_PATH = "packages/engine/Source/Widget/CesiumWidget.js";
const VIEWER_PATH = "packages/widgets/Source/Viewer/Viewer.js";
const TMS_PROVIDER_PATH =
  "packages/engine/Source/Scene/TileMapServiceImageryProvider.js";
const TILE_RENDERING_PATH =
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js";
const TILE_UB_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts";
const ASSET_DIR = `packages/engine/Source/Assets/Textures/${BUNDLED_NIGHT_IMAGERY_PATH.replace(
  "Assets/Textures/",
  "",
)}`;
const NE2_DIR = "packages/engine/Source/Assets/Textures/NaturalEarthII";

const leafAbsolute = path.join(root, LEAF_PATH);
const leafOriginal = fs.readFileSync(leafAbsolute);
const leafOriginalHash = sha256(leafOriginal);

const globe = read(GLOBE_PATH);
const widget = read(WIDGET_PATH);
const viewer = read(VIEWER_PATH);
const tmsProvider = read(TMS_PROVIDER_PATH);
const tileRendering = read(TILE_RENDERING_PATH);
const tileUb = read(TILE_UB_PATH);

const OFF = Object.freeze({
  source: NightImagerySource.NONE,
  provider: undefined,
});

// ─── A. the decision logic, executed over its whole state space ──────────────

test("A1: the default is on where the globe owns the default imagery stack", () => {
  const armed = nightImageryIsArmed({
    ownsDefaultImageryStack: true,
    explicitlyRequested: false,
  });
  assert.equal(armed, true);
  assert.deepEqual(resolveNightImageryRequest(true, armed), {
    source: NightImagerySource.BUNDLED,
    provider: undefined,
  });
});

test("A2: NO INJECTION — an application-managed stack gets nothing by default", () => {
  // The bound, as a decision rather than a description. The property still
  // reads `true`; what the globe does with it is the question.
  const armed = nightImageryIsArmed({
    ownsDefaultImageryStack: false,
    explicitlyRequested: false,
  });
  assert.equal(armed, false);
  assert.deepEqual(resolveNightImageryRequest(true, armed), OFF);
  assert.equal(
    nightImageryAction(OFF, resolveNightImageryRequest(true, armed)),
    "none",
  );
});

test("A3: an explicit assignment is a request, and arms either stack", () => {
  for (const owns of [false, true]) {
    const armed = nightImageryIsArmed({
      ownsDefaultImageryStack: owns,
      explicitlyRequested: true,
    });
    assert.equal(armed, true, `explicit request must arm (owns=${owns})`);
  }
});

test("A4: OFF IS UPSTREAM — false, null and undefined all resolve to nothing", () => {
  for (const value of [false, null, undefined]) {
    for (const armed of [false, true]) {
      assert.deepEqual(
        resolveNightImageryRequest(value, armed),
        OFF,
        `${String(value)} must attach nothing (armed=${armed})`,
      );
    }
  }
});

test("A5: a supplied provider or promise is carried through by identity", () => {
  const provider = { name: "an imagery provider" };
  const promise = Promise.resolve(provider);
  assert.deepEqual(resolveNightImageryRequest(provider, true), {
    source: NightImagerySource.PROVIDED,
    provider,
  });
  assert.deepEqual(resolveNightImageryRequest(promise, true), {
    source: NightImagerySource.PROVIDED,
    provider: promise,
  });
});

test("A6: the action machine neither churns a layer nor leaks one", () => {
  const p1 = { id: 1 };
  const p2 = { id: 2 };
  const bundled = { source: NightImagerySource.BUNDLED, provider: undefined };
  const provided1 = { source: NightImagerySource.PROVIDED, provider: p1 };
  const provided2 = { source: NightImagerySource.PROVIDED, provider: p2 };

  // Steady states cost nothing. Called every frame, this is the common case.
  assert.equal(nightImageryAction(OFF, OFF), "none");
  assert.equal(nightImageryAction(bundled, bundled), "none");
  assert.equal(
    nightImageryAction(provided1, { ...provided1 }),
    "none",
    "the same provider must not rebuild the layer every frame",
  );

  // Transitions each do exactly one thing.
  assert.equal(nightImageryAction(OFF, bundled), "attach");
  assert.equal(nightImageryAction(bundled, OFF), "detach");
  assert.equal(nightImageryAction(bundled, provided1), "replace");
  assert.equal(nightImageryAction(provided1, bundled), "replace");
  assert.equal(
    nightImageryAction(provided1, provided2),
    "replace",
    "a different provider is a different layer, not the same one",
  );
});

test("A7: every state pair yields exactly one of the four actions", () => {
  // Exhaustive over a representative state set: 5 x 5 = 25 pairs, and no pair
  // may fall through to something the caller does not handle.
  const states = [
    OFF,
    { source: NightImagerySource.BUNDLED, provider: undefined },
    { source: NightImagerySource.PROVIDED, provider: { id: "a" } },
    { source: NightImagerySource.PROVIDED, provider: { id: "b" } },
    { source: NightImagerySource.PROVIDED, provider: undefined },
  ];
  const allowed = new Set(["none", "attach", "detach", "replace"]);
  for (const current of states) {
    for (const requested of states) {
      const action = nightImageryAction(current, requested);
      assert.ok(allowed.has(action), `unhandled action ${action}`);
      // An attach may only happen from nothing, and a detach only to nothing.
      // Anything else is a second layer or an orphan.
      if (action === "attach") {
        assert.equal(current.source, NightImagerySource.NONE);
      }
      if (action === "detach") {
        assert.equal(requested.source, NightImagerySource.NONE);
      }
    }
  }
});

// ─── B. the layer configuration is what raises BOTH backends' gate ───────────

test("B1: the layer is absent in daylight and covering past the terminator", () => {
  assert.equal(NIGHT_IMAGERY_LAYER_OPTIONS.dayAlpha, 0.0);
  assert.equal(NIGHT_IMAGERY_LAYER_OPTIONS.nightAlpha, 1.0);
  assert.ok(
    Object.isFrozen(NIGHT_IMAGERY_LAYER_OPTIONS),
    "the options object is handed to every layer this globe builds; a caller " +
      "mutating it would reconfigure layers it does not own",
  );
});

test("B2: those values are exactly what turns the day/night ramp on", () => {
  // Both backends raise their gate from the resolved per-layer alphas, and the
  // condition is "away from 1.0" on either member. A night layer configured
  // with unit alphas would be invisible on both backends at zero cost — the
  // failure this pin exists for.
  const asksForDayNight = (layer) =>
    layer.dayAlpha !== 1.0 || layer.nightAlpha !== 1.0;
  assert.equal(asksForDayNight(NIGHT_IMAGERY_LAYER_OPTIONS), true);
  assert.equal(asksForDayNight({ dayAlpha: 1.0, nightAlpha: 1.0 }), false);

  // And that condition is the one the engine actually derives, on both sides.
  assert.match(
    tileRendering,
    /applyDayNightAlpha =\s*applyDayNightAlpha \|\|\s*uniformMapProperties\.dayTextureDayAlpha\[numberOfDayTextures\] !== 1\.0;/,
  );
  assert.match(
    tileUb,
    /if \(data\[dnFloatBase \+ 0\] !== 1\.0 \|\| data\[dnFloatBase \+ 1\] !== 1\.0\) \{/,
  );
});

// ─── C. the bundled pyramid, checked against the file system ─────────────────

/** `<TileSet ... order="N"/>` orders, in document order. */
function tileSetOrders(xml) {
  return [...xml.matchAll(/<TileSet\s[^>]*order="(\d+)"/g)].map((m) =>
    Number(m[1]),
  );
}

test("C1: the option's path is where the asset actually is", () => {
  const dir = path.join(root, ASSET_DIR);
  assert.ok(fs.existsSync(dir), `${ASSET_DIR} does not exist`);
  assert.ok(fs.existsSync(path.join(dir, "tilemapresource.xml")));
  assert.equal(BUNDLED_NIGHT_IMAGERY_PATH, "Assets/Textures/BlackMarble");
});

test("C2: the declared level range is the range that is on disk", () => {
  // The provider derives its maximumLevel from the LAST declared tileset order
  // (C4 pins that dependency). If the declaration reached past the tiles, the
  // globe would request 404s at every zoom beyond the pyramid.
  const xml = read(`${ASSET_DIR}/tilemapresource.xml`);
  const orders = tileSetOrders(xml);
  const levelsOnDisk = fs
    .readdirSync(path.join(root, ASSET_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b);
  assert.deepEqual(orders, levelsOnDisk, "declared levels vs levels on disk");
  // Levels 0-3 since the level-three bake ratified by R-2026-08-28-8 (Batch
  // 1244): 170 tiles at 455 KB of JPEG payload, inside the ruled gate.
  assert.deepEqual(orders, [0, 1, 2, 3]);
});

test("C3: every tile the geodetic grid implies exists, and nothing else does", () => {
  // Level L of a 2:1 geodetic scheme is 2^(L+1) columns by 2^L rows, y up.
  let total = 0;
  for (const level of [0, 1, 2, 3]) {
    const columns = 2 ** (level + 1);
    const rows = 2 ** level;
    const dir = path.join(root, ASSET_DIR, String(level));
    const found = new Set();
    for (const x of fs.readdirSync(dir)) {
      for (const file of fs.readdirSync(path.join(dir, x))) {
        found.add(`${x}/${file}`);
      }
    }
    for (let x = 0; x < columns; x++) {
      for (let y = 0; y < rows; y++) {
        assert.ok(
          found.has(`${x}/${y}.jpg`),
          `level ${level} is missing tile ${x}/${y}.jpg`,
        );
      }
    }
    assert.equal(
      found.size,
      columns * rows,
      `level ${level} carries tiles the grid does not name`,
    );
    total += found.size;
  }
  assert.equal(total, 170, "the pyramid is 170 tiles (levels 0-3)");
});

test("C4: the pyramid is the Natural Earth II layout, tile for tile", () => {
  // The layout is not incidental: it is why an unmodified
  // TileMapServiceImageryProvider over buildModuleUrl reads this asset at all.
  const night = read(`${ASSET_DIR}/tilemapresource.xml`);
  const day = read(`${NE2_DIR}/tilemapresource.xml`);
  const shape = (xml) => ({
    srs: /<SRS>([^<]*)<\/SRS>/.exec(xml)?.[1],
    profile: /<TileSets profile="([^"]*)"/.exec(xml)?.[1],
    format: /<TileFormat ([^/]*)\/>/.exec(xml)?.[1],
    bbox: /<BoundingBox ([^/]*)\/>/.exec(xml)?.[1],
    origin: /<Origin ([^/]*)\/>/.exec(xml)?.[1],
    orders: tileSetOrders(xml),
  });
  assert.deepEqual(shape(night), shape(day));
});

test("C5: the provider derives its maximumLevel from that last order", () => {
  // A dependency on upstream behaviour, pinned so it fails loudly rather than
  // turning into 404s at zoom. No explicit maximumLevel is passed precisely
  // because this derivation exists and C2 keeps the declaration honest.
  assert.match(
    tmsProvider,
    /const maximumLevel =\s*options\.maximumLevel \?\?\s*parseInt\(tilesetsList\[tilesetsList\.length - 1\]\.getAttribute\("order"\), 10\);/,
  );
});

// ─── D. the wiring, where the module cannot be imported without a build ──────

test("D1: the widget marks the default stack, and only there", () => {
  assert.equal(markIsGuardedByTheDefaultPath(widget), true);
  assert.equal(defaultPathDerivationIsLive(widget), true);
});

test("D2: the widget forwards its option, and the viewer forwards the widget's", () => {
  assert.match(
    widget,
    /if \(options\.globe !== false && defined\(options\.nightImagery\)\) \{\s*globe\.nightImagery = options\.nightImagery;\s*\}/,
  );
  assert.match(viewer, /nightImagery: options\.nightImagery,/);
  assert.match(
    viewer,
    /@property \{boolean\|ImageryProvider\|Promise<ImageryProvider>\} \[nightImagery=true\]/,
  );
});

test("D3: assignment records the explicit request", () => {
  // Without this the escape hatch in A3 does not exist and an application with
  // its own base layer could not opt in at all.
  assert.match(
    globe,
    /set nightImagery\(value\) \{\s*this\._nightImageryExplicit = true;\s*this\._nightImagery = value;\s*\}/,
  );
});

test("D4: the globe reconciles once per frame and hands off its own state", () => {
  assert.match(
    globe,
    /beginFrame\(frameState\) \{[\s\S]{0,200}?reconcileNightImagery\(this\);/,
  );
  assert.match(
    globe,
    /const action = nightImageryAction\(globe\._nightImageryState, requested\);/,
  );
  assert.match(globe, /globe\._nightImageryState = requested;/);
});

test("D5: the bundled arm builds the provider over the bundled path", () => {
  assert.match(
    globe,
    /TileMapServiceImageryProvider\.fromUrl\(\s*buildModuleUrl\(BUNDLED_NIGHT_IMAGERY_PATH\),\s*\)/,
  );
  assert.match(
    globe,
    /ImageryLayer\.fromProviderAsync\(\s*provider,\s*NIGHT_IMAGERY_LAYER_OPTIONS,\s*\)/,
  );
  assert.match(globe, /globe\._imageryLayerCollection\.add\(layer\);/);
});

test("D6: the layer leaves with the globe, and is never destroyed twice", () => {
  // The imagery collection outlives the globe, so a layer left behind is a
  // leak; an application is also free to remove the layer itself, which
  // destroys it, and a second destroy throws.
  assert.match(
    globe,
    /destroy\(\) \{[\s\S]{0,300}?detachNightImageryLayer\(this\);/,
  );
  assert.match(
    globe,
    /!globe\._imageryLayerCollection\.remove\(layer, true\) &&\s*!layer\.isDestroyed\(\)/,
  );
});

// ─── E. the off path adds nothing anywhere ───────────────────────────────────

test("E1: with the option off no layer exists, so neither backend's gate rises", () => {
  const request = resolveNightImageryRequest(false, true);
  assert.deepEqual(request, OFF);
  assert.equal(nightImageryAction(OFF, request), "none");
  // A stack with no night layer carries only unit alphas, and the condition
  // both backends derive is false for it — which is what "off is upstream"
  // means in terms the renderers can be held to.
  const stack = [
    { dayAlpha: 1.0, nightAlpha: 1.0 },
    { dayAlpha: 1.0, nightAlpha: 1.0 },
  ];
  assert.equal(
    stack.some((l) => l.dayAlpha !== 1.0 || l.nightAlpha !== 1.0),
    false,
  );
});

test("E2: off is upstream in the OTHER term the night appearance owns", () => {
  // The layer is one of two things this option now switches off. The
  // procedural night-darkening fallback ships a darkening default, so an
  // unassigned floor on a globe that never declined the fork's night
  // appearance darkens — and "off is upstream" would be a false claim if this
  // option did not take that default back with it.
  //
  // The floor is the whole of it: 1.0 is the multiplicative identity, so a
  // globe resolving to it renders what upstream renders, and 0.15 does not.
  assert.equal(
    resolveNightDarkness(NIGHT_DARKNESS_DEFAULT, false, false),
    NIGHT_DARKNESS_IDENTITY,
    "switching night imagery off must give the identity floor back",
  );
  assert.equal(
    resolveNightDarkness(NIGHT_DARKNESS_DEFAULT, false, true),
    NIGHT_DARKNESS_DEFAULT,
    "and must not be the answer for a globe that never declined it",
  );
  // The two halves of the same option: every value that makes this row's own
  // resolver attach nothing must also give the identity floor back.
  for (const declined of [false, undefined, null]) {
    assert.deepEqual(resolveNightImageryRequest(declined, true), OFF);
    assert.equal(
      resolveNightDarkness(NIGHT_DARKNESS_DEFAULT, false, declined),
      NIGHT_DARKNESS_IDENTITY,
    );
  }
  assert.notEqual(
    NIGHT_DARKNESS_DEFAULT,
    NIGHT_DARKNESS_IDENTITY,
    "a default equal to the identity would make this test vacuous",
  );
});

// ─── F. MUTANTS — on disk, re-imported, restored by hash ─────────────────────

/**
 * Whether the one marking assignment is ENCLOSED by the default-base-layer
 * branch, established by brace-scanning the block it lives in rather than by
 * matching its text. Nearest-preceding-`if` would be satisfied by a marker
 * that merely FOLLOWS a closed branch, which is exactly what mutant F6 writes.
 */
function markIsGuardedByTheDefaultPath(source) {
  const marker = "globe.ownsDefaultImageryStack = true;";
  const index = source.indexOf(marker);
  if (index < 0 || source.indexOf(marker, index + 1) >= 0) {
    return false;
  }
  const start = source.lastIndexOf("// Set the base imagery layer", index);
  if (start < 0) {
    return false;
  }
  // The region is a dozen brace-clean lines, so a character scan is exact here
  // without needing to know anything about strings or comments.
  const open = [];
  for (const line of source.slice(start, index).split("\n")) {
    for (const character of line) {
      if (character === "{") {
        open.push(line.trim());
      } else if (character === "}") {
        open.pop();
      }
    }
  }
  return open.includes("if (buildingDefaultBaseLayer) {");
}

function defaultPathDerivationIsLive(source) {
  return source.includes(
    "const buildingDefaultBaseLayer = !defined(baseLayer);",
  );
}

let mutantSerial = 0;

/**
 * Mutate the leaf on disk, import the mutated module, and restore the original
 * bytes. The restore is in a `finally` and is verified by digest, so a throw
 * inside the assertion cannot leave the tree dirty.
 */
async function withMutatedLeaf(from, to, assertion) {
  const text = leafOriginal.toString("utf8");
  assert.ok(
    text.includes(from),
    `mutation precondition failed: "${from.slice(0, 60)}..."`,
  );
  fs.writeFileSync(leafAbsolute, text.replace(from, to));
  try {
    mutantSerial += 1;
    const url = `${pathToFileURL(leafAbsolute).href}?mutant=${mutantSerial}`;
    assertion(await import(url));
  } finally {
    fs.writeFileSync(leafAbsolute, leafOriginal);
    assert.equal(
      sha256(fs.readFileSync(leafAbsolute)),
      leafOriginalHash,
      "the leaf was not restored byte-exactly",
    );
  }
}

/** The predicates, so the same functions judge the real module and the mutants. */
function armingIsLive(mod) {
  return (
    mod.nightImageryIsArmed({
      ownsDefaultImageryStack: false,
      explicitlyRequested: false,
    }) === false &&
    mod.nightImageryIsArmed({
      ownsDefaultImageryStack: true,
      explicitlyRequested: false,
    }) === true
  );
}
function resolveHonoursArming(mod) {
  return (
    mod.resolveNightImageryRequest(true, false).source ===
    mod.NightImagerySource.NONE
  );
}
function actionSeparatesProviders(mod) {
  const a = { source: mod.NightImagerySource.PROVIDED, provider: { id: 1 } };
  const b = { source: mod.NightImagerySource.PROVIDED, provider: { id: 2 } };
  return (
    mod.nightImageryAction(a, b) === "replace" &&
    mod.nightImageryAction(a, { ...a }) === "none"
  );
}
function layerOptionsRaiseTheGate(mod) {
  const o = mod.NIGHT_IMAGERY_LAYER_OPTIONS;
  return o.dayAlpha !== 1.0 || o.nightAlpha !== 1.0;
}

test("F1: ABSENCE — an arming check that always says yes is REJECTED", async () => {
  await withMutatedLeaf(
    "    options.ownsDefaultImageryStack === true ||",
    "    true ||",
    (mutant) => {
      assert.equal(
        armingIsLive(mutant),
        false,
        "without the bound, an application-managed stack gets a night layer",
      );
    },
  );
});

test("F2: INERTNESS — an arming flag that is passed but never read is REJECTED", async () => {
  // The shape a deletion mutant misses entirely: the parameter is still in the
  // signature, still supplied by the caller, and consulted by nothing.
  await withMutatedLeaf(
    "  if (isArmed !== true || value === false || !defined(value)) {",
    "  if (false || value === false || !defined(value)) {",
    (mutant) => {
      assert.equal(resolveHonoursArming(mutant), false);
    },
  );
});

test("F3: ABSENCE — an action machine that never replaces is REJECTED", async () => {
  await withMutatedLeaf('  return "replace";', '  return "none";', (mutant) => {
    assert.equal(
      actionSeparatesProviders(mutant),
      false,
      "a changed provider that produces no action leaves the old layer up",
    );
  });
});

test("F4: INERTNESS — an action machine blind to provider identity is REJECTED", async () => {
  await withMutatedLeaf(
    "    current.provider === requested.provider",
    "    (current.provider === requested.provider || true)",
    (mutant) => {
      assert.equal(actionSeparatesProviders(mutant), false);
    },
  );
});

test("F5: INERTNESS — a night layer with a unit day alpha is REJECTED", async () => {
  // Every symbol present, the layer built, added and rendered — and invisible,
  // because the pair that raises both backends' ramp is gone.
  await withMutatedLeaf("  dayAlpha: 0.0,", "  dayAlpha: 1.0,", (mutant) => {
    assert.equal(layerOptionsRaiseTheGate(mutant), false);
  });
});

test("F6: ABSENCE — a widget that marks the stack unconditionally is REJECTED", () => {
  const mutant = widget.replace(
    `      if (buildingDefaultBaseLayer) {
        globe.ownsDefaultImageryStack = true;
      }`,
    "      globe.ownsDefaultImageryStack = true;",
  );
  assert.notEqual(mutant, widget, "mutation precondition failed");
  assert.equal(markIsGuardedByTheDefaultPath(mutant), false);
});

test("F7: INERTNESS — a default-path flag that is always true is REJECTED", () => {
  const mutant = widget.replace(
    "const buildingDefaultBaseLayer = !defined(baseLayer);",
    "const buildingDefaultBaseLayer = true;",
  );
  assert.notEqual(mutant, widget, "mutation precondition failed");
  assert.equal(
    defaultPathDerivationIsLive(mutant),
    false,
    "an application-supplied base layer would then own a marked stack",
  );
});

test("F8: the mutants are DISCRIMINATING — the real module passes every predicate", async () => {
  const real = await import(pathToFileURL(leafAbsolute).href);
  assert.equal(armingIsLive(real), true);
  assert.equal(resolveHonoursArming(real), true);
  assert.equal(actionSeparatesProviders(real), true);
  assert.equal(layerOptionsRaiseTheGate(real), true);
  assert.equal(markIsGuardedByTheDefaultPath(widget), true);
  assert.equal(defaultPathDerivationIsLive(widget), true);
});

test("F9: the leaf is byte-identical to how the run found it", () => {
  assert.equal(sha256(fs.readFileSync(leafAbsolute)), leafOriginalHash);
});
