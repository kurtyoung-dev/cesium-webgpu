// @purpose Verify that the development server selects and validates the requested Cesium artifact without opening a socket.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCesiumArtifact } from "../server.js";

function makeSandbox(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "dev-server-artifact-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function assertBuildFirstError(callback, builtDirectory, detail) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(builtDirectory), error.message);
    assert.ok(error.message.includes(detail), error.message);
    assert.match(error.message, /npx gulp build/);
    return true;
  });
}

test("flag absent selects the development build and enables generation", () => {
  const developmentDirectory = path.join("Build", "CesiumDev");
  const result = resolveCesiumArtifact({
    existsSync() {
      throw new Error("the default path must not inspect the built artifact");
    },
  });

  assert.deepEqual(result, {
    directory: developmentDirectory,
    generateDevelopmentBuild: true,
    label: "development build artifact",
  });
});

test("flag present selects an existing built artifact without generation", (t) => {
  const root = makeSandbox(t);
  const builtDirectory = path.join(root, "Build", "CesiumUnminified");
  fs.mkdirSync(builtDirectory, { recursive: true });
  fs.writeFileSync(path.join(builtDirectory, "Cesium.js"), "built artifact");

  const result = resolveCesiumArtifact({ serveBuilt: true, builtDirectory });

  assert.deepEqual(result, {
    directory: builtDirectory,
    generateDevelopmentBuild: false,
    label: "built artifact",
  });
});

test("flag present rejects a missing built artifact directory", (t) => {
  const root = makeSandbox(t);
  const builtDirectory = path.join(root, "Build", "CesiumUnminified");

  assertBuildFirstError(
    () => resolveCesiumArtifact({ serveBuilt: true, builtDirectory }),
    builtDirectory,
    "does not exist",
  );
});

test("flag present rejects a built artifact without Cesium.js", (t) => {
  const root = makeSandbox(t);
  const builtDirectory = path.join(root, "Build", "CesiumUnminified");
  fs.mkdirSync(builtDirectory, { recursive: true });

  assertBuildFirstError(
    () => resolveCesiumArtifact({ serveBuilt: true, builtDirectory }),
    builtDirectory,
    "Cesium.js",
  );
});
