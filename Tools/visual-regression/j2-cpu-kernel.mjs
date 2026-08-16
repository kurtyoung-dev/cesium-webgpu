// j2-cpu-kernel.mjs — the DEMO/PROBE-owned CPU (FP64) secular-J2 propagator
// that mirrors the WGSL `orbitalKernel` of the "WebGPU Orbital Catalog" demo,
// shaped as a `ComputeInstanceCollection` cpuKernel. NOT engine code — this is
// orbital domain math (the engine stays orbital-agnostic; it only runs the
// kernel and RTE-splits the result).
// @purpose FP64 secular-J2 orbital propagator mirroring the demo's WGSL kernel; single source of truth for two orbital probes and the WebGL2 cpuKernel leg.
// @status ACTIVE
//
// The WebGL2 fallback of ComputeInstanceCollection takes a JS kernel
//   (out, index, timeSeconds, params) => void
// and the engine RTE-splits `out.position`, packs the records, and instanced-
// draws them. This module provides that kernel for the orbital element layout,
// so the WebGL2 leg lands satellites at the same screen positions the WebGPU
// df64 WGSL kernel produces. Both probe-orbital-j2.mjs (GPU-vs-FP64) and
// probe-compute-instance-webgl2.mjs (WebGL-vs-WebGPU) import this, and the
// orbital Sandcastle demo carries the same algorithm inline as its cpuKernel.
//
// Element lane layout (MUST match the demo's FLOATS_PER_INSTANCE = 13):
//   0 a (m)   1 e   2 inc (rad)   3 raan0 (rad)   4 argp0 (rad)
//   5 M0 (rad)   6 mDotHi   7 mDotLo   8 gmst0 (rad)
//   9 r   10 g   11 b   12 pixelSize (px)

export const J2_FLOATS_PER_INSTANCE = 13;

// Physical constants (WGS-84 / IERS) — identical to the demo + the J2 probe.
export const GM = 3.986004418e14;
export const EARTH_RADIUS = 6.378137e6;
export const J2 = 1.08263e-3;
export const EARTH_ROTATION_RATE = 7.2921159e-5;

// Reduce an angle to [-pi, pi] (matches the kernel's df64 range reduction
// outcome in FP64). Exported for reuse by reference propagators.
export function reduceToPi(angle) {
  const twoPi = 2 * Math.PI;
  let r = angle - twoPi * Math.round(angle / twoPi);
  if (r > Math.PI) {
    r -= twoPi;
  } else if (r < -Math.PI) {
    r += twoPi;
  }
  return r;
}

// FP64 secular-J2 propagation from the flat param lanes. Returns the absolute
// ECEF position [x, y, z] in meters at `t` seconds since epoch. This is the
// trusted reference the GPU kernel is validated against (it is the same math
// as probe-orbital-j2.mjs's propagateFP64, expressed over the param lanes so
// the demo + both probes share ONE source of truth).
export function propagateJ2FromParams(params, base, t) {
  const a = params[base + 0];
  const e = params[base + 1];
  const inc = params[base + 2];
  const raan0 = params[base + 3];
  const argp0 = params[base + 4];
  const M0 = params[base + 5];
  // The df64 mDot pair reconstructs the FP64 rate as hi + lo.
  const mDot = params[base + 6] + params[base + 7];
  const gmst0 = params[base + 8];

  const n = Math.sqrt(GM / (a * a * a));
  const ome2 = Math.max(1 - e * e, 1e-6);
  const p = a * ome2;
  const reOverP = EARTH_RADIUS / p;
  const factor = 1.5 * J2 * reOverP * reOverP * n;
  const ci = Math.cos(inc);
  const si = Math.sin(inc);
  const si2 = si * si;

  const raanDot = -factor * ci;
  const argpDot = factor * (2 - 2.5 * si2);

  const M = M0 + mDot * t;
  const raan = raan0 + raanDot * t;
  const argp = argp0 + argpDot * t;
  const gmst = gmst0 + EARTH_ROTATION_RATE * t;

  // Newton solve for eccentric anomaly E (matches the kernel's reduced seed).
  const Mred = reduceToPi(M);
  let E = Mred;
  for (let k = 0; k < 8; k++) {
    const f = E - e * Math.sin(E) - Mred;
    const fp = 1 - e * Math.cos(E);
    E = E - f / fp;
  }
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const r = a * (1 - e * cosE);
  const beta = Math.sqrt(Math.max(1 - e * e, 0));
  const nu = Math.atan2(beta * sinE, cosE - e);

  const u = nu + argp;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const co = Math.cos(raan);
  const so = Math.sin(raan);

  const xEci = r * (cu * co - su * ci * so);
  const yEci = r * (cu * so + su * ci * co);
  const zEci = r * (su * si);

  const cg = Math.cos(gmst);
  const sg = Math.sin(gmst);
  const xEcef = cg * xEci + sg * yEci;
  const yEcef = -sg * xEci + cg * yEci;
  const zEcef = zEci;
  return [xEcef, yEcef, zEcef];
}

// The ComputeInstanceCollection cpuKernel shape: writes out.position
// ({x,y,z} ECEF m), out.color ({r,g,b,a} in [0,1]) and out.pixelSize (px).
// `out` is a reused scratch object — write every field.
export function cpuKernelJ2(out, index, timeSeconds, params) {
  const base = index * J2_FLOATS_PER_INSTANCE;
  const pos = propagateJ2FromParams(params, base, timeSeconds);
  out.position.x = pos[0];
  out.position.y = pos[1];
  out.position.z = pos[2];
  out.color.red = params[base + 9];
  out.color.green = params[base + 10];
  out.color.blue = params[base + 11];
  out.color.alpha = 1.0;
  out.pixelSize = params[base + 12];
}
