// moon-albedo-asset.spec.mjs — C12-24: pins the bundled lunar albedo asset,
// its UV/prime-meridian alignment, the both-backends upload convention, and
// the LICENSE.md provenance entry.
//
// These tests fail if:
//   - the shipped albedo map goes missing, changes dimensions, stops being a
//     2:1 equirectangular, or loses its 4:4:4 chroma (subsampling smears the
//     mare colour that is the whole reason for shipping a COLOUR map);
//   - the map's orientation drifts — a 180 deg longitude phase error (the
//     nearside painted on the farside), an east/west mirror, or a north/south
//     mirror. Each is caught by a specific named landmark check, and the
//     adversarial block below proves each check actually fires rather than
//     just passing vacuously;
//   - the WebGPU moon upload stops passing `flipY: true`. WebGL reaches the
//     moon texture through Material -> Texture, which defaults `flipY: true`;
//     `copyExternalImageToTexture` defaults to false. Both backends unwrap the
//     sphere with the identical v = asin(n.z)/PI + 0.5, so a divergence there
//     renders the WebGPU moon vertically MIRRORED against WebGL — invisible on
//     the old 256x128 map, obvious on this one;
//   - either shader's ellipsoid UV unwrap drifts from its twin (the swap is
//     texture-only BY DESIGN; if a v-flip ever appears in one shader and not
//     the other, that is the parity bug this asset exists to expose);
//   - the historical `moonSmall.jpg` fallback is deleted (it is still reachable
//     as `Moon.Variant.SMALL` and must stay bundled);
//   - the LICENSE.md "Bundled Engine Assets" entry for the map disappears or
//     stops matching the shipped bytes.
//
// The manifest at Tools/moon-albedo-bake/moon-albedo-manifest.json records the
// bake's own measurements. It is NOT trusted on its own: the spec re-derives
// the shipped file's SHA-256 and rejects the manifest if they disagree, so the
// recorded evidence can never drift away from the asset it describes.
//
// Run: node --test Tools/visual-regression/moon-albedo-asset.spec.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LANDMARKS,
  latToRow,
  lonToCol,
  runAlignmentChecks,
  wrapLon,
} from "../moon-albedo-bake/lunar-landmarks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const ASSET_REL =
  "packages/engine/Source/Assets/Textures/Moon/lroc_color_poles_2k.jpg";
const LEGACY_REL = "packages/engine/Source/Assets/Textures/moonSmall.jpg";
const MANIFEST_REL = "Tools/moon-albedo-bake/moon-albedo-manifest.json";

const abs = (rel) => path.join(root, rel);
const read = (rel) => fs.readFileSync(abs(rel));
const readText = (rel) => fs.readFileSync(abs(rel), "utf8");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const EXPECTED_WIDTH = 2048;
const EXPECTED_HEIGHT = 1024;

// ---------------------------------------------------------------------------
// Dependency-free JPEG header reader. Walks the marker chain to SOF0/SOF2 for
// dimensions + component count, and reads each component's sampling factors so
// chroma subsampling can be asserted without decoding a single MCU.
// ---------------------------------------------------------------------------
function readJpegFrame(buf) {
  assert.equal(buf[0], 0xff, "not a JPEG (missing SOI)");
  assert.equal(buf[1], 0xd8, "not a JPEG (missing SOI)");
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // Standalone markers carry no length payload.
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
    const length = buf.readUInt16BE(i + 2);
    // SOF0 (baseline) / SOF1 / SOF2 (progressive)
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const p = i + 4;
      const precision = buf[p];
      const height = buf.readUInt16BE(p + 1);
      const width = buf.readUInt16BE(p + 3);
      const numComponents = buf[p + 5];
      const components = [];
      for (let c = 0; c < numComponents; c++) {
        const q = p + 6 + c * 3;
        components.push({
          id: buf[q],
          h: buf[q + 1] >> 4,
          v: buf[q + 1] & 0x0f,
        });
      }
      return {
        precision,
        width,
        height,
        numComponents,
        components,
        progressive: marker === 0xc2,
      };
    }
    i += 2 + length;
  }
  throw new Error("no SOF marker found in JPEG");
}

