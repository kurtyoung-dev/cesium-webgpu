/**
 * Slang Shader Cross-Compilation Script
 *
 * Compiles .slang shaders to BOTH .wgsl (WebGPU) and .glsl (WebGL) from a
 * single source. This is the core value proposition: write once, get both.
 *
 * ## Prerequisites
 *
 * Install the Slang compiler from: https://github.com/shader-slang/slang/releases
 * Add `slangc` to your PATH, or set the SLANG_PATH environment variable.
 *
 * ## Usage
 *
 *   node scripts/compileSlang.js [options]
 *
 * Options:
 *   --input <dir>       Input directory (default: packages/engine/Source/Shaders/Slang)
 *   --wgsl-out <dir>    WGSL output dir (default: packages/engine/Source/Shaders/WebGPU/Generated)
 *   --glsl-out <dir>    GLSL output dir (default: packages/engine/Source/Shaders/Generated)
 *   --targets <list>    Comma-separated targets: wgsl,glsl (default: wgsl,glsl)
 *   --slangc <path>     Path to slangc binary (default: slangc from PATH)
 *   --watch             Watch for changes and recompile
 *   --verbose           Print detailed output
 *   --dry-run           Show what would be compiled without writing files
 *
 * ## Output Structure
 *
 * Given: packages/engine/Source/Shaders/Slang/EllipsoidPrimitive.slang
 * Produces:
 *   packages/engine/Source/Shaders/WebGPU/Generated/EllipsoidPrimitive.wgsl
 *   packages/engine/Source/Shaders/Generated/EllipsoidPrimitive.glsl
 *
 * @module compileSlang
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

// ────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────

const DEFAULT_INPUT_DIR = "packages/engine/Source/Shaders/Slang";
const DEFAULT_WGSL_OUT = "packages/engine/Source/Shaders/WebGPU/Generated";
const DEFAULT_GLSL_OUT = "packages/engine/Source/Shaders/Generated";

/**
 * @typedef {object} CompileOptions
 * @property {string} inputDir
 * @property {string} wgslOutputDir
 * @property {string} glslOutputDir
 * @property {string[]} targets - ['wgsl'], ['glsl'], or ['wgsl','glsl']
 * @property {string} slangcPath
 * @property {boolean} watch
 * @property {boolean} verbose
 * @property {boolean} dryRun
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    inputDir: DEFAULT_INPUT_DIR,
    wgslOutputDir: DEFAULT_WGSL_OUT,
    glslOutputDir: DEFAULT_GLSL_OUT,
    targets: ["wgsl", "glsl"],
    slangcPath: process.env.SLANG_PATH || "slangc",
    watch: false,
    verbose: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--input":
        options.inputDir = args[++i];
        break;
      case "--wgsl-out":
        options.wgslOutputDir = args[++i];
        break;
      case "--glsl-out":
        options.glslOutputDir = args[++i];
        break;
      case "--targets":
        options.targets = args[++i]
          .split(",")
          .map((t) => t.trim().toLowerCase());
        break;
      case "--slangc":
        options.slangcPath = args[++i];
        break;
      case "--watch":
        options.watch = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Slang Shader Cross-Compilation — Write once, compile to WGSL + GLSL

Usage: node scripts/compileSlang.js [options]

Options:
  --input <dir>       Input directory     (default: ${DEFAULT_INPUT_DIR})
  --wgsl-out <dir>    WGSL output dir     (default: ${DEFAULT_WGSL_OUT})
  --glsl-out <dir>    GLSL output dir     (default: ${DEFAULT_GLSL_OUT})
  --targets <list>    Targets: wgsl,glsl  (default: wgsl,glsl)
  --slangc <path>     Path to slangc      (default: slangc from PATH or SLANG_PATH env)
  --watch             Watch mode
  --verbose           Detailed output
  --dry-run           Preview only
  --help              Show this help

Examples:
  node scripts/compileSlang.js                     # Compile all to WGSL + GLSL
  node scripts/compileSlang.js --targets wgsl      # WGSL only
  node scripts/compileSlang.js --targets glsl      # GLSL only
  node scripts/compileSlang.js --watch --verbose   # Watch + verbose
  `);
}

// ────────────────────────────────────────────────────────
// Slang Compiler Detection
// ────────────────────────────────────────────────────────

function detectSlangCompiler(slangcPath) {
  try {
    const output = execFileSync(slangcPath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const versionMatch = output.match(/slang\s+(\S+)/i) || [null, output];
    return { available: true, version: versionMatch[1], error: null };
  } catch {
    return {
      available: false,
      version: null,
      error:
        `Slang compiler (slangc) not found at "${slangcPath}". ` +
        `Install from https://github.com/shader-slang/slang/releases ` +
        `and add to PATH, or set SLANG_PATH environment variable.`,
    };
  }
}

// ────────────────────────────────────────────────────────
// Single-File Compilation
// ────────────────────────────────────────────────────────

/**
 * Compile a .slang file to a specific target.
 *
 * @param {string} inputFile
 * @param {string} outputFile
 * @param {"wgsl"|"glsl"} target
 * @param {string} slangcPath
 * @param {boolean} verbose
 * @returns {{ success: boolean, error: string|null }}
 */
