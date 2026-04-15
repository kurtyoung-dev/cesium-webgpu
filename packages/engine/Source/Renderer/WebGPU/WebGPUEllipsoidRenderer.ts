/**
 * @module WebGPUEllipsoidRenderer
 *
 * Shared infrastructure for rendering ellipsoid bodies via the
 * **bounding-cube + analytic ray-march** approach. Phase 1.2c v2's Moon
 * shader pioneered this technique in our codebase; this module extracts
 * the body-agnostic JS plumbing so future ellipsoid bodies (Sun-as-
 * ellipsoid, custom planets, asteroid models) can share it.
 *
 * What's reusable:
 *   - The 8-vertex / 36-index unit cube mesh (rasterized in clip space,
 *     scaled to the ellipsoid radii by the vertex shader)
 *   - The bind group layout: `(uniform UBO, texture_2d, sampler)`
 *   - The first 64 floats of the uniform buffer — RTE camera, RTE center,
 *     inverse modelView 3×3, cameraPositionMC, radii, oneOverRadiiSq,
 *     two light directions in model coordinates, far plane / log-depth flag
 *
 * What stays per-body:
 *   - The shader source. Different bodies have different lighting,
 *     phase, atmospheric coupling, corona effects, etc. Each body owns
 *     its own .wgsl file but is encouraged to import the shared chunk
 *     functions (`csm_intersectEllipsoid`, `csm_geodeticSurfaceNormal`,
 *     `csm_ellipsoidTextureCoordinates`).
 *   - Body-specific uniform fields appended after offset 64.
 *   - The texture content (lunar surface vs sun corona vs planet albedo).
 *
 * Benefits over copy-paste:
 *   1. New ellipsoid bodies pay zero JS scaffolding cost — they use the
 *      shared cube + bind group layout + base uniform pack and only need
 *      to write their body-specific shader and the per-frame "extras"
 *      uniform writes.
 *   2. Optimizations to the bounding-cube approach (different cube
 *      tessellation, conservative back-face cull tweaks, geometry
 *      caching) land once and benefit every consumer.
 *   3. The approach stays consistent across bodies — every ellipsoid
 *      reads the same 64-float prefix, so debug overlays, snapshot mode
 *      hooks, and future render-bundle infrastructure all work uniformly.
 *
 * Existing consumers:
 *   - `WebGPUEnvironmentRenderer.js` Moon path (Phase 1.2c v2 + this
 *     consolidation)
 *
 * Future consumers (planned):
 *   - Sun-as-ellipsoid renderer (currently a procedural billboard)
 *   - Custom planet feature renderer
 *   - The orphan `WebGPUEllipsoidPrimitiveRenderer.ts` could be migrated
 *     from its current screen-space-quad approach to use this module.
 */

/// <reference types="@webgpu/types" />

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix3 from "../../Core/Matrix3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

/**
 * Number of float slots that the base uniform pack consumes (offsets
 * 0..63). Body-specific uniforms append starting at offset 64. Total
 * base footprint is 64 floats × 4 bytes = 256 bytes.
 */
export const ELLIPSOID_BASE_UNIFORM_FLOATS = 64;
export const ELLIPSOID_BASE_UNIFORM_BYTES = ELLIPSOID_BASE_UNIFORM_FLOATS * 4;

/**
 * GPU resources for the shared bounding cube. The same instance can be
 * reused across many ellipsoid bodies — the cube is unit-radius and gets
 * scaled per-body in the vertex shader by `radii`.
 */
export interface EllipsoidBoundingCube {
  vertexBuffer: WebGPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
}

/**
 * Inputs that fully describe one ellipsoid body for the base uniform
 * pack. The renderer passes one of these per frame to
 * `packEllipsoidBaseUniforms()` to fill offsets 0..63 of the uniform
 * buffer; body-specific writes happen after.
 */
