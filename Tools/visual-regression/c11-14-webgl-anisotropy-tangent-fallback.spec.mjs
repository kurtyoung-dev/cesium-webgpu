// @purpose Executes the WebGL anisotropy tangent-frame branches extracted from the live shader and requires the tangent-less fallback to match both WebGPU anisotropy paths.
// @status ACTIVE

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

let glslSource;
let wgslSource;
let anisotropyFixture;

before(async () => {
  glslSource = normalizeLines(
    await readFile(
      new URL(
        "../../packages/engine/Source/Shaders/Model/MaterialStageFS.glsl",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  wgslSource = normalizeLines(
    await readFile(
      new URL(
        "../../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  anisotropyFixture = JSON.parse(
    await readFile(
      new URL(
        "../../Apps/SampleData/models/TestKHRExtensions/TestKhrAnisotropy.gltf",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});

function normalizeLines(source) {
  return source.replace(/\r\n/gu, "\n");
}

function extractBalancedBody(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `missing signature: ${signature}`);
  const openIndex = source.indexOf("{", signatureIndex + signature.length);
  assert.notEqual(openIndex, -1, `missing opening brace: ${signature}`);

  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(openIndex + 1, index);
      }
    }
  }
  throw new Error(`unbalanced body: ${signature}`);
}

function evaluateDirective(expression, defines) {
  const runnable = expression
    .replace(/\/\/.*$/u, "")
    .replace(/defined\s*\(\s*([A-Z0-9_]+)\s*\)/gu, (_, name) =>
      defines.has(name) ? "true" : "false",
    )
    .replace(/\b([A-Z][A-Z0-9_]*)\b/gu, (_, name) =>
      defines.has(name) ? "true" : "false",
    );
  assert.match(runnable, /^[\s!&|()truefals]+$/u);
  // eslint-disable-next-line no-new-func
  return Boolean(new Function(`return (${runnable});`)());
}

function preprocess(source, defines) {
  const output = [];
  const stack = [];
  let active = true;

  for (const line of source.split("\n")) {
    const directive = /^\s*#(ifdef|ifndef|if|elif|else|endif)\b(.*)$/u.exec(
      line,
    );
    if (!directive) {
      if (active) {
        output.push(line);
      }
      continue;
    }

    const [, kind, tail] = directive;
    if (kind === "ifdef" || kind === "ifndef" || kind === "if") {
      const parentActive = active;
      const name = tail.replace(/\/\/.*$/u, "").trim();
      const condition =
        kind === "ifdef"
          ? defines.has(name)
          : kind === "ifndef"
            ? !defines.has(name)
            : evaluateDirective(name, defines);
      stack.push({ parentActive, branchTaken: condition });
      active = parentActive && condition;
    } else if (kind === "elif") {
      const frame = stack.at(-1);
      assert.ok(frame, "#elif without #if");
      const condition = evaluateDirective(tail.trim(), defines);
      active = frame.parentActive && !frame.branchTaken && condition;
      frame.branchTaken ||= condition;
    } else if (kind === "else") {
      const frame = stack.at(-1);
      assert.ok(frame, "#else without #if");
      active = frame.parentActive && !frame.branchTaken;
      frame.branchTaken = true;
    } else {
      const frame = stack.pop();
      assert.ok(frame, "#endif without #if");
      active = frame.parentActive;
    }
  }

  assert.equal(stack.length, 0, "unterminated preprocessor branch");
  return output.join("\n");
}

function vec3(...values) {
  return values.length === 1
    ? [values[0], values[0], values[0]]
    : values.slice(0, 3);
}

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function scale(vector, scalar) {
  return vector.map((value) => value * scalar);
}

function subtract(left, right) {
  return left.map((value, index) => value - right[index]);
}

function negate(vector) {
  return scale(vector, -1.0);
}

function length(vector) {
  return Math.sqrt(dot(vector, vector));
}

function normalize(vector) {
  const magnitude = length(vector);
  return vector.map((value) => value / magnitude);
}

function compileWebGLTangentFrame(defines, hooks = {}) {
  const body = extractBalancedBody(
    glslSource,
    "NormalInfo getNormalInfo(ProcessedAttributes attributes)",
  );
  const materialNormalIndex = body.indexOf(
    "\n    #ifdef HAS_NORMAL_TEXTURE\n        mat3 tbn",
  );
  assert.notEqual(
    materialNormalIndex,
    -1,
    "missing post-frame normal-texture branch",
  );

  let runnable = preprocess(body.slice(0, materialNormalIndex), defines);
  runnable = runnable
    .replace(/\bvec[234]\s+([a-zA-Z_]\w*)\s*=/gu, "let $1 =")
    .replace(
      /normalize\(tangent - geometryNormal \* dot\(geometryNormal, tangent\)\)/gu,
      "normalize(subtract(tangent, scale(geometryNormal, dot(geometryNormal, tangent))))",
    )
    .replace(/-attributes\.positionEC/gu, "negate(attributes.positionEC)");

  // eslint-disable-next-line no-new-func
  const execute = new Function(
    "attributes",
    "getNormalTexCoords",
    "computeTangent",
    "vec3",
    "dot",
    "cross",
    "scale",
    "subtract",
    "negate",
    "length",
    "normalize",
    `"use strict";\n${runnable}\nreturn { tangent, bitangent, geometryNormal };`,
  );

  return (attributes) =>
    execute(
      attributes,
      hooks.getNormalTexCoords ?? (() => [0.0, 0.0]),
      hooks.computeTangent ??
        (() => {
          throw new Error("computeTangent must not run in this permutation");
        }),
      vec3,
      dot,
      cross,
      scale,
      subtract,
      negate,
      length,
      normalize,
    );
}

function extractElseBody(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `missing branch: ${signature}`);
  const ifOpen = source.indexOf("{", signatureIndex + signature.length);
  assert.notEqual(ifOpen, -1, `missing branch body: ${signature}`);

  let depth = 0;
  let ifClose = -1;
  for (let index = ifOpen; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        ifClose = index;
        break;
      }
    }
  }
  assert.notEqual(ifClose, -1, `unbalanced branch: ${signature}`);

  const elseMatch = /^\s*else\s*\{/u.exec(source.slice(ifClose + 1));
  assert.ok(elseMatch, `missing fallback branch: ${signature}`);
  const elseOpen = ifClose + 1 + elseMatch[0].lastIndexOf("{");
  return extractBalancedBody(source.slice(elseOpen), "");
}

function compileWebGPUFallback(signature, tangentName, bitangentName) {
  const body = extractElseBody(wgslSource, signature);
  // eslint-disable-next-line no-new-func
  const execute = new Function(
    "N",
    "V",
    "cross",
    "normalize",
    `"use strict";\nlet ${tangentName};\nlet ${bitangentName};\n${body}\nreturn { tangent: ${tangentName}, bitangent: ${bitangentName} };`,
  );
  return (normal, viewDirection) =>
    execute(normal, viewDirection, cross, normalize);
}

function expectedViewFrame(normal, viewDirection) {
  const tangent = normalize(cross(normal, viewDirection));
  return {
    tangent,
    bitangent: normalize(cross(tangent, normal)),
  };
}

function assertVectorClose(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= 1.0e-12,
      `${label}[${index}]: expected ${expected[index]}, got ${actual[index]}`,
    );
  }
}