function compileSlangToTarget(
  inputFile,
  outputFile,
  target,
  slangcPath,
  verbose,
) {
  const args = [inputFile, "-o", outputFile, "-matrix-layout-row-major"];

  if (target === "wgsl") {
    args.push("-target", "wgsl");
  } else if (target === "glsl") {
    // Target GLSL 300 ES for WebGL2 compatibility
    args.push("-target", "glsl");
    args.push("-profile", "glsl_300_es");
  }

  if (verbose) {
    console.log(`    slangc ${args.join(" ")}`);
  }

  try {
    const stdout = execFileSync(slangcPath, args, {
      encoding: "utf8",
      timeout: 30000,
    });
    if (stdout && verbose) {
      console.log(`    ${stdout.trim()}`);
    }
    return { success: true, error: null };
  } catch (err) {
    const errorMsg = err.stderr || err.message || String(err);
    return { success: false, error: errorMsg.trim() };
  }
}

/**
 * Add a header comment to a generated file.
 */
function addGeneratedHeader(outputFile, sourceFile, target) {
  if (!fs.existsSync(outputFile)) {
    return;
  }
  const content = fs.readFileSync(outputFile, "utf8");
  const relSource = path
    .relative(process.cwd(), sourceFile)
    .replace(/\\/g, "/");
  const commentPrefix = target === "wgsl" ? "//" : "//";
  const header =
    `${commentPrefix} ═══════════════════════════════════════════════════════════\n` +
    `${commentPrefix} AUTO-GENERATED from ${relSource}\n` +
    `${commentPrefix} Target: ${target.toUpperCase()}\n` +
    `${commentPrefix} Do not edit — edit the .slang source instead.\n` +
    `${commentPrefix} Compiled by: node scripts/compileSlang.js\n` +
    `${commentPrefix} Date: ${new Date().toISOString()}\n` +
    `${commentPrefix} ═══════════════════════════════════════════════════════════\n\n`;
  fs.writeFileSync(outputFile, header + content);
}

// ────────────────────────────────────────────────────────
// Main Pipeline
// ────────────────────────────────────────────────────────

