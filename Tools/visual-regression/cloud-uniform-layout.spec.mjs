// @purpose Pins the cloud main uniform block's named slot layout (the R-2026-09-26-12 slot rule, restated for this layout) against the WGSL struct's computed offsets and the renderer's allocation, and executes the tail writers' reserved pads.
// @status ACTIVE
//
// Plan 4.6, rule by rule:
//   1. every slot is named: the layout module's ranges tile the block without a
//      gap, each range starts and ends on the WGSL fields it names, and every
//      WGSL field from slot 64 on carries its own slot number;
//   2. append-only: the size is pinned, so a resized or inserted range is red;
//   3. reserved pads read zero after every tail writer runs;
//   5. a mutant writer that puts a non-zero value into a pad, and a mutant range
//      table that resizes a slot, must each turn a check red.
// The WGSL offsets are computed from the struct text with the host-shareable
// layout rules, not read from its comments, so a comment that drifts from the
// real layout is caught rather than trusted.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const webgpu = path.join(root, "packages/engine/Source/Renderer/WebGPU");
const layoutPath = path.join(webgpu, "WebGPUCloudUniformLayout.ts");
const shaderPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
);
const read = (file) => fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");

// The block's float count at this tip. Growing it is a new row at the tail and
// a deliberate edit here.
const PINNED_FLOATS = 180;

// Host-shareable layout in f32 units: [size, alignment].
const WGSL_TYPES = {
  f32: [1, 1],
  "vec2<f32>": [2, 2],
  "vec3<f32>": [3, 4],
  "vec4<f32>": [4, 4],
  "mat4x4<f32>": [16, 4],
};

/** The struct's fields with their computed offsets, and its padded size. */
function wgslStruct(source, name) {
  const start = source.indexOf(`struct ${name} {`);
  assert.ok(start >= 0, `struct ${name} not found`);
  const end = source.indexOf("\n};", start);
  const members = [];
  let offset = 0;
  for (const raw of source.slice(start, end).split("\n").slice(1)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line.length === 0) {
      continue;
    }
    const m = line.match(/^(\w+)\s*:\s*([\w<>]+)\s*,?$/);
    assert.ok(m, `unparsed struct line: ${raw.trim()}`);
    const type = WGSL_TYPES[m[2]];
    assert.ok(type, `unmodelled WGSL type ${m[2]}`);
    offset = Math.ceil(offset / type[1]) * type[1];
    const slot = raw.match(/\/\/\s*(\d+)/);
    members.push({
      name: m[1],
      offset,
      floats: type[0],
      slot: slot ? Number(slot[1]) : undefined,
    });
    offset += type[0];
  }
  // A uniform struct rounds to its 16-byte alignment.
  return { members, floats: Math.ceil(offset / 4) * 4 };
}

async function loadLayout(mutate, label) {
  return bundle({
    path: layoutPath,
    source: read(layoutPath),
    real: [],
    mutate,
    label,
  });
}

/** Rules 1 and 2 for one layout module (live or a mutant). */
function assertLayout(layout) {
  const ranges = layout.CLOUD_UNIFORM_RANGES;
  let next = 0;
  for (const r of ranges) {
    assert.equal(
      r.offset,
      next,
      `${r.name} leaves a gap or overlaps at ${next}`,
    );
    assert.ok(r.floats > 0, `${r.name} is empty`);
    next = r.offset + r.floats;
  }
  assert.equal(layout.CLOUD_UNIFORM_LAYOUT_FLOATS, next);
  assert.equal(next, PINNED_FLOATS, "the block's size is pinned (append-only)");
  assert.equal(next % 4, 0, "the block stays a whole number of 16-byte rows");

  const struct = wgslStruct(read(shaderPath), "CloudUniforms");
  assert.equal(
    struct.floats,
    next,
    "the WGSL struct and the layout disagree on the size",
  );
  const at = new Map(struct.members.map((m) => [m.offset, m]));
  const endingAt = new Map(
    struct.members.map((m) => [m.offset + m.floats - 1, m]),
  );
  for (const r of ranges) {
    assert.equal(
      at.get(r.offset)?.name,
      r.first,
      `${r.name} does not start on ${r.first}`,
    );
    assert.equal(
      endingAt.get(r.offset + r.floats - 1)?.name,
      r.last,
      `${r.name} does not end on ${r.last}`,
    );
  }
  for (const m of struct.members) {
    if (m.offset >= 64) {
      assert.equal(
        m.slot,
        m.offset,
        `${m.name} is documented at the wrong slot`,
      );
    }
  }
  for (const slot of layout.CLOUD_UNIFORM_RESERVED_SLOTS) {
    const member = struct.members.find(
      (m) => slot >= m.offset && slot < m.offset + m.floats,
    );
    assert.ok(member, `reserved slot ${slot} is outside the struct`);
  }
}

