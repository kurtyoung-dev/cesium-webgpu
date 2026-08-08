// readme-table.mjs — the SHARED, ENFORCEABLE home of the contract between the
// README's feature table and the screenshot manifest. Pure Node: no browser,
// no network, no GPU.
//
// WHY THIS IS A MODULE AND NOT TWO COPIES. The capture script and its spec both
// need the same answer to "does every table row have a scene, and does every
// scene have a row". This repo has repeatedly paid for the alternative: a
// checker embedded in the producer disagrees with the checker embedded in the
// guard, and the disagreement is discovered only when a run is already wrong.
// Both callers import THIS file, so a drift is impossible by construction —
// there is one parser, one validator, one cross-check.
//
// WHY THE CROSS-CHECK IS BIDIRECTIONAL. A one-way check ("every scene writes a
// file the README mentions") passes trivially when the README grows a row that
// nobody captured — the reader then gets a broken image. The reverse-only check
// passes when the manifest grows a scene nobody displays — dead capture work.
// `crossCheck` reports both directions and a table row with no scene is a hard
// failure, per DOC-01.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Every parser here
// normalises line endings before splitting; nothing anchors on a bare "\n".

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Directory (repo-relative, POSIX separators) the README points its images at. */
export const IMAGE_DIR = "Documentation/Images/webgpu-fork";

/** Fence markers delimiting the machine-read region of the README. */
export const TABLE_BEGIN = "<!-- FEATURE-TABLE:BEGIN -->";
export const TABLE_END = "<!-- FEATURE-TABLE:END -->";

/**
 * Camera "aims" a viewer scene may request. These are recipes the capture
 * script implements in-page because they cannot be expressed as static
 * lon/lat/height — they have to settle an ephemeris direction first.
 *
 * Exported so the spec can assert the capture script actually implements each
 * one. A manifest naming an aim the script does not handle is the exact shape
 * of a silently-wrong screenshot.
 */
export const SCENE_AIMS = Object.freeze(["none", "sun-disc", "moon-disc"]);

/** Scene kinds the capture script knows how to drive. */
export const SCENE_KINDS = Object.freeze(["viewer", "sandcastle", "page"]);

/** Content kinds a viewer scene may load before capture. */
export const CONTENT_TYPES = Object.freeze(["tileset", "model"]);

const LINES = (text) => text.replaceAll("\r\n", "\n").split("\n");

/**
 * Split a markdown table row into trimmed cells.
 *
 * A naive `split("|")` also yields the empty strings either side of the leading
 * and trailing pipes, which shifts every column index by one; both are dropped
 * here so callers can index by real column.
 *
 * @param {string} line One markdown table line.
 * @returns {string[]} The row's cells, in order.
 */
export function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return [];
  }
  const cells = trimmed.split("|");
  cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") {
    cells.pop();
  }
  return cells.map((c) => c.trim());
}

/** A `| --- | --- |` separator line, not a data row. */
const isSeparator = (cells) =>
  cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));

/**
 * Extract the image path from a Screenshot cell.
 *
 * Only markdown image syntax is accepted: `.markdownlint.json` sets
 * `no-inline-html` with just `details`/`summary` allowed, so an `<img>` tag
 * would fail lint — and a cell that silently parsed as "no screenshot" would
 * let a row ship with a missing picture.
 *
 * @param {string} cell The raw Screenshot cell text.
 * @returns {string|null} The repo-relative image path, or null.
 */
export function screenshotPath(cell) {
  const match = /!\[[^\]]*\]\(([^)\s]+)\)/.exec(cell);
  return match ? match[1] : null;
}

/**
 * Parse the fenced feature-table region of the README.
 *
 * @param {string} markdown Full README text.
 * @returns {{rows: object[], groups: string[], errors: string[]}} Parse result.
 */
