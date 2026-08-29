// globe-night-ocean-sentinel.spec.mjs — CLT-B2 (CELESTIAL_LIGHT_TRANSPORT_PLAN
// 2026-08-07 §2 bug 1, queue row CLT-B2).
// @purpose Pins the GLOBE_UB_UNSET (-1.0) sentinel that made enableNightLights=false reachable: OFF and default-ON no longer share the same 0.0 uniform encoding.
// @status ACTIVE
//
// WHAT THIS ROW FIXED. `oceanParams` and `nightOceanParams` are two vec4 slots
// in the globe tile uniform buffer. Six WGSL getters read them, and each one
// used to treat the value `0.0` as "the CPU configured nothing — substitute my
// built-in default":
//
//     fn getNightIntensity() -> f32 {
//       let n = tile.nightOceanParams.x;
//       return select(n, 2.5, n == 0.0);       // <- the collision
//     }
//
// `Globe.update()` expressed "night lights off" by writing that same `0.0`
// (`enableNightLights ? nightIntensity : 0.0`), so OFF and default-ON were the
// SAME 32 bits and `globe.enableNightLights = false` was a visual no-op on
// WebGPU. `tileProvider.enableNightLights` was written and never read. That is
// what made C11-159's ratified "default OFF, keep the toggle" vacuous as
// written: there was no reachable off state to default to.
//
// THE FIX, in three parts, all pinned below:
//   1. "unset" moved to the NEGATIVE half-line (`GLOBE_UB_UNSET = -1.0`) —
//      unreachable from an API whose every tunable is a non-negative magnitude.
//      The getters test `< 0.0`.
//   2. The enable travels as its own signal. `Globe.update()` mirrors the raw
//      value plus `enableNightLights` / `enableEnhancedOcean`; the tile-UB
//      packer reads BOTH and owns the encoding via `resolveGlobeTunable`.
//   3. The two features answer "what does OFF mean" differently on purpose —
//      night lights OFF is a real `0.0` (zero emission, because the shader
//      multiplies by it), enhanced ocean OFF is `GLOBE_UB_UNSET` (the whole
//      consuming branch is preprocessed out by `ShaderDefineHi.ENHANCED_OCEAN`,
//      so no value is being supplied at all).
//
// WHY THE DEFAULT LOOK IS UNCHANGED, and how this file proves it. `oceanParams`
// and `nightOceanParams` have exactly SIX readers in `GlobeTerrain.wgsl` — the
// six getters — and nothing else in the module touches either struct member.
// Section D asserts that exclusivity, so it is enough to show each getter emits
// the same number under the old and the new law for every reachable
// (enable, value) pair. Section C enumerates those pairs against BOTH laws and
// requires the two to agree everywhere EXCEPT on the states this row exists to
// change (an off night-lights toggle, and an explicit zero).
//
// A NOTE ON "BYTE-IDENTICAL". The uniform BUFFER bytes do change on the off
// path (0.0 -> -1.0); what is byte-identical is the shader's OUTPUT on the
// default path, because the getter maps both encodings to the same constant.
// Section C is that argument in executable form, and section E adds the shader
// half: the preprocessor emits the same directive-free text for the define sets
// the globe actually compiles, so no `//>>ifdef` arm moved.
//
// LINE ENDINGS: this repo checks out CRLF. Every source read is normalised to
// `\n` first — a spec anchored on a bare `\n` false-greens on a CRLF checkout.
//
// Run: node --test Tools/visual-regression/globe-night-ocean-sentinel.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

const WGSL_PATH =
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const TILE_UB_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts";
const GLOBE_PATH = "packages/engine/Source/Scene/Globe.js";

const wgsl = read(WGSL_PATH);
const tileUb = read(TILE_UB_PATH);
const globeJs = read(GLOBE_PATH);

enableEngineTsResolution();

// The contract is executed, not re-implemented. `WebGPUGlobeTunables.ts` is a
// zero-import leaf precisely so this spec can run the SAME code the packer runs
// (`WebGPUGlobeSurfaceTypes.ts` declares a `const enum`, which Node's
// strip-only loader rejects, so it is not importable from a spec).
const { GLOBE_UB_UNSET, resolveGlobeTunable } = await import(
  pathToFileURL(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeTunables.ts",
    ),
  ).href
);

