// Purpose: prove that every Sharp resolution context this repository installs —
// the root devDependency and the one `@huggingface/transformers` resolves — can
// decode, transform and re-encode real pixels **inside one Node process**.
//
// Why one process matters: Sharp ships its own libvips. When two different Sharp
// versions load into the same process on Windows, the second one inherits the
// first one's already-registered GObject type table, and its enum ordinals no
// longer line up. Measured in this repository on 2026-09-10, before the
// version-scoped override landed (root 0.35.4 first, then the nested 0.34.5):
//
//   GLib-GObject-CRITICAL: value "32" of type 'gint' is invalid or out of range
//   for property 'space' of type 'VipsInterpretation'
//   -> colourspace: parameter space not set
//
// Each version in isolation passed, and the reverse load order passed. Only
// newer-then-older failed. The repair is the `@huggingface/transformers@4.2.0`
// -> `sharp 0.35.4` override in the root manifest, which collapses both
// contexts onto one installed copy. This smoke is that override's canary: with
// the override removed, npm nests 0.34.5 again and this file goes RED.
//
// RR-2026-09-08-1 also records a second, independent defect that this file
// works around rather than hides: **both** installed Sharp versions execute
// `removeAlpha` before `ensureAlpha` regardless of JavaScript chaining order,
// so a single pipeline carrying both flags emits four channels. The alpha is
// therefore removed from the *completed* PNG in a second Sharp instance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const rootRequire = createRequire(path.join(repoRoot, "package.json"));

// 3x2 RGB, deliberately asymmetric so a transposed or mirrored result cannot
// pass by accident.
const RAW_SOURCE = Buffer.from([
  10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170,
  180,
]);

// The 4x2 window that survives resize-to-6x4 (nearest) + extract at (2,2),
// with the single composited pixel at the top-left corner.
const EXPECTED_TRANSFORMED_RGB = [
  1, 2, 3, 130, 140, 150, 160, 170, 180, 160, 170, 180, 130, 140, 150, 130, 140,
  150, 160, 170, 180, 160, 170, 180,
];

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * The two resolution contexts, resolved eagerly and in the order that used to
 * fail: root first, then the copy `@huggingface/transformers` sees. Resolution
 * happens once, at module load, so every test below shares one process and one
 * pair of loaded native payloads.
 */
function resolveContexts() {
  const contexts = [{ label: "root", require: rootRequire }];
  let transformersEntry;
  try {
    transformersEntry = rootRequire.resolve("@huggingface/transformers");
  } catch {
    transformersEntry = undefined;
  }
  if (transformersEntry !== undefined) {
    contexts.push({
      label: "transformers-resolved",
      require: createRequire(transformersEntry),
    });
  }
  return contexts;
}

const contexts = resolveContexts();

function loadedNativePayloads() {
  const loaded = Object.keys(rootRequire.cache);
  return {
    nativeModulePaths: loaded
      .filter((modulePath) => modulePath.toLowerCase().endsWith(".node"))
      .sort(),
    wasmModulePaths: loaded
      .filter((modulePath) =>
        /(?:^|[\\/])@img[\\/]sharp-wasm32(?:[\\/]|$)/i.test(modulePath),
      )
      .sort(),
  };
}

async function encodeSource(sharp) {
  const encoded = await sharp(RAW_SOURCE, {
    raw: { width: 3, height: 2, channels: 3 },
  })
    .png()
    .toBuffer();
  const metadata = await sharp(encoded).metadata();
  return { encoded, metadata };
}

/**
 * The RR-2026-09-08-1 pipeline. The alpha-bearing work finishes and is encoded
 * to PNG; only then does a **second** Sharp instance drop the alpha channel.
 * Chaining `.removeAlpha()` onto the first pipeline yields four channels on
 * both installed versions, because libvips reorders the two operations.
 */
