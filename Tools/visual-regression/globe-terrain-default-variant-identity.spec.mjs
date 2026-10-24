// globe-terrain-default-variant-identity.spec.mjs - W-A1 of the water landing (R-3, PF-3).
// @purpose Pins that every default variant of GlobeTerrain.wgsl (the 32 lo-define combinations at definesHi 0, and with UNDERWATER_OPTICS alone) preprocesses to the shader a default WebGPU globe compiled before the water landing (a999954e2b), byte for byte outside the two uniform structs (whose allowed differences are comments and four padding words now named), and that the opt-in WATER_PROVIDER_PARITY variant is that shader plus exactly the three named water parity blocks; each check has a mutant that must turn it red.
// @status ACTIVE
//
// WHY. The water landing added about 2,800 lines to GlobeTerrain.wgsl. Before W-A1
// the default variant still carried some of them as dead or equivalent text (a
// rewritten foam body, the stochastic-wave and ellipsoid helpers, a hoisted wave
// fade, a new `computeEnhancedOcean` parameter, a re-derived ocean normal), which
// the compiler parses and validates on every default globe. The Edge executor's E11
// measured the WebGPU compile at 3400 -> 4029 ms. W-A1 put every water-only function,
// member use and branch behind `//>>ifdef ENHANCED_OCEAN`, with the shipped text in
// the `//>>else` arm, so the default variant IS the shipped shader.
//
// THE ALLOW-LIST, one hunk class at a time. Inside `struct CameraUniforms` and
// `struct TileUniforms` only:
//   - comments (no code);
//   - `_pad3` is named `vesselWakeGate` (the vessel-wake camera lane);
//   - `_pad4` is named `oceanTransitionDeficit` (the tier-transition fade lane);
//   - `oceanTideHeight: f32,` is declared at tile float 493, the implicit alignment
//     gap before the 8-byte-aligned `vec2<f32>` (the struct size and every offset are
//     unchanged; `TILE_UNIFORM_FLOATS` stays 496).
//   - `_padEyeCartographic` is named `oceanWaveSeconds` (the unwrapped wave clock
//     the opt-in classic waves read; water round 6).
// A renamed or added word changes no layout and no instruction. Anything else, in
// or outside the structs, must be byte-identical: there is NO default move in
// this landing (seat ruling R-2026-10-23-S8).
//
// THE OPT-IN PARITY VARIANT (water round 6). GlobeFS.glsl's classic waves and
// coast band sit under the hi bit `WATER_PROVIDER_PARITY`, which the globe sets
// only while a water classification provider feeds it, each bounded in the
// shader by `// water-parity-r5 begin <name>` / `// water-parity-r5 end <name>`:
//   - `classic-wave-helper`: an insertion, GlobeFS.glsl's czm_getWaterNoise waves;
//   - `classic-waves`: replaces the wave march block of `computeEnhancedOcean`;
//   - `coast-band`: replaces the texel-footprint coast band with fwidth(mask).
// Tests 10-11 cut exactly those three blocks out of the parity variant (and the
// text they replace out of the base, between fixed anchors) and require the rest
// to equal the base. Their behaviour is pinned by globe-classic-ocean-default-parity
// section I, executed against the GLSL twin.
//
// THE REFERENCE. `BASE_VARIANT_SHA256` holds the sha256 of each base variant after
// the same allow-list normalisation, computed from `git show
// a999954e2b:<GlobeTerrain.wgsl>` through the engine preprocessor;
// `BASE_PARITY_CUT_SHA256` the same with the two replaced regions cut between
// their anchors. When the base commit is reachable (a full clone), test 3
// recomputes both tables from it, so neither can drift from what it claims to be.
// A deliberate change to the default globe shader updates this table in its own
// reviewed batch (`NEW-WATER-DEFAULT-OCEAN-PARITY` is that batch for the ocean).
//
// LINE ENDINGS: the repo checks out CRLF; every read is normalised to `\n`.
//
// Run: node --test Tools/visual-regression/globe-terrain-default-variant-identity.spec.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ShaderDefine,
  ShaderDefineHi,
  preprocess,
  readEngineShader,
} from "./lib/wgsl-variant.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const TERRAIN_REL = "Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const BASE_COMMIT = "a999954e2b";
const terrain = readEngineShader(TERRAIN_REL);