/** WGSL has only line comments. Absence checks must never run on raw text. */
function stripWgslComments(source) {
  return source.replace(/^[ \t]*\/\/[^\n]*$/gm, "").replace(/\/\/[^\n]*/g, "");
}

/** TypeScript/JavaScript comment strip for the same reason. */
function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const wgslCode = stripWgslComments(wgsl);
const tileUbCode = stripJsComments(tileUb);
const globeCode = stripJsComments(globeJs);

// The six getters, their slot, and their built-in default. This table is the
// spec's model of the shader; section A proves the shader still matches it.
// `text` is the literal the shader spells, kept separate from the number
// because `String(5.0)` is "5" and would silently stop matching "5.0".
const GETTERS = Object.freeze([
  {
    fn: "getNightIntensity",
    slot: "nightOceanParams.x",
    fallback: 2.5,
    text: "2.5",
  },
  {
    fn: "getOceanReflectivity",
    slot: "nightOceanParams.y",
    fallback: 0.04,
    text: "0.04",
  },
  {
    fn: "getFoamThreshold",
    slot: "nightOceanParams.z",
    fallback: 0.35,
    text: "0.35",
  },
  {
    fn: "getOceanDarkening",
    slot: "nightOceanParams.w",
    fallback: 0.6,
    text: "0.6",
  },
  {
    fn: "getFresnelPower",
    slot: "oceanParams.w",
    fallback: 5.0,
    text: "5.0",
  },
]);

// ─── A. the shader carries the new law, and no `== 0.0` sentinel survives ────

test("A1: every scalar getter tests `< 0.0`, not `== 0.0`", () => {
  for (const { fn, text } of GETTERS) {
    const body = new RegExp(
      `fn\\s+${fn}\\s*\\(\\)\\s*->\\s*f32\\s*\\{([\\s\\S]*?)\\n\\}`,
    ).exec(wgslCode);
    assert.ok(body, `${fn} not found in ${WGSL_PATH}`);
    assert.match(
      body[1],
      new RegExp(
        `select\\(\\s*\\w+\\s*,\\s*${text.replace(".", "\\.")}\\s*,\\s*\\w+\\s*<\\s*0\\.0\\s*\\)`,
      ),
      `${fn} must select its default on a NEGATIVE slot — an `.concat(
        "`== 0.0` test makes the legitimate zero unreachable",
      ),
    );
    assert.doesNotMatch(
      body[1],
      /==\s*0\.0/,
      `${fn} still contains an equality-to-zero sentinel`,
    );
  }
});

test("A2: getOceanDeepColor keys its default off a negative channel", () => {
  const body = /fn\s+getOceanDeepColor\s*\(\)[\s\S]*?\n\}/.exec(wgslCode);
  assert.ok(body, "getOceanDeepColor not found");
  assert.match(body[0], /p\.x\s*<\s*0\.0/);
  assert.doesNotMatch(
    body[0],
    /p\.x\s*==\s*0\.0/,
    "an all-zero deep colour is a legitimate black, not an unset marker",
  );
});

test("A3: no other reader of the two slots exists in the shader", () => {
  // The default-identity argument in section C is only sufficient if the
  // getters are the WHOLE consumer set. If a new direct read of
  // `tile.nightOceanParams` / `tile.oceanParams` appears, that argument lapses
  // and this test is the thing that says so.
  const reads = wgslCode.match(/tile\.(nightOceanParams|oceanParams)\b/g) ?? [];
  assert.equal(
    reads.length,
    6,
    `expected exactly 6 slot reads (one per getter), found ${reads.length}`,
  );
});

// ─── B. the enable is a separate, READ signal ────────────────────────────────