/** Rule 3: every reserved pad a tail writer covers reads zero after it runs. */
function assertPadsZero(layout) {
  for (const enabled of [true, false]) {
    const data = new Float32Array(PINNED_FLOATS).fill(7);
    const end = layout.writeCloudMaterialFlowUniforms(
      data,
      layout.CLOUD_MATERIAL_FLOW_OFFSET,
      12.5,
      enabled,
    );
    assert.equal(
      end,
      layout.CLOUD_MATERIAL_FLOW_OFFSET + layout.CLOUD_MATERIAL_FLOW_FLOATS,
    );
    assert.equal(data[176], 12.5);
    assert.equal(data[177], enabled ? 1 : 0);
    for (const slot of layout.CLOUD_UNIFORM_RESERVED_SLOTS) {
      if (slot >= 176 && slot < end) {
        assert.equal(
          data[slot],
          0,
          `reserved pad ${slot} was written non-zero`,
        );
      }
    }
    assert.ok(
      data.subarray(0, 176).every((x) => x === 7),
      "wrote below its tail",
    );
    assert.ok(
      data.subarray(end).every((x) => x === 7),
      "wrote past its tail",
    );
  }
}

test("the layout names every slot without a gap, on the WGSL struct's computed fields", async () => {
  assertLayout(await loadLayout());
});

test("the renderer allocates exactly the layout's float count", () => {
  const sources = [
    "WebGPUProceduralCloudRenderer.ts",
    "WebGPUCloudDensityDomain.ts",
    "WebGPUCloudUniformLayout.ts",
    "WebGPUCloudAirLight.ts",
  ]
    .map((file) => path.join(webgpu, file))
    // The air-light module arrives with unit 3463.
    .filter((file) => fs.existsSync(file))
    .map(read);
  const constant = (name, outer = new Set()) => {
    assert.ok(!outer.has(name), `cyclic ${name}`);
    const seen = new Set(outer).add(name);
    const pattern = new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name}\\s*=\\s*([^;]+);`,
    );
    const hit = sources.map((s) => s.match(pattern)).find(Boolean);
    assert.ok(hit, `${name} is not a constant in the cloud sources`);
    return hit[1].split("+").reduce((sum, term) => {
      const t = term.trim();
      return sum + (/^\d+$/.test(t) ? Number(t) : constant(t, seen));
    }, 0);
  };
  assert.equal(constant("CLOUD_UNIFORM_FLOATS"), PINNED_FLOATS);
});

test("the tail writers fill every reserved pad with zero", async () => {
  assertPadsZero(await loadLayout());
});

test("MUTANT: a flow writer that puts a non-zero value into a reserved pad is red", async () => {
  const mutant = await loadLayout(
    (source) =>
      source.replace("  data[offset + 3] = 0;", "  data[offset + 3] = 1;"),
    "write 1 into the flow tail's last reserved pad",
  );
  assert.throws(() => assertPadsZero(mutant), assert.AssertionError);
});

test("MUTANT: a range table that resizes a slot is red", async () => {
  const mutant = await loadLayout(
    (source) =>
      source.replace(
        'range("_padFlow0", 178, 1)',
        'range("_padFlow0", 178, 2)',
      ),
    "resize the reserved pad at 178",
  );
  assert.throws(() => assertLayout(mutant), assert.AssertionError);
});