export function parseFeatureTable(markdown) {
  const errors = [];
  const text = markdown.replaceAll("\r\n", "\n");
  const begin = text.indexOf(TABLE_BEGIN);
  const end = text.indexOf(TABLE_END);
  if (begin < 0 || end < 0 || end < begin) {
    errors.push(
      `README is missing the ${TABLE_BEGIN} / ${TABLE_END} fence around the feature table`,
    );
    return { rows: [], groups: [], errors };
  }

  const region = text.slice(begin + TABLE_BEGIN.length, end);
  const rows = [];
  const groups = [];
  let group = null;
  let sawHeader = false;

  for (const line of LINES(region)) {
    const heading = /^#{2,6}\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      group = heading[1];
      groups.push(group);
      sawHeader = false;
      continue;
    }
    const cells = tableCells(line);
    if (cells.length === 0) {
      continue;
    }
    if (isSeparator(cells)) {
      continue;
    }
    if (!sawHeader) {
      // First table line under a group heading is the column header.
      sawHeader = true;
      if (cells.length !== 4) {
        errors.push(
          `group "${group}": header has ${cells.length} columns, expected 4 (Feature | Status | Notes | Screenshot)`,
        );
      }
      continue;
    }
    if (group === null) {
      errors.push(`table row outside any group heading: ${line.trim()}`);
      continue;
    }
    if (cells.length !== 4) {
      errors.push(
        `group "${group}": row has ${cells.length} columns, expected 4: ${cells[0] ?? line.trim()}`,
      );
      continue;
    }
    const [feature, status, notes, shot] = cells;
    rows.push({
      group,
      feature: feature.replaceAll("**", "").trim(),
      status,
      notes,
      screenshot: screenshotPath(shot),
      screenshotCell: shot,
    });
  }

  if (rows.length === 0) {
    errors.push("the fenced feature-table region contains no data rows");
  }
  return { rows, groups, errors };
}

/**
 * Structural validation of a manifest object. Returns errors rather than
 * throwing so a caller can report every defect in one pass.
 *
 * @param {unknown} manifest Parsed `scenes.json` contents.
 * @returns {{scenes: object[], errors: string[]}} Validation result.
 */
export function validateManifest(manifest) {
  const errors = [];
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !Array.isArray(manifest.scenes)
  ) {
    return { scenes: [], errors: ["manifest has no `scenes` array"] };
  }
  const scenes = manifest.scenes;
  const ids = new Set();
  const outputs = new Set();

  for (const [index, scene] of scenes.entries()) {
    const where = `scenes[${index}]${scene?.id ? ` (${scene.id})` : ""}`;
    if (
      typeof scene?.id !== "string" ||
      !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(scene.id)
    ) {
      errors.push(`${where}: id must be kebab-case`);
      continue;
    }
    if (ids.has(scene.id)) {
      errors.push(`${where}: duplicate id`);
    }
    ids.add(scene.id);

    if (scene.output !== `${scene.id}.png`) {
      errors.push(
        `${where}: output must be "${scene.id}.png", got ${scene.output}`,
      );
    }
    if (outputs.has(scene.output)) {
      errors.push(`${where}: duplicate output ${scene.output}`);
    }
    outputs.add(scene.output);

    if (typeof scene.row !== "string" || scene.row.trim().length === 0) {
      errors.push(`${where}: row (the README feature name) is required`);
    }
    if (typeof scene.group !== "string" || scene.group.trim().length === 0) {
      errors.push(`${where}: group is required`);
    }
    if (!SCENE_KINDS.includes(scene.kind)) {
      errors.push(`${where}: kind must be one of ${SCENE_KINDS.join(", ")}`);
      continue;
    }
    if (scene.kind === "sandcastle") {
      if (typeof scene.gallery !== "string" || scene.gallery.length === 0) {
        errors.push(`${where}: sandcastle scenes need a gallery folder name`);
      }
    }
    if (scene.kind === "page") {
      if (typeof scene.url !== "string" || !scene.url.startsWith("/")) {
        errors.push(`${where}: page scenes need a root-relative url`);
      }
    }
    if (scene.aim !== undefined && !SCENE_AIMS.includes(scene.aim)) {
      errors.push(`${where}: unknown aim "${scene.aim}"`);
    }
    if (scene.aim !== undefined && scene.kind !== "viewer") {
      errors.push(`${where}: aim is only meaningful for viewer scenes`);
    }
    if (scene.view !== undefined) {
      if (scene.kind !== "viewer") {
        errors.push(`${where}: view is only meaningful for viewer scenes`);
      }
      for (const key of ["lon", "lat", "height"]) {
        if (typeof scene.view?.[key] !== "number") {
          errors.push(`${where}: view.${key} must be a number`);
        }
      }
    }
    if (
      scene.timeIso !== undefined &&
      Number.isNaN(Date.parse(scene.timeIso))
    ) {
      errors.push(`${where}: timeIso is not a parseable instant`);
    }
    for (const [i, setting] of (scene.settings ?? []).entries()) {
      // A single segment is legal: `viewer.shadows` is written as "shadows",
      // rooted at the viewer, exactly like the nested paths below it.
      if (
        typeof setting?.path !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(
          setting.path,
        )
      ) {
        errors.push(
          `${where}: settings[${i}].path is not a dotted property path`,
        );
      }
      if (setting?.value === undefined) {
        errors.push(`${where}: settings[${i}].value is required`);
      }
    }
    for (const [i, item] of (scene.content ?? []).entries()) {
      if (!CONTENT_TYPES.includes(item?.type)) {
        errors.push(
          `${where}: content[${i}].type must be one of ${CONTENT_TYPES.join(", ")}`,
        );
      }
      if (typeof item?.url !== "string" || !item.url.startsWith("/")) {
        errors.push(`${where}: content[${i}].url must be root-relative`);
      }
      for (const [j, setting] of (item?.settings ?? []).entries()) {
        if (
          typeof setting?.path !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(
            setting.path,
          )
        ) {
          errors.push(
            `${where}: content[${i}].settings[${j}].path is not a dotted property path`,
          );
        }
        if (setting?.value === undefined) {
          errors.push(
            `${where}: content[${i}].settings[${j}].value is required`,
          );
        }
      }
    }
    for (const [i, call] of (scene.calls ?? []).entries()) {
      if (
        typeof call !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(call)
      ) {
        errors.push(`${where}: calls[${i}] is not a dotted function path`);
      }
    }
    const pct = scene.minNonBlackPct;
    if (typeof pct !== "number" || !(pct > 0) || pct > 1) {
      errors.push(`${where}: minNonBlackPct must be a fraction in (0, 1]`);
    }
    if (typeof scene.minDistinct !== "number" || scene.minDistinct < 2) {
      errors.push(`${where}: minDistinct must be >= 2`);
    }
  }
  return { scenes, errors };
}