// Optional decode path. `sharp` is a declared devDependency, so this normally
// runs; when it cannot be resolved (a trimmed install) the pixel-level tests
// skip rather than fail, and the header/hash/manifest pins still hold.
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
test("bundled albedo asset is present with the pinned geometry and encoding", () => {
  assert.ok(fs.existsSync(abs(ASSET_REL)), `missing ${ASSET_REL}`);
  const buf = read(ASSET_REL);
  const frame = readJpegFrame(buf);

  assert.equal(frame.width, EXPECTED_WIDTH, "albedo width");
  assert.equal(frame.height, EXPECTED_HEIGHT, "albedo height");
  assert.equal(
    frame.width,
    frame.height * 2,
    "an equirectangular map must be exactly 2:1 — the UV unwrap covers 360 deg of longitude by 180 deg of latitude",
  );
  assert.equal(
    frame.numComponents,
    3,
    "must be 3-component colour, not greyscale",
  );
  assert.equal(frame.precision, 8, "8-bit precision");

  // 4:4:4 == every component sampled at the same rate as luma.
  const [y, cb, cr] = frame.components;
  assert.equal(
    y.h,
    cb.h,
    "chroma Cb horizontal sampling must match luma (4:4:4)",
  );
  assert.equal(
    y.v,
    cb.v,
    "chroma Cb vertical sampling must match luma (4:4:4)",
  );
  assert.equal(
    y.h,
    cr.h,
    "chroma Cr horizontal sampling must match luma (4:4:4)",
  );
  assert.equal(
    y.v,
    cr.v,
    "chroma Cr vertical sampling must match luma (4:4:4)",
  );
});

test("historical moonSmall.jpg fallback is still bundled", () => {
  assert.ok(
    fs.existsSync(abs(LEGACY_REL)),
    "moonSmall.jpg must stay bundled — it is still reachable as Moon.Variant.SMALL",
  );
  const frame = readJpegFrame(read(LEGACY_REL));
  assert.equal(frame.width, 256);
  assert.equal(frame.height, 128);
});

