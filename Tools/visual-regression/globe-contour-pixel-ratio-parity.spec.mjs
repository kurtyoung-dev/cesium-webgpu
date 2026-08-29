// globe-contour-pixel-ratio-parity.spec.mjs — a contour drawn on the globe
// must be as many device pixels wide on WebGPU as its GLSL reference draws.
// @purpose Evaluates the contour line-width threshold taken from the live ElevationContour fabric's WGSL body against the threshold parsed out of ElevationContourMaterial.glsl over an envelope of device pixel ratios, derives the byte offset the globe camera struct puts the ratio at, and executes the globe camera packer's write sequence to check the ratio lands on that same slot.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no device.
//
// WHY THIS EXISTS
// ---------------
// The primitive contour shaders gained a pixel-ratio lane, but the GLOBE path
// does not use them: a `globe.material` is spliced into `GlobeTerrain.wgsl` as
// the fabric's own WGSL body, and that body multiplied by a literal `1.0`
// where its GLSL source multiplies by `czm_pixelRatio`, because the globe
// camera buffer carried no such value. On a device-pixel-ratio 2 display the
// globe's contour lines therefore drew half as wide as WebGL's, and the error
// is invisible at ratio 1, which is where a desktop demo usually runs.
//
// The globe camera buffer had no room to grow — its float count is pinned by
// another gate — so the ratio reuses the padding slot after `center3DLow`.
// That makes WHERE it lands the thing most likely to rot: the shader reads a
// named struct field, the packer writes a positional slot, and nothing else
// connects them.
//
// WHAT IS ACTUALLY CHECKED
// ------------------------
//   - THE THRESHOLD AGREES. The `dF` product is parsed out of the fabric's
//     live WGSL body (read off a real constructed `Material`, not off a file)
//     and out of the GLSL reference, identifiers are mapped onto each other by
//     role, and both are evaluated in 32-bit floats over an envelope of
//     ratios, widths and per-pixel height gradients. A literal in place of the
//     ratio is a number here, not a spelling.
//   - THE SLOT IS WHERE THE PACKER PUTS IT. The WGSL `CameraUniforms` struct
//     is laid out from the uniform-address-space rules, and the packer's write
//     sequence is EXECUTED with sentinel values so the index the ratio lands
//     on is produced by running the real statements. A reordered field, an
//     inserted write or a changed loop bound moves one and not the other.
//   - THIS LANE DID NOT GROW THE BUFFER. `CAMERA_UNIFORM_FLOATS` is 244 because the celestial tail set it; this lane must leave it there: the
//     lane was carved out of padding, and an appended field would move every
//     tail offset that other gates pin.
//   - INERTNESS. Three mutants, each made unreachable or neutral rather than
//     deleted, and each has to turn one of the above red.
//
// WHAT IS NOT CHECKED HERE
// ------------------------
// No pixel is measured. The GLSL `#else` branch of the material (no
// derivatives available) is not evaluated: this fork targets WebGL2 only, so
// `__VERSION__ == 300` always selects the derivative branch.
//
// The packer's write sequence is executed with every value except the ratio
// replaced by zero, because reproducing the real values needs a device, a
// tile and a terrain mesh. The sequence, the loop bounds and the resulting
// index are real; the numbers in the other slots are not, and nothing here
// reads them.

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ENGINE_SOURCE = path.join(REPO_ROOT, "packages", "engine", "Source");

const GLSL_FILE =
  "packages/engine/Source/Shaders/Materials/ElevationContourMaterial.glsl";
const TERRAIN_FILE =
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const CAMERA_UB_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts";
const TYPES_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts";
// Gitignored, so a materialized module here is never a tracked artifact.
const OUTPUT_RELATIVE = "Tools/visual-regression/output";

// =============================================================================
// Environment — see material-appearance-blend-parity.spec.mjs for the rationale.
// The shader build outputs are absent in an unbuilt tree; each is supplied from
// the source file next to it, which is the string the build would emit.
// =============================================================================

