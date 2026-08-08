// skybox-resolution-policy.spec.mjs — browser-free trust anchor for C12-12
// (star cube map VRAM / streaming policy). Run with:
//   node --test Tools/visual-regression/skybox-resolution-policy.spec.mjs
//
// ── WHAT THIS PINS ─────────────────────────────────────────────────────────
//
// The C12-12 row asks for "2048/face default, 4096 opt-in, KTX2 compressed
// (4096/face RGBA8 uncompressed ≈ 402 MB)". Three of those four clauses are
// checkable here; the fourth is not, and the spec says so out loud:
//
//   1. DEFAULT — every variant serves its bundled tier and the six URLs it
//      builds are byte-identical to the pre-policy filenames. Asserted against
//      the actual contents of Assets/Textures/SkyBox/, in both directions:
//      every promised face exists, and every face on disk is accounted for by
//      the tier table. The second direction is what fails the day a 4096 bake
//      lands without being registered.
//   2. OPT-IN — the 4096 seam exists and resolves honestly. NO 4096 faces are
//      bundled at HEAD, so an explicit request falls back to 2048 and reports
//      it. The spec asserts BOTH halves (the seam works when a tier IS
//      registered, via an injected table; and nothing 4096-shaped is on disk),
//      so the "opt-in tier is missing" claim cannot silently go stale.
//   3. VRAM — the numbers in the docs are re-derived from the loaders' actual
//      format, and the loaders are re-read here to prove the model
//      (`rgba8unorm`, six faces, ONE mip) still matches the code. A VRAM claim
//      whose premise drifted is worse than no claim.
//   4. KTX2 — OUT OF SCOPE and still tooling-blocked (no encoder in the repo
//      or on the machine; see C12-12-KTX2-SKYBOX-NOT-BUNDLED and
//      MOON-ALBEDO-KTX2 in DEFERRED_WORK.md). Pinned negatively below so the
//      claim stays true by check rather than by memory.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CUBE_MAP_FACE_COUNT,
  DEFAULT_SKYBOX_RESOLUTION,
  SKYBOX_BUNDLED_TIERS,
  SKYBOX_BYTES_PER_TEXEL,
  SKYBOX_OPT_IN_TIER_PREFIX_SUFFIX,
  SkyBoxResolution,
  SkyBoxResolutionReason,
  bundledResolutions,
  estimateCubeMapVramBytes,
  resolveSkyBoxResolution,
} from "../../packages/engine/Source/Scene/SkyBoxResolutionPolicy.ts";

const repoUrl = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

const SKYBOX_ASSET_DIR = repoUrl(
  "packages/engine/Source/Assets/Textures/SkyBox",
);
const SKYBOX_JS = repoUrl("packages/engine/Source/Scene/SkyBox.js");
const PANORAMA_RENDERER_JS = repoUrl(
  "packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js",
);
const LOAD_CUBEMAP_JS = repoUrl(
  "packages/engine/Source/Renderer/loadCubeMap.js",
);
const BAKE_MANIFEST = repoUrl("Tools/skybox-bake/skybox-manifest.json");

const FACES = ["px", "mx", "py", "my", "pz", "mz"];

// The variant→prefix mapping SkyBox.js owns. Duplicated here deliberately: the
// spec must fail if SkyBox.js renames a prefix, which it cannot do if it reads
// the mapping from the file under test. Cross-checked below.
const VARIANT_PREFIXES = {
  TYCHO_T3: "tycho2t3_80",
  TYCHO_T5: "tycho2t5_80",
  TYCHO_T5_DIFFUSE: "tycho2t5_80_diffuse",
};

function faceFileName(prefix, tierSuffix, face) {
  return `${prefix}${tierSuffix}_${face}.jpg`;
}

// ---------------------------------------------------------------------------
// 1. Default tier — what actually ships
// ---------------------------------------------------------------------------

