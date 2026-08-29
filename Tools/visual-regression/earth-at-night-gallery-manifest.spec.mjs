// @purpose Q-147: assert the built Sandcastle2 gallery manifest carries no
// backend-conditional claim about earth-at-night's emissive city lights (SR-12:
// assert what the runtime serves, never source text). `buildGalleryList` is a
// pure-Node function (no browser, no gulp) that produces the exact
// public/gallery/list.json a served Sandcastle2 instance reads its card
// descriptions from, so it is run for real here rather than parsed as text.
// The sandcastle.yaml/main.js mutual-consistency check is separate and is
// review guidance only, per the row's acceptance clause.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "..", "..");
const SANDCASTLE_ROOT = path.join(REPOSITORY_ROOT, "packages", "sandcastle");
const BUILD_GALLERY_PATH = path.join(
  SANDCASTLE_ROOT,
  "scripts",
  "buildGallery.js",
);

const BACKEND_CONDITIONAL_PATTERN = /\bon WebGPU\b/i;

test(
  "Q-147: the generated gallery manifest's earth-at-night description carries no backend-conditional emissive-lights claim",
  { timeout: 60_000 },
  async () => {
    const { buildGalleryList } = await import(
      pathToFileURL(BUILD_GALLERY_PATH).href
    );
    const { default: sandcastleConfig } = await import(
      pathToFileURL(path.join(SANDCASTLE_ROOT, "sandcastle.config.js")).href
    );

    // Mirrors the CLI entry point at the bottom of buildGallery.js: same
    // config-derived options (metadata keys, search options, filters,
    // sourceUrl), so every yaml's declared keys are recognised the same way
    // `npm run build-gallery` recognises them. Only the embeddings leg is
    // dropped -- irrelevant to a text-field assertion and the only part of
    // the generator that needs network access.
    const { root, publicDirectory, gallery, sourceUrl } = sandcastleConfig;
    const configRoot = root
      ? path.join(SANDCASTLE_ROOT, root)
      : SANDCASTLE_ROOT;
    const output = await buildGalleryList({
      rootDirectory: configRoot,
      publicDirectory,
      galleryFiles: gallery.files,
      sourceUrl,
      defaultThumbnail: gallery.defaultThumbnail,
      searchOptions: gallery.searchOptions,
      defaultFilters: gallery.defaultFilters,
      metadata: gallery.metadata,
      includeDevelopment: gallery.includeDevelopment,
      generateEmbeddings: false,
    });

    assert.ok(
      Array.isArray(output.entries) && output.entries.length > 0,
      "generator must produce at least one gallery entry",
    );

    const entry = output.entries.find((e) => e.id === "earth-at-night");
    assert.ok(
      entry,
      "earth-at-night entry must exist in the generated manifest",
    );

    // Cross-check against the file the manifest was written to, so the
    // assertion is against "what a served instance reads" and not just the
    // in-process return value.
    const manifestPath = path.join(
      SANDCASTLE_ROOT,
      "public",
      "gallery",
      "list.json",
    );
    const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const onDiskEntry = onDisk.entries.find((e) => e.id === "earth-at-night");
    assert.ok(
      onDiskEntry,
      "earth-at-night entry must exist in list.json on disk",
    );
    assert.equal(
      onDiskEntry.description,
      entry.description,
      "in-process result and the written manifest must agree",
    );

    assert.doesNotMatch(
      entry.description,
      BACKEND_CONDITIONAL_PATTERN,
      `manifest description must not gate emissive city lights on WebGPU: ${JSON.stringify(entry.description)}`,
    );
    assert.match(
      entry.description,
      /both renderers/i,
      "manifest description should say the feature is live on both renderers",
    );
  },
);

test("Q-147 (review guidance, not this row's acceptance bar): source yaml/main.js agree with each other", () => {
  const yamlPath = path.join(
    SANDCASTLE_ROOT,
    "gallery",
    "earth-at-night",
    "sandcastle.yaml",
  );
  const mainJsPath = path.join(
    SANDCASTLE_ROOT,
    "gallery",
    "earth-at-night",
    "main.js",
  );
  const yamlText = fs.readFileSync(yamlPath, "utf8");
  const mainJsText = fs.readFileSync(mainJsPath, "utf8");

  assert.doesNotMatch(
    yamlText,
    BACKEND_CONDITIONAL_PATTERN,
    "sandcastle.yaml must not gate emissive city lights on WebGPU",
  );
  assert.match(
    mainJsText,
    /live on both renderers/,
    "main.js's on-screen note must claim both renderers, matching the yaml",
  );
});
