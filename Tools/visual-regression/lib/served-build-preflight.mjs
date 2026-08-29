// @purpose Q-98 — fetch one or more served build artifacts and compare each to
// its on-disk md5, so a preflight can name a page-specific artifact (the
// Sandcastle2 bucket's `packages/engine/Build/Unminified/index.js`) instead of
// only the main `Build/CesiumUnminified/Cesium.js` bundle the Q-76 preflight
// already covers.
// @status ACTIVE
//
// WHY THIS EXISTS. The Q-76 served-md5 preflight ("served == disk for
// Cesium.js") proved which bundle `node server.js` mounts at
// `/Build/CesiumUnminified/Cesium.js`. It says nothing about a Sandcastle2
// demo page, whose importmap
// (`Apps/Sandcastle2/templates/bucket.html`) resolves `@cesium/engine` to
// `packages/engine/Build/Unminified/index.js` — a different file, on a
// different route, sometimes served through a different mechanism (the dev
// server's in-memory esbuild context in default mode; a plain static read in
// `--serve-built` mode). A lane that preflights only the first artifact and
// then drives a Sandcastle2 demo has verified bytes the page never loads
// (Q-3E-A-5 / Q-98). This module gives every S5 probe and Edge tranche one
// shared, fetch-based check for "is the artifact this page actually imports
// the same bytes as what is on disk right now" — not what a manual `curl` +
// `md5sum` diagnostic happened to check that run.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");

/**
 * The artifact set an S5/Sandcastle2 preflight should check by default: the
 * main `Build/CesiumUnminified` entry most probes load directly, plus the
 * Sandcastle2 bucket's engine bundle its importmap resolves `@cesium/engine`
 * to (Q-3E-A-5's finding). Callers with a narrower or wider need pass their
 * own `artifacts` list to `preflightServedBuildArtifacts` instead.
 */
export const DEFAULT_SERVED_BUILD_ARTIFACTS = Object.freeze([
  "Build/CesiumUnminified/Cesium.js",
  "packages/engine/Build/Unminified/index.js",
]);

/**
 * Reads one file's bytes and fingerprints them, distinguishing "the file is
 * genuinely absent" (an ENOENT — a build that hasn't run yet) from any other
 * read failure (permission, wrong type — an integrity fault that must keep
 * failing loudly rather than being reported as a normal "missing" case).
 *
 * @param {string} absolutePath
 * @returns {{exists: boolean, byteLength: number|null, md5: string|null, error?: string}}
 */
function fingerprintDiskFile(absolutePath) {
  try {
    const bytes = fs.readFileSync(absolutePath);
    return { exists: true, byteLength: bytes.byteLength, md5: md5(bytes) };
  } catch (error) {
    return {
      exists: false,
      byteLength: null,
      md5: null,
      error: error?.code ?? String(error?.message ?? error),
    };
  }
}

/**
 * Fetches one served artifact and fingerprints the response bytes, without
 * comparing them to anything — the disk-vs-served comparison in
 * `inspectServedBuildArtifact` is what decides a match.
 *
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ok: boolean, status: number|null, byteLength: number|null, md5: string|null, error?: string}>}
 */
async function fingerprintServedArtifact(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    return {
      ok: false,
      status: null,
      byteLength: null,
      md5: null,
      error: String(error?.message ?? error),
    };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, byteLength: null, md5: null };
  }
  // FU-1 (station-3 review) - the body read must be guarded exactly like the
  // fetch call above it. A response that announced success (2xx,
  // `response.ok`) but whose body the connection then truncates - a lying
  // `Content-Length`, or the socket destroyed mid-stream - throws out of
  // `arrayBuffer()` (observed as `TypeError: terminated`). Every other
  // failure mode in this function already returns a structured result
  // instead of throwing; a truncated body must too, or it escapes
  // `inspectServedBuildArtifact` and rejects `preflightServedBuildArtifacts`
  // uncaught, contradicting this module's own reporting contract.
  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      ok: true,
      status: response.status,
      byteLength: bytes.byteLength,
      md5: md5(bytes),
    };
  } catch (error) {
    return {
      ok: false,
      status: response.status,
      byteLength: null,
      md5: null,
      error: String(error?.message ?? error),
    };
  }
}

/**
 * Fetches one served build artifact and compares it to the file at the same
 * repo-relative path on disk. A repo-relative path doubles as the URL path
 * — true for every artifact this module knows about (`Build/CesiumUnminified/
 * Cesium.js` is served at `/Build/CesiumUnminified/Cesium.js`;
 * `packages/engine/Build/Unminified/index.js` likewise) — so callers never
 * hand-maintain two paths per artifact that could quietly drift apart.
 *
 * @param {object} options
 * @param {string} options.origin e.g. `"http://localhost:8080"`
 * @param {string} options.relativePath repo-relative path, also used as the URL path
 * @param {string} options.repositoryRoot absolute path `relativePath` resolves against
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<object>} a structured per-artifact result
 */
export async function inspectServedBuildArtifact(options) {
  const { origin, relativePath, repositoryRoot, fetchImpl = fetch } = options;
  const urlPath = relativePath.replaceAll("\\", "/");
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  const url = new URL(urlPath, base).href;
  const disk = fingerprintDiskFile(path.join(repositoryRoot, relativePath));
  const served = await fingerprintServedArtifact(url, fetchImpl);
  const match =
    disk.exists === true &&
    served.ok === true &&
    disk.byteLength === served.byteLength &&
    disk.md5 === served.md5;
  return { path: relativePath, url, disk, served, match };
}

/**
 * Preflights a set of served build artifacts against one server origin.
 * `ok` is true only when EVERY artifact matched — one stale/missing/
 * unreachable artifact fails the whole preflight, the same fail-closed
 * posture `--serve-built` itself uses (`server.js:37-49`).
 *
 * @param {object} options
 * @param {string} options.origin
 * @param {string} options.repositoryRoot
 * @param {Array<string>} [options.artifacts] defaults to DEFAULT_SERVED_BUILD_ARTIFACTS
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ok: boolean, origin: string, artifacts: Array<object>}>}
 */
export async function preflightServedBuildArtifacts(options) {
  const artifacts = options.artifacts ?? DEFAULT_SERVED_BUILD_ARTIFACTS;
  const results = [];
  for (const relativePath of artifacts) {
    // Sequential, not Promise.all: a structured result always lists
    // artifacts in the order the caller gave them, matching the shape of
    // every other S5 preflight report.
    results.push(
      await inspectServedBuildArtifact({
        origin: options.origin,
        relativePath,
        repositoryRoot: options.repositoryRoot,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  return {
    ok: results.every((result) => result.match === true),
    origin: options.origin,
    artifacts: results,
  };
}
