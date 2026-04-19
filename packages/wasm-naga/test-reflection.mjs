/**
 * Test the enriched `validate_wgsl` reflection output.
 *
 * Feeds naga a WGSL program with one binding of each type (uniform
 * buffer, storage buffer, texture, sampler, storage texture) and
 * inspects the JSON that comes back. This is the data consumers need
 * to auto-derive a `GPUBindGroupLayoutDescriptor` from a translated
 * shader.
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

const SAMPLE_WGSL = `
struct Uniforms {
  tint: vec4<f32>,
  mixAmount: f32,
}

struct DataBuffer {
  values: array<f32>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read_write> data: DataBuffer;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var storageTex: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(0) var depthTex: texture_depth_2d;
@group(1) @binding(1) var cmpSamp: sampler_comparison;

@fragment fn frag_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let s = textureSample(tex, samp, uv);
  let d = textureSampleCompare(depthTex, cmpSamp, uv, 0.5);
  textureStore(storageTex, vec2<i32>(0, 0), u.tint);
  data.values[0] = u.mixAmount * d;
  return s * u.tint;
}
`;

async function main() {
  const naga = await loadNaga();
  const jsonText = naga.validate_wgsl(SAMPLE_WGSL);
  console.log(`Raw reflection JSON (${jsonText.length} bytes):\n`);
  console.log(jsonText);

  const parsed = JSON.parse(jsonText);
  console.log(`\n─── Parsed ───\n`);
  console.log(`Entry points: ${parsed.entryPoints.map((e) => `${e.name} (${e.stage})`).join(", ")}`);
  console.log(`Bindings: ${parsed.bindings.length}`);
  console.log();

  const expected = [
    { name: "u", group: 0, binding: 0, kind: "uniform-buffer" },
    { name: "data", group: 0, binding: 1, kind: "storage-buffer", access: "read_write" },
    { name: "tex", group: 0, binding: 2, kind: "texture", sampleType: "float", viewDimension: "2d", multisampled: false },
    { name: "samp", group: 0, binding: 3, kind: "sampler", sampleType: "filtering" },
    { name: "storageTex", group: 0, binding: 4, kind: "storage-texture", viewDimension: "2d", access: "write" },
    { name: "depthTex", group: 1, binding: 0, kind: "texture", sampleType: "depth", viewDimension: "2d" },
    { name: "cmpSamp", group: 1, binding: 1, kind: "sampler", sampleType: "comparison" },
  ];

  let pass = 0;
  for (const exp of expected) {
    const actual = parsed.bindings.find(
      (b) => b.name === exp.name && b.group === exp.group && b.binding === exp.binding,
    );
    if (!actual) {
      console.log(`✗ missing: ${exp.name} @ (${exp.group}, ${exp.binding})`);
      continue;
    }
    let ok = true;
    for (const [k, v] of Object.entries(exp)) {
      if (actual[k] !== v) {
        console.log(`✗ ${exp.name}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual[k])}`);
        ok = false;
      }
    }
    if (ok) {
      pass++;
      console.log(`✓ ${exp.name}: kind=${actual.kind}${actual.sampleType ? ` sampleType=${actual.sampleType}` : ""}${actual.viewDimension ? ` dim=${actual.viewDimension}` : ""}${actual.access ? ` access=${actual.access}` : ""}`);
    }
  }

  console.log(`\n${pass}/${expected.length} bindings classified correctly.`);
  process.exit(pass === expected.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
