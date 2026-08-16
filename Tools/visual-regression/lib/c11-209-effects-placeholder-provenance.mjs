// @purpose Provenance fingerprints binding the effects-depth-placeholder startup token across engine source, bundle, source map, probe, and policy files.
// @status ACTIVE

import { createHash } from "node:crypto";
import fs from "node:fs";

export const C11_209_SOURCE_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js";
export const C11_209_RUNTIME_BUNDLE = "Build/CesiumUnminified/index.js";
export const C11_209_SOURCE_MAP = "Build/CesiumUnminified/index.js.map";
export const C11_209_PROBE_FILE =
  "Tools/visual-regression/probe-c11-209-effects-placeholder-startup.mjs";
export const C11_209_POLICY_FILE =
  "Tools/visual-regression/lib/c11-209-effects-placeholder-provenance.mjs";
export const C11_209_RUNTIME_PATH = "/Build/CesiumUnminified/index.js";
export const C11_209_FEATURE_TOKEN = "Initialize effects depth placeholders";

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

export function fingerprintBytes(bytes, label = undefined) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    ...(label === undefined ? {} : { path: normalizePath(label) }),
    byteLength: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function countOccurrences(text, token) {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - token.length) {
    const index = text.indexOf(token, offset);
    if (index < 0) {
      break;
    }
    count++;
    offset = index + token.length;
  }
  return count;
}

function readFileRecord(file, failures) {
  try {
    const bytes = fs.readFileSync(file);
    const stat = fs.statSync(file);
    return {
      ...fingerprintBytes(bytes, file),
      mtimeMs: stat.mtimeMs,
      bytes,
    };
  } catch (error) {
    failures.push(`${normalizePath(file)}: ${String(error?.message ?? error)}`);
    return null;
  }
}

function publicFileRecord(record) {
  if (!record) {
    return null;
  }
  const { bytes: _bytes, ...result } = record;
  return result;
}

/**
 * Bind the live C11-209 source to the generated bundle through esbuild's
 * embedded `sourcesContent`, while also fingerprinting the exact bundle and
 * probe. This function is deliberately fail-closed and never throws: a broken
 * or missing provenance input must still be serializable in the RUNNING/error
 * artifact.
 */
export function collectC11209SourceBuildProvenance({
  sourceFile = C11_209_SOURCE_FILE,
  sourceMapSource = C11_209_SOURCE_FILE,
  runtimeBundle = C11_209_RUNTIME_BUNDLE,
  sourceMapFile = C11_209_SOURCE_MAP,
  probeFile = C11_209_PROBE_FILE,
  policyFile = C11_209_POLICY_FILE,
} = {}) {
  const failures = [];
  const source = readFileRecord(sourceFile, failures);
  const bundle = readFileRecord(runtimeBundle, failures);
  const sourceMap = readFileRecord(sourceMapFile, failures);
  const probe = readFileRecord(probeFile, failures);
  const policy = readFileRecord(policyFile, failures);
  const sourceText = source?.bytes.toString("utf8") ?? "";
  const bundleText = bundle?.bytes.toString("utf8") ?? "";

  const sourceTokenOccurrences = countOccurrences(
    sourceText,
    C11_209_FEATURE_TOKEN,
  );
  const bundleTokenOccurrences = countOccurrences(
    bundleText,
    C11_209_FEATURE_TOKEN,
  );
  if (source && sourceTokenOccurrences !== 1) {
    failures.push(
      `source feature token occurs ${sourceTokenOccurrences} times; expected exactly 1`,
    );
  }
  if (bundle && bundleTokenOccurrences !== 1) {
    failures.push(
      `runtime-bundle feature token occurs ${bundleTokenOccurrences} times; expected exactly 1`,
    );
  }

  const sourceMapDirectiveOccurrences = countOccurrences(
    bundleText,
    "//# sourceMappingURL=index.js.map",
  );
  if (bundle && sourceMapDirectiveOccurrences !== 1) {
    failures.push(
      `runtime bundle declares index.js.map ${sourceMapDirectiveOccurrences} times; expected exactly 1`,
    );
  }

  let embeddedSource = null;
  let embeddedSourcePath = null;
  let sourceMapMatchCount = 0;
  if (sourceMap) {
    try {
      const parsed = JSON.parse(sourceMap.bytes.toString("utf8"));
      const normalizedSource = normalizePath(sourceMapSource);
      const matches = (parsed.sources ?? [])
        .map((entry, index) => ({ entry, index }))
        .filter(
          ({ entry }) =>
            typeof entry === "string" &&
            (normalizePath(entry) === normalizedSource ||
              normalizePath(entry).endsWith(`/${normalizedSource}`)),
        );
      sourceMapMatchCount = matches.length;
      if (matches.length !== 1) {
        failures.push(
          `source map contains ${matches.length} entries for ${normalizedSource}; expected exactly 1`,
        );
      } else {
        const match = matches[0];
        embeddedSourcePath = match.entry;
        const content = parsed.sourcesContent?.[match.index];
        if (typeof content !== "string") {
          failures.push(
            `source map entry for ${normalizedSource} has no embedded sourcesContent`,
          );
        } else {
          embeddedSource = fingerprintBytes(
            Buffer.from(content, "utf8"),
            `${sourceMapFile}#${match.entry}`,
          );
        }
      }
    } catch (error) {
      failures.push(
        `${normalizePath(sourceMapFile)} is not valid JSON: ${String(error?.message ?? error)}`,
      );
    }
  }

  const sourceBuildExact =
    source !== null &&
    embeddedSource !== null &&
    source.sha256 === embeddedSource.sha256 &&
    source.byteLength === embeddedSource.byteLength;
  if (source && embeddedSource && !sourceBuildExact) {
    failures.push(
      "live WebGPUEffectsBindGroup.js differs from the source embedded in index.js.map",
    );
  }

  return {
    schemaVersion: 1,
    source: publicFileRecord(source),
    runtimeBundle: publicFileRecord(bundle),
    sourceMap: publicFileRecord(sourceMap),
    probe: publicFileRecord(probe),
    policy: publicFileRecord(policy),
    embeddedSource,
    embeddedSourcePath,
    sourceMapMatchCount,
    sourceBuildExact,
    featureToken: {
      value: C11_209_FEATURE_TOKEN,
      sourceOccurrences: sourceTokenOccurrences,
      runtimeBundleOccurrences: bundleTokenOccurrences,
    },
    sourceMapDirectiveOccurrences,
    failures,
    ok: failures.length === 0 && sourceBuildExact,
  };
}

