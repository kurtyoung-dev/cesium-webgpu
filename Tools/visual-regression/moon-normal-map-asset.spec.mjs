// moon-normal-map-asset.spec.mjs — C12-25: pins the bundled lunar NORMAL map,
// the derivation math that produced it, its crater-relief polarity, the
// both-backends shader wiring, and the LICENSE.md provenance entry.
//
// These tests fail if:
//   - the shipped normal map goes missing, changes dimensions, stops being a
//     2:1 equirectangular, or stops being 8-bit truecolour PNG. The format is
//     load-bearing, not stylistic: after the RGB->YCbCr rotation a normal
//     map's two INFORMATIVE channels land in the chroma planes, so a switch to
//     JPEG would quietly cost 1.26 deg of mean normal-tilt error against a
//     signal whose own mean tilt is 2.73 deg (measured — README section 7.5);
//   - the relief's ORIENTATION drifts. A mirrored green channel lights every
//     crater from the wrong side, a mirrored red channel does the same
//     east/west, an x/y transpose rotates all relief 90 deg, and a dead height
//     decode yields a flat map that passes every polarity test vacuously.
//     None of those crash and none are visible at full phase — they only show
//     at the terminator, which is the one place this asset is meant to be
//     read. Each has its own named check, and the adversarial block below
//     proves each check actually fires;
//   - the DERIVATION math regresses. The 1/cos(lat) longitude handling is
//     pinned directly: a height field with a constant EAST GROUND slope must
//     reproduce that exact slope at every latitude, which is only true if the
//     stencil widens as the texel narrows;
//   - either backend's tangent-frame construction drifts from its twin, or the
//     WebGPU normal upload stops passing `flipY: true`. Because the green
//     channel encodes NORTH, a v-flip does not merely misplace the relief —
//     it lights every crater from the wrong side on one backend only;
//   - the variant gate breaks: `Moon.Variant.SMALL` must keep shipping NO
//     normal map, so the historical flat look stays reachable;
//   - the LICENSE.md "Bundled Engine Assets" entry disappears or stops
//     matching the shipped bytes.
//
// The manifest at Tools/moon-albedo-bake/moon-normal-manifest.json records the
// bake's own measurements. It is NOT trusted on its own: the spec re-derives
// the shipped file's SHA-256 and rejects the manifest if they disagree.
//
// Run: node --test Tools/visual-regression/moon-normal-map-asset.spec.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CRATERS,
  LUNAR_RADIUS_M,
  areaDownsample,
  decodeNormalsRGB8,
  heightsToNormals,
  runReliefChecks,
} from "../moon-albedo-bake/lunar-relief.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const ASSET_REL =
  "packages/engine/Source/Assets/Textures/Moon/ldem_normal_1k.png";
const MANIFEST_REL = "Tools/moon-albedo-bake/moon-normal-manifest.json";

const abs = (rel) => path.join(root, rel);
const read = (rel) => fs.readFileSync(abs(rel));
const readText = (rel) => fs.readFileSync(abs(rel), "utf8");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const EXPECTED_WIDTH = 1024;
const EXPECTED_HEIGHT = 512;

// ---------------------------------------------------------------------------
// Dependency-free PNG IHDR reader — dimensions, bit depth and colour type
// without decoding a single scanline.
// ---------------------------------------------------------------------------
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readPngHeader(buf) {
  assert.ok(
    buf.subarray(0, 8).equals(PNG_SIGNATURE),
    "not a PNG (bad signature)",
  );
  const length = buf.readUInt32BE(8);
  const type = buf.subarray(12, 16).toString("ascii");
  assert.equal(type, "IHDR", "first chunk must be IHDR");
  assert.equal(length, 13, "IHDR must be 13 bytes");
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    // 0 grey, 2 truecolour RGB, 3 palette, 4 grey+alpha, 6 RGBA
    colorType: buf[25],
    interlace: buf[28],
  };
}

// Optional decode path, matching the albedo spec's posture: `sharp` is a
// declared devDependency, so this normally runs; when it cannot be resolved
// the pixel-level tests skip and the header/hash/wiring pins still hold.
async function tryLoadSharp() {
  try {
    return (await import("sharp")).default;
  } catch {
    return null;
  }
}
const sharp = await tryLoadSharp();

