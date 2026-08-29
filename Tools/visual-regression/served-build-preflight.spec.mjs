// @purpose Q-98 — regression coverage for the served-vs-disk build preflight
// helper: a byte-identical match, a served/disk mismatch, and an artifact
// missing on disk must each be reported distinctly and correctly, for both
// a single artifact and the multi-artifact roll-up.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/served-build-preflight.spec.mjs
//
// No browser. A real `node:http` server on a loopback port serves fixture
// files from a temp directory; the helper under test does real HTTP fetches
// against it and real `fs.readFileSync` reads against a (possibly
// different) temp directory — this exercises the actual network and
// filesystem code paths, not a mock of either.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SERVED_BUILD_ARTIFACTS,
  inspectServedBuildArtifact,
  preflightServedBuildArtifacts,
} from "./lib/served-build-preflight.mjs";

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");

/** Serves `root` as static files over a real loopback HTTP server. Returns
 * `{origin, close}`; `close` must be awaited before the temp directory is
 * removed. Missing files 404 — the same observable a stale/never-built
 * artifact produces against the real dev server. */
async function serveDirectory(root) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const filePath = path.join(root, decodeURIComponent(url.pathname));
    fs.readFile(filePath, (error, bytes) => {
      if (error) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(bytes);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function writeFixture(root, relativePath, bytes) {
  const absolute = path.join(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
}

test("inspectServedBuildArtifact: byte-identical served bytes match disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "served-preflight-match-"));
  const server = await serveDirectory(root);
  try {
    const relativePath = "Build/CesiumUnminified/Cesium.js";
    const bytes = Buffer.from("/* fixture cesium bundle */");
    await writeFixture(root, relativePath, bytes);

    const result = await inspectServedBuildArtifact({
      origin: server.origin,
      relativePath,
      repositoryRoot: root,
    });

    assert.equal(result.match, true);
    assert.equal(result.disk.exists, true);
    assert.equal(result.served.ok, true);
    assert.equal(result.served.status, 200);
    assert.equal(result.disk.md5, md5(bytes));
    assert.equal(result.served.md5, result.disk.md5);
    assert.equal(result.disk.byteLength, bytes.byteLength);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectServedBuildArtifact: served bytes differing from disk is a mismatch, not a crash", async () => {
  // Two separate roots: `servedRoot` is what the HTTP server hands back
  // (standing in for a dev server that hasn't picked up a landing yet);
  // `diskRoot` is what `repositoryRoot` reads directly (standing in for the
  // current working tree). Same relative path, deliberately different
  // bytes — exactly the Batch 1270 hazard (a landing changed source after
  // the server was still serving an older build).
  const servedRoot = await mkdtemp(
    path.join(tmpdir(), "served-preflight-mismatch-served-"),
  );
  const diskRoot = await mkdtemp(
    path.join(tmpdir(), "served-preflight-mismatch-disk-"),
  );
  const server = await serveDirectory(servedRoot);
  try {
    const relativePath = "packages/engine/Build/Unminified/index.js";
    await writeFixture(servedRoot, relativePath, Buffer.from("stale-served"));
    await writeFixture(
      diskRoot,
      relativePath,
      Buffer.from("current-disk-bytes"),
    );

    const result = await inspectServedBuildArtifact({
      origin: server.origin,
      relativePath,
      repositoryRoot: diskRoot,
    });

    assert.equal(result.match, false);
    assert.equal(result.disk.exists, true);
    assert.equal(result.served.ok, true);
    assert.notEqual(result.served.md5, result.disk.md5);
  } finally {
    await server.close();
    await rm(servedRoot, { recursive: true, force: true });
    await rm(diskRoot, { recursive: true, force: true });
  }
});

test("inspectServedBuildArtifact: missing on disk is reported as absent, not thrown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "served-preflight-missing-"));
  const server = await serveDirectory(root);
  try {
    const result = await inspectServedBuildArtifact({
      origin: server.origin,
      relativePath: "Build/CesiumUnminified/Cesium.js",
      repositoryRoot: root,
    });

    assert.equal(result.match, false);
    assert.equal(result.disk.exists, false);
    assert.equal(result.disk.error, "ENOENT");
    // Never built server-side either — same fixture, same absence.
    assert.equal(result.served.ok, false);
    assert.equal(result.served.status, 404);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectServedBuildArtifact: a truncated response body is reported as a served failure, not thrown (FU-1)", async () => {
  // A server that announces a Content-Length larger than the bytes it
  // actually sends, then destroys the socket mid-body — the connection
  // equivalent of Batch 1270's mid-tranche landing, but at the transport
  // layer instead of the source tree. Before the FU-1 fix,
  // `response.arrayBuffer()` threw (observed as `TypeError: terminated`)
  // outside every guard in this module, escaping `inspectServedBuildArtifact`
  // and rejecting `preflightServedBuildArtifacts` uncaught.
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Length": "10000" });
    response.write(Buffer.from("only a few bytes, then the socket dies"));
    // The delay matters: destroying synchronously can fail the connection
    // before the client ever receives a response (surfacing as `fetch()`
    // itself throwing, a case the outer guard already covered pre-fix). A
    // short delay lets headers land and `fetch()` resolve with a 200 first,
    // so the truncation is discovered inside `response.arrayBuffer()` —
    // the exact site FU-1 fixed.
    setTimeout(() => response.destroy(), 50);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(
    path.join(tmpdir(), "served-preflight-truncated-"),
  );
  try {
    const relativePath = "Build/CesiumUnminified/Cesium.js";
    await writeFixture(root, relativePath, Buffer.from("whatever disk holds"));

    const result = await inspectServedBuildArtifact({
      origin,
      relativePath,
      repositoryRoot: root,
    });

    assert.equal(result.match, false);
    assert.equal(result.served.ok, false);
    assert.equal(result.served.byteLength, null);
    assert.equal(result.served.md5, null);
    assert.equal(typeof result.served.error, "string");
    assert.ok(result.served.error.length > 0);
    // Disk-side reading is untouched by the served-side failure.
    assert.equal(result.disk.exists, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("preflightServedBuildArtifacts: ok is true only when every artifact matches, and defaults to the Q-3E-A-5 two-artifact set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "served-preflight-multi-"));
  const server = await serveDirectory(root);
  try {
    for (const relativePath of DEFAULT_SERVED_BUILD_ARTIFACTS) {
      await writeFixture(
        root,
        relativePath,
        Buffer.from(`fixture for ${relativePath}`),
      );
    }

    const allMatch = await preflightServedBuildArtifacts({
      origin: server.origin,
      repositoryRoot: root,
    });
    assert.equal(allMatch.ok, true);
    assert.equal(
      allMatch.artifacts.length,
      DEFAULT_SERVED_BUILD_ARTIFACTS.length,
    );
    assert.deepEqual(
      allMatch.artifacts.map((artifact) => artifact.path),
      [...DEFAULT_SERVED_BUILD_ARTIFACTS],
    );

    // One artifact goes missing on disk (simulating the Sandcastle2 engine
    // bundle never having been built) — the whole preflight must fail, not
    // just the one entry silently dropping out.
    await rm(path.join(root, DEFAULT_SERVED_BUILD_ARTIFACTS[1]));
    const oneMissing = await preflightServedBuildArtifacts({
      origin: server.origin,
      repositoryRoot: root,
    });
    assert.equal(oneMissing.ok, false);
    assert.equal(oneMissing.artifacts[0].match, true);
    assert.equal(oneMissing.artifacts[1].match, false);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Mutation check (CLAUDE.md Principle 10): prove the verdict actually tracks
// both sides of the comparison — flipping ONLY the disk side of an
// already-matched pair (the served side does not change; the server keeps
// answering with the same bytes it always has, standing in for a dev server
// that hasn't restarted/rebuilt) must flip `match` from true to false. An
// inert helper that only checks "both sides were readable" would still
// report true here.
test("mutant check: drifting disk out from under an already-matched pair flips the verdict", async () => {
  const servedRoot = await mkdtemp(
    path.join(tmpdir(), "served-preflight-mutant-served-"),
  );
  const diskRoot = await mkdtemp(
    path.join(tmpdir(), "served-preflight-mutant-disk-"),
  );
  const server = await serveDirectory(servedRoot);
  try {
    const relativePath = "Build/CesiumUnminified/Cesium.js";
    await writeFixture(servedRoot, relativePath, Buffer.from("v1"));
    await writeFixture(diskRoot, relativePath, Buffer.from("v1"));

    const matched = await inspectServedBuildArtifact({
      origin: server.origin,
      relativePath,
      repositoryRoot: diskRoot,
    });
    assert.equal(matched.match, true);

    // Disk moves on (a landing changed the file); the server keeps serving
    // what it already had.
    await writeFixture(diskRoot, relativePath, Buffer.from("v2-on-disk-only"));
    const driftedDisk = await inspectServedBuildArtifact({
      origin: server.origin,
      relativePath,
      repositoryRoot: diskRoot,
    });
    assert.equal(driftedDisk.match, false);
  } finally {
    await server.close();
    await rm(servedRoot, { recursive: true, force: true });
    await rm(diskRoot, { recursive: true, force: true });
  }
});
