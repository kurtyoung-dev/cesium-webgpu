// wgsl-compute-exec.mjs — executes a restricted WGSL compute shader in Node,
// workgroup memory and barriers included, with IEEE f32 / u32 / i32 semantics.
//
// @purpose Transpiles the compute subset of WGSL (statements, loops, integer and float arithmetic, workgroup arrays, barriers, textureLoad/textureStore) to JavaScript and runs dispatches over in-memory textures, so a spec can execute a shipped kernel instead of a transcription of it.
// @status ACTIVE
//
// WHY THIS EXISTS, AND HOW IT DIFFERS FROM THE KIT'S OTHER SHADER READERS.
// `shader-block-interpreter.mjs` interprets the straight-line statement grammar
// of the collection shaders' DISABLE_DEPTH_DISTANCE blocks (let/assign/if,
// f64 numbers, no loops, no integers, no memory). `wgsl-mini-eval.mjs`
// evaluates arithmetic functions (one guarded return, f64 with an optional
// rounding hook). A compute kernel such as an FFT stage needs what neither
// has: IEEE f32 rounding on every operation and wrapping u32/i32 bit
// arithmetic, `for` loops, `var<workgroup>` arrays, `workgroupBarrier()`
// executed in lockstep across a workgroup, texture loads and stores, and whole
// dispatches over a grid of workgroups. A spec that re-implements those in
// JavaScript cannot see a defect in the shader's own load/store coordinates;
// this module runs the shader text itself.
//
// THREE PIECES. `wgsl-compute-parser.mjs` (text -> declaration tree),
// `wgsl-compute-codegen.mjs` (tree -> typed JavaScript factory) and this
// runtime (helpers, resource binding, lockstep dispatch).
//
// SEMANTICS. Every f32 operation rounds through `Math.fround`, with no fused
// multiply-add contraction; u32 and i32 arithmetic wraps; abstract literals
// concretise to the type they meet. Invocations of a workgroup run as
// generators in lane order and suspend at each `workgroupBarrier()`, so every
// lane finishes a phase before any lane starts the next; a barrier some lanes
// reach and others skip throws. Workgroup memory starts zeroed. Out-of-bounds
// texture or array accesses throw rather than clamping, so a wrong coordinate
// is loud.
//
// FAIL CLOSED. Anything outside the subset throws at compile time: no
// pointers, matrices, atomics, storage buffers, samplers, switch, while, loop,
// compound assignment or component assignment. Supported texture formats are
// rgba32float and rg32float.
//
// API.
//   const module = compileComputeModule(wgslSource);
//   module.entryPoints            // Map name -> { workgroupSize: [x, y, z] }
//   module.dispatch(entryPoint, bindings, [gx, gy, gz]);
// `bindings` maps a group-0 binding number to a texture
// `{ width, height, format, data: Float32Array(width * height * 4) }` (a null
// `data` is allocated zeroed) or a uniform buffer `{ bytes: Uint8Array }`.

import { parseComputeModule } from "./wgsl-compute-parser.mjs";
import { generateComputeModule } from "./wgsl-compute-codegen.mjs";

const F = Math.fround;

// ───────────────────────────── runtime helpers ─────────────────────────────

const HELPERS = {
  udiv: (a, b) => (b === 0 ? a : Math.floor(a / b) >>> 0),
  umod: (a, b) => (b === 0 ? 0 : a % b),
  idiv: (a, b) => (b === 0 ? a : Math.trunc(a / b) | 0),
  imod: (a, b) => (b === 0 ? 0 : (a % b) | 0),
  f2u: (x) =>
    Number.isNaN(x)
      ? 0
      : x <= 0
        ? 0
        : x >= 4294967295
          ? 4294967295
          : Math.trunc(x),
  f2i: (x) =>
    Number.isNaN(x)
      ? 0
      : x <= -2147483648
        ? -2147483648
        : x >= 2147483647
          ? 2147483647
          : Math.trunc(x),
  chk(index, length) {
    if (!(index >= 0 && index < length)) {
      throw new RangeError(
        `wgsl-compute-exec: index ${index} out of bounds [0, ${length})`,
      );
    }
    return index;
  },
  vlen(lanes, n) {
    if (lanes.length !== n) {
      throw new Error(`wgsl-compute-exec: vec${n} built from ${lanes.length}`);
    }
    return lanes;
  },
  swz: (v, lanes) => lanes.map((l) => v[l]),
  vneg: (v) => v.map((x) => -x),
  vop(op, shape, a, b) {
    const n = shape[0] === "v" ? a.length : b.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = shape[0] === "v" ? a[i] : a;
      const y = shape[1] === "v" ? b[i] : b;
      out[i] = F(
        op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : x / y,
      );
    }
    return out;
  },
  texel(tex, coord) {
    const [x, y] = coord;
    if (!(x >= 0 && x < tex.width && y >= 0 && y < tex.height)) {
      throw new RangeError(
        `wgsl-compute-exec: texel (${x}, ${y}) outside ${tex.label ?? "texture"} ${tex.width}x${tex.height}`,
      );
    }
    return (y * tex.width + x) * 4;
  },
  tload(tex, coord, level) {
    if (level !== 0) {
      throw new Error("wgsl-compute-exec: only mip level 0");
    }
    const i = HELPERS.texel(tex, coord);
    const d = tex.data;
    return tex.format === "rg32float"
      ? [d[i], d[i + 1], 0, 1]
      : [d[i], d[i + 1], d[i + 2], d[i + 3]];
  },
  tstore(tex, coord, value) {
    const i = HELPERS.texel(tex, coord);
    const d = tex.data;
    d[i] = value[0];
    d[i + 1] = value[1];
    if (tex.format === "rgba32float") {
      d[i + 2] = value[2];
      d[i + 3] = value[3];
    }
  },
};

