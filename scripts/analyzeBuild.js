/**
 * Bundle analyzer for the Cesium production build.
 *
 * Reads the esbuild `metafile.json` produced when `bundleCesiumJs` is
 * called with `metafile: true`, then prints two summaries:
 *
 *   1. **Top-N modules by bundle bytes** — what's actually big
 *   2. **Top-N folders by aggregate bytes** — where the weight lives
 *
 * Optional `--treemap` flag pipes the metafile through esbuild's
 * built-in `analyzeMetafile()` for the canonical text treemap.
 *
 * Usage:
 *   # Generate a metafile by building with the analyzer flag
 *   node scripts/analyzeBuild.js --build
 *
 *   # Then analyze it
 *   node scripts/analyzeBuild.js
 *   node scripts/analyzeBuild.js --top 50
 *   node scripts/analyzeBuild.js --variant CesiumWebGPU
 *   node scripts/analyzeBuild.js --treemap
 *
 * @module analyzeBuild
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import esbuild from "esbuild";

import { buildCesium, buildEngine, buildWidgets } from "./build.js";

function parseArgs(argv) {
  const args = {
    top: 30,
    variant: "Cesium",
    treemap: false,
    build: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top") {
      args.top = Number(argv[++i]);
    } else if (a === "--variant") {
      args.variant = argv[++i];
    } else if (a === "--treemap") {
      args.treemap = true;
    } else if (a === "--build") {
      args.build = true;
    }
  }
  return args;
}

async function ensureBuildWithMetafile() {
  console.log("[analyzeBuild] Building Cesium with metafile output…");
  await buildEngine();
  await buildWidgets();
  await buildCesium({
    minify: true,
    removePragmas: true,
    node: true,
    sourcemap: false,
    variant: "dual",
    metafile: true,
  });
  console.log("[analyzeBuild] Build complete.");
}

function humanBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function shortenPath(p) {
  return p
    .replace(/\\/g, "/")
    .replace(/^.*?packages\/engine\/Source\//, "engine/")
    .replace(/^.*?packages\/widgets\/Source\//, "widgets/")
    .replace(/^.*?node_modules\//, "node_modules/");
}

/**
 * Reduce a metafile's `inputs` map to:
 *   - Top-N source modules ranked by `bytesInOutput` summed across
 *     every output that includes them
 *   - Folder roll-up showing aggregate bytes per top-level directory
 */
function summarizeMetafile(metafile, topN) {
  /** @type {Map<string, number>} */
  const moduleBytes = new Map();
  /** @type {Map<string, number>} */
  const folderBytes = new Map();
  let totalBytes = 0;

  // Walk every output's inputs map. esbuild's metafile structure:
  //   metafile.outputs[outputPath].inputs[sourcePath] = { bytesInOutput }
  for (const [, outputInfo] of Object.entries(metafile.outputs)) {
    if (!outputInfo.inputs) {
      continue;
    }
    // Skip sourcemap and chunk outputs from the totals; we want the
    // entry-point aggregate. Sourcemaps inflate the numbers without
    // representing actual JS shipped to the user.
    for (const [sourcePath, info] of Object.entries(outputInfo.inputs)) {
      const bytes = info.bytesInOutput || 0;
      if (bytes === 0) {
        continue;
      }
      moduleBytes.set(sourcePath, (moduleBytes.get(sourcePath) || 0) + bytes);
      totalBytes += bytes;

      // Folder roll-up: trim down to a 3-segment prefix to keep the
      // groups meaningful (engine/Scene, engine/Renderer/WebGPU, etc.)
      const normalized = sourcePath.replace(/\\/g, "/");
      let folder;
      if (normalized.includes("/Source/")) {
        const after = normalized.split("/Source/")[1];
        const parts = after.split("/");
        folder = `Source/${parts.slice(0, Math.min(2, parts.length - 1)).join("/")}`;
      } else if (normalized.includes("node_modules/")) {
        const after = normalized.split("node_modules/")[1];
        folder = `node_modules/${after.split("/")[0]}`;
      } else {
        folder = path.dirname(normalized);
      }
      folderBytes.set(folder, (folderBytes.get(folder) || 0) + bytes);
    }
  }

  const topModules = [...moduleBytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
  const topFolders = [...folderBytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  return { topModules, topFolders, totalBytes, moduleCount: moduleBytes.size };
}

function printTable(title, rows, totalBytes) {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
  const widest = Math.max(...rows.map(([name]) => shortenPath(name).length));
  for (const [name, bytes] of rows) {
    const pct = ((bytes / totalBytes) * 100).toFixed(1).padStart(5);
    const sz = humanBytes(bytes).padStart(10);
    console.log(`  ${shortenPath(name).padEnd(widest)}   ${sz}   ${pct}%`);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.build) {
    await ensureBuildWithMetafile();
  }

  const metafilePath = path.join("Build", args.variant, "metafile.json");
  let metafileText;
  try {
    metafileText = await fs.readFile(metafilePath, "utf8");
  } catch {
    console.error(`[analyzeBuild] No metafile at ${metafilePath}`);
    console.error(
      `[analyzeBuild] Run "node scripts/analyzeBuild.js --build" first ` +
        `to produce one.`,
    );
    process.exit(2);
  }

  const metafile = JSON.parse(metafileText);

  if (args.treemap) {
    // esbuild's canonical analyzer renders a hierarchical text treemap
    // — useful for seeing nested module relationships at a glance.
    console.log(
      await esbuild.analyzeMetafile(metafile, {
        verbose: false,
        color: false,
      }),
    );
    return;
  }

  const { topModules, topFolders, totalBytes, moduleCount } = summarizeMetafile(
    metafile,
    args.top,
  );

  console.log(`\n[analyzeBuild] Bundle: Build/${args.variant}/`);
  console.log(
    `[analyzeBuild] Total module bytes (sum across outputs): ${humanBytes(totalBytes)}`,
  );
  console.log(`[analyzeBuild] Distinct source modules: ${moduleCount}`);

  printTable(
    `\nTop ${args.top} folders (by aggregate bytes)`,
    topFolders,
    totalBytes,
  );
  printTable(
    `\nTop ${args.top} modules (by bytes-in-output)`,
    topModules,
    totalBytes,
  );

  console.log("");
  console.log("Hint: --treemap for esbuild's hierarchical text view.");
  console.log("Hint: --variant CesiumWebGPU to analyse the WebGPU-only build.");
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
