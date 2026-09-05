// primitive-bindgroup-layout-arity-guard.spec.mjs — STRUCTURAL guard over
// `WebGPUPrimitiveCommands.ts`. Pure Node: no browser, no GPU, no build.
//
// @purpose Requires every createBindGroup in WebGPUPrimitiveCommands.ts to supply one entry per entry of the bind-group layout it names, and refuses to pass over a call site it cannot resolve.
// @status ACTIVE
//
// ── WHY A SOURCE-SHAPE GUARD, EXCEPTIONALLY ─────────────────────────────────
//
// This repository's rule is that a spec asserts behaviour, not source text.
// This file is the commissioned exception for row `AR-834`, and it is
// ADDITIONAL to — never a substitute for — the behaviour spec next to it
// (`primitive-texture-bindgroup-entries.spec.mjs`), which drives the real
// engine code under a recording device.
//
// The reason is the defect's shape. `WebGPUPrimitiveCommands.ts` builds
// seventeen bind groups across six code paths — per-instance colour, material,
// depth-fail, polyline, polyline-material, pick — and a behaviour spec can only
// reach the paths its fixture happens to construct. The defect this guard was
// written for (`Texture BGL` declared three entries while the non-material
// builder supplied two, so `SetBindGroup(2, …)` took an invalid bind group and
// the frame's whole command buffer was discarded) was introduced when Batch 25
// widened every LAYOUT from `sampler(0) + texture(1)` to `+ texture(2)` and
// missed one of the bind-group builders. That is a class of defect that is
// created by editing one site and forgetting a sibling, and it is invisible
// until a demo that reaches the forgotten path is actually run.
//
// This guard reads every call site instead. Its negative control is the very
// defect above: with the third entry removed, the guard names line and layout.
//
// It is NOT a duplicate of `q130-wgsl-derivative-uniformity.spec.mjs`, which
// guards WGSL derivative uniformity in the `phongTextured` shader source — a
// different fault that happens to surface on the same demo.
//
// ── WHAT IT RESOLVES, AND WHAT IT REFUSES ───────────────────────────────────
//
// For each `device.createBindGroup({ layout: <expr>, entries: [...] })` it
// resolves `<expr>` to the layout(s) that can be assigned to it:
//
//   * `cache.<field>` — every `cache.<field> = makeBindGroupLayout(device,
//     "<label>", [ … ])` in the file, plus the alias form where the layout is
//     built into a local (`const cameraBGL = makeBindGroupLayout(…)`) and then
//     stored (`cache.cameraBindGroupLayout = cameraBGL;`).
//   * `cache[<KEYS>.layout]` — through every field-key table in the file that
//     declares a `layout:` field, since any of them may be the `keys` argument.
//
// If a site resolves to nothing, or to layouts that disagree about their
// binding set, the guard FAILS rather than skipping: an unresolvable site is
// a site this guard silently stops protecting. Keep new layout creation in one
// of the two forms above, or teach the resolver.
//
// CRLF: this repo checks out with `core.autocrlf=true`; the source is
// LF-normalised before scanning.
//
// Run: node --test Tools/visual-regression/primitive-bindgroup-layout-arity-guard.spec.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts",
);