const FORMATS = new Set(["rgba32float", "rg32float"]);

function decodeUniform(struct, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {};
  struct.members.forEach((m, i) => {
    if (m.type === "u32") {
      out[m.name] = view.getUint32(i * 4, true);
    } else if (m.type === "i32") {
      out[m.name] = view.getInt32(i * 4, true);
    } else if (m.type === "f32") {
      out[m.name] = view.getFloat32(i * 4, true);
    } else {
      throw new Error(`wgsl-compute-exec: uniform member type ${m.type}`);
    }
  });
  return out;
}

/**
 * Compiles a WGSL compute module for execution in Node.
 *
 * @param {string} source WGSL text.
 * @returns {{entryPoints: Map<string, {workgroupSize: number[]}>, javascript: string, dispatch: Function}}
 *   The compiled module.
 */
export function compileComputeModule(source) {
  const generator = generateComputeModule(parseComputeModule(source));
  const javascript = generator.javascript;
  // eslint-disable-next-line no-new-func
  const factory = new Function("F", "H", "R", "W", javascript);
  const entryPoints = new Map();
  for (const fn of generator.functions.values()) {
    if (fn.attrs.compute) {
      const size = (fn.attrs.workgroup_size ?? []).map((s) =>
        Number(s.replace(/[ui]$/, "")),
      );
      entryPoints.set(fn.name, {
        workgroupSize: [size[0] ?? 1, size[1] ?? 1, size[2] ?? 1],
      });
    }
  }

  function bind(bindings) {
    const R = {};
    for (const [binding, resource] of generator.resources) {
      const value = bindings[binding];
      if (value === undefined) {
        throw new Error(`wgsl-compute-exec: binding ${binding} not bound`);
      }
      if (resource.kind === "uniform") {
        R[resource.name] = decodeUniform(resource.struct, value.bytes);
        continue;
      }
      if (!FORMATS.has(value.format)) {
        throw new Error(`wgsl-compute-exec: texture format ${value.format}`);
      }
      if (resource.kind === "storage" && value.format !== resource.format) {
        throw new Error(
          `wgsl-compute-exec: ${resource.name} declared ${resource.format}, bound ${value.format}`,
        );
      }
      if (value.data === null || value.data === undefined) {
        value.data = new Float32Array(value.width * value.height * 4);
      }
      R[resource.name] = value;
    }
    return R;
  }

  function dispatch(entryPoint, bindings, workgroups) {
    const info = entryPoints.get(entryPoint);
    if (!info) {
      throw new Error(`wgsl-compute-exec: no entry point ${entryPoint}`);
    }
    const R = bind(bindings);
    const [sx, sy, sz] = info.workgroupSize;
    const [gx, gy = 1, gz = 1] = workgroups;
    for (let wz = 0; wz < gz; wz++) {
      for (let wy = 0; wy < gy; wy++) {
        for (let wx = 0; wx < gx; wx++) {
          const W = {};
          for (const [name, wg] of generator.workgroup) {
            W[name] = Array.from({ length: wg.length }, () =>
              wg.lanes ? new Array(wg.lanes).fill(0) : 0,
            );
          }
          const module = factory(F, HELPERS, R, W);
          const invocations = [];
          for (let lz = 0; lz < sz; lz++) {
            for (let ly = 0; ly < sy; ly++) {
              for (let lx = 0; lx < sx; lx++) {
                invocations.push(
                  module[entryPoint]({
                    local_invocation_id: [lx, ly, lz],
                    workgroup_id: [wx, wy, wz],
                    global_invocation_id: [
                      wx * sx + lx,
                      wy * sy + ly,
                      wz * sz + lz,
                    ],
                  }),
                );
              }
            }
          }
          for (;;) {
            let done = 0;
            for (const invocation of invocations) {
              if (invocation.next().done) {
                done++;
              }
            }
            if (done === invocations.length) {
              break;
            }
            if (done !== 0) {
              throw new Error(
                "wgsl-compute-exec: workgroupBarrier reached by some invocations of a workgroup but not all",
              );
            }
          }
        }
      }
    }
  }

  return { entryPoints, javascript, dispatch };
}
