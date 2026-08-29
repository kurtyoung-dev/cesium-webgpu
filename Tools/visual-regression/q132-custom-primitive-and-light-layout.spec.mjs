// q132-custom-primitive-and-light-layout.spec.mjs — pure Node: no browser, no GPU.
//
// @purpose Reproduces and guards the two defects that stopped rendering in the Sandcastle2 sweep: Scene.updateHeight calling a tileset-only lifecycle method on every primitive, and the WebGL scene-light uniform being declared shorter than LightCollection.pack writes.
// @status ACTIVE
//
// ── PART ONE: `primitive.isDestroyed is not a function` (both backends) ─────
//
// `custom-primitive-dev` and `multiple-shadows-dev` both threw
//
//   TypeError: primitive.isDestroyed is not a function
//       at createPrimitiveEventListener
//       at _Scene.updateHeight
//       at _Scene.initializeFrame
//
// and rendering stopped, on WebGL and on WebGPU alike. `initializeFrame` calls
// `updateHeight` whenever the globe height is dirty — every camera move — and
// `updateHeight` walked `scene.primitives` calling `primitive.isDestroyed()`
// BEFORE testing `primitive.isCesium3DTileset`.
//
// THE DECISION: ENGINE, NOT DEMO. Both failing objects are upstream's own
// gallery demos, ported verbatim, and each defines a primitive with `update`
// and nothing else. Upstream's contract for a member of `scene.primitives` is
// what `PrimitiveCollection` itself requires: `update(frameState)` every frame,
// and `destroy()` only on removal under `destroyPrimitives`. The Coding Guide
// ties `destroy`/`isDestroyed` to "classes that contain WebGL resources", which
// a primitive that only pushes a shadow map does not. Upstream's own two other
// walkers over this same heterogeneous collection —
// `SceneUtilities.getMaxPrimitiveHeight` and `PickingRayHelpers.getTilesets` —
// test the tileset marker FIRST and never touch a tileset-only member on a
// non-tileset. `Scene.updateHeight` was the sole exception, introduced with the
// tileset height callbacks. The fix restores upstream's own ordering.
//
// THE DESTROYED-TILESET SKIP IS PRESERVED, and that is not an assumption:
// `destroyObject` replaces function-valued properties only and documents that
// "accessor (getter/setter) properties are left untouched", while
// `Cesium3DTileset.isCesium3DTileset` is a getter. A destroyed tileset still
// answers the marker, so it still reaches — and is still skipped by —
// `isDestroyed()`.
//
// ── PART TWO: `RangeError: offset is out of bounds` (WebGL only) ────────────
//
// `webgpu-clustered-lighting`, forced to WebGL by the sweep, threw from
// `UniformArrayFloatVec4.set` → `Float32Array.set` and stopped rendering.
//
// `LightCollection.pack()` writes a 4-float header plus 8 lights x 20 floats =
// 164 floats, because a spot light's direction needs its own 16-byte slot.
// `czm_lightsData` was declared `vec4[33]` = 132 floats, and `UniformState`
// staged 132. `pack` reallocated to 164, and the uniform copied 164 floats into
// the 132-float buffer sized from the linked GLSL array. Two further
// consequences of the same drift: `czm_unpackLight` stepped 4 vec4s per light
// against a 5-vec4 stride, so every light after the first read the wrong slot,
// and `czm_lightCount` came from `enabledCount`, which counts area lights that
// `pack` deliberately skips.
//
// This is a WebGL-path defect in a shared feature, not a WebGPU seam running on
// the wrong backend: `czm_lightsData` / `czm_lightCount` and the
// `LightingStageFS` loop are the WebGL multi-light path, reached by any app that
// adds `scene.lights` and draws a PBR model. WebGPU is unaffected because
// `WebGPUModelRenderer` packs the same 20-float record into its own UBO.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const ENGINE = path.join(root, "packages/engine/Source");
const read = (relative) => fs.readFileSync(path.join(ENGINE, relative), "utf8");

// ═══ PART ONE ══════════════════════════════════════════════════════════════

// The listener body as `Scene.updateHeight` defines it, lifted from the source
// so the behaviour under test is the shipped ordering and not a copy of it.
function extractAddListener() {
  const source = read("Scene/Scene.js");
  const start = source.indexOf(
    "const createPrimitiveEventListener = (primitive) => {",
  );
  assert.ok(start > 0, "createPrimitiveEventListener moved");
  let depth = 0;
  let i = source.indexOf("{", start);
  const bodyStart = i;
  for (; i < source.length; ++i) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        break;
      }
    }
  }
  const body = source.slice(bodyStart + 1, i);
  // eslint-disable-next-line no-new-func
  return new Function(
    "ignore3dTiles",
    "cartographic",
    "callbackWrapper",
    "ellipsoid",
    "tilesetRemoveCallbacks",
    `return (primitive) => {${body}};`,
  );
}