const SHADER_JS = /Shaders\/[^"']*\.js$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (SHADER_JS.test(specifier) && context.parentURL) {
      const url = new URL(specifier, context.parentURL).href;
      if (!fs.existsSync(fileURLToPath(url))) {
        return { url, format: "module", shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (SHADER_JS.test(url)) {
      const file = fileURLToPath(url);
      if (!fs.existsSync(file)) {
        let text = "";
        for (const extension of [".glsl", ".wgsl"]) {
          const candidate = file.replace(/\.js$/, extension);
          if (fs.existsSync(candidate)) {
            text = fs.readFileSync(candidate, "utf8");
            break;
          }
        }
        return {
          format: "module",
          shortCircuit: true,
          source: `export default ${JSON.stringify(text)};`,
        };
      }
    }
    return nextLoad(url, context);
  },
});

for (const name of [
  "HTMLCanvasElement",
  "HTMLImageElement",
  "HTMLVideoElement",
  "ImageBitmap",
  "OffscreenCanvas",
  "ImageData",
]) {
  if (globalThis[name] === undefined) {
    globalThis[name] = class {};
  }
}

const Material = (
  await import(
    pathToFileURL(path.join(ENGINE_SOURCE, "Scene/Material.js")).href
  )
).default;

function read(relative) {
  return fs
    .readFileSync(path.join(REPO_ROOT, relative), "utf8")
    .replace(/\r\n/g, "\n");
}