test("manifest matches the shipped bytes (evidence cannot drift from the asset)", () => {
  const manifest = JSON.parse(readText(MANIFEST_REL));
  const actual = sha256(read(ASSET_REL));
  assert.equal(
    manifest.output.sha256,
    actual,
    "manifest sha256 != shipped file sha256 — re-run Tools/moon-albedo-bake/bake-lroc-color.mjs",
  );
  assert.equal(manifest.output.bytes, read(ASSET_REL).length);
  assert.equal(manifest.output.width, EXPECTED_WIDTH);
  assert.equal(manifest.output.height, EXPECTED_HEIGHT);

  // Provenance the LICENSE entry depends on.
  assert.match(manifest.source.url, /^https:\/\/svs\.gsfc\.nasa\.gov\//);
  assert.match(manifest.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.projection.centerLongitudeDeg, 0);
  assert.equal(manifest.projection.longitudePositive, "east");
  assert.equal(manifest.projection.rowZero, "north (+90 deg latitude)");

  // The bake refuses to install on a failing check; assert that is what was recorded.
  assert.ok(
    manifest.alignmentChecks.length >= 5,
    "expected the full check battery",
  );
  for (const c of manifest.alignmentChecks) {
    assert.equal(c.pass, true, `manifest records a failing check: ${c.name}`);
  }
});

test("LICENSE.md carries the Bundled Engine Assets entry for the map", () => {
  const license = readText("LICENSE.md");
  const bundled = license.slice(license.indexOf("# Bundled Engine Assets"));
  assert.ok(bundled.length > 0, "Bundled Engine Assets section missing");
  assert.ok(
    bundled.includes(ASSET_REL),
    "LICENSE.md must name the shipped albedo file inside Bundled Engine Assets",
  );
  assert.ok(bundled.includes("CGI Moon Kit"), "must name the NASA product");
  assert.ok(
    bundled.includes(
      "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_2k.tif",
    ),
    "must record the exact source URL",
  );
  assert.ok(
    bundled.includes(sha256(read(ASSET_REL))),
    "must record the shipped file's SHA-256",
  );
  assert.ok(bundled.includes("2026-08-01"), "must record the retrieval date");
  assert.ok(
    /Arizona State University/.test(bundled),
    "must credit the LROC team's underlying mosaic",
  );
});

// ---------------------------------------------------------------------------
// Alignment — the reason this spec exists.
// ---------------------------------------------------------------------------
test("landmark coordinate mapping matches the shader UV convention", () => {
  // u = atan2(n.y, n.x)/(2*PI) + 0.5  =>  u = 0.5 at lon 0, u grows eastward.
  assert.equal(
    lonToCol(0, EXPECTED_WIDTH),
    EXPECTED_WIDTH / 2,
    "0 deg longitude is map centre",
  );
  assert.equal(lonToCol(-180, EXPECTED_WIDTH), 0, "-180 deg is the left edge");
  assert.ok(
    lonToCol(90, EXPECTED_WIDTH) > lonToCol(-90, EXPECTED_WIDTH),
    "east longitude must increase to the right",
  );
  // v = asin(n.z)/PI + 0.5  =>  v = 1 at the north pole, which is image row 0
  // under the flipY:true upload both backends now use.
  assert.equal(latToRow(90, EXPECTED_HEIGHT), 0, "north pole is image row 0");
  assert.equal(
    latToRow(-90, EXPECTED_HEIGHT),
    EXPECTED_HEIGHT,
    "south pole is the last row",
  );
  assert.equal(
    latToRow(0, EXPECTED_HEIGHT),
    EXPECTED_HEIGHT / 2,
    "equator is the middle row",
  );
  assert.equal(wrapLon(190), -170);
  assert.equal(wrapLon(-190), 170);
});

test("named lunar landmarks have plausible published coordinates", () => {
  // Guards against a fat-fingered edit to the landmark table silently
  // relocating a feature and making the checks meaningless.
  for (const [name, m] of Object.entries(LANDMARKS)) {
    assert.ok(m.lon >= -180 && m.lon <= 180, `${name} longitude out of range`);
    assert.ok(m.lat >= -90 && m.lat <= 90, `${name} latitude out of range`);
    assert.ok(
      m.radius > 0 && m.radius < 20,
      `${name} sampling radius implausible`,
    );
  }
  // Spot-pin the three the task names, to their published centres.
  assert.ok(Math.abs(LANDMARKS.mareCrisium.lon - 59.1) < 1.0);
  assert.ok(Math.abs(LANDMARKS.mareCrisium.lat - 17.0) < 1.0);
  assert.ok(Math.abs(LANDMARKS.tycho.lon - -11.4) < 1.0);
  assert.ok(Math.abs(LANDMARKS.tycho.lat - -43.3) < 1.0);
  assert.ok(Math.abs(LANDMARKS.copernicus.lon - -20.1) < 1.0);
  assert.ok(Math.abs(LANDMARKS.copernicus.lat - 9.6) < 1.0);
});

test(
  "shipped albedo passes every landmark alignment check",
  { skip: sharp ? false : "sharp not resolvable" },
  async () => {
    const { pixels, width, height, channels } = await decodeAsset();
    assert.equal(width, EXPECTED_WIDTH);
    assert.equal(height, EXPECTED_HEIGHT);
    const result = runAlignmentChecks(pixels, width, height, channels);
    const failed = result.checks.filter((c) => !c.pass);
    assert.equal(
      failed.length,
      0,
      `alignment FAILED: ${failed.map((c) => `${c.name} (${c.value}, need ${c.threshold}) — ${c.detail}`).join("; ")}`,
    );
  },
);

test(
  "alignment checks REJECT every mis-orientation (the discriminator actually fires)",
  { skip: sharp ? false : "sharp not resolvable" },
  async () => {
    const { pixels, width: W, height: H, channels: C } = await decodeAsset();

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
      // Nearside painted on the farside — the classic prime-meridian error.
      shift180: (x, y) => [(x + W / 2) % W, y],
      // East/west swapped.
      mirrorLon: (x, y) => [W - 1 - x, y],
      // North/south swapped — exactly the defect a flipY mismatch produces.
      mirrorLat: (x, y) => [x, H - 1 - y],
      mirrorBoth: (x, y) => [W - 1 - x, H - 1 - y],
      rot180: (x, y) => [(x + W / 2) % W, H - 1 - y],
    };

    for (const [name, fn] of Object.entries(cases)) {
      const result = runAlignmentChecks(remap(fn), W, H, C);
      assert.equal(
        result.ok,
        false,
        `mis-orientation "${name}" was ACCEPTED — the alignment check is vacuous`,
      );
    }

    // And specifically: the 180 deg phase error must trip the check written
    // for it, not merely fail somewhere incidental.
    const shifted = runAlignmentChecks(remap(cases.shift180), W, H, C);
    const phase = shifted.checks.find(
      (c) => c.name === "nearsideDarkerThanFarside",
    );
    assert.equal(
      phase.pass,
      false,
      "a 180 deg phase error must fail nearsideDarkerThanFarside",
    );

    // ...and the north/south mirror must trip the Tycho test.
    const flipped = runAlignmentChecks(remap(cases.mirrorLat), W, H, C);
    const ns = flipped.checks.find((c) => c.name === "tychoBrighterThanMirror");
    assert.equal(
      ns.pass,
      false,
      "a north/south mirror must fail tychoBrighterThanMirror",
    );
  },
);