async function decodeAsset() {
  const { data, info } = await sharp(abs(ASSET_REL))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    pixels: data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

// ---------------------------------------------------------------------------
// Asset shape + provenance
// ---------------------------------------------------------------------------
test("bundled normal map is present with the pinned geometry and encoding", () => {
  assert.ok(fs.existsSync(abs(ASSET_REL)), `missing ${ASSET_REL}`);
  const header = readPngHeader(read(ASSET_REL));

  assert.equal(header.width, EXPECTED_WIDTH, "normal map width");
  assert.equal(header.height, EXPECTED_HEIGHT, "normal map height");
  assert.equal(
    header.width,
    header.height * 2,
    "an equirectangular map must be exactly 2:1 — the UV unwrap covers 360 deg of longitude by 180 deg of latitude",
  );
  assert.equal(header.bitDepth, 8, "8 bits per channel");
  assert.equal(
    header.colorType,
    2,
    "must be truecolour RGB (colour type 2): the three channels ARE the normal's x/y/z",
  );
  assert.equal(header.interlace, 0, "no interlacing");
});

test("the normal map is PNG, not a chroma-subsampled format", () => {
  // The whole point of the format choice. A .jpg here would still decode and
  // still render a moon — just one whose relief has been low-passed in
  // exactly the two channels that carry it.
  assert.ok(
    ASSET_REL.endsWith(".png"),
    "the relief map must be lossless — see README section 7.5 for the measured cost of JPEG",
  );
  const buf = read(ASSET_REL);
  assert.ok(
    buf.subarray(0, 8).equals(PNG_SIGNATURE),
    "extension says PNG but the bytes do not",
  );
});

test("manifest matches the shipped bytes (evidence cannot drift from the asset)", () => {
  const manifest = JSON.parse(readText(MANIFEST_REL));
  const buf = read(ASSET_REL);
  assert.equal(
    manifest.output.sha256,
    sha256(buf),
    "manifest sha256 != shipped file sha256 — re-run Tools/moon-albedo-bake/bake-lola-normals.mjs",
  );
  assert.equal(manifest.output.bytes, buf.length);
  assert.equal(manifest.output.width, EXPECTED_WIDTH);
  assert.equal(manifest.output.height, EXPECTED_HEIGHT);

  // Provenance the LICENSE entry depends on.
  assert.match(manifest.source.url, /^https:\/\/svs\.gsfc\.nasa\.gov\//);
  assert.match(manifest.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.source.file, "ldem_16.tif");
  assert.equal(manifest.source.width, 5760);
  assert.equal(manifest.source.height, 2880);
  assert.equal(manifest.projection.centerLongitudeDeg, 0);
  assert.equal(manifest.projection.longitudePositive, "east");
  assert.equal(manifest.projection.rowZero, "north (+90 deg latitude)");

  // The source must be FINER than the output — deriving relief from a coarser
  // height field would be upsampling invented detail.
  assert.ok(
    manifest.source.width > manifest.output.width,
    "the LOLA source must out-resolve the shipped grid",
  );

  assert.equal(manifest.derivation.referenceRadiusMeters, LUNAR_RADIUS_M);
  assert.equal(
    manifest.derivation.tangentFrame,
    "east / north / up (geodetic surface normal)",
  );

  // The bake refuses to install on a failing check; assert that is what was recorded.
  assert.ok(
    manifest.reliefChecks.length >= 6,
    "expected the full check battery",
  );
  for (const c of manifest.reliefChecks) {
    assert.equal(c.pass, true, `manifest records a failing check: ${c.name}`);
  }
});

test("LICENSE.md carries the Bundled Engine Assets entry for the normal map", () => {
  const license = readText("LICENSE.md");
  const bundled = license.slice(license.indexOf("# Bundled Engine Assets"));
  assert.ok(bundled.length > 0, "Bundled Engine Assets section missing");
  assert.ok(
    bundled.includes(ASSET_REL),
    "LICENSE.md must name the shipped normal map inside Bundled Engine Assets",
  );
  assert.ok(bundled.includes("CGI Moon Kit"), "must name the NASA product");
  assert.ok(
    bundled.includes(
      "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16.tif",
    ),
    "must record the exact source URL",
  );
  assert.ok(
    bundled.includes(sha256(read(ASSET_REL))),
    "must record the shipped file's SHA-256",
  );
  assert.ok(bundled.includes("2026-08-02"), "must record the retrieval date");
  assert.ok(
    /Lunar Orbiter Laser Altimeter|LOLA/.test(bundled),
    "must credit the underlying LOLA instrument data",
  );
});

// ---------------------------------------------------------------------------
// Derivation math — pinned directly, not just via the shipped bytes.
// ---------------------------------------------------------------------------
test("a flat height field derives to exactly flat normals", () => {
  const W = 64;
  const H = 32;
  const flat = new Float64Array(W * H).fill(1234.5);
  const { nx, ny, nz } = heightsToNormals(flat, W, H);
  for (let i = 0; i < nx.length; i++) {
    // Math.abs, not a bare equality: `-dh/dE` of a zero difference is the
    // signed zero -0, which is numerically correct and strictEqual-hostile.
    assert.equal(Math.abs(nx[i]), 0, `nx[${i}] should be 0 on a flat field`);
    assert.equal(Math.abs(ny[i]), 0, `ny[${i}] should be 0 on a flat field`);
    assert.equal(nz[i], 1, `nz[${i}] should be 1 on a flat field`);
  }
});

test("a constant EAST ground slope is reproduced at every latitude (the 1/cos(lat) pin)", () => {
  // h = a * R * cos(lat) * lon  has a constant east slope of exactly `a`
  // everywhere — the height change per METRE of eastward ground is the same
  // at the equator and at 80 deg. Reproducing it is only possible if the
  // longitude stencil widens as the texel narrows; a fixed one-texel stencil
  // divided by the true (shrinking) spacing reproduces `a` too, but a CLAMPED
  // divisor — the naive fix for the polar blow-up — would not.
  const W = 512;
  const H = 256;
  const a = 0.05;
  const h = new Float64Array(W * H);
  for (let row = 0; row < H; row++) {
    const lat = ((90 - ((row + 0.5) / H) * 180) * Math.PI) / 180;
    for (let col = 0; col < W; col++) {
      const lon = (((col + 0.5) / W) * 360 - 180) * (Math.PI / 180);
      h[row * W + col] = a * LUNAR_RADIUS_M * Math.cos(lat) * lon;
    }
  }
  const { nx, nz } = heightsToNormals(h, W, H);

  // Sample well away from the +/-180 seam, where the field is discontinuous.
  const col = Math.floor(W / 2);
  for (const lat of [0, 30, 60, 80]) {
    const row = Math.round(((90 - lat) / 180) * H);
    const i = row * W + col;
    // n = normalize(-dh/dE, -dh/dN, 1)  =>  dh/dE = -nx/nz
    const slope = -nx[i] / nz[i];
    assert.ok(
      Math.abs(slope - a) < 1e-4,
      `east slope at lat ${lat} was ${slope}, expected ${a} — the longitude stencil is not tracking 1/cos(lat)`,
    );
  }
});

test("a constant NORTH ground slope is reproduced, with the right sign", () => {
  // h rising toward the north => the surface normal must tilt SOUTH (ny < 0).
  const W = 128;
  const H = 64;
  const a = 0.03;
  const dNorth = LUNAR_RADIUS_M * (Math.PI / H);
  const h = new Float64Array(W * H);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      // Row index grows southward, so height must DECREASE with row.
      h[row * W + col] = -a * dNorth * row;
    }
  }
  const { ny, nz } = heightsToNormals(h, W, H);
  const row = Math.floor(H / 2);
  const i = row * W + Math.floor(W / 2);
  const slope = -ny[i] / nz[i]; // = dh/dNorth
  assert.ok(
    Math.abs(slope - a) < 1e-9,
    `north slope was ${slope}, expected ${a}`,
  );
  assert.ok(ny[i] < 0, "a north-rising slope must tilt the normal south");
});

