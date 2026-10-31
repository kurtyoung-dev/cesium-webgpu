// water-material-water-mask-tail.spec.mjs - NEW-WATER-GLOBE-MATERIAL-WATER-MASK, the CPU half.
// @purpose Pins the TileUniforms tail that hands a WebGPU globe material its water mask: the WGSL layout derived from GlobeTerrain.wgsl's struct text by the uniform address-space rules (hasRawWaterMask at float 496, explicit pad, 2,000 bytes in the same 2,048-byte slice) agreeing with WebGPUGlobeSurfaceTypes.ts, and the real tile packer writing the lane from the mask alone (1 with a mask whether or not showWaterEffect is on, 0 without a mask, on a subsequent pass or without a texture) while leaving floats 0-495 as they were; each check has an executed inertness mutant that must turn it red.
// @status ACTIVE
//
// WHY A SEPARATE LANE. WebGL defines HAS_WATER_MASK from the provider's mask and
// the tile texture alone and hands `materialInput.waterMask` to a globe material
// with `globe.showWaterEffect` off. The WebGPU tile flag `flags.x` is the mask AND
// showWaterEffect (it gates the reflective ocean), so the material composite
// needs the mask on its own lane. The shader side, executed against
// GlobeFS.glsl's law, is globe-classic-ocean-default-parity section H; the
// default-variant contract is globe-terrain-default-variant-identity.
//
// WHAT IS REAL. WebGPUGlobeSurfaceTileUB.ts and WebGPUGlobeSurfaceTypes.ts (and
// their pure dependencies) through lib/engine-stub-bundler; `writeUniformSlice`
// is replaced by a capture of the packed floats, TideModel and the debug
// sentinel by constants. The layout is computed here from the WGSL text, not
// read from the CPU constants it is compared against.
//
// Run: node --test Tools/visual-regression/water-material-water-mask-tail.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundle } from "./lib/engine-stub-bundler.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const engine = path.join(root, "packages/engine/Source");
const webgpu = path.join(engine, "Renderer/WebGPU");
const WGSL = fs
  .readFileSync(
    path.join(engine, "Shaders/WebGPU/Globe/GlobeTerrain.wgsl"),
    "utf8",
  )
  .replace(/\r\n/g, "\n");

// ─────────────── WGSL uniform layout, from the struct text ───────────────

const roundUp = (k, n) => Math.ceil(n / k) * k;

