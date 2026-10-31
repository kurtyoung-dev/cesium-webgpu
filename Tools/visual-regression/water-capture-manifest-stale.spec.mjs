// water-capture-manifest-stale.spec.mjs - a capture-manifest.json an earlier run left behind never survives a failed manifest write, water or landing.
// @purpose Row DX-KIT-WATER-MANIFEST-STALE-ON-THROW: when the manifest builder throws (a page whose rig is not registered, an I/O error) the shared throw-safe writer (writeLandingCaptureManifestOrViolations, used by writeWaterProbeManifest and by probe-landing-cells.mjs) removes a capture-manifest.json an earlier run left in the output folder and returns the reason as violations, so contact-sheet.mjs never sheets a stale manifest beside a fresh receipt; with an inertness mutant that makes the removal unreachable.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  LANDING_MANIFEST_FILE,
  writeLandingCaptureManifestOrViolations,
} from "./lib/landing-capture-manifest.mjs";
import * as piece from "./lib/water-capture-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_FILE = path.join(here, "lib/landing-capture-manifest.mjs");

const CONTEXT_BASE = {
  origin: "http://localhost:8080",
  generatedAt: "2026-10-31T07:00:00.000Z",
};

/** The landing probe's call shape over the shared writer. */
const landingWriter = (write) => ({
  writeWaterProbeManifest: ({ pages, rigsById, context, fs: io }) =>
    write({
      ...(io && { fs: io }),
      pages,
      rigsById,
      origins: { AFTER: context.origin },
      generatedAt: context.generatedAt,
      servedBuildAssertion: "enforced",
      receipt: "landing-cells-report.json",
      outputDirectory: context.outputDirectory,
    }),
});

/** Run the writer on a folder holding a stale manifest and a builder that throws; returns what is left. */
function writeOnThrowingBuilder(mod, dir, extra = {}) {
  const stale = path.join(dir, LANDING_MANIFEST_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stale, '{"stale":true}');
  const warn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = mod.writeWaterProbeManifest({
      probe: "ssr-water",
      // A page whose rig is not registered: the builder throws.
      pages: [
        {
          cell: "ssr-water",
          rig: "no-such-rig",
          renderer: "webgpu",
          page: "a",
          run: 0,
        },
      ],
      rigsById: new Map(),
      context: { ...CONTEXT_BASE, outputDirectory: dir },
      ...extra,
    });
  } finally {
    console.warn = warn;
  }
  return { result, staleExists: fs.existsSync(stale) };
}

function assertStaleRemoved(mod, dir, extra) {
  const { result, staleExists } = writeOnThrowingBuilder(mod, dir, extra);
  assert.equal(result.written, false);
  assert.equal(result.path, null);
  assert.ok(result.violations.length > 0, "the result says why");
  assert.equal(staleExists, false, "no capture-manifest.json remains");
}

test("a builder that throws leaves no stale capture-manifest.json and says why", async () => {
  await withLaneTmp("water-manifest-stale-", async (root) => {
    assertStaleRemoved(piece, path.join(root, "out"));
    const { result } = writeOnThrowingBuilder(piece, path.join(root, "out2"));
    assert.match(result.violations.join("\n"), /no-such-rig/);
  });
});

test("the landing probe's writer (the same shared piece) removes the stale manifest on a builder throw too", async () => {
  await withLaneTmp("landing-manifest-stale-", async (root) => {
    assertStaleRemoved(
      landingWriter(writeLandingCaptureManifestOrViolations),
      path.join(root, "out"),
    );
  });
});

test("an injected fs gets the removal, and a folder that cannot be cleaned still returns the violations", async () => {
  await withLaneTmp("water-manifest-stale-fs-", async (root) => {
    const removed = [];
    const io = {
      ...fs,
      rmSync: (target) => {
        removed.push(target);
        throw new Error("EPERM");
      },
    };
    const dir = path.join(root, "out");
    const { result } = writeOnThrowingBuilder(piece, dir, { fs: io });
    assert.deepEqual(removed, [path.join(dir, LANDING_MANIFEST_FILE)]);
    assert.equal(result.written, false);
    assert.match(result.violations.join("\n"), /no-such-rig/);
  });
});

test("inertness mutant: the removal on the throw path made unreachable leaves the stale manifest, so the stale check goes red", async () => {
  await withLaneTmp("water-manifest-stale-mut-", async (root) => {
    assertStaleRemoved(
      landingWriter(writeLandingCaptureManifestOrViolations),
      path.join(root, "live"),
    );
    const mutated = await importMutated(SHARED_FILE, [
      [
        "      (inputs.fs ?? fs).rmSync(",
        "      false && (inputs.fs ?? fs).rmSync(",
      ],
    ]);
    assert.throws(
      () =>
        assertStaleRemoved(
          landingWriter(mutated.writeLandingCaptureManifestOrViolations),
          path.join(root, "mutant"),
        ),
      (error) => error instanceof assert.AssertionError,
    );
  });
});
