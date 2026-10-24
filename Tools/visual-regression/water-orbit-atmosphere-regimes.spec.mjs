// water-orbit-atmosphere-regimes.spec.mjs
// @purpose Verifies Phase 2 Orbit & Atmosphere water improvements: Cox-Munk anisotropic orbital sunglint, cloud-shadow water coupling, 2D Euclidean coastal SDF, and RiverWaterClassificationProvider (ne10mRivers.bin).
// @status ACTIVE
//
// Tests 1-4 mix text tripwires on shader source with behaviour on the providers; test 5 pins the call site of the Cox-Munk glint and runs against a copy with the call removed (water-spec-mutants.mjs).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import {
  preprocess,
  ShaderDefine,
  readEngineShader,
} from "./lib/wgsl-variant.mjs";
import {
  assertCallSiteLive,
  assertInertnessMutantTurnsRed,
  stripUses,
} from "./water-spec-mutants.mjs";

// The providers below are .ts files; without the resolver this only works on a Node
// that strips types unflagged (22.18+), and package.json allows >=22.0.0.
enableEngineTsResolution();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const {
  GlobalCoastlineWaterClassificationProvider,
  applyCoastalSignedDistanceField,
} = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      "packages/engine/Source/Scene/GlobalCoastlineWaterClassificationProvider.ts",
    ),
  ).href
);

const {
  LakeWaterClassificationProvider,
  RiverWaterClassificationProvider,
  CompositeWaterClassificationProvider,
} = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      "packages/engine/Source/Scene/WaterClassificationProvider.ts",
    ),
  ).href
);