/** The five lo flags GlobeTerrain.wgsl reads, in the order the table enumerates them. */
const LO_FLAGS = [
  "GEODETIC_NORMAL",
  "LOG_DEPTH",
  "GLOBE_IMAGERY_REDUCED",
  "MATERIAL_APPLY",
  "CAPTURE_MODE",
];

function loMask(combination) {
  let mask = 0;
  LO_FLAGS.forEach((flag, bit) => {
    if (combination & (1 << bit)) {
      mask |= ShaderDefine[flag];
    }
  });
  return mask;
}

/** The allow-list: inside the two uniform structs, drop comments and map the three words. */
function normaliseStructs(text) {
  return text.replace(
    /^struct (CameraUniforms|TileUniforms) \{[\s\S]*?^\}/gm,
    (block) =>
      block
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, "").trim())
        .filter((line) => line.length > 0 && line !== "oceanTideHeight: f32,")
        .join("\n")
        .replace(/\bvesselWakeGate: f32,/, "_pad3: f32,")
        .replace(/\boceanTransitionDeficit: f32,/, "_pad4: f32,")
        .replace(/\boceanWaveSeconds: f32,/, "_padEyeCartographic: f32,"),
  );
}

const PARITY_MARK = "// water-parity-r5";
const PARITY_INSERTIONS = ["classic-wave-helper"];
const PARITY_REPLACEMENTS = [
  {
    name: "classic-waves",
    after: "  let showOceanWaves = tile.flags.z > 0.5;\n",
    before: "  // Classic WebGL-parity ocean styling, the default.\n",
  },
  {
    name: "coast-band",
    after: "    // mask footprint per pixel increases at lower zoom.\n",
    before:
      "    let coastCoverage = smoothstep(0.5 - coastBand, 0.5 + coastBand, waterMask);\n",
  },
];

/**
 * Cut the parity hunks out of a preprocessed WATER_PROVIDER_PARITY variant. On the
 * shader side (`marked`) each region must be exactly its BEGIN/END block; on
 * the base side the same anchors bound the shipped text the block replaced.
 */
function cutParityRegions(text, marked) {
  let out = text;
  if (marked) {
    for (const name of PARITY_INSERTIONS) {
      const begin = `${PARITY_MARK} begin ${name}\n`;
      const end = `${PARITY_MARK} end ${name}\n`;
      const i = out.indexOf(begin);
      const j = out.indexOf(end);
      assert.ok(
        i >= 0 && j > i && out.split(begin).length === 2,
        `one ${name} block`,
      );
      // An insertion: the base has nothing in its place.
      out = out.slice(0, i) + out.slice(j + end.length);
    }
  }
  for (const { name, after, before } of PARITY_REPLACEMENTS) {
    assert.equal(out.split(after).length - 1, 1, `one ${name} start anchor`);
    const i = out.indexOf(after) + after.length;
    const j = out.indexOf(before, i);
    assert.ok(j >= i, `${name} end anchor after its start`);
    const region = out.slice(i, j);
    if (marked) {
      const lines = region.replace(/\n+$/, "").split("\n");
      assert.match(lines[0], new RegExp(`^\\s*${PARITY_MARK} begin ${name}$`));
      assert.match(
        lines[lines.length - 1],
        new RegExp(`^\\s*${PARITY_MARK} end ${name}$`),
      );
    }
    out = out.slice(0, i) + `<<${name}>>\n` + out.slice(j);
  }
  return out;
}

