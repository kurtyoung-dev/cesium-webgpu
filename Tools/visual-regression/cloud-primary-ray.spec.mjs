// @purpose Validates that primary procedural-cloud rays preserve framebuffer UV row order through inverse projection.
// @status ACTIVE
// This source-and-math contract renders no pixels and makes no claim about
// screenshot causality or the visual magnitude of the row inversion.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import nodeTest from "node:test";

import Cartesian4 from "../../packages/engine/Source/Core/Cartesian4.js";
import ClipSpaceConvention from "../../packages/engine/Source/Core/ClipSpaceConvention.js";
import Matrix4 from "../../packages/engine/Source/Core/Matrix4.js";
import {
  evaluate,
  parseExpression,
  stripComments,
  tokenize,
} from "./lib/wgsl-mini-eval.mjs";

const rawShaderUrl = new URL(
  "../../packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
  import.meta.url,
);
const generatedShaderUrl = new URL(
  "../../packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.js",
  import.meta.url,
);

const missingGeneratedShaders = [generatedShaderUrl].filter(
  (shader) => !existsSync(shader),
);

function test(name, body) {
  return nodeTest(
    name,
    {
      skip:
        missingGeneratedShaders.length > 0
          ? "STRUCTURAL: generated ProceduralClouds.js is missing; run npx gulp build"
          : false,
    },
    body,
  );
}

const rendererUrl = new URL(
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
  import.meta.url,
);

const vertexUvRhs = "vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5))";
const currentNdcRhs = "vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0)";
const correctedNdcRhs =
  "vec4<f32>(vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0), 1.0, 1.0)";
const worldRayTail = `
  var viewDir = cloud.inverseProjection * ndc;
  viewDir.w = 0.0;
  let worldDir = cloud.inverseView * viewDir;
  return normalize(worldDir.xyz);
`;

const rows = [
  { name: "top", clipY: 1.0 },
  { name: "centre", clipY: 0.0 },
  { name: "bottom", clipY: -1.0 },
];
const frusta = [
  {
    name: "symmetric",
    left: -1.5,
    right: 1.5,
    bottom: -1.0,
    top: 1.0,
    near: 1.0,
    far: 100.0,
  },
  {
    name: "asymmetric",
    left: -0.75,
    right: 1.5,
    bottom: -0.4,
    top: 1.2,
    near: 1.0,
    far: 80.0,
  },
];

function structural(message, cause) {
  const suffix = cause instanceof Error ? `: ${cause.message}` : "";
  const error = new Error(`STRUCTURAL: ${message}${suffix}`);
  error.code = "STRUCTURAL";
  return error;
}

function structurally(label, operation) {
  try {
    return operation();
  } catch (error) {
    if (error?.code === "STRUCTURAL") {
      throw error;
    }
    throw structural(label, error);
  }
}

async function structurallyAsync(label, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.code === "STRUCTURAL") {
      throw error;
    }
    throw structural(label, error);
  }
}

async function readShaderCopies() {
  const raw = await structurallyAsync(
    "cannot read raw ProceduralClouds WGSL",
    () => readFile(rawShaderUrl, "utf8"),
  );
  const generatedModule = await structurallyAsync(
    "cannot import generated ProceduralClouds shader",
    () => import(generatedShaderUrl.href),
  );
  if (
    typeof generatedModule.default !== "string" ||
    generatedModule.default.length === 0
  ) {
    throw structural(
      "generated ProceduralClouds module must have a non-empty string default export",
    );
  }
  return [
    { name: "raw WGSL", source: raw },
    { name: "generated module", source: generatedModule.default },
  ];
}

function uniqueMatch(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw structural(`expected exactly one ${label}, found ${matches.length}`);
  }
  return matches[0];
}

function functionBody(source, header, label) {
  const prepared = stripComments(source);
  const match = uniqueMatch(prepared, header, `${label} function`);
  const openBrace = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  for (let index = openBrace; index < prepared.length; index += 1) {
    if (prepared[index] === "{") {
      depth += 1;
    } else if (prepared[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return prepared.slice(openBrace + 1, index);
      }
    }
  }
  throw structural(`${label} function has no closing brace`);
}

function canonical(expression, label) {
  return structurally(`unsupported ${label}`, () =>
    JSON.stringify(tokenize(expression).map(({ kind, text }) => [kind, text])),
  );
}

function bindExpression(expression, label) {
  return structurally(`unsupported ${label}`, () => {
    const tokens = tokenize(expression);
    const parsed = parseExpression(tokens, 0);
    if (parsed.next !== tokens.length) {
      throw new Error(`unconsumed token ${tokens[parsed.next]?.text}`);
    }
    return (environment) =>
      structurally(`cannot evaluate ${label}`, () =>
        evaluate(parsed.node, environment),
      );
  });
}