// The entry helpers exported by `WebGPUBindGroupLayoutHelpers.ts`. Each takes
// the binding index as its first argument.
const ENTRY_HELPER =
  /\b(uniformBuffer|storageBuffer|sampler|texture|storageTexture|externalTexture|depthTexture)\s*\(\s*(\d+)/g;

/**
 * Returns the text between the parentheses of a call whose opening paren is at
 * `open`, so a call spanning many lines is read whole.
 *
 * @param {string} source The module source.
 * @param {number} open Index of the opening parenthesis.
 * @returns {string} The argument text.
 */
function callArguments(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") {
      depth++;
    } else if (source[i] === ")") {
      depth--;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  throw new Error(`unbalanced parentheses from index ${open}`);
}

const sortedUnique = (values) => [...new Set(values)].sort((a, b) => a - b);

/**
 * Scans the module for bind-group layouts and bind groups.
 *
 * @param {string} source LF-normalised module source.
 * @returns {{layouts: Map<string, object[]>, sites: object[], keyTables: object[]}}
 *   Layouts indexed by the cache field they are stored in, every
 *   `createBindGroup` call site, and the field-key tables.
 */
export function scanBindGroups(source) {
  const lineOf = (index) => source.slice(0, index).split("\n").length;

  const layouts = new Map();
  const locals = new Map();
  const addLayout = (field, record) => {
    if (!layouts.has(field)) {
      layouts.set(field, []);
    }
    layouts.get(field).push(record);
  };

  for (const match of source.matchAll(/makeBindGroupLayout\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const args = callArguments(source, open);
    const record = {
      label: args.match(/"([^"]+)"/)?.[1] ?? "(unlabeled)",
      bindings: sortedUnique(
        [...args.matchAll(ENTRY_HELPER)].map((entry) => Number(entry[2])),
      ),
      line: lineOf(match.index),
    };
    const before = source.slice(
      source.lastIndexOf("\n", match.index) + 1,
      match.index,
    );
    const target = before.match(
      /(?:const|let|var)?\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*=\s*$/,
    )?.[1];
    assert.ok(
      target,
      `makeBindGroupLayout at line ${record.line} is not stored in a variable ` +
        `this guard can resolve; store it in a local or a cache field`,
    );
    if (target.includes(".")) {
      addLayout(target, record);
    } else {
      if (!locals.has(target)) {
        locals.set(target, []);
      }
      locals.get(target).push(record);
    }
  }

  // `const cameraBGL = makeBindGroupLayout(…); cache.cameraBindGroupLayout = cameraBGL;`
  for (const match of source.matchAll(
    /([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g,
  )) {
    for (const record of locals.get(match[2]) ?? []) {
      addLayout(match[1], record);
    }
  }

  const keyTables = [];
  for (const match of source.matchAll(
    /const\s+([A-Z][A-Z0-9_]*)\s*=\s*\{([\s\S]*?)\n\};/g,
  )) {
    const layoutField = match[2].match(/\blayout:\s*"([^"]+)"/)?.[1];
    if (layoutField) {
      keyTables.push({ name: match[1], layoutField });
    }
  }

  const sites = [];
  for (const match of source.matchAll(/\.createBindGroup\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const args = callArguments(source, open);
    sites.push({
      line: lineOf(match.index),
      label: args.match(/\blabel:\s*"([^"]+)"/)?.[1],
      layoutExpression: args
        .match(/\blayout:\s*([^,\n]+)/)?.[1]
        ?.replace(/\s+as\s+[\w<>.[\]]+$/, "")
        .trim(),
      bindings: sortedUnique(
        [...args.matchAll(/\bbinding:\s*(\d+)/g)].map((entry) =>
          Number(entry[1]),
        ),
      ),
    });
  }

  return { layouts, sites, keyTables };
}

/**
 * Resolves one call site's `layout:` expression to the layouts it can hold.
 *
 * @param {object} site One entry of `scanBindGroups().sites`.
 * @param {Map<string, object[]>} layouts Layouts by cache field.
 * @param {object[]} keyTables Field-key tables.
 * @returns {object[]} Candidate layouts.
 */
export function resolveLayouts(site, layouts, keyTables) {
  const dynamic = site.layoutExpression?.match(
    /^([A-Za-z_$][\w$]*)\[([A-Za-z_$][\w$]*)\.layout\]$/,
  );
  if (dynamic) {
    return keyTables.flatMap(
      (table) => layouts.get(`${dynamic[1]}.${table.layoutField}`) ?? [],
    );
  }
  return layouts.get(site.layoutExpression) ?? [];
}

/**
 * The invariant. Throws with the offending line and layout when a bind group
 * does not supply one entry per layout entry.
 *
 * @param {string} source LF-normalised module source.
 * @returns {number} The number of call sites checked.
 */
export function assertBindGroupArity(source) {
  const { layouts, sites, keyTables } = scanBindGroups(source);
  assert.ok(
    sites.length > 0,
    "found no createBindGroup call sites — the scanner has stopped matching " +
      "the file it is supposed to guard",
  );
  for (const site of sites) {
    const candidates = resolveLayouts(site, layouts, keyTables);
    assert.ok(
      candidates.length > 0,
      `createBindGroup at line ${site.line} names layout ` +
        `\`${site.layoutExpression}\`, which this guard cannot resolve to a ` +
        `makeBindGroupLayout call. Store the layout in a cache field or a ` +
        `local, or teach resolveLayouts — an unresolvable site is an ` +
        `unguarded site`,
    );
    const shapes = [...new Set(candidates.map((c) => c.bindings.join(",")))];
    assert.equal(
      shapes.length,
      1,
      `createBindGroup at line ${site.line} names \`${site.layoutExpression}\`, ` +
        `which is assigned layouts with different binding sets ` +
        `(${candidates.map((c) => `${c.label}=[${c.bindings}]`).join(", ")}). ` +
        `This guard cannot tell which one reaches this site`,
    );
    // Every candidate agrees on the binding set by the assertion above; name
    // the one created nearest above the call site, which is the one a reader
    // will be looking at.
    const nearest =
      candidates.filter((c) => c.line < site.line).pop() ?? candidates[0];
    assert.deepEqual(
      site.bindings,
      nearest.bindings,
      `createBindGroup at line ${site.line} (${site.label ?? "unlabeled"}) ` +
        `supplies bindings [${site.bindings}] but layout ` +
        `"${nearest.label}" declares [${nearest.bindings}]. ` +
        `WebGPU requires exactly one entry per layout entry; a short bind ` +
        `group is invalid and takes the frame's command buffer with it`,
    );
  }
  return sites.length;
}

const source = readFileSync(MODULE_PATH, "utf8").split("\r\n").join("\n");

test("B1 every createBindGroup supplies one entry per entry of its layout", () => {
  const checked = assertBindGroupArity(source);
  assert.ok(
    checked >= 17,
    `expected the module's full set of bind-group builders to be checked, saw ${checked}`,
  );
});

test("B2 NEGATIVE CONTROL — the pre-fix non-material texture bind group is caught", () => {
  // Exactly the source that shipped before this row: the placeholder bound to
  // the sampler and the primary texture slot, with nothing for binding 2.
  const preFix = source.replace(
    "          { binding: 1, resource: cache.defaultTexture.view },\n" +
      "          { binding: 2, resource: cache.defaultTexture.view },\n",
    "          { binding: 1, resource: cache.defaultTexture.view },\n",
  );
  assert.notEqual(
    preFix,
    source,
    "the negative control's anchor has moved — it would pass vacuously",
  );
  assert.throws(
    () => assertBindGroupArity(preFix),
    /supplies bindings \[0,1\] but layout "Texture BGL" declares \[0,1,2\]/,
  );
});

test("B3 NEGATIVE CONTROL — an unresolvable layout expression is refused, not skipped", () => {
  const opaque = source.replace(
    "        layout: cache.textureBindGroupLayout,\n" +
      "        entries: [\n" +
      "          { binding: 0, resource: cache.defaultSampler },",
    "        layout: someOpaqueHolder.layout,\n" +
      "        entries: [\n" +
      "          { binding: 0, resource: cache.defaultSampler },",
  );
  assert.notEqual(opaque, source, "the B3 anchor has moved");
  assert.throws(
    () => assertBindGroupArity(opaque),
    /cannot resolve to a makeBindGroupLayout call/,
  );
});

test("B4 NEGATIVE CONTROL — a widened layout with an unwidened bind group is caught", () => {
  // The Batch-25 shape of the defect: a layout gains a slot and a sibling
  // bind group does not follow.
  const anchor =
    'makeBindGroupLayout(device, "Camera BGL", [\n' +
    "      uniformBuffer(0, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),\n";
  const widened = source.replace(
    anchor,
    `${anchor}      uniformBuffer(1, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),\n`,
  );
  assert.notEqual(widened, source, "the B4 anchor has moved");
  assert.throws(() => assertBindGroupArity(widened), /Camera BGL/);
});