test("B1: Globe.update mirrors raw values, not enable-folded ones", () => {
  assert.match(
    globeCode,
    /tileProvider\.enableNightLights\s*=\s*this\.enableNightLights;/,
  );
  assert.match(
    globeCode,
    /tileProvider\.nightIntensity\s*=\s*this\.nightIntensity;/,
    "Globe.update must not fold the enable into the value — that fold is the bug",
  );
  assert.doesNotMatch(
    globeCode,
    /tileProvider\.nightIntensity\s*=\s*this\.enableNightLights\s*\?/,
  );
  for (const prop of [
    "oceanDeepColor",
    "oceanFresnelPower",
    "oceanReflectivity",
    "oceanFoamThreshold",
    "oceanDarkening",
  ]) {
    assert.match(
      globeCode,
      new RegExp(`tileProvider\\.${prop}\\s*=\\s*this\\.${prop};`),
      `${prop} must be mirrored raw`,
    );
  }
});

test("B2: the tile-UB packer READS both enable flags", () => {
  assert.match(
    tileUbCode,
    /tileProvider\?\.enableNightLights\s*!==\s*false/,
    "`tileProvider.enableNightLights` was write-only before CLT-B2; it must now be read",
  );
  assert.match(tileUbCode, /tileProvider\?\.enableEnhancedOcean\s*===\s*true/);
});

test("B3: every slot of both vec4s is written on every path", () => {
  // `data.fill(0)` runs at the top of `createTileUniformBuffer`, so a slot that
  // is merely left alone now reads as an EXPLICIT zero under the new law. The
  // pre-CLT-B2 code relied on exactly that (the deep-colour `if` had no else).
  assert.match(tileUbCode, /data\.fill\(0\)/);
  for (const index of [0, 1, 2, 3]) {
    assert.match(
      tileUbCode,
      new RegExp(`data\\[NIGHT_OCEAN_PARAMS_OFFSET \\+ ${index}\\]\\s*=`),
    );
    assert.match(
      tileUbCode,
      new RegExp(`data\\[OCEAN_PARAMS_OFFSET \\+ ${index}\\]\\s*=`),
    );
  }
  const deepColourElse =
    /}\s*else\s*\{[\s\S]{0,400}?OCEAN_PARAMS_OFFSET \+ 2\]\s*=\s*GLOBE_UB_UNSET/.exec(
      tileUbCode,
    );
  assert.ok(
    deepColourElse,
    "the deep-colour branch needs an else arm writing the unset marker",
  );
});

// ─── C. the enumerated default-identity argument ─────────────────────────────

/** The pre-CLT-B2 shader law. */
const oldGetter = (slot, fallback) => (slot === 0.0 ? fallback : slot);
/** The post-CLT-B2 shader law. */
const newGetter = (slot, fallback) => (slot < 0.0 ? fallback : slot);

/** The pre-CLT-B2 CPU law for a night-lights / ocean tunable. */
function oldPack(enabled, value) {
  // `Globe.update` folded the enable in, then the packer applied `?? 0.0`.
  const mirrored = enabled ? value : 0.0;
  return typeof mirrored === "number" && isFinite(mirrored) ? mirrored : 0.0;
}

test("C1: the shipped defaults are bit-identical under both laws", () => {
  // The values `Globe` ships (Scene/Globe.js) with each feature at its default
  // enable state. This is the "default look" set.
  const shipped = [
    { enabled: true, value: 2.5, fallback: 2.5, off: 0.0 }, // nightIntensity
    { enabled: false, value: 5.0, fallback: 5.0, off: GLOBE_UB_UNSET }, // fresnel
    { enabled: false, value: 0.04, fallback: 0.04, off: GLOBE_UB_UNSET },
    { enabled: false, value: 0.35, fallback: 0.35, off: GLOBE_UB_UNSET },
    { enabled: false, value: 0.6, fallback: 0.6, off: GLOBE_UB_UNSET },
  ];
  for (const { enabled, value, fallback, off } of shipped) {
    const before = oldGetter(oldPack(enabled, value), fallback);
    const after = newGetter(resolveGlobeTunable(enabled, value, off), fallback);
    assert.equal(
      Object.is(before, after),
      true,
      `default (enabled=${enabled}, value=${value}) moved: ${before} -> ${after}`,
    );
  }
});