function extractRemoveListener() {
  const source = read("Scene/Scene.js");
  const start = source.indexOf(
    "this.primitives.primitiveRemoved.addEventListener((primitive) => {",
  );
  assert.ok(start > 0, "the primitiveRemoved listener moved");
  let depth = 0;
  let i = source.indexOf("{", source.indexOf("(primitive) => {", start));
  const bodyStart = i;
  for (; i < source.length; ++i) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        break;
      }
    }
  }
  const body = source.slice(bodyStart + 1, i);
  // eslint-disable-next-line no-new-func
  return new Function(
    "tilesetRemoveCallbacks",
    `return (primitive) => {${body}};`,
  );
}

// The gallery demos' shape: `update` and nothing else. `custom-primitive-dev`
// adds `show`, `modelMatrix` and a draw command; `multiple-shadows-dev` adds
// only a shadow map. Neither implements `isDestroyed`.
function galleryCustomPrimitive() {
  return {
    show: true,
    update() {},
  };
}

function mockTileset(overrides = {}) {
  return {
    id: "tileset-1",
    show: true,
    isCesium3DTileset: true,
    isDestroyed: () => false,
    updateHeight: () => () => {},
    ...overrides,
  };
}

test("P1: the shipped listener tolerates a custom primitive with only update()", () => {
  const listener = extractAddListener()(false, {}, () => {}, {}, {});
  assert.doesNotThrow(() => listener(galleryCustomPrimitive()));
});

test("P2: MUTANT — the pre-fix ordering throws exactly the reported TypeError", () => {
  const ignore3dTiles = false;
  const preFix = (primitive) => {
    if (
      ignore3dTiles ||
      primitive.isDestroyed() ||
      !primitive.isCesium3DTileset
    ) {
      return;
    }
  };
  assert.throws(() => preFix(galleryCustomPrimitive()), {
    name: "TypeError",
    message: /isDestroyed is not a function/,
  });
});

test("P3: a live tileset still subscribes", () => {
  const callbacks = {};
  const tileset = mockTileset();
  let subscribed = false;
  tileset.updateHeight = () => {
    subscribed = true;
    return () => {};
  };
  extractAddListener()(false, {}, () => {}, {}, callbacks)(tileset);
  assert.ok(
    subscribed,
    "the tileset must still be asked for a height callback",
  );
  assert.ok(Object.hasOwn(callbacks, "tileset-1"));
});

test("P4: a DESTROYED tileset is still skipped — the reorder loses nothing", () => {
  const callbacks = {};
  let subscribed = false;
  const destroyed = mockTileset({
    isDestroyed: () => true,
    updateHeight: () => {
      subscribed = true;
      return () => {};
    },
  });
  extractAddListener()(false, {}, () => {}, {}, callbacks)(destroyed);
  assert.equal(subscribed, false);
  assert.deepEqual(callbacks, {});
});

test("P5: destroyObject leaves the tileset marker readable, which P4 depends on", async () => {
  const { code } = await transform(read("Core/destroyObject.js"), {
    loader: "js",
    format: "esm",
    target: "es2022",
  });
  const stubbed = code.replace(
    /import DeveloperError[^\n]*\n/,
    "class DeveloperError extends Error {}\n",
  );
  const { default: destroyObject } = await import(
    `data:text/javascript;base64,${Buffer.from(stubbed).toString("base64")}`
  );
  class FakeTileset {
    get isCesium3DTileset() {
      return true;
    }
    updateHeight() {
      return () => {};
    }
    isDestroyed() {
      return false;
    }
  }
  const tileset = new FakeTileset();
  destroyObject(tileset);
  assert.equal(tileset.isCesium3DTileset, true, "the getter must survive");
  assert.equal(tileset.isDestroyed(), true);
});

test("P6: the removal listener tolerates the same custom primitive", () => {
  const listener = extractRemoveListener()({});
  assert.doesNotThrow(() => listener(galleryCustomPrimitive()));
});

test("P7: the marker test precedes the lifecycle call at BOTH sites", () => {
  const source = read("Scene/Scene.js");
  for (const site of [
    /ignore3dTiles \|\|\s*\r?\n\s*!primitive\.isCesium3DTileset \|\|\s*\r?\n\s*primitive\.isDestroyed\(\)/,
    /!primitive\.isCesium3DTileset \|\| primitive\.isDestroyed\(\)/,
  ]) {
    assert.match(source, site);
  }
  assert.ok(
    !/primitive\.isDestroyed\(\) \|\|\s*\r?\n?\s*!primitive\.isCesium3DTileset/.test(
      source,
    ),
    "no site may call isDestroyed before the marker test",
  );
});

