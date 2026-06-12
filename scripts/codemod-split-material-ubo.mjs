/**
 * Splits monolithic WGSL `struct Uniforms` into separate camera + material
 * structs with distinct bind groups.
 *
 * BEFORE:
 *   struct Uniforms { mvpRelativeToEye: mat4x4<f32>, ..., materialColor: vec4<f32> }
 *   @group(0) @binding(0) var<uniform> uniforms: Uniforms;
 *   // usage: uniforms.mvpRelativeToEye, uniforms.materialColor
 *
 * AFTER:
 *   struct CameraUniforms { mvpRelativeToEye: mat4x4<f32>, ... }
 *   struct MaterialUniforms { materialColor: vec4<f32> }
 *   @group(0) @binding(0) var<uniform> camera: CameraUniforms;
 *   @group(1) @binding(0) var<uniform> material: MaterialUniforms;
 *   // usage: camera.mvpRelativeToEye, material.materialColor
 *
 * Usage:
 *   node scripts/codemod-split-material-ubo.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const SHADER_DIR = "packages/engine/Source/Shaders/WebGPU/Primitive";

// Camera uniform fields — these stay in group(0). Everything else is material.
const CAMERA_FIELDS = new Set([
  "mvpRelativeToEye",
  "modelViewRelativeToEye",
  "normalMatrix",
  "encodedCameraHigh",
  "encodedCameraLow",
  "lightDirection",
  "_pad0",
  "_pad1",
  "_pad2",
  "_pad3",
]);

function processFile(filePath) {
  let source = readFileSync(filePath, "utf8");

  // Skip files that don't have the monolithic pattern
  if (!source.includes("struct Uniforms {")) {return false;}
  if (source.includes("struct CameraUniforms")) {return false;} // already split

  // Extract the struct Uniforms block
  const structMatch = source.match(
    /struct Uniforms \{([^}]+)\}/s
  );
  if (!structMatch) {return false;}

  const structBody = structMatch[1];
  const fields = structBody
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"));

  const cameraFields = [];
  const materialFields = [];

  for (const field of fields) {
    // Parse "fieldName: type," or "fieldName: type"
    const fieldMatch = field.match(/^(\w+)\s*:\s*(.+?),?\s*$/);
    if (!fieldMatch) {continue;}
    const [, fieldName] = fieldMatch;

    if (CAMERA_FIELDS.has(fieldName)) {
      cameraFields.push(field.endsWith(",") ? field : `${field  },`);
    } else {
      materialFields.push(field.endsWith(",") ? field : `${field  },`);
    }
  }

  // If no material fields, nothing to split
  if (materialFields.length === 0) {return false;}

  // Build new structs
  const cameraStruct =
    `struct CameraUniforms {\n    ${cameraFields.join("\n    ")}\n}`;
  const materialStruct =
    `struct MaterialUniforms {\n    ${materialFields.join("\n    ")}\n}`;

  // Replace the monolithic struct
  source = source.replace(
    /struct Uniforms \{[^}]+\}/s,
    `${cameraStruct}\n\n${materialStruct}`
  );

  // Replace the binding declaration
  source = source.replace(
    /@group\(0\) @binding\(0\) var<uniform> uniforms: Uniforms;/,
    `@group(0) @binding(0) var<uniform> camera: CameraUniforms;\n@group(1) @binding(0) var<uniform> material: MaterialUniforms;`
  );

  // Replace field access: uniforms.cameraField → camera.cameraField
  for (const field of cameraFields) {
    const nameMatch = field.match(/^(\w+)\s*:/);
    if (!nameMatch) {continue;}
    const name = nameMatch[1];
    const regex = new RegExp(`uniforms\\.${name}`, "g");
    source = source.replace(regex, `camera.${name}`);
  }

  // Replace field access: uniforms.materialField → material.materialField
  for (const field of materialFields) {
    const nameMatch = field.match(/^(\w+)\s*:/);
    if (!nameMatch) {continue;}
    const name = nameMatch[1];
    const regex = new RegExp(`uniforms\\.${name}`, "g");
    source = source.replace(regex, `material.${name}`);
  }

  // Update the comment header if it mentions "Uniform:"
  source = source.replace(
    /\/\/ Uniform:.*$/m,
    "// Camera UBO: group(0) binding(0) — Material UBO: group(1) binding(0)"
  );

  writeFileSync(filePath, source, "utf8");
  return true;
}

function walkDir(dir) {
  const entries = readdirSync(dir);
  const results = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.endsWith(".wgsl")) {
      results.push(full);
    }
  }
  return results;
}

// Process primitive shaders
const files = walkDir(SHADER_DIR);
let converted = 0;
let skipped = 0;

for (const file of files) {
  if (processFile(file)) {
    console.log(`  SPLIT: ${relative(".", file)}`);
    converted++;
  } else {
    skipped++;
  }
}

// Also process polyline collection shaders
const POLYLINE_DIR = "packages/engine/Source/Shaders/WebGPU/Collections";
if (statSync(POLYLINE_DIR).isDirectory()) {
  for (const file of walkDir(POLYLINE_DIR)) {
    if (processFile(file)) {
      console.log(`  SPLIT: ${relative(".", file)}`);
      converted++;
    } else {
      skipped++;
    }
  }
}

// Also process basic shaders
const BASIC_FILES = [
  "packages/engine/Source/Shaders/WebGPU/BasicColor.wgsl",
  "packages/engine/Source/Shaders/WebGPU/BasicTextured.wgsl",
  "packages/engine/Source/Shaders/WebGPU/FlexibleGeometry.wgsl",
];
for (const file of BASIC_FILES) {
  try {
    if (processFile(file)) {
      console.log(`  SPLIT: ${relative(".", file)}`);
      converted++;
    } else {
      skipped++;
    }
  } catch {
    skipped++;
  }
}

console.log(`\nDone: ${converted} split, ${skipped} skipped`);
