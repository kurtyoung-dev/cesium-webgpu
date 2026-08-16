#!/usr/bin/env node
// Audit FeatureRendererKey enum <-> registerFeatureRenderer sites
// <-> getFeatureRenderer consumer sites.
// @purpose Node audit that FeatureRendererKey enum, registerFeatureRenderer sites and getFeatureRenderer consumers stay mutually consistent; CI/pre-commit gate.
// @status ACTIVE
//
// Fails if either:
//   - A key in FeatureRendererKey.js has no registration (dead key).
//   - A key has a registration but no scene-code consumer (dead registration).
//   - A consumer references a key that doesn't exist in the enum (stale).
//
// Runs in plain Node — no dependencies beyond the standard library. Useful
// as a CI gate and as a pre-commit sanity check when touching the FR layer.
//
// Usage:
//   node Tools/audit-feature-renderers.mjs            # text report
//   node Tools/audit-feature-renderers.mjs --json     # machine-readable
//   node Tools/audit-feature-renderers.mjs --strict   # exit 1 on any finding

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENGINE_SRC = path.join(ROOT, "packages", "engine", "Source");
const KEY_FILE = path.join(ENGINE_SRC, "Renderer", "FeatureRendererKey.js");

const args = new Set(process.argv.slice(2));
const emitJson = args.has("--json");
const strict = args.has("--strict");

// Keys that are intentionally retained in the enum without a registration
// or consumer. Reserved slots stay in the enum because FeatureRendererKey is
// add-only (reordering renumbers every later slot). Document the reason
// inline so a future reader can decide whether the key should finally land
// or be promoted off this list.
const INTENTIONAL_UNWIRED_KEYS = new Map([
  [
    "FOG",
    "Classic distance-based fog is driven by frameState.fog.* + the per-tile " +
      "UB in WebGPUGlobeSurfaceRenderer. FR helper would return a regressed " +
      "subset. Slot retained for future Scene-level fog sampler use.",
  ],
]);

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (/\.(js|ts)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

async function readEnumKeys() {
  const src = await fs.readFile(KEY_FILE, "utf8");
  const keys = new Set();
  // Match `IDENTIFIER: <number>,` inside the const FeatureRendererKey block.
  for (const match of src.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*\d+/gm)) {
    const name = match[1];
    if (name === "COUNT") continue;
    keys.add(name);
  }
  return keys;
}

// Strip line/block comments so docstring references like
// `context.getFeatureRenderer(FeatureRendererKey.XXX)` don't register as
// real consumers. Crude but sufficient — the FR API surface doesn't appear
// inside strings anywhere in the codebase.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (JSDoc etc.)
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (avoid `http://`)
}

async function scanSites() {
  const files = await walk(ENGINE_SRC);
  const registrations = new Map(); // key -> [filePath, ...]
  const consumers = new Map(); // key -> [filePath, ...]
  for (const file of files) {
    if (file === KEY_FILE) continue;
    const raw = await fs.readFile(file, "utf8");
    const src = stripComments(raw);
    for (const m of src.matchAll(
      /registerFeatureRenderer\s*\(\s*FeatureRendererKey\.([A-Z0-9_]+)/g,
    )) {
      const list = registrations.get(m[1]) ?? [];
      list.push(path.relative(ROOT, file));
      registrations.set(m[1], list);
    }
    for (const m of src.matchAll(
      /get(?:FeatureRenderer(?:Async|Status)?)\s*\(\s*FeatureRendererKey\.([A-Z0-9_]+)/g,
    )) {
      const list = consumers.get(m[1]) ?? [];
      list.push(path.relative(ROOT, file));
      consumers.set(m[1], list);
    }
  }
  return { registrations, consumers };
}

function report(enumKeys, registrations, consumers) {
  const unregistered = [];
  const deadRegistrations = [];
  const staleConsumers = [];
  const intentional = [];

  for (const key of enumKeys) {
    if (INTENTIONAL_UNWIRED_KEYS.has(key)) {
      intentional.push(key);
      continue;
    }
    if (!registrations.has(key)) unregistered.push(key);
    if (!consumers.has(key) && registrations.has(key)) {
      deadRegistrations.push(key);
    }
  }
  for (const key of consumers.keys()) {
    if (!enumKeys.has(key)) staleConsumers.push(key);
  }

  return { unregistered, deadRegistrations, staleConsumers, intentional };
}

async function main() {
  const enumKeys = await readEnumKeys();
  const { registrations, consumers } = await scanSites();
  const findings = report(enumKeys, registrations, consumers);

  if (emitJson) {
    console.log(
      JSON.stringify(
        {
          enumKeyCount: enumKeys.size,
          registeredKeyCount: registrations.size,
          consumedKeyCount: consumers.size,
          findings,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `FR audit: ${enumKeys.size} keys, ` +
        `${registrations.size} registered, ${consumers.size} consumed.`,
    );
    if (findings.unregistered.length) {
      console.log("\nUnregistered keys (in enum but no registration):");
      for (const k of findings.unregistered) console.log(`  - ${k}`);
    }
    if (findings.intentional.length) {
      console.log(
        "\nIntentionally unwired keys (reserved — excluded from strict mode):",
      );
      for (const k of findings.intentional) {
        console.log(`  - ${k}: ${INTENTIONAL_UNWIRED_KEYS.get(k)}`);
      }
    }
    if (findings.deadRegistrations.length) {
      console.log(
        "\nDead registrations (registered but no scene-code consumer):",
      );
      for (const k of findings.deadRegistrations) {
        const sites = (registrations.get(k) ?? []).join(", ");
        console.log(`  - ${k}  (registered at: ${sites})`);
      }
    }
    if (findings.staleConsumers.length) {
      console.log("\nStale consumers (references a key not in the enum):");
      for (const k of findings.staleConsumers) {
        const sites = (consumers.get(k) ?? []).join(", ");
        console.log(`  - ${k}  (consumed at: ${sites})`);
      }
    }
    if (
      !findings.unregistered.length &&
      !findings.deadRegistrations.length &&
      !findings.staleConsumers.length
    ) {
      console.log("\nNo findings.");
    }
  }

  const hasFindings =
    findings.unregistered.length > 0 ||
    findings.deadRegistrations.length > 0 ||
    findings.staleConsumers.length > 0;
  process.exit(strict && hasFindings ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