describe("Phase 2 — Orbit & Atmosphere Regimes: Cox-Munk Glint, Cloud Shadow Coupling, 2D Coastal SDF, and Global Rivers", () => {
  it("1. GlobeTerrain.wgsl implements anisotropic Cox-Munk orbital sunglint and cloud-shadow water coupling and passes Naga", async () => {
    const globeWgsl = readEngineShader(
      "Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    );

    assert.match(
      globeWgsl,
      /fn computeCoxMunkOrbitalGlint\(/,
      "GlobeTerrain.wgsl must define computeCoxMunkOrbitalGlint",
    );
    assert.match(
      globeWgsl,
      /let sigmaUp2 = max\(0\.003 \+ 0\.00316 \* windSpeed,\s*1\.0e-4\);/,
      "Cox-Munk upwind variance must follow 0.003 + 0.00316 * U",
    );
    assert.match(
      globeWgsl,
      /let sigmaCross2 = max\(0\.003 \+ 0\.00192 \* windSpeed,\s*1\.0e-4\);/,
      "Cox-Munk crosswind variance must follow 0.003 + 0.00192 * U",
    );
    assert.match(
      globeWgsl,
      /let enuToEye = eastNorthUpToEyeCoordinates\(positionMC,\s*normalEC\);/,
      "Cox-Munk must orient wind axes through eastNorthUpToEyeCoordinates",
    );
    assert.match(
      globeWgsl,
      /let glintExcess = max\(oceanColor - color,\s*vec3<f32>\(0\.0\)\);/,
      "Cloud shadow water coupling must isolate glintExcess on ENHANCED_OCEAN",
    );
    assert.match(
      globeWgsl,
      /let coolSkyAmbient = vec3<f32>\(0\.02,\s*0\.05,\s*0\.11\) \* waterMask;/,
      "Cloud shadow water coupling must retain cool ambient sky reflection under clouds",
    );

    const nagaDir = path.join(
      repoRoot,
      "Tools/shader-pipeline/naga-wasm-tools",
    );
    const naga = await import(
      pathToFileURL(path.join(nagaDir, "naga_wasm_tools.js")).href
    );
    await naga.default({
      module_or_path: fs.readFileSync(
        path.join(nagaDir, "naga_wasm_tools_bg.wasm"),
      ),
    });

    assert.doesNotThrow(() => {
      naga.validate_wgsl(preprocess(globeWgsl, 0, 0));
      naga.validate_wgsl(
        preprocess(
          globeWgsl,
          ShaderDefine.HAS_WATER_MASK | ShaderDefine.ENHANCED_OCEAN,
          0,
        ),
      );
    });
  });

  it("2. applyCoastalSignedDistanceField computes an isotropic 2D Euclidean SDF with monotonic coastal ramp and exact interior bounds", () => {
    const size = 64;
    const mask = new Uint8Array(size * size);
    // Left half land (0), right half water (255), vertical coastline at x = 32
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        mask[y * size + x] = x >= 32 ? 255 : 0;
      }
    }

    applyCoastalSignedDistanceField(mask, size, 6.0);

    const row = 32 * size;
    // Far interior land (x <= 25) must remain exact 0
    for (let x = 0; x <= 25; x++) {
      assert.strictEqual(mask[row + x], 0, `Interior land at x=${x} must be 0`);
    }
    // Far open water (x >= 38) must remain exact 255
    for (let x = 38; x < size; x++) {
      assert.strictEqual(
        mask[row + x],
        255,
        `Open water at x=${x} must be 255`,
      );
    }
    // Coastal band x in [26..37] must be strictly monotonically increasing in (0, 255)
    let prev = mask[row + 25];
    for (let x = 26; x <= 38; x++) {
      const curr = mask[row + x];
      assert.ok(
        curr > prev,
        `SDF value must strictly increase across coastline at x=${x} (${curr} > ${prev})`,
      );
      prev = curr;
    }
    // Immediately adjacent land (x=31) and water (x=32) straddle 128 symmetrically
    assert.ok(mask[row + 31] < 128 && mask[row + 31] > 100);
    assert.ok(mask[row + 32] > 128 && mask[row + 32] < 155);
  });

  it("3. RiverWaterClassificationProvider loads ne10mRivers.bin and rasterizes anti-aliased river channels and deltas", () => {
    const riverBinPath = path.join(
      repoRoot,
      "packages/engine/Source/Assets/WaterMask/ne10mRivers.bin",
    );
    assert.ok(fs.existsSync(riverBinPath), "ne10mRivers.bin must exist");
    const buffer = fs.readFileSync(riverBinPath);
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );

    const riverProvider = new RiverWaterClassificationProvider(arrayBuffer);
    assert.strictEqual(riverProvider.ready, true);

    const degToRad = Math.PI / 180.0;
    // Tile over Amazon River near Manaus / Santarem (-56 deg to -54 deg W, -3.5 deg to -1.5 deg S)
    const amazonRect = {
      west: -56.0 * degToRad,
      south: -3.5 * degToRad,
      east: -54.0 * degToRad,
      north: -1.5 * degToRad,
    };
    assert.strictEqual(riverProvider.intersectsRectangle(amazonRect), true);

    const landMask = new Uint8Array([0]);
    const augmented = riverProvider.augmentWaterMask(landMask, amazonRect, 256);
    assert.ok(augmented, "Amazon tile must be augmented with river channel");
    assert.strictEqual(augmented.length, 256 * 256);

    let riverTexels = 0;
    let landTexels = 0;
    for (let i = 0; i < augmented.length; i++) {
      if (augmented[i] > 0) riverTexels++;
      else landTexels++;
    }
    assert.ok(
      riverTexels > 100,
      `Expected > 100 river texels, got ${riverTexels}`,
    );
    assert.ok(landTexels > 50000, "Surrounding floodplain land must stay 0");

    // Pure open ocean 1-byte mask [255] must short-circuit to undefined
    assert.strictEqual(
      riverProvider.augmentWaterMask(new Uint8Array([255]), amazonRect, 256),
      undefined,
    );
  });

  it("4. CompositeWaterClassificationProvider integrates coastline, lake, and river providers", () => {
    const coastBuf = fs.readFileSync(
      path.join(
        repoRoot,
        "packages/engine/Source/Assets/WaterMask/ne50mCoastlines.bin",
      ),
    );
    const lakeBuf = fs.readFileSync(
      path.join(
        repoRoot,
        "packages/engine/Source/Assets/WaterMask/ne10mLakes.bin",
      ),
    );
    const riverBuf = fs.readFileSync(
      path.join(
        repoRoot,
        "packages/engine/Source/Assets/WaterMask/ne10mRivers.bin",
      ),
    );

    const coastProvider = new GlobalCoastlineWaterClassificationProvider(
      coastBuf.buffer.slice(
        coastBuf.byteOffset,
        coastBuf.byteOffset + coastBuf.byteLength,
      ),
    );
    const lakeProvider = new LakeWaterClassificationProvider(
      lakeBuf.buffer.slice(
        lakeBuf.byteOffset,
        lakeBuf.byteOffset + lakeBuf.byteLength,
      ),
    );
    const riverProvider = new RiverWaterClassificationProvider(
      riverBuf.buffer.slice(
        riverBuf.byteOffset,
        riverBuf.byteOffset + riverBuf.byteLength,
      ),
    );

    const composite = new CompositeWaterClassificationProvider([
      coastProvider,
      lakeProvider,
      riverProvider,
    ]);
    assert.strictEqual(composite.ready, true);

    const degToRad = Math.PI / 180.0;
    // Continental Mississippi River tile near St. Louis (-91.5 to -89.5 W, 38.0 to 40.0 N)
    const mississippiRect = {
      west: -91.5 * degToRad,
      south: 38.0 * degToRad,
      east: -89.5 * degToRad,
      north: 40.0 * degToRad,
    };
    const mask = composite.generateWaterMask(mississippiRect, 256);
    assert.strictEqual(mask.length, 256 * 256);
    let waterCount = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] > 0) waterCount++;
    }
    assert.ok(
      waterCount > 100,
      `Expected river water texels in composite mask, got ${waterCount}`,
    );
  });

  // Test 1 is a text tripwire: its regexes keep matching a definition after the call
  // is deleted. This one pins the call site and runs against a copy without it.
  it("5. inertness: the Cox-Munk orbital glint is called by the surface shader, and the check goes red when the call is removed", () => {
    const globeWgsl = readEngineShader(
      "Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    );
    assertInertnessMutantTurnsRed(
      "Cox-Munk orbital glint",
      globeWgsl,
      (text) =>
        stripUses(text, "computeCoxMunkOrbitalGlint", "vec3<f32>(0.0)", {
          call: true,
        }),
      (text) =>
        assertCallSiteLive(
          text,
          "computeCoxMunkOrbitalGlint",
          "Cox-Munk orbital glint",
          { call: true },
        ),
    );
  });
});