test("P8: PrimitiveCollection still requires only update() per frame", () => {
  const source = read("Scene/PrimitiveCollection.js");
  const updateBody = source.slice(
    source.indexOf("  update(frameState) {"),
    source.indexOf("  updateForPass("),
  );
  assert.match(updateBody, /primitives\[i\]\.update\(frameState\)/);
  assert.ok(
    !/isDestroyed\(\)/.test(updateBody),
    "if the collection ever requires isDestroyed per frame, this decision changes",
  );
});

// ═══ PART TWO ══════════════════════════════════════════════════════════════

async function loadLightTypes() {
  const result = await build({
    entryPoints: [path.join(ENGINE, "Scene/LightTypes.ts")],
    bundle: true,
    format: "esm",
    write: false,
    platform: "node",
    target: "es2022",
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

const lightTypes = await loadLightTypes();
const {
  LightCollection,
  PointLight,
  LIGHT_PACK_FLOATS,
  LIGHT_PACK_VEC4_COUNT,
  FLOATS_PER_PACKED_LIGHT,
  LIGHT_PACK_HEADER_FLOATS,
} = lightTypes;

// A minimal stand-in for the WebGL uniform-array object, sized the way
// `createUniformArray` sizes it: from the LINKED GLSL array length.
function makeUniformArray(vec4Count) {
  return {
    name: "czm_lightsData",
    value: null,
    _value: new Float32Array(vec4Count * 4),
    _overflowReported: false,
    uploaded: null,
    _gl: {
      uniform4fv: function (_location, data) {
        this.owner.uploaded = Float32Array.from(data);
      },
    },
    _location: {},
  };
}

async function loadUniformArraySetter() {
  const source = read("Renderer/createUniformArray.js");
  const start = source.indexOf("class UniformArrayFloatVec4 {");
  assert.ok(start > 0, "UniformArrayFloatVec4 moved");
  const setStart = source.indexOf("  set() {", start);
  let depth = 0;
  let i = source.indexOf("{", setStart);
  const bodyStart = i;
  for (; i < source.length; ++i) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        break;
      }
    }
  }
  const body = source.slice(bodyStart + 1, i);
  // eslint-disable-next-line no-new-func
  return new Function(
    "Cartesian4",
    "Color",
    "defined",
    `return function () {${body}};`,
  );
}

// `loadUniformArraySetter` returns a FACTORY over the method body: calling it
// with the module-scope names the body closes over yields the method itself.
const definedShim = (v) => v !== undefined && v !== null;
const uniformSet = (await loadUniformArraySetter())(null, null, definedShim);

test("Q1: the packer writes more floats than the pre-fix declaration held", () => {
  const lights = new LightCollection();
  for (let i = 0; i < 6; ++i) {
    lights.add(new PointLight({ range: 120, intensity: 600 }));
  }
  const packed = lights.pack();
  assert.equal(packed.length, LIGHT_PACK_FLOATS);
  assert.equal(packed.length, 164);
  assert.ok(
    packed.length > 33 * 4,
    "the pre-fix vec4[33] declaration was 132 floats — smaller than the pack",
  );
});

test("Q2: MUTANT — the pre-fix 132-float destination reproduces the RangeError", () => {
  const lights = new LightCollection();
  lights.add(new PointLight({ range: 120 }));
  const packed = lights.pack();
  const destination = new Float32Array(33 * 4);
  assert.throws(() => destination.set(packed), {
    name: "RangeError",
    message: /offset is out of bounds/,
  });
});

test("Q3: the shipped declaration is sized from the packer", () => {
  assert.equal(LIGHT_PACK_VEC4_COUNT, LIGHT_PACK_FLOATS / 4);
  assert.equal(LIGHT_PACK_VEC4_COUNT, 41);
  const automatic = read("Renderer/AutomaticUniforms.js");
  const block = automatic.slice(
    automatic.indexOf("czm_lightsData: new AutomaticUniform({"),
  );
  assert.match(
    block.slice(0, 200),
    /size: LIGHT_PACK_VEC4_COUNT,/,
    "the declaration must not restate a literal",
  );
});

test("Q4: UniformState stages exactly what the packer writes, so pack never reallocates", () => {
  const uniformState = read("Renderer/UniformState.js");
  assert.match(uniformState, /new Float32Array\(LIGHT_PACK_FLOATS\)/);
  const lights = new LightCollection();
  lights.add(new PointLight({}));
  const staged = new Float32Array(LIGHT_PACK_FLOATS);
  const returned = lights.pack(staged);
  assert.equal(
    returned,
    staged,
    "a correctly sized buffer must be reused in place",
  );
});

