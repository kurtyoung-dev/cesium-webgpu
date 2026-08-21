// C11-24 RenderCommand immediate WebGPU pass-slot contract.
// @purpose Instantiate the real extracted command path and route immediate draws to the active WebGPU pass encoder.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/c11-24-render-command-pass-slot.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

const renderCommandUrl = new URL(
  "../../packages/engine/Source/Renderer/WebGPU/RenderCommand.js",
  import.meta.url,
);

let RenderCommand;

function matchingBrace(source, open) {
  let depth = 0;
  let quote;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === "\\") {
        index++;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth++;
    if (character === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  assert.fail("source function did not terminate");
}

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing function: ${signature}`);
  const open = source.indexOf("{", start + signature.length);
  assert.notEqual(open, -1, `missing function body: ${signature}`);
  return source.slice(start, matchingBrace(source, open) + 1);
}

function extractPrototypeAssignment(source, name) {
  const signature = `RenderCommand.prototype.${name} = function`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing prototype function: ${name}`);
  const open = source.indexOf("{", start + signature.length);
  assert.notEqual(open, -1, `missing prototype body: ${name}`);
  const close = matchingBrace(source, open);
  const semicolon = source.indexOf(";", close + 1);
  assert.notEqual(semicolon, -1, `missing prototype terminator: ${name}`);
  assert.match(source.slice(close + 1, semicolon), /^\s*$/u);
  return source.slice(start, semicolon + 1);
}

before(async () => {
  const source = await readFile(renderCommandUrl, "utf8");
  const constructor = extractFunction(
    source,
    "function RenderCommand(options)",
  );
  const methods = [
    "execute",
    "getNativeCommand",
    "_buildWebGPUCommand",
    "_executeWebGL",
    "_executeWebGPU",
  ].map((name) => extractPrototypeAssignment(source, name));
  // eslint-disable-next-line no-new-func
  const compile = new Function(
    "Pass",
    `"use strict";\n${constructor}\n${methods.join("\n")}\nreturn RenderCommand;`,
  );
  RenderCommand = compile({ OPAQUE: 7 });
  assert.equal(typeof RenderCommand, "function");
});

test("immediate WebGPU execution uses the active encoder and cached native command", () => {
  const activeEncoder = { label: "active-pass" };
  const fallbackPassState = { label: "fallback" };
  const executedWith = [];
  let buildCalls = 0;
  const nativeCommand = {
    execute(passEncoder) {
      executedWith.push(passEncoder);
    },
  };
  const context = {
    isWebGPU: true,
    _currentRenderPassEncoder: activeEncoder,
    buildRenderCommand(command) {
      assert.equal(command.isRenderCommand, true);
      buildCalls++;
      return nativeCommand;
    },
  };
  const command = new RenderCommand({ shaderHint: "headless-consumer" });

  command.execute(context, fallbackPassState);
  command.execute(context, fallbackPassState);

  assert.equal(buildCalls, 1);
  assert.deepEqual(executedWith, [activeEncoder, activeEncoder]);
});

test("closed-pass fallback ignores the nonexistent stale alias", () => {
  const staleAlias = { label: "nonexistent-slot" };
  const fallbackPassState = { label: "fallback-pass-state" };
  let executedWith;
  const context = {
    isWebGPU: true,
    _currentRenderPassEncoder: null,
    _currentRenderPass: staleAlias,
    buildRenderCommand() {
      return {
        execute(passEncoder) {
          executedWith = passEncoder;
        },
      };
    },
  };
  new RenderCommand().execute(context, fallbackPassState);
  assert.equal(executedWith, fallbackPassState);
  assert.notEqual(executedWith, staleAlias);
});

test("the extracted WebGL immediate path keeps context plus passState", () => {
  const context = { isWebGPU: false };
  const passState = { label: "webgl-pass-state" };
  let executedArguments;
  const command = new RenderCommand();
  command._cachedWebGLCommand = {
    execute(...args) {
      executedArguments = args;
    },
  };
  command._cachedWebGLVersion = command._dirtyVersion;

  command.execute(context, passState);
  assert.deepEqual(executedArguments, [context, passState]);
});