function assertFrameClose(actual, expected, label) {
  assertVectorClose(actual.tangent, expected.tangent, `${label} tangent`);
  assertVectorClose(actual.bitangent, expected.bitangent, `${label} bitangent`);
}

test("the real anisotropy fixture reaches the tangent-less, normal-map-less permutation", () => {
  const anisotropicMaterialIndex = anisotropyFixture.materials.findIndex(
    (material) => material.extensions?.KHR_materials_anisotropy,
  );
  assert.notEqual(
    anisotropicMaterialIndex,
    -1,
    "fixture must carry KHR_materials_anisotropy",
  );
  const anisotropicMaterial =
    anisotropyFixture.materials[anisotropicMaterialIndex];
  assert.equal(anisotropicMaterial.normalTexture, undefined);

  const primitive = anisotropyFixture.meshes
    .flatMap((mesh) => mesh.primitives)
    .find((candidate) => candidate.material === anisotropicMaterialIndex);
  assert.ok(primitive, "fixture must bind the anisotropic material");
  assert.equal(Object.hasOwn(primitive.attributes, "TANGENT"), false);
});

test("the extracted WebGL fallback matches both extracted WebGPU anisotropy fallbacks", () => {
  const webgl = compileWebGLTangentFrame(new Set());
  const webgpuDirect = compileWebGPUFallback(
    "if (tanLenSq > 1.0e-6)",
    "aniT",
    "aniB",
  );
  const webgpuIbl = compileWebGPUFallback(
    "if (tanLenSqIBL > 1.0e-6)",
    "aniTI",
    "aniBI",
  );

  const cases = [
    { normal: [0.0, 0.0, 1.0], position: [-2.0, 0.0, -3.0] },
    { normal: [0.0, 1.0, 0.0], position: [-3.0, -2.0, 1.0] },
    {
      normal: normalize([1.0, 2.0, 3.0]),
      position: [-4.0, 1.0, -2.0],
    },
  ];

  for (const { normal, position } of cases) {
    const viewDirection = normalize(negate(position));
    const expected = expectedViewFrame(normal, viewDirection);
    const glslFrame = webgl({ normalEC: normal, positionEC: position });
    const directFrame = webgpuDirect(normal, viewDirection);
    const iblFrame = webgpuIbl(normal, viewDirection);
    assertFrameClose(glslFrame, expected, "WebGL oracle");
    assertFrameClose(glslFrame, directFrame, "WebGL/WebGPU direct parity");
    assertFrameClose(glslFrame, iblFrame, "WebGL/WebGPU IBL parity");
  }
});

test("authored and normal-texture tangent frames keep their historical WebGL behavior", () => {
  const authored = compileWebGLTangentFrame(new Set(["HAS_BITANGENTS"]));
  const authoredFrame = authored({
    normalEC: [0.0, 0.0, 1.0],
    positionEC: [0.0, 0.0, -2.0],
    tangentEC: [1.0, 0.0, 0.0],
    bitangentEC: [0.0, 1.0, 0.0],
  });
  assert.deepEqual(authoredFrame.tangent, [1.0, 0.0, 0.0]);
  assert.deepEqual(authoredFrame.bitangent, [0.0, 1.0, 0.0]);

  let observedUv;
  const normalMapped = compileWebGLTangentFrame(
    new Set(["HAS_NORMAL_TEXTURE"]),
    {
      getNormalTexCoords: () => [0.25, 0.75],
      computeTangent: (_position, uv) => {
        observedUv = uv;
        return [2.0, 0.0, 1.0];
      },
    },
  );
  const normalMappedFrame = normalMapped({
    normalEC: [0.0, 0.0, 1.0],
    positionEC: [1.0, 2.0, -3.0],
  });
  assert.deepEqual(observedUv, [0.25, 0.75]);
  assertFrameClose(
    normalMappedFrame,
    { tangent: [1.0, 0.0, 0.0], bitangent: [0.0, 1.0, 0.0] },
    "normal-map derivative frame",
  );
});