test("Q5: the shipped setter uploads instead of throwing when a producer overpacks", () => {
  const array = makeUniformArray(41);
  array._gl.owner = array;
  array.value = new Float32Array(164).fill(1);
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  try {
    uniformSet.call(array);
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 0, "a correctly sized array must not report");
  assert.equal(array.uploaded.length, 164);
});

test("Q6: an overpacking producer is reported once, by name, and does not throw", () => {
  const array = makeUniformArray(33);
  array._gl.owner = array;
  array.value = new Float32Array(164).fill(2);
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  try {
    assert.doesNotThrow(() => uniformSet.call(array));
    array.value = new Float32Array(164).fill(3);
    uniformSet.call(array);
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1, "the report is latched, not per-frame");
  assert.match(errors[0], /czm_lightsData/);
  assert.equal(
    array.uploaded.length,
    132,
    "the addressable prefix is uploaded",
  );
});

test("Q7: the GLSL unpack stride matches the packer's record size", () => {
  const glsl = read("Shaders/Model/LightingStageFS.glsl");
  const stride = /int base = 1 \+ index \* (\d+);/.exec(glsl);
  assert.ok(stride, "czm_unpackLight's stride expression moved");
  assert.equal(
    Number(stride[1]) * 4,
    FLOATS_PER_PACKED_LIGHT,
    `GLSL steps ${stride[1]} vec4s; the packer writes ${FLOATS_PER_PACKED_LIGHT} floats per light`,
  );
});

test("Q8: the GLSL vec4 indices land on the fields the packer wrote", () => {
  const lights = new LightCollection();
  lights.add(new PointLight({ intensity: 0 }));
  const marked = lights.add(
    new PointLight({
      intensity: 7.5,
      range: 42,
      constantAttenuation: 1.5,
      linearAttenuation: 2.5,
      quadraticAttenuation: 3.5,
    }),
  );
  const packed = lights.pack();
  const stride = FLOATS_PER_PACKED_LIGHT / 4;
  const base = 1 + 1 * stride; // vec4 index of the SECOND light
  const vec4 = (index) => packed.subarray(index * 4, index * 4 + 4);
  assert.equal(vec4(base)[3], marked.lightType, "v0.w must be the light type");
  assert.equal(vec4(base + 1)[3], 7.5, "v1.w must be intensity");
  assert.deepEqual(
    Array.from(vec4(base + 2)),
    [42, 1.5, 2.5, 3.5],
    "v2 must be range + the three attenuation terms",
  );
});

test("Q9: MUTANT — the pre-fix stride of 4 reads the wrong slot for light 1", () => {
  const lights = new LightCollection();
  lights.add(new PointLight({ intensity: 1 }));
  lights.add(new PointLight({ intensity: 7.5, range: 42 }));
  const packed = lights.pack();
  const preFixBase = 1 + 1 * 4;
  const vec4 = (index) => packed.subarray(index * 4, index * 4 + 4);
  assert.notEqual(
    vec4(preFixBase + 1)[3],
    7.5,
    "if the 4-vec4 stride still found the intensity, Q7 would prove nothing",
  );
});

test("Q10: the shader loop bound cannot exceed the slots the packer provides", () => {
  const glsl = read("Shaders/Model/LightingStageFS.glsl");
  const bound = /for \(int i = 0; i < (\d+); i\+\+\)/.exec(
    glsl.slice(glsl.indexOf("int additionalLightCount")),
  );
  assert.ok(bound, "the additional-light loop moved");
  assert.equal(Number(bound[1]), LightCollection.MAX_LIGHTS);
  const maxVec4 =
    1 + (Number(bound[1]) - 1) * (FLOATS_PER_PACKED_LIGHT / 4) + 4;
  assert.ok(
    maxVec4 < LIGHT_PACK_VEC4_COUNT,
    `the loop can address vec4 ${maxVec4} of ${LIGHT_PACK_VEC4_COUNT}`,
  );
  assert.equal(LIGHT_PACK_HEADER_FLOATS, 4);
});

test("Q11: the published light count is the one the packer wrote, not enabledCount", () => {
  const uniformState = read("Renderer/UniformState.js");
  assert.match(uniformState, /this\._lightCount = this\._lightsData\[0\];/);
  assert.ok(
    !/this\._lightCount = lights\.enabledCount;/.test(uniformState),
    "enabledCount counts area lights that pack() skips",
  );
  const lights = new LightCollection();
  lights.add(new PointLight({}));
  lights.add(new PointLight({}));
  const packed = lights.pack();
  assert.equal(packed[0], 2);
  assert.equal(packed[0], lights.enabledCount);
});
