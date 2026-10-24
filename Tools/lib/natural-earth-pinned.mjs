/**
 * Pinned Natural Earth sources for the bundled water-mask builders.
 * @purpose One table of the natural-earth-vector commit and the SHA-256 of every GeoJSON source the water-mask builders read, so a network rebuild is reproducible and a changed source fails loudly.
 * @status ACTIVE
 *
 * The water binaries under `packages/engine/Source/Assets/WaterMask/` are
 * tracked only with a reproducible builder that pins its source URLs and
 * hashes (maintainer ruling R-2026-10-22-5). The builders used to read the
 * repository's `master` branch with no recorded hash. `master` has not moved
 * since this commit (2022-06-02), and a rebuild of the coastline, lake and
 * river binaries from these exact files reproduces the bundled bytes.
 *
 * A network build downloads from the commit below and REFUSES a file whose
 * hash differs. A `--input` build verifies too, but only warns on a mismatch:
 * the builders' specs drive them with small synthetic fixtures, and the
 * warning says plainly that such an output is not the bundled build.
 *
 * Natural Earth is public domain (https://www.naturalearthdata.com/about/terms-of-use/).
 * No identity is sent with the download: a plain `fetch`, no headers.
 */
import crypto from "node:crypto";
import fs from "node:fs";

export const NATURAL_EARTH_COMMIT = "ca96624a56bd078437bca8184e78163e5039ad19";

export const NATURAL_EARTH_SHA256 = Object.freeze({
  "ne_10m_land.geojson":
    "1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416",
  "ne_10m_minor_islands.geojson":
    "8c933ca7a4760256bdc46408355706e39764b0fa01c160c28888b90b4faec29f",
  "ne_10m_antarctic_ice_shelves_polys.geojson":
    "8f9bf62368695f5664b5fcd9bc0e2baea66da295aea014ce0e9cf510f209898d",
  "ne_10m_lakes.geojson":
    "2d036f53dedec578001c5c30c2959ee7d4eebc1306900fa4367c49929ec8f2d9",
  "ne_10m_lakes_north_america.geojson":
    "76f49d4b698f3529e690136a989713bcd3c028ade150346f4b358de9815cfc43",
  "ne_10m_lakes_europe.geojson":
    "b4dd9e7a5edd0d07b54768b5404d1ebe77f80b9d579c85fff65f90cf50369769",
  "ne_10m_playas.geojson":
    "3ece2a37f3e87d46869a45b05205bb78e273c83e191cee9ab60936368f4b9cc6",
  "ne_10m_reefs.geojson":
    "4dcfb7cb57e7c04108df66ca0ac1bb4125b2b40b6bb45d7d2aa589bd4e46dc57",
  "ne_10m_rivers_lake_centerlines.geojson":
    "bb854a900ecbd3b408df46d5e16e3e0f974ba55993f9d8b5c26e855273c0905a",
});

/** The pinned download URL of one source file. */
export function naturalEarthUrl(name) {
  if (!Object.hasOwn(NATURAL_EARTH_SHA256, name)) {
    throw new Error(`${name} is not a pinned Natural Earth source`);
  }
  return `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NATURAL_EARTH_COMMIT}/geojson/${name}`;
}

/**
 * Checks one source's bytes against the pin.
 *
 * @param {Uint8Array} bytes The source's bytes.
 * @param {string} name The source file name.
 * @param {{ strict: boolean, warn?: (message: string) => void }} options
 *   `strict` throws on a mismatch (network builds); otherwise `warn` is called.
 * @returns {boolean} True when the bytes are the pinned file.
 */
export function verifyNaturalEarthSource(bytes, name, options) {
  const expected = NATURAL_EARTH_SHA256[name];
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual === expected) {
    return true;
  }
  const message =
    expected === undefined
      ? `${name} is not a pinned Natural Earth source`
      : `${name} SHA-256 ${actual} is not the pinned ${expected} (natural-earth-vector ${NATURAL_EARTH_COMMIT})`;
  if (options.strict) {
    throw new Error(message);
  }
  (options.warn ?? console.warn)(
    `WARNING: ${message}. This output is NOT the reproducible bundled build.`,
  );
  return false;
}

/** Downloads one pinned source, refusing it unless its SHA-256 matches. */
export async function fetchPinnedNaturalEarthSource(name) {
  const url = naturalEarthUrl(name);
  console.log(`Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  verifyNaturalEarthSource(bytes, name, { strict: true });
  return bytes;
}

/** Reads one local source, warning (not throwing) when it is not the pinned file. */
export function readNaturalEarthSource(filePath, name) {
  const bytes = fs.readFileSync(filePath);
  verifyNaturalEarthSource(bytes, name, { strict: false });
  return bytes;
}
