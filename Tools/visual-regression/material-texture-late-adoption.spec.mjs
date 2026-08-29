// material-texture-late-adoption.spec.mjs — a textured primitive material must
// adopt its image on the frame the image becomes reachable, not only on the
// frame the draw command happened to be built.
// @purpose Pins that the WebGPU primitive material path re-binds its texture after `Material.update` drains a late image into `_imageSources`, for the main and depth-fail slots, and proves the check is live rather than inert.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no adapter, no pixels.
//
// WHY THIS EXISTS
// ---------------
// A Material publishes a decoded image in two steps that straddle a frame
// boundary. `Material.update` drains `_loadedImages` into `_imageSources` at
// its HEAD, and the per-uniform update functions that PUSH into `_loadedImages`
// run at its TAIL. So an image queued during one update is only readable from
// `_imageSources` during the next one.
//
// `Primitive.update` calls `material.update(context)` and then builds its draw
// commands in the same call, and it rebuilds them only when the appearance, the
// material identity, the render-target format, or the device resources change.
// The first frame on which a primitive is COMPLETE is therefore the frame that
// both queues the image and builds the commands — in that order — and nothing
// afterwards revisits the decision. Every textured material whose image is an
// in-memory canvas takes that path deterministically: the elevation, slope and
// aspect ramps, and the elevation band. Their commands kept the 1x1 placeholder
// for the life of the primitive, so those materials rendered flat white and the
// height, slope and aspect arithmetic behind them was unobservable. URL-backed
// images usually resolve before the geometry completes, which is why the
// texture-carrying materials that load from a URL appeared to work.
//
// WHAT IT PINS
// ------------
//   A. THE PREMISE, executed. The real `Material.update` body and the real
//      per-uniform texture update function from `MaterialHelpers` are run
//      together: `_imageSources` must still be empty after the first update and
//      must carry the canvas after the second. Nothing here is asserted from
//      reading the source.
//   B. BEHAVIOUR. A command assembled the way the builder assembles one — its
//      texture slot holding whatever the binding helper produced while
//      `_imageSources` was empty — must, after one per-frame material update,
//      carry a bind group whose primary texture entry is the view derived from
//      the image. The assertion locates the slot by the identity of the group
//      that was there, so the harness never names an index it wants to find.
//   C. THE RECORDED SLOT IS HONOURED. The same sequence run with the texture
//      group at a different index must update THAT index, which a hardcoded
//      slot would fail.
//   D. THE DEPTH-FAIL TWIN. Its own `df*` cache fields must be the ones that
//      move, and the main fields must be untouched.
//   E. NO CHURN. A second update with an unchanged image must not build another
//      bind group; a reassigned image must build exactly one more.
//   F. THE CHECK IS LIVE. Every contract above is re-run against staged mutants
//      of the engine source — the refresh deleted, the refresh made
//      unreachable, the slot ignored, the key sets swapped — and each mutant
//      must fail. A spec that survives its inert mutant has asserted nothing
//      about the code being reached.
//
// WHAT IS NOT CHECKED HERE
// ------------------------
// No GPU is created and no pixel is read, so this cannot say the adopted view
// samples correctly; that is the latitude probe's leg. The command assembly in
// `createWebGPUMaterialCommands` is too entangled with geometry, pipelines and
// buffers to execute in a browser-free harness, so the one link between the
// builder and the updater — that the builder records the index it pushed the
// texture group at — is checked structurally over the AST, and is labelled as
// such below rather than being passed off as behaviour.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const RENDERER_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts";
const MATERIAL_FILE = "packages/engine/Source/Scene/Material.js";
const MATERIAL_HELPERS_FILE = "packages/engine/Source/Scene/MaterialHelpers.js";

const RENDERER_FUNCTIONS = new Set([
  "getTextureUniformName",
  "ensureMaterialTextureBindGroup",
  "ensureDepthFailMaterialTextureBindGroup",
  "refreshMaterialCommandTextureSlot",
  "updateWebGPUMaterialCommandUniforms",
]);

const RENDERER_CONSTANTS = new Set(["MAIN_MAT_TEX_KEYS", "DF_MAT_TEX_KEYS"]);

// =============================================================================
// Source loading
// =============================================================================

function read(root, relative) {
  return fs
    .readFileSync(path.join(root, relative), "utf8")
    .replace(/\r\n/g, "\n");
}

