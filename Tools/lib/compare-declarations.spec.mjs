import assert from "node:assert/strict";
import test from "node:test";
import typescript from "typescript";

import { compareDeclarations } from "./compare-declarations.mjs";

function compare(baseline, candidate) {
  return compareDeclarations({ baseline, candidate, typescript });
}

test("reports exact text independently from structural and comment parity", () => {
  const declaration =
    "/** Value docs. */\nexport declare const value: string;\n";
  const result = compare(declaration, declaration);

  assert.equal(result.comparable, true);
  assert.equal(result.exactText, true);
  assert.equal(result.structural.equal, true);
  assert.equal(result.comments.exactEqual, true);
  assert.equal(result.jsdoc.normalizedEqual, true);
});

test("accepts formatting-only structural changes without hiding comment formatting", () => {
  const baseline =
    "/** Returns a value. */\nexport declare function read(value?: string): string;\n";
  const candidate = `
/**
 * Returns a value.
 */
export declare function read(
  value?: string,
): string;
`;
  const result = compare(baseline, candidate);

  assert.equal(result.exactText, false);
  assert.equal(result.structural.equal, true);
  assert.equal(result.comments.exactEqual, false);
  assert.equal(result.comments.normalizedEqual, true);
  assert.equal(result.jsdoc.normalizedEqual, true);
});

test("never reports structural parity for missing, empty, non-string, or invalid candidates", async (t) => {
  const valid = "export declare const value: string;";
  const cases = [
    ["missing", undefined, "missing"],
    ["null", null, "missing"],
    ["non-string", { declaration: valid }, "invalid-input"],
    ["empty", " \r\n\t", "empty"],
    ["comment only", "/** no declaration */", "no-substantive-statements"],
    ["invalid syntax", "export declare const value: ;", "invalid-syntax"],
  ];

  for (const [name, candidate, expectedStatus] of cases) {
    await t.test(name, () => {
      const result = compare(valid, candidate);
      assert.equal(result.comparable, false);
      assert.equal(result.structural.equal, false);
      assert.equal(result.comments.eligible, false);
      assert.equal(result.comments.normalizedEqual, false);
      assert.equal(result.jsdoc.normalizedEqual, false);
      assert.equal(result.subjects.candidate.status, expectedStatus);
    });
  }
});

test("applies invalid-subject handling symmetrically to baselines", async (t) => {
  const valid = "export declare const value: string;";
  const cases = [
    ["null", null, "missing"],
    ["non-string", [valid], "invalid-input"],
    ["empty", " \r\n\t", "empty"],
    ["comment only", "/** no declaration */", "no-substantive-statements"],
    ["invalid syntax", "export declare const value: ;", "invalid-syntax"],
  ];

  for (const [name, baseline, expectedStatus] of cases) {
    await t.test(name, () => {
      const result = compare(baseline, valid);
      assert.equal(result.comparable, false);
      assert.equal(result.structural.equal, false);
      assert.equal(result.comments.eligible, false);
      assert.equal(result.comments.normalizedEqual, false);
      assert.equal(result.jsdoc.normalizedEqual, false);
      assert.equal(result.subjects.baseline.status, expectedStatus);
    });
  }
});

test("detects a lost export", () => {
  const baseline = "export declare const value: string;";
  const candidate = "declare const value: string;";
  assert.equal(compare(baseline, candidate).structural.equal, false);
});

test("detects a lost enum member and a changed enum value", async (t) => {
  const baseline = 'export declare enum Mode { Fast = "fast", Safe = "safe" }';

  await t.test("lost member", () => {
    const candidate = 'export declare enum Mode { Fast = "fast" }';
    assert.equal(compare(baseline, candidate).structural.equal, false);
  });
  await t.test("changed value", () => {
    const candidate =
      'export declare enum Mode { Fast = "quick", Safe = "safe" }';
    assert.equal(compare(baseline, candidate).structural.equal, false);
  });
});

test("detects a required parameter replacing an optional parameter", () => {
  const baseline = "export declare function open(path?: string): void;";
  const candidate = "export declare function open(path: string): void;";
  assert.equal(compare(baseline, candidate).structural.equal, false);
});

test("detects loss in nested generic, union, and null structure", () => {
  const baseline =
    "export type Result<T> = Promise<Array<T | string | null> | null>;";
  const candidate = "export type Result<T> = Promise<Array<T>>;";
  assert.equal(compare(baseline, candidate).structural.equal, false);
});

test("detects lost inheritance", () => {
  const baseline =
    "export declare class Base {} export declare class Child extends Base {}";
  const candidate =
    "export declare class Base {} export declare class Child {}";
  assert.equal(compare(baseline, candidate).structural.equal, false);
});

test("detects widening to any", () => {
  const baseline =
    "export declare function select(value: string | number): string;";
  const candidate = "export declare function select(value: any): string;";
  assert.equal(compare(baseline, candidate).structural.equal, false);
});

test("reports changed JSDoc separately from an unchanged declaration", () => {
  const baseline =
    "/** Returns the selected value. */\nexport declare function select(): string;";
  const candidate =
    "/** Returns an unrelated value. */\nexport declare function select(): string;";
  const result = compare(baseline, candidate);

  assert.equal(result.structural.equal, true);
  assert.equal(result.comments.normalizedEqual, false);
  assert.equal(result.jsdoc.normalizedEqual, false);
  assert.deepEqual(
    result.jsdoc.baseline.map((record) => record.normalized),
    ["Returns the selected value."],
  );
});

test("documents that ordered JSDoc comparison does not track declaration attachment", () => {
  const baseline = `/** Shared docs. */
export declare const first: string;
export declare const second: string;`;
  const candidate = `export declare const first: string;
/** Shared docs. */
export declare const second: string;`;
  const result = compare(baseline, candidate);

  assert.equal(result.exactText, false);
  assert.equal(result.structural.equal, true);
  assert.equal(result.comments.normalizedEqual, true);
  assert.equal(result.jsdoc.normalizedEqual, true);
});

test("keeps ordered non-JSDoc comments independently observable", () => {
  const baseline = "// first\n// second\nexport declare const value: string;";
  const candidate = "// second\n// first\nexport declare const value: string;";
  const result = compare(baseline, candidate);

  assert.equal(result.structural.equal, true);
  assert.equal(result.comments.normalizedEqual, false);
  assert.equal(result.jsdoc.normalizedEqual, true);
});
