// WGSL string-module comment strip contract.
// @purpose Prove the minify-time WGSL comment strip preserves every //>> directive byte-exact, leaves unminified modules untouched, and is wired into the build.
// @status ACTIVE

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  constructRegex as constructPluginRegex,
  escapeCharacters,
} from "../rollup-plugin-strip-pragma/regex.js";
import {
  constructRegex,
  stripWgslComments,
  wgslModuleContents,
} from "../../scripts/build.js";

const punctuationPragma = "x+y?";

function pragmaBlock(prefix, pragma, body) {
  return [
    `//>>${prefix}Start('${pragma}', pragmas.${pragma});`,
    body,
    `//>>${prefix}End('${pragma}');`,
    "",
  ].join("\n");
}

const realShaderPath = new URL(
  "../../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
  import.meta.url,
);

function assertPunctuationEscape(escape) {
  const pattern = new RegExp(`^${escape(punctuationPragma)}$`);
  assert.equal(pattern.test(punctuationPragma), true);
  assert.equal(pattern.test("xy"), false);
}

test("the pragma helper preserves direct output and error semantics", () => {
  assert.equal(escapeCharacters(punctuationPragma), "x\\+y\\?");
  assert.throws(() => escapeCharacters(42), TypeError);
});

test("the punctuation escape contract rejects an inert helper", () => {
  assertPunctuationEscape(escapeCharacters);
  assert.throws(() => assertPunctuationEscape((token) => token), {
    code: "ERR_ASSERTION",
  });
});

test("both pragma consumers treat punctuation as literal token text", () => {
  const source = `${pragmaBlock(
    "include",
    punctuationPragma,
    "removed();",
  )}retained();\n`;

  assert.equal(
    source.replace(constructRegex(punctuationPragma, false), ""),
    "retained();\n",
  );
  assert.equal(
    source.replace(constructPluginRegex(punctuationPragma), ""),
    "retained();\n",
  );
});

test("the build consumer preserves ordinary include and exclude boundaries", () => {
  const includeBlock = pragmaBlock("include", "debug", "includeOnly();");
  const excludeBlock = pragmaBlock("exclude", "debug", "excludeOnly();");
  const retained = "retained();\n";
  const source = `${includeBlock}${excludeBlock}${retained}`;

  assert.equal(
    source.replace(constructRegex("debug", false), ""),
    `${excludeBlock}${retained}`,
  );
  assert.equal(
    source.replace(constructPluginRegex("debug"), ""),
    `${excludeBlock}${retained}`,
  );
  assert.equal(
    source.replace(constructRegex("debug", true), ""),
    `${includeBlock}${retained}`,
  );
});

test("wgslModuleContents leaves unminified modules byte-identical", () => {
  const source = [
    "// a comment the strip would remove",
    "",
    "//>>ifdef LOG_DEPTH",
    "let a = 1.0; // trailing",
    "//>>endif",
    "",
  ].join("\n");
  assert.equal(wgslModuleContents(source, false), source);
});

test("wgslModuleContents applies the strip under minify and terminates the module", () => {
  const source = [
    "// a comment the strip would remove",
    "//>>ifdef LOG_DEPTH",
    "let a = 1.0; // trailing",
    "//>>endif",
  ].join("\n");
  const minified = wgslModuleContents(source, true);
  assert.notEqual(minified, source);
  assert.equal(minified, `${stripWgslComments(source)}\n`);
  assert.ok(minified.endsWith("\n"));
});

test("a real shader keeps every directive and loses every comment line under minify only", () => {
  const source = readFileSync(realShaderPath, "utf8").replace(/\r\n/g, "\n");
  assert.equal(wgslModuleContents(source, false), source);
  const minified = wgslModuleContents(source, true);
  const directives = source
    .split("\n")
    .filter((line) => line.trimStart().startsWith("//>>"));
  assert.ok(directives.length > 0, "fixture shader must carry directives");
  const kept = minified
    .split("\n")
    .filter((line) => line.trimStart().startsWith("//>>"));
  assert.deepEqual(kept, directives);
  const commentLines = minified.split("\n").filter((line) => {
    const t = line.trimStart();
    return t.startsWith("//") && !t.startsWith("//>>");
  });
  assert.deepEqual(commentLines, []);
});

const adjacentDirective = "  //>>ifdef LOG_DEPTH  ";

function assertAdjacentDirectiveContract(strip) {
  const source = [
    "// Bind group 2 supplies the globe depth texture.",
    adjacentDirective,
    "  let depth = textureLoad(depthTexture, pixel, 0); // Sample once.",
    "//>>endif",
    "",
  ].join("\n");
  const expected = [
    adjacentDirective,
    "let depth = textureLoad(depthTexture, pixel, 0);",
    "//>>endif",
    "",
  ].join("\n");
  assert.equal(strip(source), expected);
}

test("removes an adjacent comment while preserving the directive byte-exact", () => {
  assertAdjacentDirectiveContract(stripWgslComments);
});

test("preserves every supported directive family byte-exact", () => {
  const directives = [
    "\t//>>ifdef FEATURE_FLAG ",
    "  //>>else  ",
    "//>>endif",
    "  //>>includeStart('debug', pragmas.debug); ",
    "\t//>>includeEnd('debug');",
  ];
  const source = `${directives.join("\n")}\n`;
  assert.equal(stripWgslComments(source), source);
});

test("removes blank lines", () => {
  const source = "  let first = 1;  \n   \n\t\n  let second = 2;\n";
  assert.equal(stripWgslComments(source), "let first = 1;\nlet second = 2;\n");
});

test("leaves comment markers inside quoted literals intact", () => {
  const source =
    '  let url = "https://example.test/a//b"; // Remove only this comment.\n';
  assert.equal(
    stripWgslComments(source),
    'let url = "https://example.test/a//b";\n',
  );
});

test("preserves CRLF line endings", () => {
  const source =
    "// Remove this.\r\n\r\n  //>>endif  \r\n  let value = 1; // Remove this too.\r\n";
  const stripped = stripWgslComments(source);
  assert.equal(stripped, "  //>>endif  \r\nlet value = 1;\r\n");
  assert.equal(stripped.replaceAll("\r\n", "").includes("\n"), false);
});

test("is idempotent", () => {
  const source = [
    "// Remove this.",
    "//>>ifdef FEATURE_FLAG",
    "  let value = 1; /* Remove this block. */",
    "",
    "//>>endif",
    "",
  ].join("\n");
  const stripped = stripWgslComments(source);
  assert.equal(stripWgslComments(stripped), stripped);
});

test("removes block comments without joining tokens", () => {
  const source =
    "let first = 1; /* Explanation. */\n/** Documentation. */\nlet second = 2;\n";
  assert.equal(stripWgslComments(source), "let first = 1;\nlet second = 2;\n");
});

test("directive-whitelist mutation is caught by the contract fixture", async () => {
  const originalSource = stripWgslComments.toString();
  const mutatedSource = originalSource.replace(
    'startsWith("//>>")',
    'startsWith("//>>disabled")',
  );
  assert.notEqual(mutatedSource, originalSource);

  const moduleSource = `export default ${mutatedSource};`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
  const { default: mutatedStrip } = await import(moduleUrl);

  assert.throws(() => assertAdjacentDirectiveContract(mutatedStrip), {
    code: "ERR_ASSERTION",
  });
});
