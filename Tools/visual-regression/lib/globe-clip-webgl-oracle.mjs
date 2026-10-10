// globe-clip-webgl-oracle.mjs — WebGL's globe clipping decisions, written from the GLSL.
//
// @purpose Independent f64 transcriptions of WebGL's globe clip path (transformPlane.glsl, the generated clip() bodies in getClippingFunction.js, metersPerPixel.glsl) plus the camera and surface fixtures the clipping-plane specs share, so a WebGPU shader law is compared with the WebGL one rather than with itself.
// @status ACTIVE

import Cartesian3 from "../../../packages/engine/Source/Core/Cartesian3.js";
import CesiumMath from "../../../packages/engine/Source/Core/Math.js";
import Matrix4 from "../../../packages/engine/Source/Core/Matrix4.js";
import Transforms from "../../../packages/engine/Source/Core/Transforms.js";

/** A view matrix for a camera `height` metres above a point, looking straight down, north up. */
export function lookDownView(lon, lat, height) {
  const position = Cartesian3.fromDegrees(lon, lat, height);
  const enu = Transforms.eastNorthUpToFixedFrame(
    Cartesian3.fromDegrees(lon, lat, 0),
  );
  const east = Matrix4.multiplyByPointAsVector(
    enu,
    Cartesian3.UNIT_X,
    new Cartesian3(),
  );
  const north = Matrix4.multiplyByPointAsVector(
    enu,
    Cartesian3.UNIT_Y,
    new Cartesian3(),
  );
  const up = Matrix4.multiplyByPointAsVector(
    enu,
    Cartesian3.UNIT_Z,
    new Cartesian3(),
  );
  const direction = Cartesian3.negate(up, new Cartesian3());
  return {
    position,
    direction,
    view: Matrix4.computeView(position, direction, north, east, new Matrix4()),
  };
}

export const enuModelMatrix = (lon, lat) =>
  Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, 0));

/**
 * WebGL's plane in eye space, from `czm_transformPlane` and
 * `u_clippingPlanesMatrix = inverseTranspose(view * modelMatrix)`.
 */
export function glslEyePlane(plane, view, modelMatrix) {
  const transform = Matrix4.inverseTranspose(
    Matrix4.multiply(view, modelMatrix, new Matrix4()),
    new Matrix4(),
  );
  const t = Matrix4.multiplyByVector(
    transform,
    {
      x: plane.normal.x,
      y: plane.normal.y,
      z: plane.normal.z,
      w: plane.distance,
    },
    {},
  );
  const length = Math.hypot(t.x, t.y, t.z);
  return { n: [t.x / length, t.y / length, t.z / length], w: t.w / length };
}

/**
 * The same eye-space plane from the geometry alone: a point on the plane and a
 * unit normal, both carried through `view * modelMatrix`. Written without any
 * plane algebra, so it checks `glslEyePlane` rather than restating it.
 */
export function geometricEyePlane(plane, view, modelMatrix) {
  const local = new Cartesian3(plane.normal.x, plane.normal.y, plane.normal.z);
  const point = Cartesian3.multiplyByScalar(
    local,
    -plane.distance,
    new Cartesian3(),
  );
  const world = Matrix4.multiplyByPoint(modelMatrix, point, new Cartesian3());
  const eyePoint = Matrix4.multiplyByPoint(view, world, new Cartesian3());
  const direction = Matrix4.multiplyByPointAsVector(
    view,
    Matrix4.multiplyByPointAsVector(modelMatrix, local, new Cartesian3()),
    new Cartesian3(),
  );
  Cartesian3.normalize(direction, direction);
  return { normal: direction, point: eyePoint };
}

/** WebGL's amount for one plane, in METRES (the shader divides it by pixel width afterwards). */
export const glslAmountMetres = (eyePlane, positionEC) => {
  const [nx, ny, nz] = eyePlane.n;
  const px = -eyePlane.w * nx;
  const py = -eyePlane.w * ny;
  const pz = -eyePlane.w * nz;
  return (
    nx * (positionEC.x - px) +
    ny * (positionEC.y - py) +
    nz * (positionEC.z - pz)
  );
};