export interface EllipsoidBaseUniformInputs {
  /**
   * `projection × modelView` with the body's translation column
   * **zeroed** so the result is the body-rotated MVP relative to the
   * eye. The shader applies the RTE position separately.
   */
  mvpRelativeToEye: ArrayLike<number>;
  /** Camera view matrix (column-major Matrix4 — i.e. `uniformState.view`). */
  viewMatrix: Matrix4;
  /** Camera position in world (ECEF) coords. */
  cameraPositionWC: Cartesian3;
  /**
   * Body model matrix (rotation + translation, no scale — radii are
   * applied in the shader). The translation column is the body center
   * in world coords; we extract it here for the RTE split.
   */
  modelMatrix: Matrix4;
  /** Body-frame radii (Cartesian3 with x/y/z). */
  radii: { x: number; y: number; z: number };
  /** Body-frame `1 / radii²` for geodetic normal + ray-march math. */
  oneOverRadiiSquared: { x: number; y: number; z: number };
  /** Sun direction in world coords (already normalized). */
  sunDirectionWC: Cartesian3;
  /**
   * Optional alternate light direction (e.g., when `scene.light` is a
   * MoonLight or a DirectionalLight). Falls back to `sunDirectionWC`.
   */
  sceneLightDirectionWC?: Cartesian3;
}

// ─── Bounding cube geometry ──────────────────────────────────────────
//
// Unit cube in [-1, 1]^3 model space. The vertex shader scales each
// position by the body's `radii` so the cube wraps the ellipsoid
// bounding volume. 8 verts, 36 indices, CCW winding for outward normals.

/**
 * Allocate the shared bounding cube geometry on the given device.
 * Caller can hold one instance per device and reuse across bodies.
 */
export function createEllipsoidBoundingCube(
  device: GPUDevice,
): EllipsoidBoundingCube {
  // prettier-ignore
  const vertices = new Float32Array([
    -1, -1, -1,    1, -1, -1,    1,  1, -1,   -1,  1, -1,
    -1, -1,  1,    1, -1,  1,    1,  1,  1,   -1,  1,  1,
  ]);
  // prettier-ignore
  const indices = new Uint16Array([
    // -Z face
    0, 2, 1,  0, 3, 2,
    // +Z face
    4, 5, 6,  4, 6, 7,
    // -Y face
    0, 1, 5,  0, 5, 4,
    // +Y face
    3, 6, 2,  3, 7, 6,
    // -X face
    0, 4, 7,  0, 7, 3,
    // +X face
    1, 2, 6,  1, 6, 5,
  ]);

  const vertexBuffer = WebGPUBuffer.createVertexBuffer(
    device,
    vertices,
    "EllipsoidBoundingCube_Vertices",
  );

  const indexBuffer = device.createBuffer({
    label: "EllipsoidBoundingCube_Indices",
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, indices);

  return { vertexBuffer, indexBuffer, indexCount: indices.length };
}

/**
 * Build the canonical bind group layout for an ellipsoid body. Three
 * bindings: a uniform buffer, a 2D texture, and a filtering sampler.
 * This matches the Moon shader and is the contract for any future body
 * that uses this module.
 *
 *   binding 0: uniform UBO  (vertex + fragment)
 *   binding 1: texture_2d   (fragment)
 *   binding 2: sampler      (fragment)
 */
export function createEllipsoidBindGroupLayout(
  device: GPUDevice,
): GPUBindGroupLayout {
  return makeBindGroupLayout(device, "Ellipsoid_BindGroupLayout", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    texture(1, Stage.FRAGMENT),
    sampler(2, Stage.FRAGMENT),
  ]);
}

// ─── Base uniform pack ───────────────────────────────────────────────
//
// Layout (offsets in floats):
//   0..15  : mvpRelativeToEye         mat4
//   16..19 : encodedCameraHigh + pad  vec3+pad
//   20..23 : encodedCameraLow  + pad  vec3+pad
//   24..27 : centerHigh        + pad  vec3+pad
//   28..31 : centerLow         + pad  vec3+pad
//   32..35 : ivmRow0           + pad  vec3+pad   (inverse modelView 3×3, row 0)
//   36..39 : ivmRow1           + pad  vec3+pad
//   40..43 : ivmRow2           + pad  vec3+pad
//   44..47 : cameraPositionMC  + pad  vec3+pad   (camera in body model coords)
//   48..51 : radii             + pad  vec3+pad
//   52..55 : oneOverRadiiSq    + pad  vec3+pad
//   56..59 : sunDirMC          + pad  vec3+pad   (sun direction in model space)
//   60..63 : sceneLightDirMC   + pad  vec3+pad
//
// Body-specific uniforms append starting at offset 64 (256 bytes in).
//
// The function takes raw arrays / objects rather than typed Cesium types
// to avoid coupling this shared module to any single math implementation.
// All vector inputs use the `{ x, y, z }` shape that Cartesian3 satisfies.