test("rising toward the east tilts the normal west", () => {
  const W = 128;
  const H = 64;
  const dEast = LUNAR_RADIUS_M * ((2 * Math.PI) / W);
  const h = new Float64Array(W * H);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      h[row * W + col] = 0.02 * dEast * col;
    }
  }
  const { nx } = heightsToNormals(h, W, H);
  // Equator, away from the seam where the ramp wraps.
  const i = Math.floor(H / 2) * W + Math.floor(W / 2);
  assert.ok(
    nx[i] < 0,
    "an east-rising slope must tilt the normal west (nx < 0) — this is the sign convention every crater check depends on",
  );
});

test("area downsample preserves a constant and preserves the mean", () => {
  const sw = 45;
  const sh = 27;
  const src = new Float64Array(sw * sh).fill(7.25);
  const out = areaDownsample(src, sw, sh, 15, 9);
  assert.equal(out.length, 15 * 9);
  for (const v of out) {
    assert.ok(
      Math.abs(v - 7.25) < 1e-9,
      "a constant field must survive intact",
    );
  }

  // Non-integer ratio (the real case is 5760 -> 1024, i.e. 5.625:1).
  const sw2 = 90;
  const sh2 = 45;
  const src2 = new Float64Array(sw2 * sh2);
  for (let i = 0; i < src2.length; i++) src2[i] = (i % 13) - 6;
  const out2 = areaDownsample(src2, sw2, sh2, 16, 8);
  const meanIn = src2.reduce((a, b) => a + b, 0) / src2.length;
  const meanOut = out2.reduce((a, b) => a + b, 0) / out2.length;
  assert.ok(
    Math.abs(meanIn - meanOut) < 0.05,
    `area average must conserve the mean (in ${meanIn}, out ${meanOut})`,
  );
});