async function importGenerated(text, tag) {
  const file = path.join(
    os.tmpdir(),
    `${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  fs.writeFileSync(file, text);
  try {
    return await import(`file:///${file.replaceAll("\\", "/")}`);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // A leftover temp module in the OS temp directory is harmless.
    }
  }
}

/**
 * Extracts the material texture-binding decision surface from the renderer's
 * TypeScript by AST and imports it. Importing the module itself is impossible
 * in an unbuilt tree: it pulls in generated shader siblings that only exist
 * after a build. Everything the extracted code calls that is not part of the
 * decision — camera-uniform writing, shadow-cast transforms, the material UBO
 * upload, the effects-slot swap — is supplied as an inert stand-in, so a
 * failure here can only come from the binding code itself.
 */
async function loadRenderer(root) {
  const source = read(root, RENDERER_FILE);
  const sourceFile = ts.createSourceFile(
    "WebGPUPrimitiveCommands.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const fragments = [];
  const found = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      RENDERER_FUNCTIONS.has(statement.name.text)
    ) {
      fragments.push(
        source.slice(statement.getStart(sourceFile), statement.end),
      );
      found.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          RENDERER_CONSTANTS.has(declaration.name.text)
        ) {
          fragments.push(
            `const ${declaration.name.text} = ${declaration.initializer.getText(
              sourceFile,
            )};`,
          );
          found.add(declaration.name.text);
        }
      }
    }
  }

  for (const name of [...RENDERER_FUNCTIONS, ...RENDERER_CONSTANTS]) {
    assert.ok(found.has(name), `${name} was not found in ${RENDERER_FILE}`);
  }

  const prelude = [
    "const defined = (value) => value !== undefined && value !== null;",
    "class DeveloperError extends Error {}",
    "const pragmas = { debug: true };",
    // Orthogonal to the texture decision: camera math, the shadow-cast
    // transform, the material UBO upload and the effects slot. The two sizes
    // only have to be large enough for the scratch array the lifted code
    // allocates; they mirror the renderer's constants so a reader is not
    // misled about the real layout.
    "const FLAT_CAMERA_BYTES = 288;",
    "const LIT_CAMERA_BYTES = 448;",
    "const scratchMaterialCameraData = new Float32Array(LIT_CAMERA_BYTES / 4);",
    "const computeRTEMatrices = () => ({});",
    "const _refreshPrimitiveShadowCastTransform = () => {};",
    "const _refreshPrimitiveEffectsSlot = () => {};",
    "const isMaterialLitShader = () => false;",
    "const isPBRShader = () => false;",
    "const writeRTEUniformsFlat = () => {};",
    "const writeRTEUniformsLit = () => {};",
    "const createMaterialUploadState = () => ({});",
    "const uploadMaterialUniformBuffer = () => {};",
    "const WebGPUTexture = {",
    "  create2D: () => ({ view: { label: 'unreachable-fallback' }, write: () => {} }),",
    "};",
  ].join("\n");

  const moduleText = `${prelude}\n${fragments.join("\n")}\nexport { ${[
    ...found,
  ].join(", ")} };\n`;

  const transpiled = ts.transpileModule(moduleText, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;

  return importGenerated(transpiled, "mat-tex-renderer");
}

/**
 * Extracts `Material.prototype.update` by AST and imports it as a standalone
 * function so the real drain order can be executed against a material double.
 * `Material.js` itself cannot be imported in an unbuilt tree because it pulls
 * in generated GLSL string modules.
 */