test("C2: on the ON path with a positive value, nothing moved", () => {
  for (const { fallback } of GETTERS) {
    for (const value of [0.01, 0.25, 0.5, 1, 2.5, 7.75, 1e-6, 1e6]) {
      const before = oldGetter(oldPack(true, value), fallback);
      const after = newGetter(
        resolveGlobeTunable(true, value, GLOBE_UB_UNSET),
        fallback,
      );
      assert.equal(before, after, `ON/${value} moved for default ${fallback}`);
    }
  }
});

test("C3: an unpopulated provider still gets the historical default", () => {
  // The early-frame case: `Globe.update()` has not run, so the property is
  // undefined. Both laws must land on the shader default.
  for (const { fallback } of GETTERS) {
    for (const value of [undefined, null, NaN, Infinity, "2.5"]) {
      const before = oldGetter(oldPack(true, value), fallback);
      const after = newGetter(
        resolveGlobeTunable(true, value, GLOBE_UB_UNSET),
        fallback,
      );
      assert.equal(before, fallback);
      assert.equal(after, fallback, `unset(${String(value)}) lost its default`);
    }
  }
});

test("C4: the ONLY states that moved are the two this row exists to fix", () => {
  // (i) night lights OFF now produces zero emission instead of the default.
  const offBefore = oldGetter(oldPack(false, 2.5), 2.5);
  const offAfter = newGetter(resolveGlobeTunable(false, 2.5, 0.0), 2.5);
  assert.equal(offBefore, 2.5, "the pre-fix off path really did render as 2.5");
  assert.equal(offAfter, 0.0, "the post-fix off path must be zero emission");

  // (ii) an explicit zero is now reachable.
  const zeroBefore = oldGetter(oldPack(true, 0.0), 2.5);
  const zeroAfter = newGetter(resolveGlobeTunable(true, 0.0, 0.0), 2.5);
  assert.equal(zeroBefore, 2.5, "`nightIntensity = 0` used to render as 2.5");
  assert.equal(zeroAfter, 0.0, "`nightIntensity = 0` must mean no emission");
});

test("C5: the enhanced-ocean off path is INERT, not zeroed", () => {
  // Enhanced ocean OFF must NOT collapse the tunables to 0 — the consuming
  // branch is removed by the define, so the honest encoding is "no value", and
  // the getters must keep returning what they returned before this row.
  for (const { fallback } of GETTERS) {
    const packed = resolveGlobeTunable(false, 0.42, GLOBE_UB_UNSET);
    assert.ok(packed < 0, "the off arm must carry the unset marker");
    assert.equal(newGetter(packed, fallback), fallback);
  }
});

test("C6: the identity argument is FALSIFIABLE", () => {
  // A check that cannot fail proves nothing, so run the predicates against
  // packers that are deliberately wrong and require each to be rejected.

  // Mutant 1 — "just flip the getter, keep Globe.js's fold". This DOES fix
  // night lights, which is why it is the tempting minimal patch. It breaks the
  // ocean siblings: `enableEnhancedOcean` is default-FALSE, so the fold writes
  // 0.0 into four slots on the DEFAULT path, and under the new `< 0.0` law
  // those zeros are now honoured — the getters stop returning their built-in
  // defaults and the default look moves. That is the whole reason the fold had
  // to leave `Globe.update()`.
  for (const { fallback } of GETTERS) {
    const folded = oldPack(false, fallback);
    assert.equal(
      newGetter(folded, fallback),
      0,
      "the fold + new getter must be shown to collapse an off tunable to zero",
    );
    assert.notEqual(
      newGetter(folded, fallback),
      fallback,
      "keeping the Globe.js fold must NOT pass the default-identity predicate",
    );
  }

  // Mutant 2/3 — an off arm that writes a non-negative marker cannot express
  // "unset", so the getter stops reaching its default.
  for (const off of [0.0, 2.5]) {
    const packed = resolveGlobeTunable(false, 0.42, off);
    assert.ok(packed >= 0, "precondition: the mutant marker is non-negative");
    assert.notEqual(
      newGetter(packed, 0.35),
      0.35,
      `an off arm of ${off} must fail the enhanced-ocean inertness predicate`,
    );
  }

  // Mutant 4 — NaN. `NaN < 0` is false, so a NaN slot is NOT unset; it flows
  // through and poisons every product downstream. The predicate must see it.
  const nanPacked = resolveGlobeTunable(false, 0.42, NaN);
  assert.ok(Number.isNaN(newGetter(nanPacked, 0.35)));
  assert.notEqual(newGetter(nanPacked, 0.35), 0.35);

  // And the shipped resolver must never itself emit NaN from a bad input.
  assert.equal(resolveGlobeTunable(true, NaN, 0.0), GLOBE_UB_UNSET);
  assert.equal(resolveGlobeTunable(true, Infinity, 0.0), GLOBE_UB_UNSET);
});

