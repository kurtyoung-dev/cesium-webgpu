// @purpose Verifies parent-dead browser classification and memory totals without reading live processes.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { mkLaneTmp, removeLaneTmp } from "./lane-tmp.mjs";
import {
  parseProcessCsv,
  findOrphanRoots,
  PROCESS_QUERY,
} from "./browser-orphan-preflight.mjs";

const fixture = [
  '"ProcessId","ParentProcessId","Name","WorkingSetSize"',
  '"4","0","System","1000"',
  '"1000","4","explorer.exe","2000"',
  '"18776","19296","msedge.exe","100000000"',
  '"12624","18776","msedge.exe","50000000"',
  '"21140","12624","msedge.exe","3391104"',
  '"2200","1000","msedge.exe","5000"',
  '"2201","2200","msedge.exe","6000"',
  '"3300","33001","chrome.exe","7000000"',
  '"4400","44001","conhost.exe","8000"',
].join("\r\n");
const rows = parseProcessCsv(fixture);
const roots = findOrphanRoots(rows);

test("T1 parses nine process rows", () => assert.equal(rows.length, 9));
test("T2 finds exactly two parent-dead browser roots", () =>
  assert.equal(roots.length, 2));
test("T3 the largest root is the orphaned Edge process", () => {
  assert.equal(roots[0].root.pid, 18776);
  assert.equal(roots[0].root.ppid, 19296);
  assert.equal(roots[0].root.name, "msedge.exe");
});
test("T4 sums the complete three-process descendant tree", () => {
  assert.equal(roots[0].tree.length, 3);
  assert.equal(roots[0].bytes, 153391104);
});
test("T5 the second root is the single orphaned Chrome process", () => {
  assert.equal(roots[1].root.pid, 3300);
  assert.equal(roots[1].root.ppid, 33001);
  assert.equal(roots[1].root.name, "chrome.exe");
  assert.equal(roots[1].tree.length, 1);
  assert.equal(roots[1].bytes, 7000000);
});
test("T6 roots sort by descending bytes then ascending PID", () => {
  assert.ok(roots[0].bytes > roots[1].bytes);
  const tied = findOrphanRoots([
    { pid: 8, ppid: 99, name: "FIREFOX.exe", rss: 1 },
    { pid: 7, ppid: 99, name: "webkit.exe", rss: 1 },
  ]);
  assert.deepEqual(
    tied.map(({ root }) => root.pid),
    [7, 8],
  );
});
test("T7 a browser with a live immediate parent is outside every orphan tree", () => {
  assert.ok(
    roots.every(
      ({ root, tree }) =>
        root.pid !== 2200 && tree.every((row) => row.pid !== 2200),
    ),
  );
});
test("T8 a parent-dead non-browser is not a root", () => {
  assert.ok(roots.every(({ root }) => root.pid !== 4400));
});
test("T9 rejects a different CSV header", () => {
  assert.throws(() => parseProcessCsv('"a","b"'), {
    message: 'unexpected header: "a","b"',
  });
});
test("T10 rejects an unparsable process row", () => {
  assert.throws(() => parseProcessCsv(fixture.split("\r\n")[0] + "\r\nbogus"), {
    message: "unparsable row: bogus",
  });
});
test("T11 exposes the frozen Windows query", () => {
  assert.match(PROCESS_QUERY.args[3], /Get-CimInstance Win32_Process/);
  assert.equal(Object.isFrozen(PROCESS_QUERY), true);
});
test("T12 making the root predicate unreachable removes the fixture's roots", async () => {
  const host = mkLaneTmp("browser-orphan-mutant-", {
    laneName: "browser-orphan-spec-mutant",
  });
  try {
    const source = fs
      .readFileSync(
        new URL("./browser-orphan-preflight.mjs", import.meta.url),
        "utf8",
      )
      .replaceAll("\r\n", "\n");
    const marker =
      "/^(msedge|chrome|chromium|firefox|playwright|webkit)\\.exe$/i";
    assert.equal(source.split(marker).length - 1, 1);
    const changed = source.replace(marker, "false && " + marker);
    assert.notEqual(changed, source);
    const file = path.join(host, "browser-orphan-mutant.mjs");
    fs.writeFileSync(file, changed);
    const inert = await import(pathToFileURL(file).href);
    assert.equal(inert.findOrphanRoots(rows).length, 0);
  } finally {
    removeLaneTmp(host);
  }
});