// ---------------------------------------------------------------------------
// Relief orientation — the reason this spec exists.
// ---------------------------------------------------------------------------
test("named craters have plausible published coordinates and radii", () => {
  for (const [name, c] of Object.entries(CRATERS)) {
    assert.ok(c.lon >= -180 && c.lon <= 180, `${name} longitude out of range`);
    assert.ok(c.lat >= -90 && c.lat <= 90, `${name} latitude out of range`);
    assert.ok(
      c.radiusDeg > 0 && c.radiusDeg < 10,
      `${name} rim radius implausible`,
    );
  }
  // Tycho: 85 km across => 42.5 km radius => ~1.40 deg (1 deg ~ 30.32 km).
  assert.ok(Math.abs(CRATERS.tycho.lon - -11.4) < 1.0);
  assert.ok(Math.abs(CRATERS.tycho.lat - -43.3) < 1.0);
  assert.ok(Math.abs(CRATERS.tycho.radiusDeg - 1.4) < 0.3);
  // Copernicus: 93 km across => 46.5 km radius => ~1.53 deg.
  assert.ok(Math.abs(CRATERS.copernicus.lon - -20.1) < 1.0);
  assert.ok(Math.abs(CRATERS.copernicus.lat - 9.6) < 1.0);
  assert.ok(Math.abs(CRATERS.copernicus.radiusDeg - 1.53) < 0.3);
});

test(
  "shipped normal map passes every relief check",
  { skip: sharp ? false : "sharp not resolvable" },
  async () => {
    const { pixels, width, height, channels } = await decodeAsset();
    assert.equal(width, EXPECTED_WIDTH);
    assert.equal(height, EXPECTED_HEIGHT);
    const { nx, ny, nz } = decodeNormalsRGB8(pixels, width, height, channels);
    const result = runReliefChecks(nx, ny, nz, width, height);
    const failed = result.checks.filter((c) => !c.pass);
    assert.equal(
      failed.length,
      0,
      `relief FAILED: ${failed.map((c) => `${c.name} (${c.value}, need ${c.threshold}) — ${c.detail}`).join("; ")}`,
    );
  },
);