const sha256 = (text) =>
  crypto.createHash("sha256").update(text, "utf8").digest("hex");

/**
 * sha256 of each normalised variant of `source` at a given hi word; with
 * `cut`, the parity regions are cut first (`marked`: the shader side, whose
 * regions must be exactly their blocks).
 */
function variantDigests(
  source,
  definesHi,
  { cut = false, marked = true } = {},
) {
  return Array.from(
    { length: 1 << LO_FLAGS.length },
    (ignored, combination) => {
      const variant = preprocess(source, loMask(combination), definesHi);
      return sha256(
        normaliseStructs(cut ? cutParityRegions(variant, marked) : variant),
      );
    },
  );
}

/** The combinations whose variant differs from the base table, byte for byte. */
function mismatches(source, definesHi) {
  const digests = variantDigests(source, definesHi);
  return digests
    .map((digest, combination) =>
      digest === BASE_VARIANT_SHA256[combination] ? -1 : combination,
    )
    .filter((combination) => combination >= 0);
}

/** The combinations whose parity variant, its three blocks cut, differs from the base. */
function parityMismatches(source) {
  const digests = variantDigests(source, ShaderDefineHi.WATER_PROVIDER_PARITY, {
    cut: true,
  });
  return digests
    .map((digest, combination) =>
      digest === BASE_PARITY_CUT_SHA256[combination] ? -1 : combination,
    )
    .filter((combination) => combination >= 0);
}

// sha256 of normaliseStructs(preprocess(base GlobeTerrain.wgsl, loMask(i), 0)),
// i = 0..31.
const BASE_VARIANT_SHA256 = [
  "978dd05d5d2f1ce979f5dda5e0a2f0519e8f0fb3ff8e1438ba4b373079643e5f",
  "58e7032f63d4ffcaea7762efc2aee2f58b3d2faba2448afcba45a90788ae24e2",
  "f54c3efdb5cd2d87f1def1eaefa674219a3e7a64cecaa1769e2bcda31b935e23",
  "c66978a9eed07b8836471a0fc2c7e931eb96cfc4a8189f59a2468ed3547b9451",
  "41e6c28ea852862a155ad44a30b36d685071533503661f12355a03fbeda9b2bc",
  "9682d0d85056634e2e20f54eb3beb640d9d88e28b335b8c7372e317166f9a056",
  "2a9063a7e868b1a6ed69d4fa0ebca8d05cf67ba3a9eee9e8bb136eb5542f2319",
  "c2b992fcca06cbce789727e5ae2f2b7ac990da966ee0e317ebe6e1e938083379",
  "6116867edbf861c5890580d10ddb751c5bf476a513828652ec5d091f5d5249fe",
  "2887bce725d2209e9eda1331b1041edf85097e3c19dd093a5954b69053dffe8e",
  "dfe968b16b3e37ca9135e1402b61912acc6198a9436568a0d272eced925249f5",
  "688921f4ec42a17f8ed2b072ea23cbd364b6e141fa09caf48d4c3fe5352d335e",
  "4bb9bdb55a7864937c45b2568c5c60f7435fc92e63499fe59d7477a9e202c92a",
  "4cb6873dcaac41fafd9b214133d8f89aa8ee8809b2c909daedf88efa365af35c",
  "cbd7df9c83d0d8678cda52ec1ff2915ddf85250f0afbe24a82d19ce470d98d27",
  "d78ea708821792d1c5208822d0bbc50421ee9b39eea1db70870e3a5e416ea103",
  "4b38ffd125b37606648b16cb32144925cd3b405c853bcca2a13e3049868c0ebc",
  "4608d17155e5f61e6dcf9a5ff7c3acf400fa76128398d1b686075eb42a5fec00",
  "17a68a333b92867009827168a1de76a045f5d106fa27a7ac9b9b0dad64f9b2c6",
  "7362de9c5497c833eafd9f039a6be29fbe5cb47be8b65bf3da742bc91b5847bc",
  "0f796801e22dd0caa7a57b7cd4bfede0c8e75de8934b5214c4526415417b7e4b",
  "fdd50e5aa430f61a02f57cc6cbe37ec673c20d0cef090eb85b32e8d3d425e79d",
  "f2c3f3e4820252cc534a22471b045c109ce1797ca4d113fe3e2998d143fff231",
  "caad0f42ba0ade31abb59431a07c9bb5f23ffaceb46db35f1675210cec73e446",
  "a888eead00b546cc4e600ea138e5da99b58dfdc09a207560d277a76d633764f9",
  "bfc3519664bfd4b48c737c00725acda10d8e38ebf06e26f145838303832a84eb",
  "c819286be3f190d6832562caf8873485721ff9b5617329946287b1b58b3fd73c",
  "6502d09c0031f89442d25ff6ffe26304a3e46ffe94a1ee0698f07a9926cde835",
  "d30d1179ea7ceeba6143c0d75efe6d1052dd829e2921e62432ab1e3a524034a9",
  "e676a6ad7bf8eb1e4befcd19a7a34b777d2bac97be0d9b751f4cd1df88a36676",
  "f51b402479ce8c0fc5fc82206ce3a352e2abf7c3ac6a348f0393cafbbf32aaa5",
  "4be7b465c1305e04c1dafa60ba21dd9c516e4481951e3b7f6c46fced51038874",
];

