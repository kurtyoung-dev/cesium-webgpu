// elevation-contour-pixel-ratio-parity.spec.mjs — the contour line width the
// static primitive shaders draw must be the width the GLSL reference draws on
// the same display.
// @purpose Evaluates the contour line-width threshold parsed out of both PrimitiveMatElevContour shaders against the threshold parsed out of ElevationContourMaterial.glsl, over an envelope of device pixel ratios, and independently derives the byte offset the shaders read the ratio from so it matches the offset WebGPUPrimitiveCommands packs it to.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no device.
//
// WHY THIS EXISTS
// ---------------
// `czm_pixelRatio` converts a CSS-pixel line width into device pixels. The GLSL
// contour material scales its screen-space derivative threshold by it; the two
// static WGSL shaders did not, because the primitive camera uniform buffer
// carried no pixel-ratio lane at all. On a device-pixel-ratio 2 display that
// halves the drawn contour line, and the error is invisible at ratio 1, which
// is where a desktop demo usually runs.
//
// WHAT IS ACTUALLY CHECKED
// ------------------------
// Two things, and they fail for different reasons.
//
//   - THE THRESHOLD AGREES. The `dF` expression is parsed out of each WGSL
//     shader and out of the GLSL reference, identifiers are mapped onto each
//     other by role, and both are evaluated numerically over an envelope of
//     ratios, widths and derivatives. A divergence is reported as a number.
//   - THE LANE IS WHERE THE PACKER PUTS IT. The WGSL struct is laid out here
//     from the uniform-address-space rules, and the byte offset that lands on
//     is compared against the float offset `WebGPUPrimitiveCommands.ts`
//     declares. A field appended to either side alone moves one and not the
//     other, so this fails on the mismatch rather than on a pixel.
//   - THE LANE CARRIES THE RATIO. The two packer functions are lifted out of
//     the TypeScript source and EXECUTED against fixture uniform states, so a
//     lane that is present, correctly placed and filled with a constant 1.0
//     is a failure here rather than a silent no-op on every display.
//
// WHAT IS NOT CHECKED HERE
// ------------------------
// The fabric's own WGSL port of the same material, which the globe path splices
// into `GlobeTerrain.wgsl`, still hardcodes the factor as `1.0`: the globe
// surface camera buffer carries no pixel-ratio lane either. That is a separate
// lane in a different uniform buffer and it stays open. Nothing here is a pixel
// measurement.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const COMMANDS_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts";
const GLSL_FILE =
  "packages/engine/Source/Shaders/Materials/ElevationContourMaterial.glsl";
// Gitignored, so a materialized module here is never a tracked artifact.
const OUTPUT_RELATIVE = "Tools/visual-regression/output";

const SHADERS = [
  {
    file: "packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatElevContourFlat.wgsl",
    sizeConstant: "FLAT_CAMERA_BYTES",
    offsetConstant: "FLAT_PIXEL_RATIO_OFFSET",
  },
  {
    file: "packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatElevContourLit.wgsl",
    sizeConstant: "LIT_CAMERA_BYTES",
    offsetConstant: "LIT_PIXEL_RATIO_OFFSET",
  },
];

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

const f32 = Math.fround;

function read(relative) {
  return fs
    .readFileSync(path.join(REPO_ROOT, relative), "utf8")
    .replace(/\r\n/g, "\n");
}

function stripComments(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

// =============================================================================
// A tiny evaluator for the threshold expressions, which are products of names,
// literals and `max(a, b)`.
// =============================================================================

function parseProduct(expression) {
  const tokens = expression
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

  function primary() {
    if (peek() === "(") {
      take("(");
      const inner = product();
      take(")");
      return inner;
    }
    if (peek() === "max") {
      take("max");
      take("(");
      const left = product();
      take(",");
      const right = product();
      take(")");
      return { kind: "max", left, right };
    }
    const token = take();
    if (/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) {
      return { kind: "literal", value: Number.parseFloat(token) };
    }
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(token)) {
      return { kind: "name", name: token };
    }
    throw new Error(`unparsable token ${String(token)}`);
  }

  function product() {
    let left = primary();
    while (peek() === "*") {
      take("*");
      left = { kind: "product", left, right: primary() };
    }
    return left;
  }

  const tree = product();
  if (index !== tokens.length) {
    throw new Error(`trailing tokens: ${tokens.slice(index).join(" ")}`);
  }
  return tree;
}