async function transformInTwoInstances(sharp, encoded) {
  const composited = await sharp(encoded)
    .resize({ width: 6, height: 4, kernel: "nearest" })
    .extract({ left: 2, top: 2, width: 4, height: 2 })
    .ensureAlpha()
    .composite([
      {
        input: Buffer.from([1, 2, 3, 255]),
        raw: { width: 1, height: 1, channels: 4 },
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  const flattened = await sharp(composited).removeAlpha().png().toBuffer();
  return { composited, flattened };
}

test("every installed Sharp resolution context is discoverable", () => {
  assert.ok(
    contexts.length >= 1,
    "the root devDependency must resolve a Sharp copy",
  );
  for (const context of contexts) {
    const sharp = context.require("sharp");
    assert.match(
      sharp.versions?.sharp ?? "",
      /^\d+\.\d+\.\d+/u,
      `${context.label} reports no Sharp version`,
    );
    assert.match(
      sharp.versions?.vips ?? "",
      /^\d+\.\d+\.\d+/u,
      `${context.label} reports no libvips version`,
    );
  }
});

test("one libvips serves every resolution context in this process", () => {
  const seen = contexts.map((context) => {
    const sharp = context.require("sharp");
    return {
      label: context.label,
      sharp: sharp.versions.sharp,
      vips: sharp.versions.vips,
    };
  });
  const vipsVersions = new Set(seen.map((entry) => entry.vips));
  assert.equal(
    vipsVersions.size,
    1,
    `two libvips builds cannot coexist in one process on Windows; saw ${JSON.stringify(seen)}`,
  );
});

for (const context of contexts) {
  test(`${context.label}: encodes raw RGB to PNG with three channels`, async () => {
    const sharp = context.require("sharp");
    const { metadata } = await encodeSource(sharp);
    assert.deepEqual(
      {
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        channels: metadata.channels,
      },
      { format: "png", width: 3, height: 2, channels: 3 },
      `${context.label} encoded metadata mismatch`,
    );
  });

  test(`${context.label}: resize/extract/composite then removeAlpha in a second instance yields 4x2x3`, async () => {
    const sharp = context.require("sharp");
    const { encoded } = await encodeSource(sharp);
    const { composited, flattened } = await transformInTwoInstances(
      sharp,
      encoded,
    );

    // The first instance is expected to still carry alpha. That is the defect
    // being worked around, asserted rather than assumed, so that a future Sharp
    // which fixes the ordering makes this expectation visibly stale instead of
    // silently redundant.
    const compositedMeta = await sharp(composited).metadata();
    assert.equal(
      compositedMeta.channels,
      4,
      `${context.label}: the alpha-bearing pipeline should still be RGBA`,
    );

    const decoded = await sharp(flattened)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual(
      {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: decoded.info.channels,
      },
      { width: 4, height: 2, channels: 3 },
      `${context.label} transformed dimensions/channels mismatch`,
    );
    assert.deepEqual(
      [...decoded.data],
      EXPECTED_TRANSFORMED_RGB,
      `${context.label} transformed pixels mismatch`,
    );
  });

  test(`${context.label}: round-trips EXIF orientation and auto-orients`, async () => {
    const sharp = context.require("sharp");
    const white = Buffer.alloc(2 * 3 * 3, 255);
    const oriented = await sharp(white, {
      raw: { width: 2, height: 3, channels: 3 },
    })
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    assert.equal(
      (await sharp(oriented).metadata()).orientation,
      6,
      `${context.label} orientation metadata missing`,
    );
    const autoOriented = await sharp(oriented)
      .autoOrient()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual(
      {
        width: autoOriented.info.width,
        height: autoOriented.info.height,
        channels: autoOriented.info.channels,
      },
      { width: 3, height: 2, channels: 3 },
      `${context.label} auto-orientation mismatch`,
    );
    assert.equal(
      autoOriented.data.length,
      18,
      `${context.label} auto-oriented content length mismatch`,
    );
    assert.ok(
      autoOriented.data.every((value) => value >= 250),
      `${context.label} auto-oriented content corrupted`,
    );
  });

  test(`${context.label}: rejects malformed input`, async () => {
    const sharp = context.require("sharp");
    let malformedError;
    try {
      await sharp(Buffer.from("not-an-image", "utf8")).metadata();
    } catch (error) {
      malformedError = error;
    }
    assert.ok(
      malformedError instanceof Error,
      `${context.label} malformed input was accepted`,
    );
  });
}

test("the native payload, not the wasm fallback, served the pipelines", () => {
  const payloads = loadedNativePayloads();
  assert.equal(
    payloads.wasmModulePaths.length,
    0,
    `the wasm32 fallback was loaded: ${payloads.wasmModulePaths.join(", ")}`,
  );
  assert.ok(
    payloads.nativeModulePaths.some((modulePath) =>
      /(?:^|[\\/])@img[\\/]sharp-[a-z0-9]+-[a-z0-9]+(?:[\\/]|$)/i.test(
        modulePath,
      ),
    ),
    `no @img native Sharp payload was loaded: ${payloads.nativeModulePaths.join(", ")}`,
  );
});

test("the transformed bytes are stable across contexts", async () => {
  const digests = [];
  for (const context of contexts) {
    const sharp = context.require("sharp");
    const { encoded } = await encodeSource(sharp);
    const { flattened } = await transformInTwoInstances(sharp, encoded);
    digests.push({ label: context.label, sha256: digest(flattened) });
  }
  const unique = new Set(digests.map((entry) => entry.sha256));
  assert.equal(
    unique.size,
    1,
    `resolution contexts disagreed on the transformed bytes: ${JSON.stringify(digests)}`,
  );
});