/**
 * Bidirectional cross-check between README rows and manifest scenes.
 *
 * @param {object[]} rows Parsed README rows.
 * @param {object[]} scenes Validated manifest scenes.
 * @returns {string[]} Every mismatch found, in both directions.
 */
export function crossCheck(rows, scenes) {
  const errors = [];
  const byImage = new Map();
  for (const scene of scenes) {
    byImage.set(`${IMAGE_DIR}/${scene.output}`, scene);
  }

  const seen = new Set();
  for (const row of rows) {
    if (row.screenshot === null) {
      errors.push(
        `README row "${row.feature}" (${row.group}) has no screenshot image — every row needs a scene`,
      );
      continue;
    }
    if (!row.screenshot.startsWith(`${IMAGE_DIR}/`)) {
      errors.push(
        `README row "${row.feature}" points outside ${IMAGE_DIR}/: ${row.screenshot}`,
      );
      continue;
    }
    const scene = byImage.get(row.screenshot);
    if (scene === undefined) {
      errors.push(
        `README row "${row.feature}" references ${row.screenshot} but no manifest scene produces it`,
      );
      continue;
    }
    if (seen.has(scene.id)) {
      errors.push(
        `manifest scene "${scene.id}" is claimed by more than one README row (second: "${row.feature}")`,
      );
    }
    seen.add(scene.id);
    if (scene.row !== row.feature) {
      errors.push(
        `manifest scene "${scene.id}" records row "${scene.row}" but the README row reads "${row.feature}"`,
      );
    }
    if (scene.group !== row.group) {
      errors.push(
        `manifest scene "${scene.id}" records group "${scene.group}" but the README group is "${row.group}"`,
      );
    }
  }

  for (const scene of scenes) {
    if (!seen.has(scene.id)) {
      errors.push(
        `manifest scene "${scene.id}" has no README row — remove it or add the row`,
      );
    }
  }
  return errors;
}

