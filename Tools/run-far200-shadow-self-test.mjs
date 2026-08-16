// @purpose Thin bootstrap: esbuild-bundles Tools/far200-shadow-self-test.ts and executes it via a data: URL import.
// @status ACTIVE

import { build } from "esbuild";

const result = await build({
  entryPoints: ["Tools/far200-shadow-self-test.ts"],
  absWorkingDir: process.cwd(),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});

const bundledTest = result.outputFiles[0].text;
const dataUrl = `data:text/javascript;base64,${Buffer.from(bundledTest).toString("base64")}`;
await import(dataUrl);