function compileAll(options) {
  const {
    inputDir,
    wgslOutputDir,
    glslOutputDir,
    targets,
    slangcPath,
    verbose,
    dryRun,
  } = options;

  if (!fs.existsSync(inputDir)) {
    console.log(`Input directory does not exist: ${inputDir}`);
    console.log(
      `Creating it. Add .slang files to start using Slang cross-compilation.`,
    );
    fs.mkdirSync(inputDir, { recursive: true });
    return { compiled: 0, failed: 0, skipped: 0 };
  }

  const allFiles = fs.readdirSync(inputDir, {
    recursive: true,
    withFileTypes: false,
  });
  const slangFiles = allFiles
    .filter((f) => f.toString().endsWith(".slang"))
    .map((f) => path.join(inputDir, f.toString()));

  if (slangFiles.length === 0) {
    if (verbose) {
      console.log(`No .slang files found in ${inputDir}`);
    }
    return { compiled: 0, failed: 0, skipped: 0 };
  }

  let compiled = 0;
  let failed = 0;
  let skipped = 0;

  for (const slangFile of slangFiles) {
    const relativePath = path.relative(inputDir, slangFile);

    // Compile to each requested target
    for (const target of targets) {
      const ext = target === "wgsl" ? ".wgsl" : ".glsl";
      const outDir = target === "wgsl" ? wgslOutputDir : glslOutputDir;
      const outputFile = path.join(
        outDir,
        relativePath.replace(/\.slang$/, ext),
      );

      // Incremental: skip if output is newer than source
      if (fs.existsSync(outputFile)) {
        const srcStat = fs.statSync(slangFile);
        const dstStat = fs.statSync(outputFile);
        if (dstStat.mtimeMs > srcStat.mtimeMs) {
          if (verbose) {
            console.log(`  SKIP (up-to-date): ${relativePath} → ${target}`);
          }
          skipped++;
          continue;
        }
      }

      if (dryRun) {
        console.log(
          `  WOULD COMPILE: ${relativePath} → ${target} (${path.relative(process.cwd(), outputFile)})`,
        );
        compiled++;
        continue;
      }

      // Ensure output directory
      const outputSubdir = path.dirname(outputFile);
      if (!fs.existsSync(outputSubdir)) {
        fs.mkdirSync(outputSubdir, { recursive: true });
      }

      if (verbose) {
        console.log(`  COMPILE: ${relativePath} → ${target}`);
      }

      const result = compileSlangToTarget(
        slangFile,
        outputFile,
        target,
        slangcPath,
        verbose,
      );
      if (result.success) {
        addGeneratedHeader(outputFile, slangFile, target);
        compiled++;
        if (!verbose) {
          process.stdout.write(".");
        }
      } else {
        console.error(`\n  ✗ FAILED: ${relativePath} → ${target}`);
        console.error(`    ${result.error}`);
        failed++;
      }
    }
  }

  return { compiled, failed, skipped };
}

// ────────────────────────────────────────────────────────
// Watch Mode
// ────────────────────────────────────────────────────────

function watchMode(options) {
  console.log(`\nWatching ${options.inputDir} for .slang changes...`);
  console.log("Press Ctrl+C to stop.\n");

  const watcher = fs.watch(
    options.inputDir,
    { recursive: true },
    (_event, filename) => {
      //eslint-disable-line no-unused-vars
      if (filename && filename.endsWith(".slang")) {
        console.log(
          `\n[${new Date().toLocaleTimeString()}] Changed: ${filename}`,
        );
        const stats = compileAll(options);
        console.log(
          `\n  Compiled: ${stats.compiled}, Failed: ${stats.failed}, Skipped: ${stats.skipped}`,
        );
      }
    },
  );

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}

// ────────────────────────────────────────────────────────
// Entry Point
// ────────────────────────────────────────────────────────

function main() {
  const options = parseArgs();

  console.log("═══════════════════════════════════════════════════");
  console.log("  Slang Shader Cross-Compilation");
  console.log(`  Targets: ${options.targets.join(" + ").toUpperCase()}`);
  console.log("═══════════════════════════════════════════════════");

  const slang = detectSlangCompiler(options.slangcPath);
  if (!slang.available) {
    console.log(`\n⚠ ${slang.error}`);
    console.log(
      "\nSlang compilation skipped. Pre-compiled output files will be used if available.",
    );
    console.log(
      "This is normal — Slang is only needed when editing .slang source files.\n",
    );
    return;
  }

  console.log(`  Compiler:  slangc v${slang.version}`);
  console.log(`  Input:     ${options.inputDir}`);
  if (options.targets.includes("wgsl")) {
    console.log(`  WGSL out:  ${options.wgslOutputDir}`);
  }
  if (options.targets.includes("glsl")) {
    console.log(`  GLSL out:  ${options.glslOutputDir}`);
  }
  if (options.dryRun) {
    console.log("  Mode:      DRY RUN");
  }
  console.log("");

  const stats = compileAll(options);

  if (!options.dryRun && stats.compiled > 0) {
    console.log("");
  }

  console.log(
    `\n  ✓ Compiled: ${stats.compiled}  ✗ Failed: ${stats.failed}  ⊘ Skipped: ${stats.skipped}`,
  );

  if (stats.failed > 0) {
    process.exit(1);
  }

  if (options.watch) {
    watchMode(options);
  }
}

main();

export { compileSlangToTarget, detectSlangCompiler, compileAll };