// Identifiers are mapped onto roles so the two dialects can be compared by
// meaning. An identifier with no role is an error, not a silent zero.
const ROLES = new Map([
  ["dxc", "dxc"],
  ["dyc", "dyc"],
  ["czm_pixelRatio", "pixelRatio"],
  ["camera.pixelRatio.x", "pixelRatio"],
  ["width", "width"],
  ["material.width", "width"],
]);

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

function rolesUsed(node, found = new Set()) {
  if (node.kind === "name") {
    found.add(ROLES.get(node.name));
  } else if (node.kind === "literal") {
    // nothing
  } else if (node.kind === "max" || node.kind === "product") {
    rolesUsed(node.left, found);
    rolesUsed(node.right, found);
  }
  return found;
}

function thresholdExpression(source, pattern) {
  const match = stripComments(source).match(pattern);
  assert.ok(match, "no contour threshold expression found");
  return match[1].trim();
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
  const match = stripComments(source).match(
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
  const maxAlign = Math.max(
    ...fields.map((field) => WGSL_TYPES.get(field.type).align),
  );
  return { placed, size: Math.ceil(offset / maxAlign) * maxAlign };
}

function numericConstant(source, name) {
  const match = stripComments(source).match(
    new RegExp(`const\\s+${name}\\s*=\\s*([0-9_]+)`),
  );
  assert.ok(match, `no constant ${name} in ${COMMANDS_FILE}`);
  return Number.parseInt(match[1].replace(/_/g, ""), 10);
}

// =============================================================================
// Tests
// =============================================================================

// Lifts a function body out of the TypeScript source so it can be executed.
// The two functions this is used on carry no TypeScript-only syntax in their
// bodies, and running them is the only way to score what they WRITE rather
// than what they are spelled as.
function liftFunctionBody(source, name) {
  const start = stripComments(source).indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `no function ${name} in ${COMMANDS_FILE}`);
  const text = stripComments(source);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
  }
  throw new Error(`unbalanced body for ${name}`);
}

// Re-emits the two lifted bodies as a real ES module under the gitignored
// output directory and imports it, so the real loader runs the real source.
// The alternative — evaluating the text in-process — would be the same
// execution with a worse provenance story.
async function importLiftedPacker(commands) {
  const directory = fs.mkdtempSync(
    path.join(REPO_ROOT, OUTPUT_RELATIVE, "contour-pixel-ratio-"),
  );
  const file = path.join(directory, "lifted-packer.mjs");
  fs.writeFileSync(
    file,
    [
      "function defined(value) {",
      "  return value !== undefined && value !== null;",
      "}",
      `export function resolvePixelRatio(uniformState) {${liftFunctionBody(
        commands,
        "resolvePixelRatio",
      )}}`,
      `export function writePixelRatioTail(ud, offset, uniformState) {${liftFunctionBody(
        commands,
        "writePixelRatioTail",
      )}}`,
      "",
    ].join("\n"),
  );
  const module = await import(pathToFileURL(file).href);
  return { module, directory };
}

