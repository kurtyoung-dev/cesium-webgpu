import assert from "node:assert";
import { register } from "node:module";

// Teach bare Node the fork's TypeScript-source resolution convention before
// loading the `@cesium/engine` ESM barrel — see Specs/register-ts.mjs at the
// repo root. Without this, importing the barrel fails under Node with
// ERR_MODULE_NOT_FOUND on the first TS-backed re-export. The registration must
// run before the barrel is imported, so the barrel import is dynamic.
// (C4-CI-NODE20-ESM-TS-BARREL)
register("../../../Specs/register-ts.mjs", import.meta.url);

const { Cartographic, createWorldTerrainAsync, sampleTerrain } =
  await import("@cesium/engine");

// NodeJS smoke screen test
async function test() {
  const provider = await createWorldTerrainAsync();
  const results = await sampleTerrain(provider, 11, [
    Cartographic.fromDegrees(86.925145, 27.988257),
    Cartographic.fromDegrees(87.0, 28.0),
  ]);

  assert(results[0].height > 5000);
  assert(results[0].height < 10000);
  assert(results[1].height > 5000);
  assert(results[1].height < 10000);
}

test();
