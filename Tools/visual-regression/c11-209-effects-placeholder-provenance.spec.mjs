import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  C11_209_FEATURE_TOKEN,
  C11_209_SOURCE_FILE,
  collectC11209SourceBuildProvenance,
  evaluateC11209Provenance,
  fingerprintBytes,
} from "./lib/c11-209-effects-placeholder-provenance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_SOURCE = fs.readFileSync(
  path.join(HERE, "probe-c11-209-effects-placeholder-startup.mjs"),
  "utf8",
);

function probeWiringFailures(source) {
  const requirements = [
    ["schema v2", /schemaVersion:\s*2/],
    ["start provenance", /start:\s*collectC11209SourceBuildProvenance\(\)/],
    [
      "end provenance",
      /provenance\.end\s*=\s*collectC11209SourceBuildProvenance\(\)/,
    ],
    ["served bundle response", /page\.on\("response"/],
    ["served origin", /url\.origin\s*!==\s*new URL\(BASE\)\.origin/],
    ["served byte fingerprint", /\.\.\.fingerprintBytes\(body\)/],
    ["lifecycle fold", /evaluateC11209Provenance\(\{/],
    ["structural gate", /provenance\?\.ok\s*===\s*true/],
    ["analyzer-visible close", /if\s*\(browser\)[\s\S]*browser\.close\(\)/],
  ];
  return requirements
    .filter(([, pattern]) => !pattern.test(source))
    .map(([name]) => name);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c11-209-provenance-"));
  const sourceFile = path.join(root, "WebGPUEffectsBindGroup.js");
  const runtimeBundle = path.join(root, "index.js");
  const sourceMapFile = path.join(root, "index.js.map");
  const probeFile = path.join(root, "probe.mjs");
  const policyFile = path.join(root, "policy.mjs");
  const source = `const descriptor = { label: "${C11_209_FEATURE_TOKEN}" };\n`;
  const bundle = `${source}//# sourceMappingURL=index.js.map\n`;
  const writeMap = (content = source) =>
    fs.writeFileSync(
      sourceMapFile,
      JSON.stringify({
        version: 3,
        sources: [`../../${C11_209_SOURCE_FILE}`],
        sourcesContent: [content],
        names: [],
        mappings: "",
      }),
    );
  fs.writeFileSync(sourceFile, source);
  fs.writeFileSync(runtimeBundle, bundle);
  writeMap();
  fs.writeFileSync(probeFile, "// probe identity\n");
  fs.writeFileSync(policyFile, "// provenance policy identity\n");
  return {
    root,
    sourceFile,
    runtimeBundle,
    sourceMapFile,
    probeFile,
    policyFile,
    source,
    bundle,
    writeMap,
    collect() {
      return collectC11209SourceBuildProvenance({
        sourceFile,
        runtimeBundle,
        sourceMapFile,
        probeFile,
        policyFile,
      });
    },
  };
}

function servedResponse(bundle) {
  return {
    url: "http://localhost:8080/Build/CesiumUnminified/index.js",
    status: 200,
    ok: true,
    ...fingerprintBytes(Buffer.from(bundle)),
  };
}

test("exact embedded source and runtime entry produce a provenance identity", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const result = f.collect();
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.sourceBuildExact, true);
  assert.equal(result.sourceMapMatchCount, 1);
  assert.equal(result.featureToken.sourceOccurrences, 1);
  assert.equal(result.featureToken.runtimeBundleOccurrences, 1);
  assert.match(result.source.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.runtimeBundle.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.sourceMap.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.probe.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.policy.sha256, /^[0-9a-f]{64}$/);
  const liveSource = fs.readFileSync(
    path.resolve(HERE, "../..", C11_209_SOURCE_FILE),
    "utf8",
  );
  assert.equal(
    liveSource.includes(C11_209_FEATURE_TOKEN),
    true,
    "the production source lost the exact C11-209 feature token",
  );
});

test("stale source-map content and a bundle without the feature token fail closed", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.writeMap("const stale = true;\n");
  fs.writeFileSync(
    f.runtimeBundle,
    "const stale = true;\n//# sourceMappingURL=index.js.map\n",
  );
  const result = f.collect();
  assert.equal(result.ok, false);
  assert.equal(result.sourceBuildExact, false);
  assert.ok(
    result.failures.some((failure) =>
      failure.includes("differs from the source"),
    ),
  );
  assert.ok(
    result.failures.some((failure) =>
      failure.includes("runtime-bundle feature token occurs 0 times"),
    ),
  );
});

test("malformed source maps degrade to a recorded failure instead of throwing", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(f.sourceMapFile, "{not-json");
  let result;
  assert.doesNotThrow(() => {
    result = f.collect();
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((failure) => failure.includes("not valid JSON")),
  );
});

test("the lifecycle verdict binds stable local inputs to the served bytes", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const start = f.collect();
  const end = f.collect();
  const verdict = evaluateC11209Provenance({
    start,
    end,
    servedRuntime: { responses: [servedResponse(f.bundle)] },
  });
  assert.equal(verdict.ok, true, verdict.failures.join("\n"));
});

test("lifecycle mutants cannot vacuously pass", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const start = f.collect();
  const end = structuredClone(start);
  const goodServed = { responses: [servedResponse(f.bundle)] };
  const mutate = (callback) => {
    const mutant = {
      start: structuredClone(start),
      end: structuredClone(end),
      servedRuntime: structuredClone(goodServed),
    };
    callback(mutant);
    return evaluateC11209Provenance(mutant);
  };
  const mutants = [
    mutate((value) => {
      value.end.source.sha256 = "0".repeat(64);
    }),
    mutate((value) => {
      value.end.runtimeBundle.byteLength++;
    }),
    mutate((value) => {
      value.end.sourceMap.sha256 = "1".repeat(64);
    }),
    mutate((value) => {
      value.end.probe.sha256 = "2".repeat(64);
    }),
    mutate((value) => {
      value.end.policy.sha256 = "4".repeat(64);
    }),
    mutate((value) => {
      value.servedRuntime.responses[0].sha256 = "3".repeat(64);
    }),
    mutate((value) => {
      value.servedRuntime.responses = [];
    }),
    mutate((value) => {
      value.start.ok = false;
      value.start.failures = ["injected start failure"];
    }),
  ];
  for (const [index, mutant] of mutants.entries()) {
    assert.equal(mutant.ok, false, `mutant ${index} passed vacuously`);
    assert.ok(mutant.failures.length > 0, `mutant ${index} had no failure`);
  }
});

test("the browser probe wires the provenance verdict into a structural gate", () => {
  assert.deepEqual(probeWiringFailures(PROBE_SOURCE), []);
});

test("the probe-wiring policy rejects an orphaned always-green gate", () => {
  const mutant = PROBE_SOURCE.replace("provenance?.ok === true", "true");
  assert.notEqual(mutant, PROBE_SOURCE, "gate mutation did not apply");
  assert.deepEqual(probeWiringFailures(mutant), ["structural gate"]);
});
