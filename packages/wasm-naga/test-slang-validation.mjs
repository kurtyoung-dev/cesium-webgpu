/**
 * Standalone test of the Slang → Naga validation integration.
 *
 * Calls `validateWgslWithNaga` directly on pre-generated Slang WGSL
 * outputs in `packages/engine/Source/Shaders/WebGPU/Generated/`. Doesn't
 * require slangc to be installed — we just re-validate whatever the
 * Slang pipeline has produced on someone else's machine.
 *
 * Usage: node test-slang-validation.mjs
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "..");
const GENERATED_WGSL_DIR = join(
  ROOT,
  "packages",
  "engine",
  "Source",
  "Shaders",
  "WebGPU",
  "Generated",
);
const SCRIPT_URL = pathToFileURL(join(ROOT, "scripts", "compileSlang.js")).href;

async function main() {
  // Importing compileSlang.js runs main() — which exits early if slangc
  // isn't installed, but ALSO re-exports validateWgslWithNaga which is
  // what we actually want to test. The module evaluation completes
  // before main()'s promise chain tries process.exit, so the named
  // re-exports are usable on the other side of the await.
  const script = await import(SCRIPT_URL);
  const { validateWgslWithNaga } = script;

  let files = [];
  try {
    files = (await readdir(GENERATED_WGSL_DIR)).filter((f) =>
      f.endsWith(".wgsl"),
    );
  } catch (err) {
    console.log(`No generated WGSL at ${GENERATED_WGSL_DIR}:`, err.message);
    process.exit(0);
  }

  if (files.length === 0) {
    console.log(`No .wgsl files in ${GENERATED_WGSL_DIR}`);
    process.exit(0);
  }

  let ok = 0;
  let fail = 0;
  let skipped = 0;
  for (const f of files) {
    const full = join(GENERATED_WGSL_DIR, f);
    const result = await validateWgslWithNaga(full);
    if (result.ok === true) {
      console.log(`✓ ${f}`);
      ok++;
    } else if (result.ok === "skipped") {
      console.log(`⊘ ${f} (${result.reason})`);
      skipped++;
    } else {
      console.log(`✗ ${f}`);
      console.log(`  ${result.error.slice(0, 400)}`);
      fail++;
    }
  }

  console.log(
    `\n${ok}/${files.length} WGSL outputs valid (${fail} failed, ${skipped} skipped)`,
  );
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
