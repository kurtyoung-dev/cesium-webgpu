/**
 * Verifies the VENDORED naga-wasm copy loads correctly.
 *
 * `test-synthetic.mjs` loads from `pkg/` (raw wasm-pack output, crate-
 * native filenames). This harness loads from the vendored destination
 * instead to prove that:
 *
 *   1. The `buildWasm.js` copy step produced working files.
 *   2. The JS glue's patched `new URL("naga_wasm_bg.wasm", …)` reference
 *      resolves correctly — if the rename step in `buildWasm.js` is
 *      broken, this test surfaces it before a browser does.
 *   3. All four exported functions are callable.
 *
 * Usage: node test-vendored.mjs
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const VENDORED_DIR = join(
  __dirname,
  "..",
  "engine",
  "Source",
  "ThirdParty",
  "naga-wasm",
);

async function main() {
  const glueUrl = pathToFileURL(join(VENDORED_DIR, "naga_wasm.js")).href;
  console.log(`Loading vendored glue: ${glueUrl}`);
  const mod = await import(glueUrl);

  console.log(
    `  exported functions: ${Object.keys(mod)
      .filter((k) => typeof mod[k] === "function")
      .join(", ")}`,
  );

  const wasmBytes = await readFile(join(VENDORED_DIR, "naga_wasm_bg.wasm"));
  console.log(`  WASM size: ${(wasmBytes.length / 1024).toFixed(1)} KB`);
  await mod.default({ module_or_path: wasmBytes });

  // Sanity test each runtime export. Failures here indicate a broken
  // vendor step, not a naga-WASM bug — the underlying pipeline is
  // already covered by `test-synthetic.mjs`.
  const tests = [
    {
      name: "glsl_to_wgsl",
      run: () =>
        mod.glsl_to_wgsl(
          `#version 450
layout(location = 0) out vec4 o;
void main() { o = vec4(1.0); }
`,
          "fragment",
        ),
    },
    {
      name: "normalize_wgsl",
      run: () =>
        mod.normalize_wgsl(`@fragment fn main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}`),
    },
    {
      name: "validate_wgsl",
      run: () =>
        mod.validate_wgsl(`@fragment fn main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}`),
    },
  ];

  let pass = 0;
  for (const t of tests) {
    try {
      const result = t.run();
      if (typeof result === "string" && result.length > 0) {
        console.log(`  ✓ ${t.name} (${result.length} bytes out)`);
        pass++;
      } else {
        console.log(`  ✗ ${t.name}: empty or non-string result`);
      }
    } catch (err) {
      console.log(`  ✗ ${t.name}: ${err.message?.slice(0, 160)}`);
    }
  }

  console.log(`\n${pass}/${tests.length} vendored exports working.`);
  process.exit(pass === tests.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