async function loadMaterialUpdate(root) {
  const source = read(root, MATERIAL_FILE);
  const sourceFile = ts.createSourceFile(
    "Material.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  let body;
  for (const statement of sourceFile.statements) {
    if (
      !ts.isClassDeclaration(statement) ||
      statement.name?.text !== "Material"
    ) {
      continue;
    }
    for (const member of statement.members) {
      if (
        ts.isMethodDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === "update"
      ) {
        body = source.slice(member.body.getStart(sourceFile), member.body.end);
      }
    }
  }
  assert.ok(
    body,
    `Material.prototype.update was not found in ${MATERIAL_FILE}`,
  );

  const prelude = [
    "const defined = (value) => value !== undefined && value !== null;",
    // The drain allocates a backend texture per loaded image. Its identity is
    // irrelevant here; what matters is the `_imageSources` write beside it.
    "class Sampler { constructor(options) { Object.assign(this, options); } }",
    "class Texture {",
    "  constructor(options) {",
    "    this._width = options?.source?.width ?? 1;",
    "    this._height = options?.source?.height ?? 1;",
    "  }",
    "  destroy() { this.destroyed = true; }",
    "}",
    "class CubeMap { constructor(options) { Object.assign(this, options); } }",
  ].join("\n");

  const moduleText = `${prelude}\nexport function materialUpdate(context) ${body}\n`;
  return importGenerated(moduleText, "mat-tex-material");
}

async function loadMaterialHelpers(root) {
  const file = path.join(root, MATERIAL_HELPERS_FILE);
  return import(`file:///${file.replaceAll("\\", "/")}`);
}

// =============================================================================
// Doubles
// =============================================================================

class FakeCanvas {
  constructor(label) {
    this.label = label;
    this.width = 256;
    this.height = 1;
  }
}

/**
 * Installs the DOM constructors the real material update function tests
 * `instanceof` against. Without them that branch throws a ReferenceError in
 * Node and the canvas would never be recognised.
 */
function installDomGlobals() {
  globalThis.HTMLCanvasElement = FakeCanvas;
  globalThis.HTMLImageElement ??= class HTMLImageElement {};
  globalThis.HTMLVideoElement ??= class HTMLVideoElement {};
  globalThis.ImageBitmap ??= class ImageBitmap {};
  globalThis.OffscreenCanvas ??= class OffscreenCanvas {};
}

function createDevice() {
  const record = { bindGroups: [], samplers: 0 };
  return {
    record,
    createSampler(descriptor) {
      record.samplers += 1;
      return { kind: "sampler", ...descriptor };
    },
    createBindGroup(descriptor) {
      const group = { kind: "bindGroup", entries: descriptor.entries };
      record.bindGroups.push(group);
      return group;
    },
    createBuffer(descriptor) {
      return { kind: "buffer", ...descriptor };
    },
    queue: { writeBuffer() {} },
  };
}

const PLACEHOLDER_VIEW = { kind: "view", source: "1x1-placeholder" };

function createContext(device) {
  const record = { createdFrom: [] };
  return {
    device,
    record,
    defaultTexture: { view: PLACEHOLDER_VIEW },
    uniformState: {},
    createTextureFromImage(source) {
      record.createdFrom.push(source);
      return {
        view: { kind: "view", source },
        destroy() {
          this.destroyed = true;
        },
      };
    },
  };
}

function primaryViewOf(bindGroup) {
  const entry = bindGroup.entries.find((candidate) => candidate.binding === 1);
  return entry?.resource;
}

/**
 * Runs the material through the real two-phase publication: the drain at the
 * head of `Material.update` and the per-uniform push at its tail.
 */
let materialDoubleCount = 0;

function createMaterialDouble(helpers, image, extraUniforms = {}) {
  const material = {
    type: undefined,
    shaderSource: "",
    wgslShaderSource: "",
    uniforms: {},
    _uniforms: {},
    materials: {},
    _strict: undefined,
    _template: undefined,
    _count: 0,
    _texturePaths: {},
    _textureTargetKeys: {},
    _loadedImages: [],
    _loadedCubeMaps: [],
    _textures: {},
    _imageSources: {},
    _updateFunctions: [],
    _defaultTexture: undefined,
    _initializationPromises: [],
    _translucentFunctions: [],
    _minificationFilter: 0,
    _magnificationFilter: 0,
    translucent: undefined,
  };
  helpers.initializeMaterial(
    {
      fabric: {
        // `initializeMaterial` registers each new type in a module-level
        // cache and serves later materials of that type a deep clone of the
        // first one, so every subject needs its own type.
        type: `LateAdoptionSubject${++materialDoubleCount}`,
        uniforms: { image, ...extraUniforms },
        source:
          "czm_material czm_getMaterial(czm_materialInput materialInput)\n" +
          "{\n" +
          "  czm_material material = czm_getDefaultMaterial(materialInput);\n" +
          "  material.diffuse = texture(image, materialInput.st).rgb;\n" +
          "  return material;\n" +
          "}\n",
      },
    },
    material,
    function MaterialConstructor() {},
  );
  return material;
}

const MATERIAL_UPDATE_CONTEXT = {
  defaultTexture: { _width: 1, _height: 1 },
  graphicsCapabilities: { ktx2TranscodeTargets: undefined },
};

// =============================================================================
// The scenario
// =============================================================================

/**
 * Reproduces the frame sequence a textured primitive material actually sees.
 *
 * Frame 1 is the primitive's first complete frame: `Material.update` runs, the
 * canvas is queued, and the command is then built against whatever the binding
 * helper can see — nothing. Frame 2 drains the canvas into `_imageSources` and
 * runs only the per-frame material updater, which is the code under test.
 */
async function runScenario(renderer, materialUpdate, helpers, options = {}) {
  const {
    depthFail = false,
    textureSlotIndex = 2,
    bindGroupCount = 4,
    extraFrames = 0,
    replacementImage = undefined,
  } = options;

  const device = createDevice();
  const context = createContext(device);
  const image = new FakeCanvas("ramp-a");
  const material = createMaterialDouble(helpers, image);

  // Frame 1 — the drain finds nothing and the tail queues the canvas.
  materialUpdate.call(material, MATERIAL_UPDATE_CONTEXT);
  const imageSourcesAtBuild = { ...material._imageSources };

  const keys = depthFail
    ? renderer.DF_MAT_TEX_KEYS
    : renderer.MAIN_MAT_TEX_KEYS;
  const otherKeys = depthFail
    ? renderer.MAIN_MAT_TEX_KEYS
    : renderer.DF_MAT_TEX_KEYS;
  const cache = {};
  cache[keys.layout] = { kind: "bindGroupLayout" };

  // The builder's own call: bind whatever is available at command creation.
  const ensure = depthFail
    ? renderer.ensureDepthFailMaterialTextureBindGroup
    : renderer.ensureMaterialTextureBindGroup;
  ensure(context, device, material, "matElevRampFlat", cache);
  const builtBindGroup = cache[keys.bindGroup];

  const bindGroups = new Array(bindGroupCount);
  for (let i = 0; i < bindGroupCount; i++) {
    bindGroups[i] = { kind: "bindGroup", entries: [], role: `slot-${i}` };
  }
  bindGroups[textureSlotIndex] = builtBindGroup;

  const command = {
    isWebGPUDrawCommand: true,
    bindGroups,
    _webgpuCameraBuffer: { kind: "buffer" },
    _webgpuShaderType: "matElevRampFlat",
    _webgpuMatCache: cache,
    _webgpuMaterial: material,
    _webgpuMatShaderType: "matElevRampFlat",
    _webgpuMatTextureSlot: textureSlotIndex,
  };
  if (depthFail) {
    command._webgpuMatTextureIsDepthFail = true;
  }

  const frameState = { context, camera: {}, passes: {} };
  const modelMatrix = {};

  // Frame 2 — the drain publishes the canvas; only the per-frame updater runs.
  materialUpdate.call(material, MATERIAL_UPDATE_CONTEXT);
  const imageSourcesAfterDrain = { ...material._imageSources };
  renderer.updateWebGPUMaterialCommandUniforms(
    command,
    frameState,
    modelMatrix,
  );

  const afterAdoption = {
    bindGroup: command.bindGroups[textureSlotIndex],
    bindGroupsBuilt: device.record.bindGroups.length,
    // Snapshot the cache before the optional replacement phase moves it on.
    primarySource: cache[keys.primarySource],
    otherBindGroup: cache[otherKeys.bindGroup],
  };

  for (let i = 0; i < extraFrames; i++) {
    materialUpdate.call(material, MATERIAL_UPDATE_CONTEXT);
    renderer.updateWebGPUMaterialCommandUniforms(
      command,
      frameState,
      modelMatrix,
    );
  }
  const afterExtraFrames = {
    bindGroup: command.bindGroups[textureSlotIndex],
    bindGroupsBuilt: device.record.bindGroups.length,
  };

  let afterReplacement;
  if (defined_(replacementImage)) {
    material.uniforms.image = replacementImage;
    materialUpdate.call(material, MATERIAL_UPDATE_CONTEXT);
    materialUpdate.call(material, MATERIAL_UPDATE_CONTEXT);
    renderer.updateWebGPUMaterialCommandUniforms(
      command,
      frameState,
      modelMatrix,
    );
    afterReplacement = {
      bindGroup: command.bindGroups[textureSlotIndex],
      bindGroupsBuilt: device.record.bindGroups.length,
    };
  }

  return {
    image,
    material,
    cache,
    keys,
    otherKeys,
    depthFail,
    command,
    context,
    device,
    builtBindGroup,
    imageSourcesAtBuild,
    imageSourcesAfterDrain,
    afterAdoption,
    afterExtraFrames,
    afterReplacement,
  };
}

function defined_(value) {
  return value !== undefined && value !== null;
}

/**
 * The contract every leg — pristine and mutant — is scored against. Returns
 * `null` when satisfied and the first violation otherwise, so a mutant that
 * throws and a mutant that quietly does nothing are both recorded as kills.
 */
function checkContract(result) {
  if (defined_(result.imageSourcesAtBuild.image)) {
    return "the premise collapsed: the image was already published when the command was built";
  }
  if (result.imageSourcesAfterDrain.image !== result.image) {
    return "the premise collapsed: the second drain did not publish the image";
  }
  const adopted = result.afterAdoption.bindGroup;
  if (adopted === result.builtBindGroup) {
    return "the texture slot still holds the bind group built before the image existed";
  }
  const view = primaryViewOf(adopted);
  if (!defined_(view)) {
    return "the adopted bind group declares no primary texture entry";
  }
  if (view === PLACEHOLDER_VIEW) {
    return "the adopted bind group still binds the 1x1 placeholder view";
  }
  if (view.source !== result.image) {
    return `the adopted bind group binds ${String(view.source)} rather than the material image`;
  }
  if (result.afterAdoption.primarySource !== result.image) {
    return "the refresh did not record the adopted source in its own cache fields";
  }
  if (defined_(result.afterAdoption.otherBindGroup)) {
    return "the refresh wrote the other appearance's cache fields";
  }
  return null;
}

// =============================================================================
// Legs
// =============================================================================

test("the material publishes its image one update after it is queued", async () => {
  installDomGlobals();
  const helpers = await loadMaterialHelpers(REPO_ROOT);
  const materialUpdate = (await loadMaterialUpdate(REPO_ROOT)).materialUpdate;
  const image = new FakeCanvas("ramp-a");
  const material = createMaterialDouble(helpers, image);

  assert.equal(
    material._imageSources.image,
    undefined,
    "nothing is published before the first update",
  );
  materialUpdate.call(material, MATERIAL_UPDATE_CONTEXT);
  assert.equal(
    material._loadedImages.length,
    1,
    "the first update queues the canvas at its tail, after the drain has run",
  );
  assert.equal(
    material._imageSources.image,
    undefined,
    "the first update queues the canvas at its tail, so it cannot also publish it",
  );

  materialUpdate.call(material, MATERIAL_UPDATE_CONTEXT);
  assert.equal(
    material._loadedImages.length,
    0,
    "the second drain empties the queue",
  );
  assert.equal(
    material._imageSources.image,
    image,
    "the second update drains the queued canvas into the WebGPU image sources",
  );
});

test("a command built before the image existed adopts it on the next frame", async () => {
  installDomGlobals();
  const renderer = await loadRenderer(REPO_ROOT);
  const helpers = await loadMaterialHelpers(REPO_ROOT);
  const materialUpdate = (await loadMaterialUpdate(REPO_ROOT)).materialUpdate;

  const result = await runScenario(renderer, materialUpdate, helpers);
  assert.equal(checkContract(result), null);

  assert.equal(
    primaryViewOf(result.builtBindGroup),
    PLACEHOLDER_VIEW,
    "the group the builder could produce binds the placeholder — that is the defect's starting state",
  );
  assert.equal(
    result.cache[result.keys.primarySource],
    result.image,
    "the cache records the adopted source so later frames early-return",
  );
});

test("the updater writes the slot the builder recorded, not a fixed index", async () => {
  installDomGlobals();
  const renderer = await loadRenderer(REPO_ROOT);
  const helpers = await loadMaterialHelpers(REPO_ROOT);
  const materialUpdate = (await loadMaterialUpdate(REPO_ROOT)).materialUpdate;

  for (const textureSlotIndex of [1, 2]) {
    const result = await runScenario(renderer, materialUpdate, helpers, {
      textureSlotIndex,
      bindGroupCount: 4,
    });
    assert.equal(
      checkContract(result),
      null,
      `texture slot ${textureSlotIndex} was not refreshed`,
    );
    for (let i = 0; i < 4; i++) {
      if (i === textureSlotIndex) {
        continue;
      }
      assert.equal(
        result.command.bindGroups[i].role,
        `slot-${i}`,
        `slot ${i} must not be disturbed when the texture lives at ${textureSlotIndex}`,
      );
    }
  }
});

test("the depth-fail twin moves its own cache fields and leaves the main slots alone", async () => {
  installDomGlobals();
  const renderer = await loadRenderer(REPO_ROOT);
  const helpers = await loadMaterialHelpers(REPO_ROOT);
  const materialUpdate = (await loadMaterialUpdate(REPO_ROOT)).materialUpdate;

  const result = await runScenario(renderer, materialUpdate, helpers, {
    depthFail: true,
  });
  assert.equal(checkContract(result), null);

  assert.equal(
    result.cache[renderer.DF_MAT_TEX_KEYS.primarySource],
    result.image,
    "the depth-fail source field records the adopted image",
  );
  assert.equal(
    result.cache[renderer.MAIN_MAT_TEX_KEYS.primarySource],
    undefined,
    "the main-appearance fields must not be written by the depth-fail refresh",
  );
  assert.equal(
    result.cache[renderer.MAIN_MAT_TEX_KEYS.bindGroup],
    undefined,
    "the main-appearance bind group must not be built by the depth-fail refresh",
  );
});

test("adoption happens once, and a replaced image is adopted again", async () => {
  installDomGlobals();
  const renderer = await loadRenderer(REPO_ROOT);
  const helpers = await loadMaterialHelpers(REPO_ROOT);
  const materialUpdate = (await loadMaterialUpdate(REPO_ROOT)).materialUpdate;

  const replacement = new FakeCanvas("ramp-b");
  const result = await runScenario(renderer, materialUpdate, helpers, {
    extraFrames: 5,
    replacementImage: replacement,
  });
  assert.equal(checkContract(result), null);

  assert.equal(
    result.afterExtraFrames.bindGroupsBuilt,
    result.afterAdoption.bindGroupsBuilt,
    "five further frames with an unchanged image must not rebuild the bind group",
  );
  assert.equal(
    result.afterExtraFrames.bindGroup,
    result.afterAdoption.bindGroup,
    "the command must keep the same bind group while the image is unchanged",
  );

  assert.equal(
    result.afterReplacement.bindGroupsBuilt,
    result.afterAdoption.bindGroupsBuilt + 1,
    "reassigning the image uniform must rebuild exactly once",
  );
  assert.equal(
    primaryViewOf(result.afterReplacement.bindGroup).source,
    replacement,
    "the command must carry the replacement image after the reassignment",
  );
});

// STRUCTURAL, and labelled as such. `createWebGPUMaterialCommands` cannot be
// executed without geometry, pipelines and a device, so the single link between
// the builder and the updater is read off the AST instead: both assembly sites
// must record the index they pushed the texture group at, taken from the array
// length at the push.
test("both builders record the index they pushed the texture group at", async () => {
  const source = read(REPO_ROOT, RENDERER_FILE);
  const sourceFile = ts.createSourceFile(
    "WebGPUPrimitiveCommands.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const sites = [];
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      /TextureSlot$/.test(node.left.text) &&
      ts.isPropertyAccessExpression(node.right) &&
      node.right.name.text === "length" &&
      ts.isIdentifier(node.right.expression)
    ) {
      sites.push({
        slotVariable: node.left.text,
        array: node.right.expression.text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  assert.deepEqual(
    sites.sort((a, b) => a.slotVariable.localeCompare(b.slotVariable)),
    [
      { slotVariable: "dfTextureSlot", array: "dfBGs" },
      { slotVariable: "matTextureSlot", array: "cmdBGs" },
    ],
    "the main and depth-fail assemblies must each record the slot from the live array length",
  );

  for (const { array } of sites) {
    const pushCount = (
      source.match(
        new RegExp(`${array}\\.push\\(cache\\.\\w*[Tt]extureBindGroup\\)`, "g"),
      ) ?? []
    ).length;
    assert.equal(
      pushCount,
      1,
      `${array} must push the texture bind group exactly once`,
    );
  }
});

// =============================================================================
// Mutation staging
// =============================================================================

function stageSources() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mat-tex-mutation-"));
  for (const relative of [RENDERER_FILE]) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relative), destination);
  }
  return root;
}