// ---------------------------------------------------------------------------
// Both-backends wiring.
// ---------------------------------------------------------------------------
test("Moon.js defaults to the 2K variant and keeps SMALL selectable", () => {
  const src = readText("packages/engine/Source/Scene/Moon.js");
  assert.match(
    src,
    /Moon\.Variant = Object\.freeze\(/,
    "Moon.Variant enum missing",
  );
  assert.match(src, /LROC_COLOR_2K:\s*"LROC_COLOR_2K"/);
  assert.match(
    src,
    /SMALL:\s*"SMALL"/,
    "the historical fallback must stay selectable",
  );
  assert.match(
    src,
    /Moon\.defaultVariant = Moon\.Variant\.LROC_COLOR_2K/,
    "the 2K map must be the default",
  );
  assert.match(
    src,
    /Assets\/Textures\/Moon\/lroc_color_poles_2k\.jpg/,
    "variant table must point at the shipped asset",
  );
  assert.match(
    src,
    /Assets\/Textures\/moonSmall\.jpg/,
    "SMALL variant must still resolve to moonSmall.jpg",
  );
});

test("WebGPU moon upload matches the WebGL flipY convention", () => {
  const src = readText(
    "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  );
  const idx = src.indexOf("function createMoonTextureRequestHooks");
  assert.ok(idx > 0, "moon texture realization hooks not found");
  // Look at the realization hooks, not the whole file. Both exact channels
  // deliberately share this orientation-safe upload path.
  const body = src.slice(idx, idx + 5000);
  assert.match(
    body,
    /uploadImageToTexture\([\s\S]*?flipY:\s*true/,
    "the WebGPU moon upload must pass flipY:true — WebGL's Texture defaults to " +
      "flipY:true and both backends share the v = asin(n.z)/PI + 0.5 unwrap, so " +
      "omitting it renders the WebGPU moon vertically mirrored against WebGL",
  );
});

test("GLSL and WGSL ellipsoid UV unwraps remain twins (swap is texture-only)", () => {
  const glsl = readText(
    "packages/engine/Source/Shaders/Builtin/Functions/ellipsoidTextureCoordinates.glsl",
  );
  const wgsl = readText(
    "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
  );

  // GLSL: atan(normal.y, normal.x) * czm_oneOverTwoPi + 0.5, asin(normal.z) * czm_oneOverPi + 0.5
  assert.match(
    glsl,
    /atan\(\s*normal\.y\s*,\s*normal\.x\s*\)\s*\*\s*czm_oneOverTwoPi\s*\+\s*0\.5/,
  );
  assert.match(
    glsl,
    /asin\(\s*normal\.z\s*\)\s*\*\s*czm_oneOverPi\s*\+\s*0\.5/,
  );

  // WGSL twin: same expression, same signs, no compensating flip.
  assert.match(
    wgsl,
    /atan2\(n\.y,\s*n\.x\)\s*\*\s*\(0\.5\s*\/\s*PI\)\s*\+\s*0\.5/,
  );
  assert.match(wgsl, /asin\(n\.z\)\s*\*\s*\(1\.0\s*\/\s*PI\)\s*\+\s*0\.5/);

  // Neither side may carry a v-flip: if one ever does, the backends diverge.
  assert.doesNotMatch(
    wgsl,
    /1\.0\s*-\s*\(?\s*asin\(n\.z\)/,
    "a v-flip in the WGSL unwrap would break parity with the GLSL twin — " +
      "the upload-side flipY is where the convention is reconciled",
  );
});