/** WebGL's generated clip() bodies, transcribed from getClippingFunction.js. */
export function glslFold(distances, union) {
  if (union) {
    let clipAmount = 0;
    for (let i = 0; i < distances.length; i += 1) {
      const amount = distances[i];
      clipAmount = i === 0 ? amount : Math.min(amount, clipAmount);
      if (amount <= 0) return { clipped: true };
    }
    return { clipped: false, amount: clipAmount };
  }
  let clipped = true;
  let clipAmount = 0;
  for (const amount of distances) {
    clipAmount = Math.max(amount, clipAmount);
    clipped = clipped && amount <= 0;
  }
  return clipped ? { clipped: true } : { clipped: false, amount: clipAmount };
}

export const VIEWPORT = { width: 800, height: 600 };

/** `czm_metersPerPixel` from metersPerPixel.glsl. */
export function glslMetersPerPixel(
  positionEC,
  frustum,
  orthographic,
  pixelRatio,
) {
  let pixelWidth;
  let pixelHeight;
  if (orthographic) {
    pixelWidth = (frustum.right - frustum.left) / VIEWPORT.width;
    pixelHeight = (frustum.top - frustum.bottom) / VIEWPORT.height;
  } else {
    const distanceToPixel = -positionEC.z;
    const inverseNear = 1 / frustum.near;
    pixelHeight =
      (2 * distanceToPixel * (frustum.top * inverseNear)) / VIEWPORT.height;
    pixelWidth =
      (2 * distanceToPixel * (frustum.right * inverseNear)) / VIEWPORT.width;
  }
  return Math.max(pixelWidth, pixelHeight) * pixelRatio;
}

export const tanHalfFovY = Math.tan(CesiumMath.toRadians(60) / 2);
export const FRUSTA = {
  "symmetric 60 deg": (() => {
    const top = tanHalfFovY;
    return {
      near: 1,
      top,
      bottom: -top,
      right: top * (4 / 3),
      left: -top * (4 / 3),
    };
  })(),
  "stretched (non-square pixels)": (() => {
    const top = tanHalfFovY;
    return { near: 1, top, bottom: -top, right: top * 2, left: -top * 2 };
  })(),
};

/** Eye position of the surface under a pixel centre, for a surface plane in eye space. */
export function surfaceUnderPixel(px, py, frustum, orthographic, surface) {
  const ndcX = ((px + 0.5) / VIEWPORT.width) * 2 - 1;
  const ndcY = 1 - ((py + 0.5) / VIEWPORT.height) * 2;
  const { normal, offset } = surface; // normal . p = offset
  if (orthographic) {
    const x = frustum.left + ((ndcX + 1) / 2) * (frustum.right - frustum.left);
    const y =
      frustum.bottom + ((ndcY + 1) / 2) * (frustum.top - frustum.bottom);
    const z = (offset - normal[0] * x - normal[1] * y) / normal[2];
    return { x, y, z };
  }
  const direction = [
    ndcX * (frustum.right / frustum.near),
    ndcY * (frustum.top / frustum.near),
    -1,
  ];
  const t =
    offset /
    (normal[0] * direction[0] +
      normal[1] * direction[1] +
      normal[2] * direction[2]);
  return { x: direction[0] * t, y: direction[1] * t, z: direction[2] * t };
}

export function tiltedSurface(tiltDegrees, azimuthDegrees, depth) {
  const t = CesiumMath.toRadians(tiltDegrees);
  const a = CesiumMath.toRadians(azimuthDegrees);
  const normal = [
    Math.sin(t) * Math.cos(a),
    Math.sin(t) * Math.sin(a),
    Math.cos(t),
  ];
  return { normal, offset: -depth * normal[2] };
}

export const subtract = (a, b) => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