function rewrite(root, relative, pattern, replacement) {
  const file = path.join(root, relative);
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) {
    throw new Error(`mutation anchor not found in ${relative}`);
  }
  fs.writeFileSync(file, after);
}

const MUTATIONS = [
  {
    name: "ABSENCE — the per-frame refresh call is deleted",
    apply: (root) =>
      rewrite(
        root,
        RENDERER_FILE,
        /refreshMaterialCommandTextureSlot\(command, context, device\);/,
        "",
      ),
  },
  {
    name: "INERTNESS — the refresh is still called but unreachable",
    apply: (root) =>
      rewrite(
        root,
        RENDERER_FILE,
        /refreshMaterialCommandTextureSlot\(command, context, device\);/,
        "if (false) { refreshMaterialCommandTextureSlot(command, context, device); }",
      ),
  },
  {
    name: "INERTNESS — the refreshed group is computed but never stored",
    apply: (root) =>
      rewrite(
        root,
        RENDERER_FILE,
        /bindGroups\[slot\] = bindGroup;/,
        "void bindGroup;",
      ),
  },
  {
    name: "the recorded slot is ignored in favour of a fixed index",
    apply: (root) =>
      rewrite(
        root,
        RENDERER_FILE,
        /const slot = command\._webgpuMatTextureSlot;/,
        "const slot = 3;",
      ),
  },
  {
    name: "the depth-fail flag no longer selects the depth-fail key set",
    apply: (root) =>
      rewrite(
        root,
        RENDERER_FILE,
        /command\._webgpuMatTextureIsDepthFail === true\r?\n?\s*\? DF_MAT_TEX_KEYS\r?\n?\s*: MAIN_MAT_TEX_KEYS;/,
        "false ? DF_MAT_TEX_KEYS : MAIN_MAT_TEX_KEYS;",
      ),
  },
  {
    name: "the binding helper stops recording the adopted source",
    apply: (root) =>
      rewrite(
        root,
        RENDERER_FILE,
        /cache\[k\.primarySource\] = primarySource;/,
        "cache[k.primarySource] = undefined;",
      ),
  },
];