// sha256 of normaliseStructs(cutParityRegions(preprocess(base GlobeTerrain.wgsl,
// loMask(i), 0), false)), i = 0..31: the base with the two replaced regions cut.
const BASE_PARITY_CUT_SHA256 = [
  "1e759dbb8dd1509287da799a8826c7839d61dfa0dba4926d1f1e026ae7991fb3",
  "4439e2ffdd173b94459c8e48dbd29278ce4805a31595dd9560917516483e9d3a",
  "248ccfd31b8c78a5cfe7b0d91672852fd668e7e14e55f318f8a7c82c2f658411",
  "622d1ab248766da039f1ba6a2b07ac901dce1ae3b1ff02ad4d5da996bd8a9b05",
  "b0f75f39fb352b56e935035c219872581886cf51dc22f5de1396a22568247594",
  "af200fee506cc1a490ad47fc0716675cddf93f6c8abe996f97c787c78918a896",
  "1794a1d5a2cfd7ecbe69ccd29044ca83b0a98bf1a8646c95580ffcc51a8699be",
  "407e2c0aea066de2f2134b0b8755f309bd191d1f7dc31fde5fd588f493a0a9a6",
  "91a9e65734356431aa1ef2e4124057bc7ffc6fd5e34f68e5cd66a8767fa9ef56",
  "9a97ff1ed45252f7a30b4e8676accfc6313e24b74e0efe0353f09a628c1dfb96",
  "e0479fe90725113e82ed0bfa28a986aef1def7a5024339319280423be7f4811f",
  "da7f4a050ee4613e562e997bb91bb2824f675788a27a40e3725dcb1ef3c595c0",
  "b4f1e90642a76719dbc2111f1f5af349774502d4b47474766d4dac61040961b9",
  "f74270e0e608ca42dbaeb3b0add2bb2fce312941b978514b677f529b3abc31ea",
  "73639904b9d5f89c490f06ff5f5f2f15b90a600bc690ed163550f140d61e0182",
  "8d12ef939afce0f4742639d55bbd28dbbcdb839eaa86fe118762289f7b845eba",
  "5175b62e90c0260375d0ede6aecfc4c5ca130e1d0002c3566c52e68b4eb95f00",
  "4f2650f514268c0f691c3e7fa79bcede7cfd5af26cd87f0d8f9d371a27676448",
  "22864ebde1e75a1b5e9d923e09cdd7da7af55ca190e6fa06454291c0b2d24e4e",
  "417229ddb96bc6153bb24cde5ce9146acc2095034d73afaea5cd21feb36718ee",
  "f03962fd1ed176bcc31755f388e2e42990064eb791775a97ec91803b5c5eb7de",
  "8d1064b474d5885f9445ac98d289e26d195c28c9b497aba361c18b377d19105c",
  "f1018aceac49a65c6814bd8a763b434e9dfe848ebefa8d036131422233847b52",
  "13b6daa5f95f93b2db15bf980632cbad7e7f87fdbff4f0989ed8e88914c007bd",
  "8cf1a5a8678cd0a6170382104747b14659ed357dd2be55168faf4e9bdfd879cd",
  "6978584c046001aadaeb21902ab386bb6990422387e8db857b0c82b1520279f7",
  "491029bd987615617b25fc1bd99db955e2361e228451e8440b9010e2613ac6ff",
  "bebe435a1320dc6d8a3d65ec218d1049e62f373cf4ea2d428ace11469d8a51f8",
  "1a95467561d5817a8ff1cd0fe3df89d5e7febf29419b543d822b07443c6acea5",
  "4dd90f4f6ec4a7bc912e300cec016cff63d1faaac31c5867c519655acef81e72",
  "9a4abf3f950871020be88aa697c351c8c2d51740bba7876087ff3b1283402a97",
  "2826a4ae4059be39667da54239d8578476d2f53c5b15124fa4c3c19a3ef107dc",
];

