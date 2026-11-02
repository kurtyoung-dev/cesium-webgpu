import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { preprocess, ShaderDefineHi as H } from "./lib/wgsl-variant.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const result = await build({
  stdin: {
    contents:
      'export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudWeatherBounds.ts";',
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const api = await import(
  "data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
const domain = {
  equatorialRadius: 6378137,
  polarRadius: 6356752,
  bottom: 1500,
  top: 12000,
};
const immediate = () => Promise.resolve();
const small = () => new Uint8Array(16 * 8 * 4);
const waitPrepared = async (state) => {
  for (let i = 0; i < 200 && state.pending; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(state.pending, false);
  assert.equal(state.failed, false);
};
globalThis.GPUBufferUsage ??= { STORAGE: 1, COPY_DST: 2 };
function recordingDevice() {
  const record = { buffers: [], writes: [], failWrite: false };
  const device = {
    createBuffer(descriptor) {
      const value = {
        ...descriptor,
        destroyed: false,
        destroy() {
          value.destroyed = true;
        },
      };
      record.buffers.push(value);
      return value;
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        if (record.failWrite) {
          throw new Error("injected upload failure");
        }
        record.writes.push({ buffer, offset, data: data.slice() });
      },
    },
  };
  return { device, record };
}
function nodes(packed) {
  const f = packed.data,
    u = new Uint32Array(f.buffer);
  return Array.from({ length: packed.nodeCount }, (_, i) => {
    const offset = 4 + i * 16;
    return {
      min: [0, 1, 2].map((a) => f[offset + a] + f[offset + 4 + a]),
      max: [0, 1, 2].map((a) => f[offset + 8 + a] + f[offset + 12 + a]),
      coverage: f[offset + 11],
      escape: u[offset + 3],
      leaf: u[offset + 7],
    };
  });
}
function position(lon, lat, altitude) {
  const c = Math.cos(lat),
    s = Math.sin(lat);
  const radius =
    1 /
    Math.hypot(
      c / (domain.equatorialRadius + altitude),
      s / (domain.polarRadius + altitude),
    );
  return [radius * c * Math.cos(lon), radius * c * Math.sin(lon), radius * s];
}

test("occupied source filter support survives pooling, seam wrapping, poles and split packing", async () => {
  const width = 721,
    height = 361,
    bytes = new Uint8Array(width * height * 4);
  const texels = [
    [0, 0, 255],
    [720, 0, 150],
    [0, 360, 240],
    [720, 360, 1],
    [0, 170, 70],
    [720, 180, 170],
    [351, 192, 125],
    [366, 169, 210],
    [16, 16, 50],
  ];
  for (const [x, y, value] of texels) {
    bytes[(y * width + x) * 4] = value;
  }
  let yields = 0;
  const packed = await api.prepareCloudWeatherBounds(
    bytes,
    width,
    height,
    domain,
    () => true,
    async () => {
      yields++;
    },
  );
  assert.ok(yields >= 1 + Math.floor(height / 16));
  const all = nodes(packed),
    leaves = all.filter((n) => n.leaf);
  assert.ok(leaves.length > 0);
  for (const [x, y, value] of texels) {
    for (const dx of [-0.5, 0.5, 1.5]) {
      for (const dy of [-0.5, 0.5, 1.5]) {
        const lon = (((x + dx) / width) * 2 - 1) * Math.PI;
        const lat = Math.max(
          -Math.PI / 2,
          Math.min(Math.PI / 2, (0.5 - (y + dy) / height) * Math.PI),
        );
        for (const altitude of [domain.bottom, 6750, domain.top]) {
          const p = position(lon, lat, altitude);
          assert.ok(
            leaves.some(
              (node) =>
                node.coverage >= value / 255 &&
                p.every(
                  (v, axis) => v >= node.min[axis] && v <= node.max[axis],
                ),
            ),
            JSON.stringify({ x, y, dx, dy, altitude, p }),
          );
        }
      }
    }
  }
  for (let i = 0; i < all.length; i++) {
    assert.ok(all[i].escape > i && all[i].escape <= all.length);
    if (!all[i].leaf) {
      for (let j = i + 1; j < all[i].escape; j++) {
        assert.ok(all[i].coverage >= all[j].coverage);
        assert.ok(all[j].min.every((v, a) => v >= all[i].min[a] - 0.01));
        assert.ok(all[j].max.every((v, a) => v <= all[i].max[a] + 0.01));
      }
    }
  }
});

test("all-clear fields publish a valid empty hierarchy and cancelled work cannot finish", async () => {
  const packed = await api.prepareCloudWeatherBounds(
    small(),
    16,
    8,
    domain,
    () => true,
    immediate,
  );
  assert.equal(packed.nodeCount, 0);
  assert.equal(new Uint32Array(packed.data.buffer)[1], 1);
  assert.equal(packed.data.byteLength, 80);
  let current = true;
  await assert.rejects(
    api.prepareCloudWeatherBounds(
      new Uint8Array(32 * 32 * 4),
      32,
      32,
      domain,
      () => current,
      async () => {
        current = false;
      },
    ),
    /expired/,
  );
  await assert.rejects(
    api.prepareCloudWeatherBounds(small(), 16, 9, domain),
    /Invalid/,
  );
});

test("OFF allocates nothing; current fields publish only during prepare and preserve same-frame users", async () => {
  const { device, record } = recordingDevice();
  const monitor = {
    begins: 0,
    resolves: 0,
    begin() {
      this.begins++;
      return {};
    },
    resolve() {
      this.resolves++;
    },
  };
  const state = new api.CloudWeatherBounds(device, monitor),
    a = small(),
    b = small();
  a[64] = 200;
  b[128] = 240;
  const prepare = (bytes, version = 1, enabled = true, frame = 1) =>
    state.prepare(bytes, 16, 8, version, domain, enabled, frame);
  assert.equal(prepare(a, 1, false), null);
  assert.equal(record.buffers.length, 0);
  assert.equal(prepare(a), null);
  assert.equal(state.pending, true);
  await waitPrepared(state);
  assert.equal(record.buffers.length, 0);
  const first = prepare(a);
  assert.ok(first);
  assert.equal(state.builds, 1);
  assert.equal(prepare(a), first);
  assert.equal(
    prepare(b),
    null,
    "same provider-local version cannot reuse different weather bytes",
  );
  await waitPrepared(state);
  const second = prepare(b);
  assert.notEqual(first, second);
  assert.equal(first.destroyed, false);
  assert.equal(prepare(b, 2), null, "same bytes with a new version invalidate");
  await waitPrepared(state);
  const third = prepare(b, 2, true, 2);
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, true);
  assert.equal(monitor.begins, 3);
  assert.equal(monitor.resolves, 3);
  assert.equal(prepare(b, 2, false, 3), null);
  assert.equal(prepare(b, 2, true, 3), third);
  state.destroy();
  assert.ok(record.buffers.every((buffer) => buffer.destroyed));
});

test("pending disposal cannot publish; upload failure remains a detailed-path fallback", async () => {
  const first = recordingDevice(),
    abandoned = new api.CloudWeatherBounds(first.device);
  abandoned.prepare(small(), 16, 8, 1, domain, true);
  abandoned.destroy();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(abandoned.buffer, null);
  assert.equal(first.record.buffers.length, 0);
  const { device, record } = recordingDevice(),
    state = new api.CloudWeatherBounds(device);
  state.prepare(small(), 16, 8, 1, domain, true);
  await waitPrepared(state);
  record.failWrite = true;
  const source = state.source;
  assert.equal(state.prepare(source, 16, 8, 1, domain, true), null);
  assert.equal(state.failed, true);
  assert.ok(record.buffers.every((buffer) => buffer.destroyed));
  state.destroy();
});

test("actual weather/spatial recipes validate, and OFF composition omits the traversal", async () => {
  const directory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(directory, "naga_wasm_tools.js"))
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(directory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  const renderer = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
    ),
    "utf8",
  );
  const imports = new Map(
    [
      ...renderer.matchAll(
        /import\s+(\w+)\s+from\s+"([^"]*\/Shaders\/WebGPU\/[^"]+)\.js";/g,
      ),
    ].map((match) => [
      match[1],
      path.resolve(
        root,
        "packages/engine/Source/Renderer/WebGPU",
        match[2] + ".wgsl",
      ),
    ]),
  );
  const backtick = String.fromCharCode(96);
  const expression = renderer.match(
    new RegExp(
      "const PROCEDURAL_CLOUDS_SOURCE = " +
        backtick +
        "([^" +
        backtick +
        "]+)" +
        backtick +
        ";",
    ),
  )[1];
  const composed = expression
    .replace(/\$\{(\w+)\}/g, (_, name) =>
      fs.readFileSync(imports.get(name), "utf8"),
    )
    .replaceAll("\\n", "\n");
  const base =
    H.CLOUD_NOISE_BAKED_ONLY |
    H.CLOUD_MORPHOLOGY_BASE_ONLY |
    H.CLOUD_SPATIAL_OCCUPANCY;
  assert.doesNotMatch(
    preprocess(composed, 0, base),
    /fn cloudWeatherCoverageUpper/,
  );
  for (const flags of [
    base | H.CLOUD_WEATHER_VOLUME_BOUNDS,
    base |
      H.CLOUD_WEATHER_VOLUME_BOUNDS |
      H.CLOUD_PRIMARY_REUSE |
      H.CLOUD_MARCH_EMIT_RECONSTRUCTION,
  ]) {
    assert.doesNotThrow(() =>
      naga.validate_wgsl(preprocess(composed, 0, flags)),
    );
  }
  // The define is the bit the registry layout allocates to it, and the layout
  // records it as consumed.
  const layout = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "Tools/visual-regression/fixtures/shader-registry-layout.json",
      ),
      "utf8",
    ),
  );
  const entry = JSON.stringify(layout).match(
    /\{[^{}]*"name":"CLOUD_WEATHER_VOLUME_BOUNDS"[^{}]*\}/,
  );
  assert.ok(entry, "the registry layout lists CLOUD_WEATHER_VOLUME_BOUNDS");
  const allocated = JSON.parse(entry[0]);
  assert.equal(allocated.word, "hi");
  assert.equal(allocated.status, "consumed");
  assert.equal(H.CLOUD_WEATHER_VOLUME_BOUNDS, 2 ** allocated.bit);
});