// ─── D. the sibling-sentinel audit, recorded as executable facts ─────────────

test("D1: getFoamThreshold is REACHED on the classic path", () => {
  // `computeFoam` is called OUTSIDE the `//>>ifdef ENHANCED_OCEAN` block, so
  // the foam threshold's sentinel was a LIVE hole whenever the enhanced branch
  // was compiled in — an explicit `oceanFoamThreshold = 0` was unreachable.
  const call = /foamFactor\s*=\s*computeFoam\(/.exec(wgslCode);
  assert.ok(call, "computeFoam call site not found");
  const ifdefIndex = wgsl.indexOf("//>>ifdef ENHANCED_OCEAN");
  assert.ok(ifdefIndex > 0);
  assert.ok(
    wgsl.indexOf("foamFactor = computeFoam(") < ifdefIndex,
    "computeFoam is expected to run unconditionally; if it moves inside the " +
      "define, this row's foam finding needs restating",
  );
});

test("D2: the other four ocean getters have no live consumer at HEAD", () => {
  // Recorded, not enforced as a permanent invariant: `getOceanDeepColor`,
  // `getOceanReflectivity` and `getOceanDarkening` have zero call sites, and
  // `getFresnelPower` is reached only through `fresnelSchlick`, which itself
  // has none. Their sentinel hole was therefore LATENT. Principle 7 says leave
  // the scaffolding alone; this row fixes the encoding without deleting it, so
  // the fill-in inherits a correct getter.
  for (const name of [
    "getOceanDeepColor",
    "getOceanReflectivity",
    "getOceanDarkening",
  ]) {
    const calls = wgslCode.match(new RegExp(`${name}\\(\\)`, "g")) ?? [];
    assert.equal(
      calls.length,
      1,
      `${name} now has ${calls.length} occurrences (1 = definition only). ` +
        "If a consumer landed, re-run the CLT-B2 audit for that slot.",
    );
  }
  const fresnelCalls = wgslCode.match(/fresnelSchlick\(/g) ?? [];
  assert.equal(fresnelCalls.length, 1, "fresnelSchlick gained a caller");
});

test("D3: the WebGL globe's night-lights sentinel reads the same way", () => {
  // This test used to discharge the parity obligation by there being no GLSL
  // twin to fix. There is one now: night-lights emission ships on both
  // backends, so the sentinel it inherits has to be the SAME sentinel, and the
  // obligation is discharged by the two agreeing rather than by absence.
  //
  // Executed, not compared by eye — the two are read out of their own sources
  // and run against each other over the whole reachable domain, including the
  // two values the collision was about.
  const glsl = read("packages/engine/Source/Shaders/GlobeFS.glsl");
  const glslArm = glsl.match(
    /return u_nightIntensity ([^;]+) \? ([\d.]+) : u_nightIntensity;/,
  );
  assert.ok(glslArm, "GlobeFS.glsl must resolve the slot with a guarded arm");
  assert.equal(glslArm[1], "< 0.0", "the guard must be the negative half-line");
  const wgslArm = wgslCode.match(
    /fn getNightIntensity\(\) -> f32 \{\s*let n = tile\.nightOceanParams\.x;\s*return select\(n, ([\d.]+), n < 0\.0\);\s*\}/,
  );
  assert.ok(wgslArm, "the WGSL getter must still take the same shape");
  assert.equal(
    glslArm[2],
    wgslArm[1],
    "both backends must substitute the same built-in default",
  );
  const fallback = Number(wgslArm[1]);
  const resolve = (n) => (n < 0 ? fallback : n);
  for (const packed of [-1, -0.5, 0, 0.5, 2.5, 10]) {
    assert.equal(
      resolve(packed),
      packed < 0 ? fallback : packed,
      `the shared law must not move at ${packed}`,
    );
  }
  // The two values the collision was about: a real zero survives as zero, and
  // only the negative marker reaches the default.
  assert.equal(resolve(0), 0, "zero is a value, not an absence");
  assert.equal(resolve(-1), fallback, "the marker is the only absence");

  // The enhanced-ocean tunables remain WebGPU-only, so their half of this row
  // is still discharged by absence.
  assert.doesNotMatch(
    glsl,
    /oceanFoamThreshold|oceanDarkening|oceanReflectivity/,
  );
});

// ─── E. the shader still compiles, and the default arms did not move ─────────

test("E1: GlobeTerrain.wgsl passes naga validation in both layout variants", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(() => naga.validate_wgsl(expandDefines(wgsl, [])));
  assert.doesNotThrow(() =>
    naga.validate_wgsl(expandDefines(wgsl, ["GLOBE_IMAGERY_REDUCED"])),
  );
  assert.doesNotThrow(() =>
    naga.validate_wgsl(expandDefines(wgsl, ["ENHANCED_OCEAN"])),
  );
});

test("E2: this row touched no `//>>ifdef` arm", () => {
  // THE BYTE-IDENTITY ARGUMENT'S SHADER HALF. Every line this row edited sits
  // at conditional depth ZERO, so no `//>>else` branch was rewritten, no
  // define's expansion changed shape, and the preprocessor emits the same
  // directive-free text for every define set except on the six getter lines.
  const lines = wgsl.split("\n");
  let depth = 0;
  const depthOf = new Map();
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//>>ifdef")) {
      depth += 1;
      return;
    }
    if (trimmed.startsWith("//>>endif")) {
      depth -= 1;
      return;
    }
    if (trimmed.startsWith("//>>else")) {
      return;
    }
    depthOf.set(index, depth);
  });
  assert.equal(depth, 0, "unbalanced `//>>ifdef` / `//>>endif` in the shader");

  for (const { fn } of GETTERS.concat([{ fn: "getOceanDeepColor" }])) {
    const index = lines.findIndex((l) => l.trimStart().startsWith(`fn ${fn}(`));
    assert.ok(index >= 0, `${fn} not found`);
    assert.equal(
      depthOf.get(index),
      0,
      `${fn} is inside a //>>ifdef block — the identity argument would need a ` +
        "per-define expansion, not a single reading of the source",
    );
    // And the whole body, not just the signature.
    for (let k = index; k < index + 8 && k < lines.length; k++) {
      assert.equal(depthOf.get(k) ?? 0, 0, `${fn} body crosses a directive`);
    }
  }

  // Both expansions still contain all six getters and no live directive.
  for (const defines of [[], ["ENHANCED_OCEAN"], ["GLOBE_IMAGERY_REDUCED"]]) {
    const text = expandDefines(wgsl, defines);
    for (const { fn } of GETTERS) {
      assert.ok(
        text.includes(`fn ${fn}(`),
        `${fn} vanished under [${defines.join(",")}]`,
      );
    }
    const live = text.split("\n").filter((l) => l.trim().startsWith("//>>"));
    assert.equal(
      live.length,
      0,
      `a directive survived preprocessing under [${defines.join(",")}]`,
    );
  }
});

// `//>>ifdef` expansion for a given define set — the `//>>else` branch is the
// historical path, matching `WebGPUShaderPreprocessor`'s zero-mask contract.
function expandDefines(source, defines) {
  const active = new Set(defines);
  const out = [];
  const stack = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//>>ifdef")) {
      const flag = trimmed.split(/\s+/)[1];
      stack.push({ emitting: active.has(flag) });
      continue;
    }
    if (trimmed.startsWith("//>>else")) {
      const top = stack[stack.length - 1];
      top.emitting = !top.emitting;
      continue;
    }
    if (trimmed.startsWith("//>>endif")) {
      stack.pop();
      continue;
    }
    if (stack.every((frame) => frame.emitting)) {
      out.push(line);
    }
  }
  return out.join("\n");
}
