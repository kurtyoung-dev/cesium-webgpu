import { preprocess } from "./WebGPUShaderPreprocessor.js";
import { ShaderDefineHi } from "./WebGPUShaderDefines.js";
import BuildSource from "../../Shaders/WebGPU/Compute/CloudDensityCache.js";

export function cloudDensityCacheProgram(source: string): string {
  return cloudDensityComputeProgram(
    source,
    BuildSource,
    "cloudDensityCacheBuildMain",
  );
}

export function cloudDensityComputeProgram(
  source: string,
  kernel: string,
  entry: string,
  definesHi = 0,
): string {
  const flags =
    ShaderDefineHi.CLOUD_NOISE_BAKED_ONLY |
    ShaderDefineHi.CLOUD_MORPHOLOGY_BASE_ONLY |
    definesHi;
  const raw = preprocess([source, kernel].join("\n"), 0, flags)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const functions = new Map<string, string>(),
    ranges: Array<[number, number]> = [];
  const declaration = /(?:@\w+(?:\([^)]*\))?\s*)*fn\s+(\w+)\s*\(/g;
  for (let match; (match = declaration.exec(raw)) !== null;) {
    const start = match.index,
      body = raw.indexOf("{", declaration.lastIndex);
    if (body < 0) {
      throw new Error("Cloud density function body is missing.");
    }
    let depth = 1,
      end = body + 1;
    while (end < raw.length && depth > 0) {
      if (raw[end] === "{") {
        depth++;
      }
      if (raw[end] === "}") {
        depth--;
      }
      end++;
    }
    if (depth !== 0 || functions.has(match[1])) {
      throw new Error("Invalid cloud density function boundary.");
    }
    functions.set(match[1], raw.slice(start, end));
    ranges.push([start, end]);
    declaration.lastIndex = end;
  }
  const selected = new Set<string>(),
    pending = [entry];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (selected.has(name)) {
      continue;
    }
    const body = functions.get(name);
    if (!body) {
      throw new Error("Cloud density producer entry is missing.");
    }
    selected.add(name);
    for (const call of body.matchAll(/\b(\w+)\s*\(/g)) {
      if (call[1] !== name && functions.has(call[1])) {
        pending.push(call[1]);
      }
    }
  }
  let globals = "",
    previous = 0;
  for (const [start, end] of ranges) {
    globals += raw.slice(previous, start);
    previous = end;
  }
  globals += raw.slice(previous);
  return [
    globals,
    ...[...functions]
      .filter(([name]) => selected.has(name))
      .map(([, body]) => body),
  ].join("\n");
}
