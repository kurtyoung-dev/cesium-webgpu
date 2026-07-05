import assert from "node:assert";
import { register } from "node:module";

// Teach bare Node the fork's TypeScript-source resolution convention before
// loading the `@cesium/widgets` barrel (which re-exports the `@cesium/engine`
// barrel) — see Specs/register-ts.mjs at the repo root. Without this, the
// import fails under Node with ERR_MODULE_NOT_FOUND on the first TS-backed
// re-export. The registration must run before the barrel is imported, so the
// barrel import is dynamic. (C4-CI-NODE20-ESM-TS-BARREL)
register("../../../Specs/register-ts.mjs", import.meta.url);

const { createCommand } = await import("@cesium/widgets");

// NodeJS smoke screen test

const testFunc = () => {};

const command = createCommand(testFunc, true);
assert(command.canExecute === true);
