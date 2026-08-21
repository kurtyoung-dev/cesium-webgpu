import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL("../scripts/karmaDefaultBrowsers.js", import.meta.url);
const { resolveDefaultBrowsers } = await import(moduleUrl.href);

const edgePath =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

test("Edge defaults to the headed compatibility launcher", () => {
  assert.deepEqual(resolveDefaultBrowsers(edgePath), ["EdgeCompat"]);
});

test("Edge debugging keeps the debugging launcher", () => {
  assert.deepEqual(resolveDefaultBrowsers(edgePath, true), ["ChromeDebugging"]);
});

test("Chrome keeps the default Chrome launcher", () => {
  assert.deepEqual(
    resolveDefaultBrowsers(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ),
    ["Chrome"],
  );
});

test("an undefined CHROME_BIN keeps the default Chrome launcher", () => {
  assert.deepEqual(resolveDefaultBrowsers(undefined), ["Chrome"]);
});

test("an explicit browser list overrides Edge detection", () => {
  assert.deepEqual(
    resolveDefaultBrowsers(edgePath, true, "Firefox,ChromeHeadless"),
    ["Firefox", "ChromeHeadless"],
  );
});
