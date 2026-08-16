// @purpose Unit tests for the extracted PickFrustumMath drawing-buffer-to-frustum coordinate mapping and pick-frustum half extents.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  drawingBufferToFrustumCoordinates,
  pickFrustumHalfExtents,
} from "../../packages/engine/Source/Scene/PickFrustumMath.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

test("symmetric center maps to the frustum axis", () => {
  const result = {};
  drawingBufferToFrustumCoordinates(
    400,
    300,
    0,
    0,
    800,
    600,
    -2,
    2,
    -1,
    1,
    result,
  );
  assert.deepEqual(result, { x: 0, y: 0 });
});

test("asymmetric frustum center retains its projection offset", () => {
  const result = {};
  drawingBufferToFrustumCoordinates(
    400,
    300,
    0,
    0,
    800,
    600,
    1,
    5,
    -3,
    1,
    result,
  );
  assert.deepEqual(result, { x: 3, y: -1 });
});

test("drawing-buffer viewport offsets map their own corners", () => {
  const lowerLeft = {};
  const upperRight = {};
  drawingBufferToFrustumCoordinates(
    100,
    50,
    100,
    50,
    400,
    200,
    -4,
    2,
    -2,
    6,
    lowerLeft,
  );
  drawingBufferToFrustumCoordinates(
    500,
    250,
    100,
    50,
    400,
    200,
    -4,
    2,
    -2,
    6,
    upperRight,
  );
  assert.deepEqual(lowerLeft, { x: -4, y: -2 });
  assert.deepEqual(upperRight, { x: 2, y: 6 });
});

test("pick aperture width and height scale independently", () => {
  const result = {};
  pickFrustumHalfExtents(-4, 2, -2, 6, 600, 400, 25, 9, result);
  assert.equal(result.x, 0.125);
  assert.equal(result.y, 0.09);
});

test("ordinary picking and snapping share the same coordinate home", () => {
  const picking = fs.readFileSync(
    path.join(root, "packages/engine/Source/Scene/Picking.js"),
    "utf8",
  );
  const snapping = fs.readFileSync(
    path.join(root, "packages/engine/Source/Scene/Snapping.js"),
    "utf8",
  );
  assert.match(picking, /from "\.\/PickFrustumMath\.js"/);
  assert.match(snapping, /from "\.\/PickFrustumMath\.js"/);
  assert.match(picking, /pickFrustumHalfExtents\(/);
  assert.match(snapping, /drawingBufferToFrustumCoordinates\(/);
});