test("1: all 32 default variants (definesHi 0) equal the shipped shader under the allow-list, with nothing cut", () => {
  assert.deepEqual(mismatches(terrain, 0), []);
});

test("2: UNDERWATER_OPTICS alone changes no default variant (it only compiles inside the enhanced arm)", () => {
  assert.deepEqual(mismatches(terrain, ShaderDefineHi.UNDERWATER_OPTICS), []);
});

test("3: the table is the base commit's own variants (skipped when the base commit is not in this clone)", (t) => {
  const shown = spawnSync(
    "git",
    [
      "-C",
      root,
      "show",
      `${BASE_COMMIT}:packages/engine/Source/${TERRAIN_REL}`,
    ],
    { encoding: "utf8", maxBuffer: 1 << 26 },
  );
  if (shown.status !== 0) {
    t.skip(`${BASE_COMMIT} is not reachable here`);
    return;
  }
  const base = shown.stdout.replace(/\r\n/g, "\n");
  assert.deepEqual(variantDigests(base, 0), BASE_VARIANT_SHA256);
  assert.deepEqual(
    variantDigests(base, 0, { cut: true, marked: false }),
    BASE_PARITY_CUT_SHA256,
  );
});

test("4: the enhanced and the parity variants are not the default one (control: the checks can see the water text)", () => {
  assert.equal(mismatches(terrain, ShaderDefineHi.ENHANCED_OCEAN).length, 32);
  assert.equal(
    mismatches(terrain, ShaderDefineHi.WATER_PROVIDER_PARITY).length,
    32,
    "if the parity variant matched the table, test 1 would prove nothing about the gate",
  );
});