const _scratchEncodedCamera = new EncodedCartesian3();
const _scratchEncodedCenter = new EncodedCartesian3();
const _scratchCenterWC = new Cartesian3();
const _scratchModelView = new Matrix4();
const _scratchInverseModelView = new Matrix3();
const _scratchInverseModelMatrix = new Matrix4();
const _scratchCameraMC = new Cartesian3();
const _scratchInverseModelRot = new Matrix3();
const _scratchSunMC = new Cartesian3();
const _scratchSceneLightMC = new Cartesian3();

/**
 * Pack the body-agnostic prefix (offsets 0..63) of an ellipsoid uniform
 * buffer. Body-specific writes happen after offset 64. The function
 * uses internal scratch storage so it allocates nothing on the hot path.
 *
 * Pre-conditions:
 *   - `uniformData.length >= 64`
 *   - `inputs.modelMatrix` is a column-major 16-element Matrix4
 *   - `inputs.mvpRelativeToEye` is a column-major 16-element matrix with
 *     the body translation already zeroed in the modelView term
 */
export function packEllipsoidBaseUniforms(
  uniformData: Float32Array,
  inputs: EllipsoidBaseUniformInputs,
): void {
  const {
    mvpRelativeToEye,
    viewMatrix,
    cameraPositionWC,
    modelMatrix,
    radii,
    oneOverRadiiSquared,
    sunDirectionWC,
  } = inputs;
  const sceneLightDirectionWC = inputs.sceneLightDirectionWC ?? sunDirectionWC;

  // mvpRTE — offsets 0..15
  for (let i = 0; i < 16; i++) {
    uniformData[i] = mvpRelativeToEye[i];
  }

  // RTE camera split — offsets 16..23
  EncodedCartesian3.fromCartesian(cameraPositionWC, _scratchEncodedCamera);
  uniformData[16] = _scratchEncodedCamera.high.x;
  uniformData[17] = _scratchEncodedCamera.high.y;
  uniformData[18] = _scratchEncodedCamera.high.z;
  uniformData[19] = 0;
  uniformData[20] = _scratchEncodedCamera.low.x;
  uniformData[21] = _scratchEncodedCamera.low.y;
  uniformData[22] = _scratchEncodedCamera.low.z;
  uniformData[23] = 0;

  // RTE body-center split — offsets 24..31
  // Translation column of modelMatrix is offsets 12, 13, 14 in
  // column-major layout. Pull it out without going through Matrix4 so
  // this module stays loosely typed.
  _scratchCenterWC.x = modelMatrix[12];
  _scratchCenterWC.y = modelMatrix[13];
  _scratchCenterWC.z = modelMatrix[14];
  EncodedCartesian3.fromCartesian(_scratchCenterWC, _scratchEncodedCenter);
  uniformData[24] = _scratchEncodedCenter.high.x;
  uniformData[25] = _scratchEncodedCenter.high.y;
  uniformData[26] = _scratchEncodedCenter.high.z;
  uniformData[27] = 0;
  uniformData[28] = _scratchEncodedCenter.low.x;
  uniformData[29] = _scratchEncodedCenter.low.y;
  uniformData[30] = _scratchEncodedCenter.low.z;
  uniformData[31] = 0;

  // Inverse modelView 3x3 — offsets 32..43.
  // The eye→model rotation is `inverse(view × model)` upper-left 3x3.
  // For an orthonormal rotation matrix, inverse equals transpose. We
  // compute `view × model`, take its 3x3, transpose, and pack as 3
  // vec4 rows. Bodies that need an eye-space → model-space rotation
  // (e.g. Sun-as-ellipsoid corona reading the eye direction in model
  // space) read these slots; the Moon shader currently does its ray
  // construction directly in model space and doesn't read them, but
  // they're written for forward-compatibility.
  Matrix4.multiply(viewMatrix, modelMatrix, _scratchModelView);
  Matrix4.getMatrix3(_scratchModelView, _scratchInverseModelView);
  Matrix3.transpose(_scratchInverseModelView, _scratchInverseModelView);
  // Pack as 3 vec4 rows (Matrix3 is column-major; transpose-pack so
  // each ivmRow vec4 is one row of the 3x3).
  uniformData[32] = _scratchInverseModelView[0];
  uniformData[33] = _scratchInverseModelView[3];
  uniformData[34] = _scratchInverseModelView[6];
  uniformData[35] = 0;
  uniformData[36] = _scratchInverseModelView[1];
  uniformData[37] = _scratchInverseModelView[4];
  uniformData[38] = _scratchInverseModelView[7];
  uniformData[39] = 0;
  uniformData[40] = _scratchInverseModelView[2];
  uniformData[41] = _scratchInverseModelView[5];
  uniformData[42] = _scratchInverseModelView[8];
  uniformData[43] = 0;

  // Camera position in body model coordinates — offsets 44..47
  Matrix4.inverseTransformation(modelMatrix, _scratchInverseModelMatrix);
  Matrix4.multiplyByPoint(
    _scratchInverseModelMatrix,
    cameraPositionWC,
    _scratchCameraMC,
  );
  uniformData[44] = _scratchCameraMC.x;
  uniformData[45] = _scratchCameraMC.y;
  uniformData[46] = _scratchCameraMC.z;
  uniformData[47] = 0;

  // radii — offsets 48..51
  uniformData[48] = radii.x;
  uniformData[49] = radii.y;
  uniformData[50] = radii.z;
  uniformData[51] = 0;

  // oneOverRadiiSq — offsets 52..55
  uniformData[52] = oneOverRadiiSquared.x;
  uniformData[53] = oneOverRadiiSquared.y;
  uniformData[54] = oneOverRadiiSquared.z;
  uniformData[55] = 0;

  // Sun + scene light directions in body model coordinates — offsets 56..63
  // model→world rotation = upper-left 3x3 of modelMatrix; world→model
  // is its transpose (assuming no scale in the model matrix — radii
  // are applied in the shader).
  _scratchInverseModelRot[0] = modelMatrix[0];
  _scratchInverseModelRot[3] = modelMatrix[1];
  _scratchInverseModelRot[6] = modelMatrix[2];
  _scratchInverseModelRot[1] = modelMatrix[4];
  _scratchInverseModelRot[4] = modelMatrix[5];
  _scratchInverseModelRot[7] = modelMatrix[6];
  _scratchInverseModelRot[2] = modelMatrix[8];
  _scratchInverseModelRot[5] = modelMatrix[9];
  _scratchInverseModelRot[8] = modelMatrix[10];
  Matrix3.multiplyByVector(
    _scratchInverseModelRot,
    sunDirectionWC,
    _scratchSunMC,
  );
  Matrix3.multiplyByVector(
    _scratchInverseModelRot,
    sceneLightDirectionWC,
    _scratchSceneLightMC,
  );

  // sunDirMC — offsets 56..59 (.w slot is reserved for body-specific
  // flags like onlySunLighting; this packer leaves it zero, the
  // body-specific tail overwrites it)
  uniformData[56] = _scratchSunMC.x;
  uniformData[57] = _scratchSunMC.y;
  uniformData[58] = _scratchSunMC.z;
  uniformData[59] = 0;

  // sceneLightDirMC + pad — offsets 60..63
  uniformData[60] = _scratchSceneLightMC.x;
  uniformData[61] = _scratchSceneLightMC.y;
  uniformData[62] = _scratchSceneLightMC.z;
  uniformData[63] = 0;
}

export default {
  ELLIPSOID_BASE_UNIFORM_FLOATS,
  ELLIPSOID_BASE_UNIFORM_BYTES,
  createEllipsoidBoundingCube,
  createEllipsoidBindGroupLayout,
  packEllipsoidBaseUniforms,
};