test(
  "relief checks REJECT every corruption (the discriminator actually fires)",
  { skip: sharp ? false : "sharp not resolvable" },
  async () => {
    const { pixels, width: W, height: H, channels: C } = await decodeAsset();

    // Channel-space corruptions: the encoded value v maps to (v-127.5)/127.5,
    // so negating a component is exactly 255 - v.
    const perTexel = (fn) => {
      const out = Buffer.from(pixels);
      for (let i = 0; i < W * H; i++) fn(out, i * C);
      return out;
    };
    // Image-space corruptions: the content moves but the encoded vectors do
    // not re-orient — precisely the shape of an upload-convention mismatch.
    const remap = (fn) => {
      const out = Buffer.alloc(pixels.length);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const [sx, sy] = fn(x, y);
          const di = (y * W + x) * C;
          const si = (sy * W + sx) * C;
          for (let c = 0; c < C; c++) out[di + c] = pixels[si + c];
        }
      }
      return out;
    };

    const cases = {
      // THE case the C12-25 brief names: a flipped-Y normal map.
      flipGreen: () => perTexel((b, p) => (b[p + 1] = 255 - b[p + 1])),
      flipRed: () => perTexel((b, p) => (b[p] = 255 - b[p])),
      swapChannels: () =>
        perTexel((b, p) => {
          const t = b[p];
          b[p] = b[p + 1];
          b[p + 1] = t;
        }),
      flatten: () =>
        perTexel((b, p) => {
          b[p] = 128;
          b[p + 1] = 128;
          b[p + 2] = 255;
        }),
      mirrorLat: () => remap((x, y) => [x, H - 1 - y]),
      mirrorLon: () => remap((x, y) => [W - 1 - x, y]),
    };

    for (const [name, make] of Object.entries(cases)) {
      const d = decodeNormalsRGB8(make(), W, H, C);
      const result = runReliefChecks(d.nx, d.ny, d.nz, W, H);
      assert.equal(
        result.ok,
        false,
        `corruption "${name}" was ACCEPTED — the relief check is vacuous`,
      );
    }

    // And specifically: a flipped GREEN channel must trip the check written
    // for it, not merely fail somewhere incidental. This is the assertion the
    // C12-25 brief asks for by name.
    const flipped = decodeNormalsRGB8(cases.flipGreen(), W, H, C);
    const fr = runReliefChecks(flipped.nx, flipped.ny, flipped.nz, W, H);
    const ns = fr.checks.find((c) => c.name === "craterNorthSouthPolarity");
    assert.equal(
      ns.pass,
      false,
      "a flipped-Y (green) normal map must fail craterNorthSouthPolarity",
    );
    // ...and it must ALSO be caught end-to-end, as "lit from the wrong side".
    const illum = fr.checks.find((c) => c.name === "craterLitFromTestAzimuth");
    assert.equal(
      illum.pass,
      false,
      "a flipped-Y normal map must fail the illumination check too",
    );
    // ...while leaving the east/west check alone, proving the checks are
    // independently signed rather than one signal read six ways.
    const ew = fr.checks.find((c) => c.name === "craterEastWestPolarity");
    assert.equal(
      ew.pass,
      true,
      "a GREEN flip must not disturb the east/west (red) discriminator",
    );

    // Symmetrically, a flipped RED channel must trip east/west and leave
    // north/south alone.
    const flippedR = decodeNormalsRGB8(cases.flipRed(), W, H, C);
    const rr = runReliefChecks(flippedR.nx, flippedR.ny, flippedR.nz, W, H);
    assert.equal(
      rr.checks.find((c) => c.name === "craterEastWestPolarity").pass,
      false,
      "a flipped-X (red) normal map must fail craterEastWestPolarity",
    );
    assert.equal(
      rr.checks.find((c) => c.name === "craterNorthSouthPolarity").pass,
      true,
      "a RED flip must not disturb the north/south (green) discriminator",
    );
  },
);

test(
  "no polar ring — the 1/cos(lat) handling did not blow up at the poles",
  { skip: sharp ? false : "sharp not resolvable" },
  async () => {
    // The failure this guards is specific and would be invisible in any
    // top-down screenshot: dividing a one-texel longitude difference by the
    // true (vanishing) east spacing turns pole rows into vertical cliffs, so
    // the moon grows a hard bright ring at each pole under grazing light.
    const { pixels, width: W, height: H, channels: C } = await decodeAsset();
    const { nx, ny } = decodeNormalsRGB8(pixels, W, H, C);
    const bandMean = (r0, r1) => {
      let s = 0;
      let n = 0;
      for (let r = r0; r < r1; r++) {
        for (let c = 0; c < W; c++) {
          const i = r * W + c;
          s += Math.hypot(nx[i], ny[i]);
          n++;
        }
      }
      return s / n;
    };
    const global = bandMean(0, H);
    const north = bandMean(0, 2);
    const south = bandMean(H - 2, H);
    assert.ok(global > 0, "map has no relief at all");
    assert.ok(
      north / global < 3.0,
      `north pole band is ${(north / global).toFixed(2)}x the global mean tangential tilt — a polar ring`,
    );
    assert.ok(
      south / global < 3.0,
      `south pole band is ${(south / global).toFixed(2)}x the global mean tangential tilt — a polar ring`,
    );
  },
);

