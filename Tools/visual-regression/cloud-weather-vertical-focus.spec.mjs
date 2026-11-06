import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const built = await build({
  stdin: {
    contents: [
      'export * from "./packages/engine/Source/Scene/Weather/WeatherVerticalField.ts";',
      'export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityCache.ts";',
    ].join("\n"),
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const api = await import(
  "data:text/javascript;base64," +
    Buffer.from(built.outputFiles[0].text).toString("base64")
);
function plane(width, height) {
  return {
    bytes: new Uint8Array(width * height * 4),
    minimumBase: 0,
    maximumTop: 30000,
  };
}
function write(value, i, base, top) {
  const b = Math.round(base * 2),
    t = Math.round(top * 2);
  value.bytes.set([b & 255, b >>> 8, t & 255, t >>> 8], i * 4);
}
function data() {
  const value = new Float32Array(196);
  value[40] = 1500;
  value[41] = 4000;
  value[42] = 6378137;
  value[62] = 6356752;
  value[114] = 500;
  value[115] = 14000;
  value[64] = 1;
  value.set([-Math.PI, -Math.PI / 2, 2 * Math.PI, Math.PI], 68);
  return value;
}

test("packed height sampling decodes before interpolation and preserves missing support", () => {
  const value = plane(2, 2);
  write(value, 0, 127.5, 1000);
  write(value, 1, 128.5, 3000);
  write(value, 2, 127.5, 1000);
  write(value, 3, 128.5, 3000);
  assert.deepEqual(
    api.samplePackedWeatherVertical(value, 2, 2, 0.5, 0.5),
    [128, 2000, 1],
  );
  value.bytes.fill(0);
  write(value, 0, 1000, 2000);
  assert.deepEqual(
    api.samplePackedWeatherVertical(value, 2, 2, 0.5, 0.5),
    [1000, 2000, 0.25],
  );
  value.bytes.fill(0);
  assert.equal(
    api.samplePackedWeatherVertical(value, 2, 2, 0.5, 0.5),
    undefined,
  );
  assert.equal(
    api.samplePackedWeatherVertical(value, 2, 2, NaN, 0.5),
    undefined,
  );
  assert.equal(
    api.samplePackedWeatherVertical(value, 0, 2, 0.5, 0.5),
    undefined,
  );
});

test("local height lookup wraps longitude, clamps latitude and reads only four texels", () => {
  const value = plane(4, 2);
  for (let i = 0; i < 8; i++)
    write(value, i, i < 4 ? 500 : 1500, i < 4 ? 2000 : 5000);
  assert.deepEqual(
    api.samplePackedWeatherVertical(value, 4, 2, 0, 0.5),
    api.samplePackedWeatherVertical(value, 4, 2, 1, 0.5),
  );
  assert.deepEqual(
    api.samplePackedWeatherVertical(value, 4, 2, -0.25, 0.5),
    api.samplePackedWeatherVertical(value, 4, 2, 0.75, 0.5),
  );
  assert.deepEqual(
    api.samplePackedWeatherVertical(value, 4, 2, 0.5, -1),
    [500, 2000, 1],
  );
  assert.deepEqual(
    api.samplePackedWeatherVertical(value, 4, 2, 0.5, 2),
    [1500, 5000, 1],
  );
  const large = plane(1024, 512);
  let reads = 0;
  const tracked = new Proxy(large.bytes, {
    get(target, key) {
      if (/^\d+$/.test(String(key))) {
        reads++;
        return target[key];
      }
      if (key === "length") return target.length;
      return Reflect.get(target, key, target);
    },
  });
  api.samplePackedWeatherVertical(
    { ...large, bytes: tracked },
    1024,
    512,
    0.6,
    0.4,
  );
  assert.equal(reads, 16);
});

test("local cache centers inside shallow regional clouds instead of the global vertical envelope", () => {
  const uniforms = data(),
    value = plane(2, 2),
    size = { width: 2, height: 2 };
  for (let i = 0; i < 4; i++) write(value, i, 1000, 2000);
  const camera = [6384137, 0, 0];
  const local = api.cloudDensityCacheFocus(camera, uniforms, true, value, size);
  assert.ok(Math.abs(local[0] - (6378137 + 1500)) < 1e-6);
  assert.ok(Math.abs(local[0] - (6378137 + (500 + 14000) / 2)) > 5000);
  assert.deepEqual(
    api.cloudDensityCacheFocus([15000000, 0, 0], uniforms, true, value, size),
    local,
  );
  const north = api.cloudDensityCacheFocus(
    [0, 0, 7000000],
    uniforms,
    true,
    value,
    size,
  );
  assert.ok(north.every(Number.isFinite));
  assert.ok(Math.abs(north[2] - (6356752 + 1500)) < 1e-6);
});

test("configured height fallback survives unknown, partial, disabled and malformed metadata", () => {
  const uniforms = data(),
    value = plane(2, 2),
    size = { width: 2, height: 2 },
    camera = [6384137, 0, 0];
  const fallback = 6378137 + 2750;
  assert.ok(
    Math.abs(
      api.cloudDensityCacheFocus(camera, uniforms, true, value, size)[0] -
        fallback,
    ) < 1e-6,
  );
  write(value, 0, 1000, 2000);
  assert.ok(
    Math.abs(
      api.cloudDensityCacheFocus(camera, uniforms, true, value, size)[0] -
        (6378137 + 2437.5),
    ) < 1e-6,
  );
  assert.ok(
    Math.abs(
      api.cloudDensityCacheFocus(camera, uniforms, false, value, size)[0] -
        fallback,
    ) < 1e-6,
  );
  uniforms[64] = 0;
  assert.ok(
    Math.abs(
      api.cloudDensityCacheFocus(camera, uniforms, true, value, size)[0] -
        fallback,
    ) < 1e-6,
  );
  uniforms[64] = 1;
  assert.ok(
    Math.abs(
      api.cloudDensityCacheFocus(
        camera,
        uniforms,
        true,
        { ...value, bytes: new Uint8Array(4) },
        size,
      )[0] - fallback,
    ) < 1e-6,
  );
});
