/**
 * Generates .js wrapper files from .wgsl source files in chunks/functions and chunks/structs,
 * and rebuilds CsmBuiltins.js.
 * Run: node scripts/generateWgslJs.js
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, basename } from "path";

const BASE = join(
  "packages",
  "engine",
  "Source",
  "Shaders",
  "WebGPU",
  "chunks",
);
const FUNCTIONS_DIR = join(BASE, "functions");
const STRUCTS_DIR = join(BASE, "structs");

function escapeForJs(content) {
  return content
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n\\\n");
}

function generateJsWrapper(wgslPath) {
  const wgslContent = readFileSync(wgslPath, "utf8");
  const escaped = escapeForJs(wgslContent);
  return `//This file is automatically rebuilt by the Cesium build process.\nexport default "${escaped}";\n`;
}

// Process functions
const funcFiles = readdirSync(FUNCTIONS_DIR)
  .filter((f) => f.endsWith(".wgsl"))
  .sort();
let funcCount = 0;
for (const file of funcFiles) {
  const wgslPath = join(FUNCTIONS_DIR, file);
  const jsPath = join(FUNCTIONS_DIR, file.replace(".wgsl", ".js"));
  writeFileSync(jsPath, generateJsWrapper(wgslPath), "utf8");
  funcCount++;
}
console.log(`Generated ${funcCount} function .js files`);

// Process structs
const structFiles = readdirSync(STRUCTS_DIR)
  .filter((f) => f.endsWith(".wgsl"))
  .sort();
let structCount = 0;
for (const file of structFiles) {
  const wgslPath = join(STRUCTS_DIR, file);
  const jsPath = join(STRUCTS_DIR, file.replace(".wgsl", ".js"));
  writeFileSync(jsPath, generateJsWrapper(wgslPath), "utf8");
  structCount++;
}
console.log(`Generated ${structCount} struct .js files`);

// Rebuild CsmBuiltins.js
const structNames = structFiles.map((f) => basename(f, ".wgsl"));
const funcNames = funcFiles.map((f) => basename(f, ".wgsl"));

let csmBuiltins =
  "//This file is automatically rebuilt by the Cesium build process.\n";

// Struct imports
for (const name of structNames) {
  csmBuiltins += `import ${name} from './structs/${name}.js'\n`;
}

// Function imports
for (const name of funcNames) {
  csmBuiltins += `import ${name} from './functions/${name}.js'\n`;
}

csmBuiltins +=
  "\n/**\n * Central registry of all WGSL builtin chunks.\n * @private\n */\nconst CsmBuiltins = {\n";

// Struct entries
for (const name of structNames) {
  csmBuiltins += `  ${name}: ${name},\n`;
}

// Function entries
for (const name of funcNames) {
  csmBuiltins += `  ${name}: ${name},\n`;
}

csmBuiltins += "};\n\nexport default CsmBuiltins;\n";

writeFileSync(join(BASE, "CsmBuiltins.js"), csmBuiltins, "utf8");
console.log(
  `\nRebuilt CsmBuiltins.js with ${structNames.length} structs + ${funcNames.length} functions = ${structNames.length + funcNames.length} total entries`,
);