function compareFingerprint(label, start, end, failures) {
  if (!start || !end) {
    failures.push(`${label} fingerprint is missing at start or end`);
    return;
  }
  if (start.sha256 !== end.sha256 || start.byteLength !== end.byteLength) {
    failures.push(`${label} changed while the browser probe was running`);
  }
}

/**
 * Fold start/end local identity and every observed HTTP response for the actual
 * runtime entry module into one structural verdict.
 */
export function evaluateC11209Provenance({ start, end, servedRuntime }) {
  const failures = [];
  if (start?.ok !== true) {
    failures.push(
      `start provenance is invalid: ${(start?.failures ?? ["missing"]).join("; ")}`,
    );
  }
  if (end?.ok !== true) {
    failures.push(
      `end provenance is invalid: ${(end?.failures ?? ["missing"]).join("; ")}`,
    );
  }
  compareFingerprint("source", start?.source, end?.source, failures);
  compareFingerprint(
    "runtime bundle",
    start?.runtimeBundle,
    end?.runtimeBundle,
    failures,
  );
  compareFingerprint("source map", start?.sourceMap, end?.sourceMap, failures);
  compareFingerprint("probe", start?.probe, end?.probe, failures);
  compareFingerprint("policy", start?.policy, end?.policy, failures);

  const responses = servedRuntime?.responses;
  if (!Array.isArray(responses) || responses.length === 0) {
    failures.push(
      "no HTTP response for /Build/CesiumUnminified/index.js was captured",
    );
  } else {
    for (const [index, response] of responses.entries()) {
      if (response?.ok !== true || response?.error) {
        failures.push(
          `served runtime response ${index} was not readable and successful`,
        );
        continue;
      }
      if (
        response.sha256 !== start?.runtimeBundle?.sha256 ||
        response.byteLength !== start?.runtimeBundle?.byteLength
      ) {
        failures.push(
          `served runtime response ${index} differs from the fingerprinted local index.js`,
        );
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}

export default {
  C11_209_SOURCE_FILE,
  C11_209_RUNTIME_BUNDLE,
  C11_209_SOURCE_MAP,
  C11_209_PROBE_FILE,
  C11_209_POLICY_FILE,
  C11_209_RUNTIME_PATH,
  C11_209_FEATURE_TOKEN,
  fingerprintBytes,
  collectC11209SourceBuildProvenance,
  evaluateC11209Provenance,
};