test("5 (mutant): a water function moved outside its ifdef is DETECTED", () => {
  // The stochastic-wave helper opens the enhanced-only helper block; moving the
  // block's `//>>ifdef` below it leaks one function body into every default variant.
  const opener =
    "//>>ifdef ENHANCED_OCEAN\n// Evaluates a zero-SFU (pure ALU triangle-quintic)";
  assert.equal(terrain.split(opener).length - 1, 1, "mutation anchor");
  const fnEnd = terrain.indexOf("\n}\n", terrain.indexOf(opener)) + 3;
  const mutant =
    terrain.slice(0, terrain.indexOf(opener)) +
    terrain.slice(
      terrain.indexOf(opener) + "//>>ifdef ENHANCED_OCEAN\n".length,
      fnEnd,
    ) +
    "//>>ifdef ENHANCED_OCEAN\n" +
    terrain.slice(fnEnd);
  assert.match(preprocess(mutant, 0, 0), /fn evaluateStochasticWaveField\(/);
  assert.equal(mismatches(mutant, 0).length, 32);
});

test("6 (mutant): a code change inside a uniform struct is DETECTED despite the allow-list", () => {
  const member = "  vectorCoverageRadius: f32,\n";
  assert.equal(terrain.split(member).length - 1, 1, "mutation anchor");
  const mutant = terrain.replace(member, "  vectorCoverageRadiusX: f32,\n");
  assert.equal(mismatches(mutant, 0).length, 32);
});

test("7 (mutant): a comment-only change OUTSIDE the structs is DETECTED (byte identity, not code identity)", () => {
  const line = "// Fog & Atmosphere\n";
  assert.ok(terrain.includes(line), "mutation anchor");
  const mutant = terrain.replace(line, "// Fog and Atmosphere\n");
  assert.equal(mismatches(mutant, 0).length, 32);
});

test("8: the parity blocks exist only in the WATER_PROVIDER_PARITY variant: none at defaults, none under ENHANCED_OCEAN", () => {
  const markers = (text) =>
    [...text.matchAll(/\/\/ water-parity-r5 begin (\S+)/g)]
      .map((m) => m[1])
      .sort();
  assert.deepEqual(markers(preprocess(terrain, 0, 0)), []);
  assert.deepEqual(
    markers(preprocess(terrain, 0, ShaderDefineHi.UNDERWATER_OPTICS)),
    [],
  );
  assert.deepEqual(
    markers(preprocess(terrain, 0, ShaderDefineHi.WATER_PROVIDER_PARITY)),
    ["classic-wave-helper", "classic-waves", "coast-band"],
  );
  for (const hi of [
    ShaderDefineHi.ENHANCED_OCEAN,
    ShaderDefineHi.ENHANCED_OCEAN | ShaderDefineHi.WATER_PROVIDER_PARITY,
  ]) {
    assert.deepEqual(markers(preprocess(terrain, 0, hi)), []);
  }
});

test("9 (mutant): a parity block leaked into the default arm is DETECTED", () => {
  // The coast-band block taken out of its gate: it then compiles in every
  // non-enhanced variant in place of the shipped band.
  const gate =
    "//>>ifdef WATER_PROVIDER_PARITY\n    // water-parity-r5 begin coast-band\n";
  const shipped =
    "    // water-parity-r5 end coast-band\n//>>else\n    let coastBand = clamp(maskScreenGrad * 1.5, 0.2, 0.5);\n//>>endif\n";
  assert.equal(terrain.split(gate).length - 1, 1, "mutation anchor");
  assert.equal(terrain.split(shipped).length - 1, 1, "mutation anchor");
  const mutant = terrain
    .replace(gate, "    // water-parity-r5 begin coast-band\n")
    .replace(shipped, "    // water-parity-r5 end coast-band\n");
  assert.match(preprocess(mutant, 0, 0), /water-parity-r5 begin coast-band/);
  assert.equal(mismatches(mutant, 0).length, 32);
});

test("10: every WATER_PROVIDER_PARITY variant is the base outside exactly the three named blocks", () => {
  assert.deepEqual(parityMismatches(terrain), []);
});

test("11 (mutant): a change on the line before a parity block is DETECTED in the parity variant", () => {
  const line =
    "  var tsPerturbationRatio: f32 = 1.0; // 1.0 = flat, 0.0 = vertical wave\n";
  assert.equal(terrain.split(line).length - 1, 1, "mutation anchor");
  const mutant = terrain.replace(
    line,
    "  var tsPerturbationRatio: f32 = 0.5; // 1.0 = flat, 0.0 = vertical wave\n",
  );
  assert.equal(parityMismatches(mutant).length, 32);
});