/** The member list of `struct <name> { ... }`, comments stripped. */
function structMembers(text, name) {
  const m = new RegExp(`^struct ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(text);
  assert.ok(m, `struct ${name} in the shader`);
  return m[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const member = /^(\w+)\s*:\s*(.+),$/.exec(line);
      assert.ok(member, `member line: ${line}`);
      return { name: member[1], type: member[2].trim() };
    });
}

/**
 * {align, size} of a type in the uniform address space (WGSL spec, "Memory
 * Layout"): vec2 8/8, vec3 16/12, vec4 16/16, matCxR = C columns of vecR; an
 * array's element stride is its element size rounded to the element alignment
 * and, in uniform space, to 16; a struct aligns to its largest member (16 in
 * uniform space when nested) and its size rounds up to that alignment.
 */
function layoutOf(text, type) {
  if (type === "f32" || type === "u32" || type === "i32") {
    return { align: 4, size: 4 };
  }
  let m;
  if ((m = /^vec([234])<f32>$/.exec(type))) {
    const n = Number(m[1]);
    return { align: n === 2 ? 8 : 16, size: 4 * n };
  }
  if ((m = /^mat([234])x([234])<f32>$/.exec(type))) {
    const column = layoutOf(text, `vec${m[2]}<f32>`);
    return {
      align: column.align,
      size: Number(m[1]) * roundUp(column.align, column.size),
    };
  }
  if ((m = /^array<(.+),\s*(\d+)>$/.exec(type))) {
    const element = layoutOf(text, m[1].trim());
    const align = roundUp(16, element.align);
    const stride = roundUp(16, roundUp(element.align, element.size));
    return { align, size: stride * Number(m[2]) };
  }
  const { size, align } = structLayout(text, type);
  return { align: roundUp(16, align), size };
}

/** Byte offsets of every member, and the struct's size and alignment. */
function structLayout(text, name) {
  let offset = 0;
  let align = 0;
  const offsets = {};
  for (const member of structMembers(text, name)) {
    const l = layoutOf(text, member.type);
    offset = roundUp(l.align, offset);
    offsets[member.name] = offset;
    offset += l.size;
    align = Math.max(align, l.align);
  }
  return { offsets, size: roundUp(align, offset), align };
}

// ───────────────────────────── the real packer ─────────────────────────────

const REAL = [
  "WebGPUGlobeSurfaceTileUB.ts",
  "WebGPUGlobeSurfaceTypes.ts",
  "WebGPUGlobeTunables.ts",
  "WebGPUVectorTileResources.ts",
  "WebGPUGlobeLightingFade.ts",
  "GlobeNightImagery.js",
  "GlobeOceanWaveClock.js",
  "SceneMode.js",
];

const PACK_WRITE =
  "  data[HAS_RAW_WATER_MASK_OFFSET] = hasWaterMask ? 1.0 : 0.0;\n";

/** An override that rewrites `anchor` (exactly once) in a real module. */
function swap(basename, anchor, replacement, label) {
  return {
    basename,
    label,
    mutate: (source) => {
      assert.equal(
        source.split(anchor).length - 1,
        1,
        `mutant ${label}: anchor must occur once in ${basename}`,
      );
      return source.replace(anchor, () => replacement);
    },
  };
}

function importPacker(overrides = []) {
  return bundle({
    path: path.join(webgpu, "__water-material-tail-spec.ts"),
    source: [
      'export { createTileUniformBuffer } from "./WebGPUGlobeSurfaceTileUB.js";',
      "export {",
      "  TILE_UNIFORM_FLOATS,",
      "  TILE_UNIFORM_BYTES,",
      "  HAS_RAW_WATER_MASK_OFFSET,",
      "  VECTOR_METERS_PER_UV_OFFSET,",
      "  OCEAN_TIDE_HEIGHT_OFFSET,",
      "  WATER_MASK_TS_OFFSET,",
      "  FLAGS_OFFSET,",
      '} from "./WebGPUGlobeSurfaceTypes.js";',
    ].join("\n"),
    real: REAL,
    realDir: path.join(engine, "Core"),
    preseed: [path.join(webgpu, "WebGPUGlobeSurfaceTileUB.ts")],
    stubSources: {
      "../../Core/TideModel.js":
        "export default { equilibriumHeight() { return 0.5; } };",
      "./WebGPUGlobeSurfaceCameraUB.js":
        "export const writeUniformSlice = (device, frameState, data, size) => { globalThis.__waterMaterialTailData = data.slice(); return { buffer: {}, offset: 0, size }; };",
      "./WebGPUGlobeFragmentDebug.js":
        "export const getActiveDebugSentinel = () => null;",
    },
    overrides,
  });
}

/** The floats the real packer writes for one first-pass (or subsequent) tile. */
function pack(
  ns,
  {
    hasWaterMask = true,
    texture = true,
    showWaterEffect = false,
    subsequent = false,
  } = {},
) {
  const host = {
    _tileUniformData: new Float32Array(ns.TILE_UNIFORM_FLOATS),
    _tileUniformU32View: new Uint32Array(ns.TILE_UNIFORM_FLOATS),
    _diagLastLayerCountLogMs: 0,
    _diagLastFogLogMs: 0,
    _diagFogMissingLogged: true,
  };
  const surfaceTile = {
    waterMaskTranslationAndScale: { x: 0.25, y: 0.5, z: 0.5, w: 0.5 },
  };
  if (texture) {
    surfaceTile.waterMaskTexture = {};
  }
  const tileProvider = {
    hasWaterMask,
    showWaterEffect,
    oceanNormalMap: {},
    nightFadeOutDistance: 1.0e7,
    nightFadeInDistance: 5.0e7,
  };
  const tile = {
    level: 12,
    x: 655,
    y: 1583,
    rectangle: {
      west: -2.1,
      east: -2.0992,
      south: 0.6588,
      north: 0.6596,
      width: 0.0008,
      height: 0.0008,
    },
  };
  globalThis.__waterMaterialTailData = undefined;
  ns.createTileUniformBuffer(
    host,
    {},
    surfaceTile,
    tileProvider,
    { time: {}, mode: 3, camera: {}, fog: {}, verticalExaggeration: 1 },
    tile,
    [],
    subsequent,
  );
  const data = globalThis.__waterMaterialTailData;
  assert.ok(data instanceof Float32Array, "the packer wrote a slice");
  return data;
}

const CASES = [
  { name: "mask, showWaterEffect off", opts: {}, lane: 1, flagX: 0 },
  {
    name: "mask, showWaterEffect on",
    opts: { showWaterEffect: true },
    lane: 1,
    flagX: 1,
  },
  {
    name: "provider without a mask",
    opts: { hasWaterMask: false, showWaterEffect: true },
    lane: 0,
    flagX: 0,
  },
  {
    name: "mask, no texture on the tile yet",
    opts: { texture: false, showWaterEffect: true },
    lane: 0,
    flagX: 0,
  },
  {
    name: "mask, subsequent imagery pass",
    opts: { subsequent: true, showWaterEffect: true },
    lane: 0,
    flagX: 0,
  },
];

/** Every way the packed lane differs from the GLSL HAS_WATER_MASK law. */
function laneFindings(ns) {
  const findings = [];
  for (const c of CASES) {
    const data = pack(ns, c.opts);
    const got = {
      length: data.length,
      lane: data[ns.HAS_RAW_WATER_MASK_OFFSET],
      pad: [497, 498, 499].map((i) => data[i]),
      flagX: data[ns.FLAGS_OFFSET],
    };
    const want = { length: 500, lane: c.lane, pad: [0, 0, 0], flagX: c.flagX };
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      findings.push({ case: c.name, got, want });
    }
  }
  return findings;
}

/** The layout facts the CPU constants must agree with, derived from the WGSL. */
function layoutFindings(ns, wgsl = WGSL) {
  const { offsets, size } = structLayout(wgsl, "TileUniforms");
  const findings = [];
  const expect = (what, cpu, derived) => {
    if (cpu !== derived) {
      findings.push({ what, cpu, derived });
    }
  };
  expect("TILE_UNIFORM_BYTES", ns.TILE_UNIFORM_BYTES, size);
  expect("TILE_UNIFORM_FLOATS * 4", ns.TILE_UNIFORM_FLOATS * 4, size);
  expect(
    "HAS_RAW_WATER_MASK_OFFSET",
    ns.HAS_RAW_WATER_MASK_OFFSET * 4,
    offsets.hasRawWaterMask,
  );
  expect(
    "VECTOR_METERS_PER_UV_OFFSET",
    ns.VECTOR_METERS_PER_UV_OFFSET * 4,
    offsets.vectorMetersPerUv,
  );
  expect(
    "OCEAN_TIDE_HEIGHT_OFFSET",
    ns.OCEAN_TIDE_HEIGHT_OFFSET * 4,
    offsets.oceanTideHeight,
  );
  expect(
    "WATER_MASK_TS_OFFSET",
    ns.WATER_MASK_TS_OFFSET * 4,
    offsets.waterMaskTranslationAndScale,
  );
  expect("FLAGS_OFFSET", ns.FLAGS_OFFSET * 4, offsets.flags);
  return findings;
}

const nsPromise = importPacker();

test("L1: the uniform-rule layout of TileUniforms puts hasRawWaterMask at float 496 and the struct at 2,000 bytes, and the CPU constants agree", async () => {
  const ns = await nsPromise;
  const { offsets, size } = structLayout(WGSL, "TileUniforms");
  assert.equal(offsets.vectorMetersPerUv, 494 * 4);
  assert.equal(offsets.hasRawWaterMask, 496 * 4);
  assert.equal(size, 2000);
  assert.deepEqual(layoutFindings(ns), []);
});

test("L2: the tail moves no base member: every offset is the one the struct had without it (1,984 bytes), and the slice stays 2,048 bytes", () => {
  const { offsets, size } = structLayout(WGSL, "TileUniforms");
  const base = WGSL.replace(
    /^ {2}hasRawWaterMask: f32,\n[\s\S]*?^ {2}_padTileTail1: vec2<f32>,\n/m,
    "",
  );
  assert.notEqual(base, WGSL, "tail removal anchor");
  const before = structLayout(base, "TileUniforms");
  assert.equal(before.size, 1984);
  for (const [name, offset] of Object.entries(before.offsets)) {
    assert.equal(offsets[name], offset, name);
  }
  assert.equal(roundUp(256, before.size), roundUp(256, size));
});

test("L3 (control): the calculator sees alignment - an f32 put ahead of vectorMetersPerUv pushes the vec2 and grows the struct", async () => {
  const ns = await nsPromise;
  const moved = WGSL.replace(
    "  vectorMetersPerUv: vec2<f32>,\n",
    "  extraWord: f32,\n  vectorMetersPerUv: vec2<f32>,\n",
  );
  assert.notEqual(moved, WGSL);
  assert.notDeepEqual(layoutFindings(ns, moved), []);
});

test("P1: the real packer writes hasRawWaterMask from the mask alone (showWaterEffect off or on), 0 without a mask, a texture or on a subsequent pass, and zeros 497-499", async () => {
  const ns = await nsPromise;
  assert.deepEqual(laneFindings(ns), []);
});

test("P2: floats 0-495 are what the packer writes with the new lane unreachable (the lane writes nothing below 496)", async () => {
  const ns = await nsPromise;
  const without = await importPacker([
    swap(
      "WebGPUGlobeSurfaceTileUB.ts",
      PACK_WRITE,
      "  if (false) data[HAS_RAW_WATER_MASK_OFFSET] = hasWaterMask ? 1.0 : 0.0;\n",
      "lane unreachable",
    ),
  ]);
  for (const c of CASES) {
    const a = pack(ns, c.opts);
    const b = pack(without, c.opts);
    assert.deepEqual(
      Array.from(a.subarray(0, 496)),
      Array.from(b.subarray(0, 496)),
      c.name,
    );
  }
});

async function assertMutantRed(label, overrides, check) {
  const mutant = await importPacker(overrides);
  assert.throws(
    () => check(mutant),
    assert.AssertionError,
    `mutant "${label}" must turn the check red`,
  );
}

test("P3 (mutant): the lane write made unreachable is DETECTED", async () => {
  await assertMutantRed(
    "lane unreachable",
    [
      swap(
        "WebGPUGlobeSurfaceTileUB.ts",
        PACK_WRITE,
        "  if (false) data[HAS_RAW_WATER_MASK_OFFSET] = hasWaterMask ? 1.0 : 0.0;\n",
        "lane unreachable",
      ),
    ],
    (ns) => assert.deepEqual(laneFindings(ns), []),
  );
});

test("P4 (mutant): the lane coupled to showWaterEffect (flags.x's gate) is DETECTED", async () => {
  await assertMutantRed(
    "lane gated on showWaterEffect",
    [
      swap(
        "WebGPUGlobeSurfaceTileUB.ts",
        PACK_WRITE,
        "  data[HAS_RAW_WATER_MASK_OFFSET] = showReflectiveOcean ? 1.0 : 0.0;\n",
        "lane gated on showWaterEffect",
      ),
    ],
    (ns) => assert.deepEqual(laneFindings(ns), []),
  );
});

test("P5 (mutant): the CPU offset off the WGSL member (497) is DETECTED by the layout check", async () => {
  await assertMutantRed(
    "offset 497",
    [
      swap(
        "WebGPUGlobeSurfaceTypes.ts",
        "export const HAS_RAW_WATER_MASK_OFFSET = 496;",
        "export const HAS_RAW_WATER_MASK_OFFSET = 497;",
        "offset 497",
      ),
    ],
    (ns) => assert.deepEqual(layoutFindings(ns), []),
  );
});

test("P6 (mutant): TILE_UNIFORM_FLOATS left at 496 is DETECTED by the layout check", async () => {
  await assertMutantRed(
    "floats 496",
    [
      swap(
        "WebGPUGlobeSurfaceTypes.ts",
        "export const TILE_UNIFORM_FLOATS = 500;",
        "export const TILE_UNIFORM_FLOATS = 496;",
        "floats 496",
      ),
    ],
    (ns) => assert.deepEqual(layoutFindings(ns), []),
  );
});