function vec4Adapter(xy, z, w) {
  if (
    arguments.length !== 3 ||
    typeof xy?.x !== "number" ||
    typeof xy?.y !== "number" ||
    typeof z !== "number" ||
    typeof w !== "number"
  ) {
    throw structural("unsupported vec4 constructor shape");
  }
  return new Cartesian4(xy.x, xy.y, z, w);
}

function bindPrimaryRay(source) {
  const vertex = functionBody(
    source,
    /\bfn\s+vertexMain\s*\(\s*@builtin\s*\(\s*vertex_index\s*\)\s*vid\s*:\s*u32\s*\)\s*->\s*VertexOutput\s*\{/gu,
    "vertexMain",
  );
  const worldRay = functionBody(
    source,
    /\bfn\s+getWorldRay\s*\(\s*uv\s*:\s*vec2\s*<\s*f32\s*>\s*\)\s*->\s*vec3\s*<\s*f32\s*>\s*\{/gu,
    "getWorldRay",
  );
  const uv = uniqueMatch(
    vertex,
    /\bout\.uv\s*=\s*([^;]+);/gu,
    "vertexMain UV assignment",
  )[1];
  const ndcMatch = uniqueMatch(
    worldRay,
    /\blet\s+ndc\s*=\s*([^;]+);/gu,
    "getWorldRay NDC assignment",
  );
  const beforeNdc = worldRay.slice(0, ndcMatch.index);
  const afterNdc = worldRay.slice(ndcMatch.index + ndcMatch[0].length);
  if (
    canonical(beforeNdc, "getWorldRay leading source") !==
    canonical("", "empty getWorldRay prefix")
  ) {
    throw structural("getWorldRay has source before its NDC assignment");
  }
  if (
    canonical(afterNdc, "getWorldRay tail") !==
    canonical(worldRayTail, "required getWorldRay tail")
  ) {
    throw structural("unsupported getWorldRay tail");
  }
  const ndc = ndcMatch[1];
  if (canonical(uv, "vertex UV expression") !== canonical(vertexUvRhs)) {
    throw structural("unsupported vertexMain UV expression");
  }
  const ndcShape = canonical(ndc, "getWorldRay NDC expression");
  const supported = [currentNdcRhs, correctedNdcRhs].map((rhs) =>
    canonical(rhs, "supported NDC expression"),
  );
  if (!supported.includes(ndcShape)) {
    throw structural("unsupported getWorldRay NDC expression");
  }
  return {
    vertexUv: bindExpression(uv, "vertex UV expression"),
    ndc: bindExpression(ndc, "getWorldRay NDC expression"),
    ndcShape,
  };
}

function worldRay(frustum, ndc) {
  const projection = Matrix4.computePerspectiveOffCenter(
    frustum.left,
    frustum.right,
    frustum.bottom,
    frustum.top,
    frustum.near,
    frustum.far,
    new Matrix4(),
    ClipSpaceConvention.WEBGPU,
  );
  const inverseProjection = Matrix4.inverse(projection, new Matrix4());
  const view = Matrix4.multiplyByVector(
    inverseProjection,
    ndc,
    new Cartesian4(),
  );
  view.w = 0.0;
  const world = Matrix4.multiplyByVector(
    Matrix4.IDENTITY,
    view,
    new Cartesian4(),
  );
  const magnitude = Math.hypot(world.x, world.y, world.z);
  return [world.x / magnitude, world.y / magnitude, world.z / magnitude];
}

function close(left, right) {
  return Math.abs(left - right) <= 1e-12;
}

function observations(name, source) {
  const shader = bindPrimaryRay(source);
  return frusta.flatMap((frustum) =>
    rows.map((row) => {
      const uv = shader.vertexUv({ x: 0.0, y: row.clipY });
      const actualNdc = shader.ndc({
        uv,
        __functions: { vec4: vec4Adapter },
      });
      const expectedNdc = new Cartesian4(
        uv.x * 2.0 - 1.0,
        1.0 - uv.y * 2.0,
        1.0,
        1.0,
      );
      const actualRay = worldRay(frustum, actualNdc);
      const expectedRay = worldRay(frustum, expectedNdc);
      return {
        source: name,
        frustum: frustum.name,
        row: row.name,
        expectedRayY: expectedRay[1],
        ndcYMatches: close(actualNdc.y, expectedNdc.y),
        rayMatches: actualRay.every((value, index) =>
          close(value, expectedRay[index]),
        ),
      };
    }),
  );
}

function predicate(results) {
  return results.every(
    ({ ndcYMatches, rayMatches }) => ndcYMatches && rayMatches,
  );
}

function replaceExactlyOnce(source, before, after, label) {
  const pieces = source.split(before);
  if (pieces.length !== 2) {
    throw structural(
      `${label} expected exactly one site, found ${pieces.length - 1}`,
    );
  }
  return `${pieces[0]}${after}${pieces[1]}`;
}

function withNdc(source, targetRhs) {
  const binding = bindPrimaryRay(source);
  const targetShape = canonical(targetRhs, "target NDC expression");
  if (binding.ndcShape === targetShape) {
    return source;
  }
  const beforeRhs =
    binding.ndcShape === canonical(currentNdcRhs)
      ? currentNdcRhs
      : correctedNdcRhs;
  return replaceExactlyOnce(
    source,
    `let ndc = ${beforeRhs};`,
    `let ndc = ${targetRhs};`,
    "getWorldRay NDC replacement",
  );
}

function uvConsumers(source) {
  const visible = functionBody(
    source,
    /\bfn\s+fragmentMain\s*\(\s*input\s*:\s*VertexOutput\s*\)\s*->\s*@location\s*\(\s*0\s*\)\s*vec4\s*<\s*f32\s*>\s*\{/gu,
    "visible fragmentMain",
  );
  const mask = functionBody(
    source,
    /\bfn\s+fragmentCloudMaskMain\s*\(\s*input\s*:\s*VertexOutput\s*\)\s*->\s*@location\s*\(\s*0\s*\)\s*f32\s*\{/gu,
    "fragmentCloudMaskMain",
  );
  const assignments = (body, label) => {
    if (/\buv\s*\.\s*[xy]\s*=/u.test(body)) {
      throw structural(`${label} writes a reversed UV component`);
    }
    return [...body.matchAll(/\b(?:(?:var|let)\s+)?uv\s*=\s*([^;]+);/gu)].map(
      (match) => canonical(match[1], `${label} UV assignment`),
    );
  };
  return {
    visibleAssignments: assignments(visible, "fragmentMain"),
    visibleColor: canonical(
      uniqueMatch(
        visible,
        /\blet\s+sceneColor\s*=\s*textureSample\s*\(\s*colorTex\s*,\s*texSampler\s*,\s*([^,)]+)\s*\)\s*;/gu,
        "fragmentMain scene-color UV",
      )[1],
    ),
    visibleDepth: canonical(
      uniqueMatch(
        visible,
        /\blet\s+sceneDepth\s*=\s*textureSampleLevel\s*\(\s*depthTex\s*,\s*texSampler\s*,\s*([^,]+)\s*,\s*0\.0\s*\)\.r\s*;/gu,
        "fragmentMain scene-depth UV",
      )[1],
    ),
    visibleRay: canonical(
      uniqueMatch(
        visible,
        /\blet\s+rayDir\s*=\s*getWorldRay\s*\(\s*([^\)]+)\s*\)\s*;/gu,
        "fragmentMain ray UV",
      )[1],
    ),
    maskAssignments: assignments(mask, "fragmentCloudMaskMain"),
    maskDepth: canonical(
      uniqueMatch(
        mask,
        /\blet\s+sceneDepth\s*=\s*textureSampleLevel\s*\(\s*depthTex\s*,\s*texSampler\s*,\s*([^,]+)\s*,\s*0\.0\s*\)\.r\s*;/gu,
        "fragmentCloudMaskMain scene-depth UV",
      )[1],
    ),
    maskRay: canonical(
      uniqueMatch(
        mask,
        /\blet\s+rayDir\s*=\s*getWorldRay\s*\(\s*([^\)]+)\s*\)\s*;/gu,
        "fragmentCloudMaskMain ray UV",
      )[1],
    ),
  };
}

test("primary cloud rays preserve framebuffer top-centre-bottom order", async () => {
  const copies = await readShaderCopies();
  const results = copies.flatMap(({ name, source }) =>
    observations(name, source),
  );
  assert.equal(predicate(results), true, JSON.stringify(results, null, 2));
});

test("in-memory NDC correction passes and its inertness mutant fails", async () => {
  const copies = await readShaderCopies();
  for (const { name, source } of copies) {
    // This source copy is a control for the predicate, not a production repair.
    const corrected = withNdc(source, correctedNdcRhs);
    const correctedResults = observations(name, corrected);
    const inertMutant = withNdc(corrected, currentNdcRhs);
    // Both copies bind before the predicate is asserted, so a structural
    // extraction or evaluator error cannot count as a mutant rejection.
    const mutantResults = observations(name, inertMutant);

    assert.equal(
      predicate(correctedResults),
      true,
      `${name}: corrected control`,
    );
    assert.equal(predicate(mutantResults), false, `${name}: inert mutant`);
    assert.ok(
      mutantResults
        .filter(({ row }) => row === "centre")
        .every(({ ndcYMatches, rayMatches }) => ndcYMatches && rayMatches),
      `${name}: centre must remain the positive discriminator`,
    );
    assert.ok(
      correctedResults.some(
        ({ frustum, row, expectedRayY }) =>
          frustum === "asymmetric" &&
          row === "centre" &&
          Math.abs(expectedRayY) > 1e-6,
      ),
      `${name}: asymmetric centre ray must be non-zero`,
    );
  }
});

test("visible and mask consumers keep color, depth, and ray on one UV", async () => {
  const copies = await readShaderCopies();
  const expected = {
    visibleAssignments: [
      canonical("input.uv"),
      canonical("uv + vec2<f32>(bx, by) * texel"),
    ],
    visibleColor: canonical("uv"),
    visibleDepth: canonical("uv"),
    visibleRay: canonical("uv"),
    maskAssignments: [canonical("input.uv")],
    maskDepth: canonical("uv"),
    maskRay: canonical("uv"),
  };
  for (const { name, source } of copies) {
    assert.deepEqual(uvConsumers(source), expected, name);
  }
});

nodeTest(
  "primary renderer binds the generated shader and unchanged inverse matrices",
  async () => {
    const renderer = await structurallyAsync(
      "cannot read WebGPUProceduralCloudRenderer",
      () => readFile(rendererUrl, "utf8"),
    );
    uniqueMatch(
      renderer,
      /import\s+ProceduralCloudsWGSL\s+from\s+"\.\.\/\.\.\/Shaders\/WebGPU\/Environment\/ProceduralClouds\.js"\s*;/gu,
      "generated ProceduralClouds import",
    );
    uniqueMatch(
      renderer,
      /const\s+PROCEDURAL_CLOUDS_SOURCE\s*=\s*`\$\{CloudDensityDomainWGSL\}\\n\$\{ProceduralCloudsWGSL\}`\s*;/gu,
      "runtime ProceduralClouds source composition",
    );
    uniqueMatch(
      renderer,
      /const\s+invProj\s*=\s*us\s*\?\.\s*inverseProjection\s*;/gu,
      "inverseProjection uniform alias",
    );
    uniqueMatch(
      renderer,
      /const\s+invView\s*=\s*us\s*\?\.\s*inverseView\s*;/gu,
      "inverseView uniform alias",
    );
    uniqueMatch(
      renderer,
      /for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*16\s*;\s*i\+\+\s*\)\s*data\s*\[\s*offset\+\+\s*\]\s*=\s*invProj\s*\[\s*i\s*\]\s*;/gu,
      "inverseProjection uniform copy",
    );
    uniqueMatch(
      renderer,
      /for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*16\s*;\s*i\+\+\s*\)\s*data\s*\[\s*offset\+\+\s*\]\s*=\s*invView\s*\[\s*i\s*\]\s*;/gu,
      "inverseView uniform copy",
    );
  },
);

test("primary-ray extraction fails structurally on malformed NDC or ray tails", async () => {
  const [{ source }] = await readShaderCopies();
  const corrected = withNdc(source, correctedNdcRhs);
  const statement = `let ndc = ${correctedNdcRhs};`;
  const malformed = [
    replaceExactlyOnce(corrected, statement, "", "missing NDC control"),
    replaceExactlyOnce(
      corrected,
      statement,
      `${statement}\n  ${statement}`,
      "duplicate NDC control",
    ),
    replaceExactlyOnce(
      corrected,
      statement,
      "let ndc = vec4<f32>(uv, 1.0, 1.0);",
      "unsupported NDC control",
    ),
    replaceExactlyOnce(
      corrected,
      "viewDir.w = 0.0;",
      "viewDir.w = 1.0;",
      "malformed getWorldRay tail control",
    ),
    replaceExactlyOnce(
      corrected,
      "return normalize(worldDir.xyz);",
      "returnnormalize(worldDir.xyz);",
      "merged-token getWorldRay tail control",
    ),
  ];
  for (const sourceVariant of malformed) {
    assert.throws(
      () => bindPrimaryRay(sourceVariant),
      (error) => error?.code === "STRUCTURAL",
    );
  }
});