/**
 * Read the `legacyId` of a Sandcastle gallery folder.
 *
 * The new gallery (`packages/sandcastle/gallery/<folder>/`) is the catalogue;
 * the standalone page the probe fleet actually drives is
 * `Apps/Sandcastle/gallery/<legacyId>`. Resolving through the yaml keeps the
 * manifest addressed by gallery folder, as DOC-01 asks, without hard-coding the
 * spaced-and-capitalised legacy file names.
 *
 * @param {string} repoRoot Absolute repository root.
 * @param {string} gallery Gallery folder name.
 * @returns {string|null} The legacy file name, or null when absent.
 */
export function galleryLegacyId(repoRoot, gallery) {
  const yaml = join(
    repoRoot,
    "packages",
    "sandcastle",
    "gallery",
    gallery,
    "sandcastle.yaml",
  );
  if (!existsSync(yaml)) {
    return null;
  }
  for (const line of LINES(readFileSync(yaml, "utf8"))) {
    const match = /^legacyId:\s*(.+?)\s*$/.exec(line);
    if (match) {
      return match[1].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

/**
 * Resolve a scene to the URL the browser opens and the repo files it needs.
 *
 * Returning `requiredFiles` is what lets the spec fail at authoring time
 * instead of at capture time: a manifest pointing at a tileset that was moved
 * is caught by `node --test`, not by a 40-minute Edge run that ends in a black
 * PNG.
 *
 * @param {object} scene A validated manifest scene.
 * @param {string} repoRoot Absolute repository root.
 * @returns {{url: string, requiredFiles: string[], errors: string[]}} Resolution.
 */
export function resolveScene(scene, repoRoot) {
  const errors = [];
  const requiredFiles = [];
  let url;

  if (scene.kind === "sandcastle") {
    const legacyId = galleryLegacyId(repoRoot, scene.gallery);
    if (legacyId === null) {
      errors.push(
        `scene "${scene.id}": gallery "${scene.gallery}" has no sandcastle.yaml legacyId`,
      );
      url = "";
    } else {
      const rel = `Apps/Sandcastle/gallery/${legacyId}`;
      requiredFiles.push(rel);
      // Every fork demo reads `?renderer=` (three of them default to WebGPU
      // that way rather than pinning it in source), so the parameter is always
      // appended — harmless for the 26 that pin it, load-bearing for the rest.
      url = `/Apps/Sandcastle/gallery/${encodeURIComponent(legacyId)}?renderer=webgpu`;
    }
    requiredFiles.push(
      `packages/sandcastle/gallery/${scene.gallery}/sandcastle.yaml`,
    );
  } else if (scene.kind === "page") {
    url = scene.url;
    requiredFiles.push(scene.url.replace(/^\//, "").split("?")[0]);
  } else {
    url = "/Apps/CesiumViewer/index.html?renderer=webgpu";
  }

  for (const item of scene.content ?? []) {
    requiredFiles.push(item.url.replace(/^\//, "").split("?")[0]);
  }

  for (const rel of requiredFiles) {
    if (!existsSync(join(repoRoot, rel))) {
      errors.push(`scene "${scene.id}": required file is missing: ${rel}`);
    }
  }
  return { url, requiredFiles, errors };
}

/**
 * One-call authoring-time audit: parse, validate, cross-check, resolve.
 *
 * @param {string} readmeText Full README text.
 * @param {unknown} manifest Parsed manifest object.
 * @param {string} repoRoot Absolute repository root.
 * @returns {{rows: object[], scenes: object[], errors: string[]}} Audit result.
 */
export function auditContract(readmeText, manifest, repoRoot) {
  const parsed = parseFeatureTable(readmeText);
  const validated = validateManifest(manifest);
  const errors = [...parsed.errors, ...validated.errors];
  if (errors.length === 0) {
    errors.push(...crossCheck(parsed.rows, validated.scenes));
    for (const scene of validated.scenes) {
      errors.push(...resolveScene(scene, repoRoot).errors);
    }
  }
  return { rows: parsed.rows, scenes: validated.scenes, errors };
}