test("every mutation of the adoption path is caught", async () => {
  installDomGlobals();
  const helpers = await loadMaterialHelpers(REPO_ROOT);
  const materialUpdate = (await loadMaterialUpdate(REPO_ROOT)).materialUpdate;

  const pristine = await loadRenderer(REPO_ROOT);
  const scenarios = [
    { name: "main", options: {} },
    { name: "depth-fail", options: { depthFail: true } },
    { name: "slot 1", options: { textureSlotIndex: 1 } },
    {
      name: "no churn",
      options: { extraFrames: 5, replacementImage: new FakeCanvas("ramp-b") },
    },
  ];

  for (const scenario of scenarios) {
    const result = await runScenario(
      pristine,
      materialUpdate,
      helpers,
      scenario.options,
    );
    assert.equal(
      checkContract(result),
      null,
      `the pristine source must satisfy the ${scenario.name} scenario`,
    );
  }

  const survivors = [];
  for (const mutation of MUTATIONS) {
    const root = stageSources();
    let killed = false;
    let detail;
    try {
      mutation.apply(root);
      const mutant = await loadRenderer(root);
      const failures = [];
      for (const scenario of scenarios) {
        try {
          const result = await runScenario(
            mutant,
            materialUpdate,
            helpers,
            scenario.options,
          );
          const violation = checkContract(result);
          if (violation !== null) {
            failures.push(`${scenario.name}: ${violation}`);
          } else if (
            scenario.name === "no churn" &&
            result.afterExtraFrames.bindGroupsBuilt !==
              result.afterAdoption.bindGroupsBuilt
          ) {
            failures.push(
              `${scenario.name}: the bind group churned every frame`,
            );
          }
        } catch (error) {
          failures.push(`${scenario.name}: threw ${error.message}`);
        }
      }
      if (failures.length > 0) {
        killed = true;
        detail = failures[0];
      } else {
        detail = "every scenario still passed";
      }
    } catch (error) {
      killed = true;
      detail = `loading the mutant failed: ${error.message}`;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(
      `${killed ? "KILLED  " : "SURVIVED"}  ${mutation.name}  --  ${detail}`,
    );
    if (!killed) {
      survivors.push(mutation.name);
    }
  }

  assert.deepEqual(
    survivors,
    [],
    "a surviving mutant means this gate is not load-bearing",
  );
});