function stripLineComments(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

// =============================================================================
// A tiny evaluator for the threshold expressions, which are products of names,
// literals and `max(a, b)`.
// =============================================================================

const ROLES = new Map([
  ["dxc", "dx"],
  ["dyc", "dy"],
  ["czm_pixelRatio", "ratio"],
  ["width", "width"],
]);

function parseProduct(expression) {
  // `czm_pixelRatio()` in WGSL and `czm_pixelRatio` in GLSL are the same role;
  // normalize the call form so one role table serves both.
  const tokens = expression
    .replace(/czm_pixelRatio\s*\(\s*\)/g, "czm_pixelRatio")
    .replace(/([*(),])/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
  let index = 0;
  const peek = () => tokens[index];
  const take = (expected) => {
    const token = tokens[index++];
    if (expected !== undefined && token !== expected) {
      throw new Error(`expected ${expected} but found ${String(token)}`);
    }
    return token;
  };

  function atom() {
    const token = take();
    if (token === "max") {
      take("(");
      const left = product();
      take(",");
      const right = product();
      take(")");
      return { kind: "max", left, right };
    }
    if (token === "(") {
      const inner = product();
      take(")");
      return inner;
    }
    if (/^[0-9]/.test(token)) {
      return { kind: "literal", value: Number.parseFloat(token) };
    }
    return { kind: "name", name: token };
  }

  function product() {
    let node = atom();
    while (peek() === "*") {
      take("*");
      node = { kind: "product", left: node, right: atom() };
    }
    return node;
  }

  const tree = product();
  assert.equal(index, tokens.length, `unconsumed tokens in ${expression}`);
  return tree;
}

const f32 = Math.fround;

function evaluate(node, environment) {
  switch (node.kind) {
    case "literal":
      return f32(node.value);
    case "name": {
      const role = ROLES.get(node.name);
      if (role === undefined) {
        throw new Error(`no role for identifier ${node.name}`);
      }
      return f32(environment[role]);
    }
    case "max":
      return f32(
        Math.max(
          evaluate(node.left, environment),
          evaluate(node.right, environment),
        ),
      );
    case "product":
      return f32(
        evaluate(node.left, environment) * evaluate(node.right, environment),
      );
    default:
      throw new Error(`unsupported node ${node.kind}`);
  }
}

function thresholdExpression(source, pattern, label) {
  const match = stripLineComments(source).match(pattern);
  assert.ok(match, `no contour threshold expression in ${label}`);
  return match[1].trim();
}

// Ratios a real display reports, plus the two that bracket them.
const RATIOS = [1, 1.25, 1.5, 2, 2.5, 3, 4];
const WIDTHS = [0.5, 1, 2, 5];
// Per-pixel height gradients a contour demo actually produces.
const DERIVATIVES = [
  [0.5, 0.25],
  [8, 12],
  [53, 4],
  [90, 90],
];

function compareThresholds(wgslSource, glslSource) {
  const wgsl = parseProduct(
    thresholdExpression(wgslSource, /let\s+dF\s*=\s*([^;]+);/, "fabric WGSL"),
  );
  const glsl = parseProduct(
    thresholdExpression(glslSource, /float\s+dF\s*=\s*([^;]+);/, GLSL_FILE),
  );
  const divergences = [];
  for (const ratio of RATIOS) {
    for (const width of WIDTHS) {
      for (const [dx, dy] of DERIVATIVES) {
        const environment = { ratio, width, dx, dy };
        const a = evaluate(wgsl, environment);
        const b = evaluate(glsl, environment);
        if (a !== b) {
          divergences.push({ ratio, width, dx, dy, wgsl: a, glsl: b });
        }
      }
    }
  }
  return divergences;
}

// =============================================================================
// WGSL uniform-address-space layout, derived rather than assumed.
// =============================================================================

const WGSL_TYPES = new Map([
  ["f32", { size: 4, align: 4 }],
  ["u32", { size: 4, align: 4 }],
  ["i32", { size: 4, align: 4 }],
  ["vec2<f32>", { size: 8, align: 8 }],
  ["vec3<f32>", { size: 12, align: 16 }],
  ["vec4<f32>", { size: 16, align: 16 }],
  ["mat3x3<f32>", { size: 48, align: 16 }],
  ["mat4x4<f32>", { size: 64, align: 16 }],
]);

function structFields(source, name) {
  const match = stripLineComments(source).match(
    new RegExp(`struct\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  assert.ok(match, `no struct ${name}`);
  return match[1]
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(":").map((part) => part.trim());
      assert.equal(parts.length, 2, `unparsable struct member: ${line}`);
      return { name: parts[0], type: parts[1] };
    });
}

function layout(fields) {
  let offset = 0;
  const placed = [];
  for (const field of fields) {
    const shape = WGSL_TYPES.get(field.type);
    assert.ok(shape, `unhandled WGSL type ${field.type}`);
    offset = Math.ceil(offset / shape.align) * shape.align;
    placed.push({ ...field, offset });
    offset += shape.size;
  }
  return placed;
}

function fieldFloatOffset(terrainSource, fieldName) {
  const placed = layout(structFields(terrainSource, "CameraUniforms"));
  const field = placed.find((entry) => entry.name === fieldName);
  assert.ok(field, `CameraUniforms has no field ${fieldName}`);
  assert.equal(field.type, "f32", `${fieldName} must be a scalar float lane`);
  assert.equal(field.offset % 4, 0);
  return field.offset / 4;
}

// =============================================================================
// Executing the packer's write sequence
// =============================================================================

const PACKER_FUNCTION = "createCameraUniformBuffer";
const SCALAR_WRITE = /^ {2}data\[offset\+\+\] = (.+);$/;
const LOOP_WRITE =
  /^ {2}for \(let i = 0; i < (\d+); i\+\+\) data\[offset\+\+\] = .+;$/;
const RATIO_SOURCE = "uniformState.pixelRatio";

function packerBody(rawSource) {
  // Comments go first: a brace inside one would derail the depth count, and
  // the writes this reads are all bare statements.
  const source = stripLineComments(rawSource);
  const start = source.indexOf(`export function ${PACKER_FUNCTION}(`);
  assert.notEqual(start, -1, `no ${PACKER_FUNCTION} in ${CAMERA_UB_FILE}`);
  // The signature's return type is itself an object literal, so the body's
  // brace is the LAST one on the line that closes the parameter list.
  const signatureEnd = source.indexOf("):", start);
  assert.notEqual(signatureEnd, -1, `${PACKER_FUNCTION} has no return type`);
  const lineEnd = source.indexOf("\n", signatureEnd);
  const open = source.lastIndexOf("{", lineEnd);
  assert.ok(open > signatureEnd, `${PACKER_FUNCTION} body brace not found`);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  throw new Error(`unbalanced body for ${PACKER_FUNCTION}`);
}

// Re-emits the packer's prefix as a real module and imports it, so the write
// sequence is run rather than counted. Every value but the ratio becomes 0 —
// the real ones need a device, a tile and a terrain mesh — while the loop
// bounds, the statement order and the ratio's own expression go in verbatim.
async function importPackerPrefix(cameraSource) {
  const body = packerBody(cameraSource);
  const statements = [];
  let reachedRatio = false;
  for (const line of body.split("\n")) {
    if (!line.includes("data[offset")) {
      continue;
    }
    const loop = line.match(LOOP_WRITE);
    const scalar = line.match(SCALAR_WRITE);
    assert.ok(
      loop || scalar,
      `unhandled buffer write before the pixel-ratio lane: ${line.trim()}`,
    );
    if (loop) {
      statements.push(
        `  for (let i = 0; i < ${loop[1]}; i++) data[offset++] = 0;`,
      );
      continue;
    }
    if (scalar[1].includes(RATIO_SOURCE)) {
      statements.push(`  data[offset++] = ${scalar[1]};`);
      reachedRatio = true;
      break;
    }
    statements.push("  data[offset++] = 0;");
  }
  assert.ok(
    reachedRatio,
    `${PACKER_FUNCTION} never writes ${RATIO_SOURCE} through data[offset++]`,
  );

  const directory = fs.mkdtempSync(
    path.join(REPO_ROOT, OUTPUT_RELATIVE, "globe-contour-ratio-"),
  );
  const file = path.join(directory, "lifted-packer-prefix.mjs");
  fs.writeFileSync(
    file,
    [
      "export function packPrefix(uniformState, floats) {",
      "  const data = new Float32Array(floats);",
      "  let offset = 0;",
      ...statements,
      "  return { data, offset };",
      "}",
      "",
    ].join("\n"),
  );
  const module = await import(pathToFileURL(file).href);
  return { module, directory };
}

function discard(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function cameraUniformFloats(typesSource) {
  const match = typesSource.match(
    /export const CAMERA_UNIFORM_FLOATS = (\d+);/,
  );
  assert.ok(match, `no CAMERA_UNIFORM_FLOATS in ${TYPES_FILE}`);
  return Number.parseInt(match[1], 10);
}

// =============================================================================
// Tests
// =============================================================================

const fabricWGSL = Material.fromType("ElevationContour")._template.wgsl.source;

test("the fabric's WGSL body is the one the globe splices", () => {
  assert.ok(
    fabricWGSL.includes("fn czm_getMaterial(materialInput: czm_MaterialInput)"),
    "the ElevationContour fabric must still carry a WGSL body",
  );
});

test("the globe contour threshold matches its GLSL reference at every ratio", () => {
  const divergences = compareThresholds(fabricWGSL, read(GLSL_FILE));
  assert.deepEqual(
    divergences,
    [],
    `the fabric's contour width diverges from the GLSL reference: ${JSON.stringify(
      divergences.slice(0, 3),
    )}`,
  );
});

test("the fabric reads the ratio rather than a literal", () => {
  // The envelope above is the real check; this one names the failure.
  const expression = thresholdExpression(
    fabricWGSL,
    /let\s+dF\s*=\s*([^;]+);/,
    "fabric WGSL",
  );
  assert.match(expression, /czm_pixelRatio\s*\(\s*\)/);
});

test("the globe shader exposes the ratio through a czm_pixelRatio accessor", () => {
  const terrain = read(TERRAIN_FILE);
  const accessor = terrain.match(
    /fn czm_pixelRatio\(\) -> f32 \{\s*return ([^;]+);\s*\}/,
  );
  assert.ok(accessor, "GlobeTerrain.wgsl must define czm_pixelRatio()");
  assert.equal(accessor[1].trim(), "camera.pixelRatio");
});

test("the camera struct carries the ratio in the slot the packer writes", async () => {
  const terrain = read(TERRAIN_FILE);
  const shaderFloatOffset = fieldFloatOffset(terrain, "pixelRatio");
  const floats = cameraUniformFloats(read(TYPES_FILE));

  const { module, directory } = await importPackerPrefix(read(CAMERA_UB_FILE));
  try {
    const ratio = 2.5;
    const { data, offset } = module.packPrefix({ pixelRatio: ratio }, floats);
    assert.equal(
      offset - 1,
      shaderFloatOffset,
      "the packer's ratio write and the shader's struct field must land on the same float",
    );
    assert.equal(data[shaderFloatOffset], f32(ratio));
    assert.equal(
      data[shaderFloatOffset - 1],
      0,
      "the preceding slot is center3DLow.z, not the ratio",
    );
  } finally {
    discard(directory);
  }
});

test("the lane was carved out of padding, not appended", () => {
  assert.equal(
    cameraUniformFloats(read(TYPES_FILE)),
    244,
    "growing the globe camera buffer moves every tail offset other gates pin",
  );
});

// =============================================================================
// Inertness
// =============================================================================

test("MUTANT — a fabric that multiplies by a literal goes red", () => {
  const mutated = fabricWGSL.replace("czm_pixelRatio()", "1.0");
  assert.notEqual(mutated, fabricWGSL);
  const divergences = compareThresholds(mutated, read(GLSL_FILE));
  assert.notEqual(
    divergences.length,
    0,
    "a literal in place of the ratio must be visible as a number",
  );
  // And only away from ratio 1, which is why a desktop capture missed it.
  assert.equal(
    divergences.every((entry) => entry.ratio !== 1),
    true,
  );
});

test("MUTANT — an accessor that answers a constant goes red", () => {
  const terrain = read(TERRAIN_FILE);
  const mutated = terrain.replace(
    "  return camera.pixelRatio;",
    "  if (false) { return camera.pixelRatio; }\n  return 1.0;",
  );
  assert.notEqual(mutated, terrain);
  const accessor = mutated.match(
    /fn czm_pixelRatio\(\) -> f32 \{\s*return ([^;]+);\s*\}/,
  );
  assert.equal(
    accessor,
    null,
    "an accessor whose live return is a constant must not read as the real one",
  );
});

test("MUTANT — a packer that writes a constant goes red", async () => {
  const camera = read(CAMERA_UB_FILE);
  const marker = "  data[offset++] = uniformState.pixelRatio ?? 1.0;";
  assert.ok(camera.includes(marker), "the packer's ratio write moved");
  const mutated = camera.replace(marker, "  data[offset++] = 1.0;");

  // Either the prefix runs off the end without ever seeing the ratio, or it
  // walks past the straight-line region into the conditional writes that
  // follow it. Both are the extraction refusing to produce an index.
  await assert.rejects(
    () => importPackerPrefix(mutated),
    /never writes uniformState\.pixelRatio|unhandled buffer write/,
    "a packer that stops writing the ratio must be visible here",
  );
});

test("MUTANT — a struct field renamed back to padding goes red", () => {
  const terrain = read(TERRAIN_FILE);
  const mutated = terrain.replace("  pixelRatio: f32,", "  _pad2b: f32,");
  assert.notEqual(mutated, terrain);
  assert.throws(
    () => fieldFloatOffset(mutated, "pixelRatio"),
    /CameraUniforms has no field pixelRatio/,
  );
});
