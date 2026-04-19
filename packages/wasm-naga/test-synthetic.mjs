/**
 * Naga synthetic-shader test.
 *
 * The `test-compatibility.mjs` sweep over `packages/engine/Source/Shaders/`
 * revealed that Cesium's raw .glsl files aren't complete programs — they
 * reference `czm_*` builtins that the ShaderSource preprocessor prepends
 * at runtime. You can't feed one to ANY GLSL compiler and expect it to
 * parse.
 *
 * What the naga-wasm stub ACTUALLY sees at runtime is the COMPLETE, post-
 * preprocessor output of `gl.shaderSource(shader, combinedSrc)`. This
 * harness tests that workflow directly: it feeds naga a handful of
 * deliberately self-contained GLSL shaders that represent what the
 * stub would receive from a user's `CustomShader` API call or a
 * third-party extension.
 *
 * Failing cases here = real naga limitations. Passing cases = the stub
 * pipeline works end-to-end for those shader shapes.
 *
 * Usage: node test-synthetic.mjs
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

async function loadNaga() {
  const modUrl = pathToFileURL(
    join(__dirname, "pkg", "cesium_naga_wasm.js"),
  ).href;
  const mod = await import(modUrl);
  const wasmBytes = await readFile(
    join(__dirname, "pkg", "cesium_naga_wasm_bg.wasm"),
  );
  await mod.default({ module_or_path: wasmBytes });
  return mod;
}

// Minimal fragment shader — solid red. Pure Vulkan GLSL, no extensions.
const MINIMAL_FS = `#version 450
layout(location = 0) in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() {
  o_color = vec4(1.0, 0.0, 0.0, 1.0);
}
`;

// Minimal vertex shader producing a fullscreen triangle.
const MINIMAL_VS = `#version 450
layout(location = 0) out vec2 v_uv;
void main() {
  vec2 pos = vec2((gl_VertexIndex << 1) & 2, gl_VertexIndex & 2);
  v_uv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Fragment that samples a texture + reads a UBO — the typical shape of
// a post-process or material shader. Tests that naga's GLSL frontend
// correctly emits @group / @binding attributes for the WGSL target.
const TEXTURED_FS = `#version 450
layout(set = 0, binding = 0) uniform texture2D tex;
layout(set = 0, binding = 1) uniform sampler texSampler;
layout(set = 0, binding = 2) uniform Uniforms {
  vec4 tintColor;
  float mixAmount;
} ubo;
layout(location = 0) in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() {
  vec4 sampled = texture(sampler2D(tex, texSampler), v_uv);
  o_color = mix(sampled, ubo.tintColor, ubo.mixAmount);
}
`;

// Compute shader — simple add-one over a storage buffer.
const COMPUTE_CS = `#version 450
layout(local_size_x = 64) in;
layout(set = 0, binding = 0) buffer Data {
  float values[];
} data;
void main() {
  uint idx = gl_GlobalInvocationID.x;
  if (idx < data.values.length()) {
    data.values[idx] = data.values[idx] + 1.0;
  }
}
`;

const CASES = [
  { name: "MINIMAL_FS (solid red fragment)", source: MINIMAL_FS, stage: "fragment" },
  { name: "MINIMAL_VS (fullscreen triangle)", source: MINIMAL_VS, stage: "vertex" },
  { name: "TEXTURED_FS (sampler + UBO)", source: TEXTURED_FS, stage: "fragment" },
  { name: "COMPUTE_CS (storage buffer add-one)", source: COMPUTE_CS, stage: "compute" },
];

function previewWgsl(wgsl, lines = 12) {
  const split = wgsl.split("\n");
  const head = split.slice(0, lines).join("\n");
  if (split.length > lines) {return `${head  }\n    … (${split.length - lines} more lines)`;}
  return head;
}

async function main() {
  const naga = await loadNaga();
  console.log("Loaded naga-wasm. Testing synthetic shaders…\n");

  let pass = 0;
  for (const tc of CASES) {
    try {
      const wgsl = naga.glsl_to_wgsl(tc.source, tc.stage);
      console.log(`✓ ${tc.name}`);
      console.log(`  → ${wgsl.length} bytes of WGSL`);
      console.log("  preview:");
      console.log(`    ${  previewWgsl(wgsl).replace(/\n/g, "\n    ")}`);
      console.log();
      pass++;
    } catch (err) {
      console.log(`✗ ${tc.name}`);
      console.log(`  ${err.message.slice(0, 400)}`);
      console.log();
    }
  }

  // Also exercise normalize_wgsl with a small hand-written fragment, since
  // that path doesn't need the glsl-in frontend.
  const SAMPLE_WGSL = `@group(0) @binding(0) var<uniform> color: vec4<f32>;
@fragment fn main() -> @location(0) vec4<f32> {
  return color;
}`;

  try {
    const normalized = naga.normalize_wgsl(SAMPLE_WGSL);
    console.log(`✓ normalize_wgsl (WGSL → WGSL roundtrip)`);
    console.log(`  input:  ${SAMPLE_WGSL.length} bytes`);
    console.log(`  output: ${normalized.length} bytes`);
    console.log(`  (acts as a validator + light minifier)`);
    pass++;
  } catch (err) {
    console.log(`✗ normalize_wgsl`);
    console.log(`  ${err.message}`);
  }

  console.log();
  console.log(`${pass}/${CASES.length + 1} test cases passed.`);
  process.exit(pass === CASES.length + 1 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