test("the packed lane carries the real device pixel ratio", async (t) => {
  const commands = read(COMMANDS_FILE);
  const { module, directory } = await importLiftedPacker(commands);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const resolve = (state) => module.resolvePixelRatio(state);
  const write = (ud, offset, state) =>
    module.writePixelRatioTail(ud, offset, state);

  const cases = [
    { state: { pixelRatio: 2 }, expected: 2 },
    { state: { pixelRatio: 1.25 }, expected: 1.25 },
    { state: { frameState: { pixelRatio: 3 } }, expected: 3 },
    { state: {}, expected: 1 },
    // A uniform state that carries both must prefer its own value, the way
    // the polyline lane already does.
    { state: { pixelRatio: 2, frameState: { pixelRatio: 4 } }, expected: 2 },
  ];

  for (const { state, expected } of cases) {
    assert.equal(
      resolve(state),
      expected,
      `resolvePixelRatio(${JSON.stringify(state)})`,
    );
    for (const shader of SHADERS) {
      const offset = numericConstant(commands, shader.offsetConstant);
      const bufferBytes = numericConstant(commands, shader.sizeConstant);
      const ud = new Float32Array(bufferBytes / 4).fill(-1);
      write(ud, offset, state);
      assert.equal(
        ud[offset],
        f32(expected),
        `${shader.offsetConstant}: the lane holds ${ud[offset]} for ` +
          `${JSON.stringify(state)}`,
      );
      assert.deepEqual(
        [ud[offset + 1], ud[offset + 2], ud[offset + 3]],
        [0, 0, 0],
        `${shader.offsetConstant}: the reserved lanes must be zeroed`,
      );
    }
  }

  // A lane that only ever reports 1.0 would satisfy every check above that
  // does not vary the ratio, so require it to actually vary.
  assert.notEqual(
    resolve({ pixelRatio: 2 }),
    resolve({ pixelRatio: 1 }),
    "the resolver returns the same value for different ratios",
  );

  // The value semantics above are executed; this last part is the wiring, and
  // it can only be read off the call sites. A packer that fills the lane
  // correctly but is never called leaves the shader reading whatever the
  // buffer already held.
  for (const shader of SHADERS) {
    const writer =
      shader.offsetConstant === "FLAT_PIXEL_RATIO_OFFSET"
        ? "writeRTEUniformsFlat"
        : "writeRTEUniformsLit";
    const body = liftFunctionBody(commands, writer);
    assert.ok(
      body.includes(
        `writePixelRatioTail(ud, ${shader.offsetConstant}, uniformState)`,
      ),
      `${writer} never packs the pixel-ratio lane`,
    );
  }
});

test("both static shaders compute the GLSL contour threshold", () => {
  const glslTree = parseProduct(
    thresholdExpression(read(GLSL_FILE), /float\s+dF\s*=([^;]*);/),
  );
  const glslRoles = rolesUsed(glslTree);
  assert.ok(
    glslRoles.has("pixelRatio"),
    `${GLSL_FILE} no longer scales by the pixel ratio — this spec's premise is gone`,
  );

  for (const shader of SHADERS) {
    const wgslTree = parseProduct(
      thresholdExpression(read(shader.file), /let\s+dF\s*=([^;]*);/),
    );
    for (const ratio of RATIOS) {
      for (const width of WIDTHS) {
        for (const [dxc, dyc] of DERIVATIVES) {
          const environment = { dxc, dyc, pixelRatio: ratio, width };
          const expected = evaluate(glslTree, environment);
          const observed = evaluate(wgslTree, environment);
          assert.equal(
            observed,
            expected,
            `${shader.file}: at ratio ${ratio}, width ${width}, ` +
              `derivatives ${dxc}/${dyc} the threshold is ${observed} ` +
              `where the GLSL reference computes ${expected}`,
          );
        }
      }
    }
  }
});

test("the ratio a shader reads sits where the packer writes it", () => {
  const commands = read(COMMANDS_FILE);
  for (const shader of SHADERS) {
    const { placed, size } = layout(
      structFields(read(shader.file), "CameraUniforms"),
    );
    const field = placed.find((candidate) => candidate.name === "pixelRatio");
    assert.ok(field, `${shader.file}: CameraUniforms declares no pixelRatio`);

    const packedFloatOffset = numericConstant(commands, shader.offsetConstant);
    assert.equal(
      field.offset,
      packedFloatOffset * 4,
      `${shader.file}: the shader reads the ratio at byte ${field.offset} ` +
        `but ${shader.offsetConstant} packs it to byte ${packedFloatOffset * 4}`,
    );

    const bufferBytes = numericConstant(commands, shader.sizeConstant);
    assert.ok(
      size <= bufferBytes,
      `${shader.file}: the struct needs ${size} bytes but ` +
        `${shader.sizeConstant} allocates ${bufferBytes}`,
    );
    assert.equal(
      bufferBytes % 16,
      0,
      `${shader.sizeConstant} must stay a multiple of 16`,
    );
  }
});