describe("bundled tiers match the tree", () => {
  test("the default request is 2048", () => {
    assert.equal(DEFAULT_SKYBOX_RESOLUTION, SkyBoxResolution.SIZE_2048);
    assert.equal(DEFAULT_SKYBOX_RESOLUTION, "2048");
  });

  test("every tier the table promises is on disk", () => {
    for (const [variant, tiers] of Object.entries(SKYBOX_BUNDLED_TIERS)) {
      const prefix = VARIANT_PREFIXES[variant];
      assert.ok(prefix, `no prefix known for variant ${variant}`);
      for (const [tier, descriptor] of Object.entries(tiers)) {
        assert.equal(
          String(descriptor.faceSize),
          tier,
          `${variant} tier "${tier}" declares faceSize ${descriptor.faceSize}`,
        );
        for (const face of FACES) {
          const file = faceFileName(prefix, descriptor.prefixSuffix, face);
          assert.ok(
            existsSync(`${SKYBOX_ASSET_DIR}/${file}`),
            `promised face missing from the tree: ${file}`,
          );
        }
      }
    }
  });

  test("every face on disk is accounted for by the table", () => {
    const expected = new Set();
    for (const [variant, tiers] of Object.entries(SKYBOX_BUNDLED_TIERS)) {
      for (const descriptor of Object.values(tiers)) {
        for (const face of FACES) {
          expected.add(
            faceFileName(
              VARIANT_PREFIXES[variant],
              descriptor.prefixSuffix,
              face,
            ),
          );
        }
      }
    }
    const onDisk = readdirSync(SKYBOX_ASSET_DIR).filter((f) =>
      f.endsWith(".jpg"),
    );
    assert.equal(
      onDisk.length,
      18,
      "18 faces = 3 variants x 6 faces at one tier each",
    );
    for (const file of onDisk) {
      assert.ok(
        expected.has(file),
        `${file} is on disk but no tier in SKYBOX_BUNDLED_TIERS serves it — ` +
          `register the tier (and update the C12-12 ledger + LICENSE.md)`,
      );
    }
  });

  test("SkyBox.js still owns the prefixes this spec assumes", () => {
    const source = readFileSync(SKYBOX_JS, "utf8");
    for (const prefix of Object.values(VARIANT_PREFIXES)) {
      assert.match(source, new RegExp(`prefix:\\s*"${prefix}"`));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The resolver
// ---------------------------------------------------------------------------

describe("resolveSkyBoxResolution — default path", () => {
  test("T5 and T5_DIFFUSE serve 2048 with the historical filenames", () => {
    for (const variant of ["TYCHO_T5", "TYCHO_T5_DIFFUSE"]) {
      const d = resolveSkyBoxResolution({ variant });
      assert.equal(d.resolution, "2048");
      assert.equal(d.faceSize, 2048);
      assert.equal(d.prefixSuffix, "", "default URLs must not gain an infix");
      assert.equal(d.fallback, false);
      assert.equal(d.reason, SkyBoxResolutionReason.EXACT);
      assert.equal(d.estimatedVramBytes, 100_663_296);
    }
  });

  test("T3 is bundled at 1024, so the default request falls back", () => {
    const d = resolveSkyBoxResolution({ variant: "TYCHO_T3" });
    assert.equal(d.resolution, "1024");
    assert.equal(d.faceSize, 1024);
    assert.equal(d.prefixSuffix, "");
    assert.equal(d.fallback, true);
    assert.equal(d.reason, SkyBoxResolutionReason.TIER_NOT_BUNDLED);
    assert.equal(d.estimatedVramBytes, 25_165_824);
  });

  test("availableResolutions is ascending and real", () => {
    assert.deepEqual(bundledResolutions("TYCHO_T5"), ["2048"]);
    assert.deepEqual(bundledResolutions("TYCHO_T3"), ["1024"]);
    assert.deepEqual(bundledResolutions("NOPE"), []);
    // Numeric, not lexical: "512" must sort below "2048".
    const table = {
      X: {
        512: { faceSize: 512, prefixSuffix: "_512" },
        2048: { faceSize: 2048, prefixSuffix: "" },
      },
    };
    assert.deepEqual(bundledResolutions("X", table), ["512", "2048"]);
  });
});

describe("resolveSkyBoxResolution — the 4096 opt-in seam", () => {
  test("MUTANT: an explicit 4096 request never fabricates a URL at HEAD", () => {
    const d = resolveSkyBoxResolution({
      variant: "TYCHO_T5_DIFFUSE",
      requested: SkyBoxResolution.SIZE_4096,
    });
    assert.equal(d.requested, "4096");
    assert.equal(d.resolution, "2048", "serves what is actually bundled");
    assert.equal(d.prefixSuffix, "");
    assert.equal(d.fallback, true);
    assert.equal(d.reason, SkyBoxResolutionReason.TIER_NOT_BUNDLED);
  });

  test("no 4096 face exists anywhere in the asset directory", () => {
    // The negative half of the claim above. If someone bakes the tier without
    // registering it, this fires and the ledger row gets corrected.
    const onDisk = readdirSync(SKYBOX_ASSET_DIR);
    for (const file of onDisk) {
      assert.doesNotMatch(
        file,
        /_4096_/,
        `${file} looks like a 4096 tier — register it in SKYBOX_BUNDLED_TIERS`,
      );
    }
  });

  test("the seam works the moment a tier IS registered", () => {
    // Exactly the shape the follow-up bake would install — a data-only change.
    const table = {
      TYCHO_T5_DIFFUSE: {
        2048: { faceSize: 2048, prefixSuffix: "" },
        4096: {
          faceSize: 4096,
          prefixSuffix: SKYBOX_OPT_IN_TIER_PREFIX_SUFFIX,
        },
      },
    };
    const d = resolveSkyBoxResolution({
      variant: "TYCHO_T5_DIFFUSE",
      requested: "4096",
      bundled: table,
    });
    assert.equal(d.resolution, "4096");
    assert.equal(d.faceSize, 4096);
    assert.equal(d.prefixSuffix, "_4096");
    assert.equal(d.fallback, false);
    assert.equal(d.reason, SkyBoxResolutionReason.EXACT);
    assert.equal(d.estimatedVramBytes, 402_653_184);
    assert.equal(
      faceFileName(VARIANT_PREFIXES.TYCHO_T5_DIFFUSE, d.prefixSuffix, "px"),
      "tycho2t5_80_diffuse_4096_px.jpg",
    );
  });

  test("with 4096 registered, the DEFAULT still serves 2048", () => {
    const table = {
      TYCHO_T5_DIFFUSE: {
        2048: { faceSize: 2048, prefixSuffix: "" },
        4096: { faceSize: 4096, prefixSuffix: "_4096" },
      },
    };
    const d = resolveSkyBoxResolution({
      variant: "TYCHO_T5_DIFFUSE",
      bundled: table,
    });
    assert.equal(d.resolution, "2048", "96 MiB stays the default, not 384 MiB");
    assert.equal(d.fallback, false);
  });
});

describe("resolveSkyBoxResolution — device limits and bad input", () => {
  const table = {
    V: {
      1024: { faceSize: 1024, prefixSuffix: "_1024" },
      2048: { faceSize: 2048, prefixSuffix: "" },
      4096: { faceSize: 4096, prefixSuffix: "_4096" },
    },
  };

  test("steps down to what the device can allocate", () => {
    const d = resolveSkyBoxResolution({
      variant: "V",
      requested: "4096",
      bundled: table,
      maximumCubeMapSize: 2048,
    });
    assert.equal(d.resolution, "2048");
    assert.equal(d.reason, SkyBoxResolutionReason.DEVICE_LIMIT);
    assert.equal(d.fallback, true);
    assert.equal(d.exceedsDeviceLimit, false);
  });

  test("a generous limit does not perturb the choice", () => {
    const d = resolveSkyBoxResolution({
      variant: "V",
      bundled: table,
      maximumCubeMapSize: 8192,
    });
    assert.equal(d.resolution, "2048");
    assert.equal(d.reason, SkyBoxResolutionReason.EXACT);
  });

  test("an unknown limit (0/undefined) disables the clamp", () => {
    for (const maximumCubeMapSize of [undefined, 0]) {
      const d = resolveSkyBoxResolution({
        variant: "V",
        requested: "4096",
        bundled: table,
        maximumCubeMapSize,
      });
      assert.equal(d.resolution, "4096");
    }
  });

  test("MUTANT: a limit below every tier reports it instead of hiding it", () => {
    const d = resolveSkyBoxResolution({
      variant: "TYCHO_T5",
      maximumCubeMapSize: 512,
    });
    assert.equal(d.exceedsDeviceLimit, true);
    assert.equal(d.resolution, "2048", "names the smallest tier there is");
    assert.equal(d.reason, SkyBoxResolutionReason.DEVICE_LIMIT);
  });

  test("MUTANT: an unknown resolution becomes the default, never a filename", () => {
    for (const requested of ["8192", "2048px", "", "high"]) {
      const d = resolveSkyBoxResolution({
        variant: "TYCHO_T5_DIFFUSE",
        requested,
      });
      assert.equal(d.requested, DEFAULT_SKYBOX_RESOLUTION);
      assert.equal(d.resolution, "2048");
      assert.equal(d.reason, SkyBoxResolutionReason.UNKNOWN_RESOLUTION);
      assert.equal(d.prefixSuffix, "");
    }
  });

  test("MUTANT: an unknown variant is reported, not guessed", () => {
    const d = resolveSkyBoxResolution({ variant: "TYCHO_T9" });
    assert.equal(d.reason, SkyBoxResolutionReason.UNKNOWN_VARIANT);
    assert.equal(d.faceSize, 0);
    assert.equal(d.estimatedVramBytes, 0);
    assert.deepEqual(d.availableResolutions, []);
  });

  test("a request below every bundled tier serves the smallest", () => {
    const d = resolveSkyBoxResolution({
      variant: "TYCHO_T5",
      requested: "1024",
    });
    assert.equal(d.resolution, "2048");
    assert.equal(d.fallback, true);
    assert.equal(d.reason, SkyBoxResolutionReason.TIER_NOT_BUNDLED);
  });
});

// ---------------------------------------------------------------------------
// 3. VRAM model, and the loader evidence behind it
// ---------------------------------------------------------------------------

describe("VRAM model", () => {
  test("the documented numbers are 6 x faceSize^2 x 4", () => {
    assert.equal(estimateCubeMapVramBytes(1024), 25_165_824); // 24 MiB
    assert.equal(estimateCubeMapVramBytes(2048), 100_663_296); // 96 MiB
    assert.equal(estimateCubeMapVramBytes(4096), 402_653_184); // 384 MiB
    // The C12-12 row's "≈ 402 MB" is the decimal-MB reading of the 4096 tier.
    assert.equal(Math.round(402_653_184 / 1e6), 403);
    assert.equal(Math.round(402_653_184 / (1024 * 1024)), 384);
  });

  test("constants match the formula", () => {
    assert.equal(CUBE_MAP_FACE_COUNT, 6);
    assert.equal(SKYBOX_BYTES_PER_TEXEL, 4);
    assert.equal(
      estimateCubeMapVramBytes(2048),
      CUBE_MAP_FACE_COUNT * 2048 * 2048 * SKYBOX_BYTES_PER_TEXEL,
    );
  });

  test("degenerate sizes are 0, not NaN", () => {
    for (const size of [0, -1, Number.NaN, undefined]) {
      assert.equal(estimateCubeMapVramBytes(size), 0);
    }
  });

  test("the mipmapped model is the exact chain sum, not 4/3", () => {
    // 6 x 4 x (4^2 + 2^2 + 1^2) = 24 x 21 = 504
    assert.equal(estimateCubeMapVramBytes(4, { mipmapped: true }), 504);
    const approx = (100_663_296 * 4) / 3;
    const exact = estimateCubeMapVramBytes(2048, { mipmapped: true });
    assert.ok(exact < approx, "the finite chain is strictly below 4/3");
    assert.ok(exact > 100_663_296);
  });

  test("EVIDENCE: the WebGPU loader is rgba8unorm with one mip level", () => {
    const source = readFileSync(PANORAMA_RENDERER_JS, "utf8");
    const call = source.slice(
      source.indexOf('label: "CubeMapPanorama-cubemap"'),
    );
    const descriptor = call.slice(0, call.indexOf("});"));
    assert.match(descriptor, /format:\s*"rgba8unorm"/);
    assert.match(descriptor, /size:\s*\[size,\s*size,\s*6\]/);
    assert.doesNotMatch(
      descriptor,
      /mipLevelCount/,
      "a mip chain would make every VRAM number in the C12-12 docs wrong",
    );
  });

  test("EVIDENCE: the WebGL loader never generates mipmaps for the sky box", () => {
    const source = readFileSync(LOAD_CUBEMAP_JS, "utf8");
    assert.match(source, /new CubeMap\(\{/);
    assert.doesNotMatch(source, /generateMipmap/);
    assert.doesNotMatch(
      source,
      /pixelFormat|pixelDatatype/,
      "constructor defaults (RGBA + UNSIGNED_BYTE) are what the model assumes",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Scope boundaries — what C12-12 did NOT ship
// ---------------------------------------------------------------------------

describe("scope boundaries", () => {
  test("the 4096 master is reproducible but not bundled", () => {
    const manifest = JSON.parse(readFileSync(BAKE_MANIFEST, "utf8"));
    assert.equal(manifest.encode.masterSize, 4096);
    assert.equal(manifest.encode.faceSize, 2048);
    assert.match(manifest.reproject, /4096/);
  });

  test("MUTANT: no compressed-texture form of the sky box is bundled", () => {
    // The KTX2 half of C12-12 is tooling-blocked. When an encoder exists and a
    // compressed face lands, this fires — and the ledger, LICENSE.md and the
    // VRAM model (which assumes rgba8unorm) all need revisiting together.
    const onDisk = readdirSync(SKYBOX_ASSET_DIR).filter((f) =>
      statSync(`${SKYBOX_ASSET_DIR}/${f}`).isFile(),
    );
    for (const file of onDisk) {
      assert.doesNotMatch(file, /\.(ktx2?|basis|dds)$/i, `unexpected: ${file}`);
    }
  });

  test("SkyBox.js exposes the policy in the Variant API shape", () => {
    const source = readFileSync(SKYBOX_JS, "utf8");
    assert.match(source, /SkyBox\.Resolution = SkyBoxResolution;/);
    assert.match(
      source,
      /SkyBox\.defaultResolution = DEFAULT_SKYBOX_RESOLUTION;/,
    );
    assert.match(source, /static createEarthSkyBox\(variant, options\)/);
    assert.match(source, /resolveSkyBoxResolution\(\{/);
    // The face URLs must go through the tier infix, on every face.
    for (const face of FACES) {
      assert.match(
        source,
        new RegExp(`resolved\\.url\\("${face}", tierSuffix\\)`),
      );
    }
    assert.match(
      source,
      /\$\{this\.prefix\}\$\{tierSuffix \?\? ""\}_\$\{face\}\.jpg/,
    );
  });
});