// ---------------------------------------------------------------------------
// Both-backends wiring.
// ---------------------------------------------------------------------------
test("Moon.js pairs the normal map with the 2K variant and keeps SMALL flat", () => {
  const src = readText("packages/engine/Source/Scene/Moon.js");
  assert.match(
    src,
    /moonNormalMapVariants\s*=\s*\{/,
    "the variant -> normal map table is missing",
  );
  assert.match(
    src,
    /\[Moon\.Variant\.SMALL\]:\s*undefined/,
    "Moon.Variant.SMALL must ship NO normal map — it is the historical flat look",
  );
  assert.match(
    src,
    /\[Moon\.Variant\.LROC_COLOR_2K\]:\s*"Assets\/Textures\/Moon\/ldem_normal_1k\.png"/,
    "the 2K variant must point at the shipped normal map",
  );
  assert.match(
    src,
    /Moon\.getVariantNormalMapUrl\s*=\s*function/,
    "the variant resolver is part of the public surface",
  );
  assert.match(src, /this\.normalMapStrength\s*=/, "strength dial missing");
  // Resolved once, backend-agnostically, and published for both backends.
  assert.match(
    src,
    /frameState\.moonNormalMapStrength\s*=/,
    "the strength must be published on frameState so BOTH backends read one number",
  );
  assert.match(
    src,
    /lighting\.enableLunarNormalMap\s*===\s*true/,
    "the lighting toggle must gate the strength",
  );
});

test("AtmosphericConditions exposes enableLunarNormalMap, default ON", () => {
  const src = readText("packages/engine/Source/Scene/AtmosphericConditions.js");
  assert.match(
    src,
    /enableLunarNormalMap:\s*true/,
    "enableLunarNormalMap must exist and default to true",
  );
});

test("EllipsoidPrimitive gates the WebGL sampler behind the LUNAR_NORMAL_MAP define", () => {
  const src = readText("packages/engine/Source/Scene/EllipsoidPrimitive.js");
  assert.match(
    src,
    /fs\.defines\.push\("LUNAR_NORMAL_MAP"\)/,
    "the define must be pushed",
  );
  assert.match(
    src,
    /const lunarNormalMapEnabled = defined\(this\.lunarNormalMap\)/,
    "the define must be driven by the presence of the texture",
  );
  assert.match(
    src,
    /u_lunarNormalMap:\s*function/,
    "the sampler uniform must be supplied",
  );
  assert.match(
    src,
    /u_lunarNormalStrength:\s*function/,
    "the strength uniform must be supplied",
  );
  // The strength must NOT be part of the recompile trigger — animating it
  // would otherwise rebuild the shader program every frame.
  const triggerBlock = src.slice(
    src.indexOf("if (\n      materialChanged"),
    src.indexOf("vs = new ShaderSource"),
  );
  assert.ok(
    !/lunarNormalStrength/.test(triggerBlock),
    "lunarNormalStrength is a per-frame uniform and must not trigger a recompile",
  );
});

test("WebGPU moon normal upload matches the WebGL flipY convention", () => {
  const src = readText(
    "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  );
  const idx = src.indexOf("_loadMoonNormalTexture");
  assert.ok(idx > 0, "moon normal texture loader not found");
  const body = src.slice(idx, idx + 3000);
  assert.match(
    body,
    /uploadImageToTexture\([\s\S]*?flipY:\s*true/,
    "the WebGPU normal-map upload must pass flipY:true — the green channel encodes NORTH, " +
      "so a v-flip lights every crater from the wrong side on WebGPU only",
  );
  // Binding 3 must be wired in the layout AND the bind group.
  assert.match(
    src,
    /createEllipsoidBindGroupLayout\(device,\s*\{\s*normalTexture:\s*true\s*\}\)/,
    "the moon must opt into binding 3 in its bind group layout",
  );
  assert.match(
    src,
    /\{\s*binding:\s*3,\s*resource:\s*cache\.normalTextureView\s*\}/,
    "the bind group must supply binding 3",
  );
  // The uniform buffer grew add-only.
  assert.match(
    src,
    /const MOON_UNIFORM_BUFFER_SIZE = 352;/,
    "the moon UB must be 352 bytes (336 + the C12-25 normalStrength slot)",
  );
  assert.match(
    src,
    /ud\[84\] = frameState\.moonNormalMapStrength/,
    "normalStrength must be packed at float offset 84 (byte 336)",
  );
});

test("GLSL and WGSL tangent-frame constructions remain twins", () => {
  const glsl = readText("packages/engine/Source/Shaders/EllipsoidFS.glsl");
  const wgsl = readText(
    "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
  );

  // Both must decode the map the same way: n * 2 - 1.
  assert.match(
    glsl,
    /texture\(u_lunarNormalMap,\s*st\)\.xyz\s*\*\s*2\.0\s*-\s*1\.0/,
  );
  assert.match(
    wgsl,
    /textureSampleLevel\(normalTex,\s*samp,\s*uv,\s*0\.0\)\.xyz\s*\*\s*2\.0\s*-\s*1\.0/,
  );

  // Both must scale only the TANGENTIAL components by the strength — scaling
  // z too would change the perturbation's character, not just its magnitude.
  assert.match(glsl, /nTS\.xy\s*\*=\s*u_lunarNormalStrength/);
  assert.match(wgsl, /nRaw\.xy\s*\*\s*u\.normalStrength/);

  // Both must build EAST as (-y, x, 0) in MODEL space, guarded at the poles.
  assert.match(glsl, /vec3\(-positionMC\.y,\s*positionMC\.x,\s*0\.0\)/);
  assert.match(wgsl, /vec3<f32>\(-hitMC\.y,\s*hitMC\.x,\s*0\.0\)/);
  assert.match(glsl, /1\.0e-6/, "GLSL pole guard missing");
  assert.match(wgsl, /1\.0e-6/, "WGSL pole guard missing");

  // Both must build NORTH as cross(up, east) — the opposite order would flip
  // the green channel's meaning on one backend only.
  assert.match(glsl, /cross\(upMC,\s*eastMC\)/);
  assert.match(wgsl, /cross\(upMC,\s*eastMC\)/);

  // Both must recombine in the same order and normalize.
  assert.match(
    glsl,
    /normalize\(eastMC\s*\*\s*nTS\.x\s*\+\s*northMC\s*\*\s*nTS\.y\s*\+\s*upMC\s*\*\s*nTS\.z\)/,
  );
  assert.match(
    wgsl,
    /normalize\(eastMC\s*\*\s*nTS\.x\s*\+\s*northMC\s*\*\s*nTS\.y\s*\+\s*upMC\s*\*\s*nTS\.z\)/,
  );

  // Neither side may sneak in a compensating flip.
  assert.doesNotMatch(
    glsl,
    /nTS\.y\s*=\s*-/,
    "a green-channel flip in one shader would break parity with its twin",
  );
  assert.doesNotMatch(wgsl, /nTS\.y\s*=\s*-/);
});

test("WGSL declares binding 3 and the normalStrength uniform at the tail", () => {
  const wgsl = readText(
    "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
  );
  assert.match(
    wgsl,
    /@group\(0\)\s*@binding\(3\)\s*var normalTex:\s*texture_2d<f32>/,
    "binding 3 must be the normal map (0/1/2 are UB / albedo / sampler)",
  );
  // Binding 3 must reuse the binding-2 sampler rather than declaring a fourth.
  assert.doesNotMatch(
    wgsl,
    /@binding\(4\)/,
    "the normal map must reuse the existing sampler at binding 2",
  );
  assert.match(
    wgsl,
    /normalStrength:\s*f32,\s*\/\/\s*336/,
    "normalStrength must sit at byte 336 — add-only at the tail, existing offsets frozen",
  );
  // The zero-strength path must skip the fetch entirely.
  assert.match(
    wgsl,
    /if\s*\(u\.normalStrength\s*>\s*0\.0\)/,
    "a zero strength must short-circuit to the exact identity",
  );
});
