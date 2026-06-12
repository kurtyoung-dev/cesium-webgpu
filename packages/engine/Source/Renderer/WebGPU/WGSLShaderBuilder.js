/**
 * Programmatic WGSL shader construction — the WebGPU equivalent of
 * ShaderBuilder.js for GLSL. Used by the Model/glTF pipeline and
 * other systems that need to dynamically compose shader code.
 *
 * Key differences from GLSL ShaderBuilder:
 * - Vertex inputs use structs with @location(N) instead of `in` declarations
 * - Inter-stage data (varyings) use structs with @location(N)
 * - Uniforms use @group(G) @binding(B) var<uniform> with explicit bind groups
 * - Entry points are @vertex fn vertexMain() / @fragment fn fragmentMain()
 * - Constants use `const` instead of `#define` (preprocessor still handles #ifdef)
 * - Textures and samplers are separate bindings
 *
 * @alias WGSLShaderBuilder
 * @constructor
 * @private
 *
 * @example
 * const builder = new WGSLShaderBuilder();
 * builder.addDefine("ENABLE_LIGHTING");
 * builder.addVertexInput("vec3<f32>", "position", 0);
 * builder.addVertexInput("vec3<f32>", "normal", 1);
 * builder.addVertexOutput("vec4<f32>", "position", undefined, "@builtin(position)");
 * builder.addVertexOutput("vec3<f32>", "normalEC", 0);
 * builder.addUniformBlock("SceneUniforms", 0, 0, [
 *   { type: "mat4x4<f32>", name: "modelViewProjection" },
 *   { type: "mat3x3<f32>", name: "normalMatrix" },
 * ]);
 * builder.addVertexMainLines([
 *   "let worldPos = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);",
 *   "output.position = worldPos;",
 *   "output.normalEC = uniforms.normalMatrix * input.normal;",
 * ]);
 * builder.addFragmentMainLines([
 *   "let color = vec4<f32>(input.normalEC * 0.5 + 0.5, 1.0);",
 *   "return color;",
 * ]);
 * const wgslSource = builder.build();
 * @module WGSLShaderBuilder
 */
import defined from "../../Core/defined.js";

// =========================================================================
// WGSLStruct — dynamic struct generation for WGSL
// =========================================================================

/**
 * @private
 */
function WGSLStruct(name) {
  this.name = name;
  this.fields = [];
}

WGSLStruct.prototype.addField = function (type, identifier, annotation) {
  this.fields.push({
    type: type,
    identifier: identifier,
    annotation: annotation || "",
  });
};

WGSLStruct.prototype.generateLines = function () {
  const lines = [`struct ${this.name} {`];
  for (let i = 0; i < this.fields.length; i++) {
    const f = this.fields[i];
    const annotation = f.annotation ? `${f.annotation} ` : "";
    const comma = i < this.fields.length - 1 ? "," : ",";
    lines.push(`  ${annotation}${f.identifier}: ${f.type}${comma}`);
  }
  lines.push("};");
  return lines;
};

// =========================================================================
// WGSLFunction — dynamic function generation for WGSL
// =========================================================================

/**
 * @private
 */
function WGSLFunction(signature) {
  this.signature = signature;
  this.body = [];
}

WGSLFunction.prototype.addLines = function (lines) {
  if (Array.isArray(lines)) {
    for (let i = 0; i < lines.length; i++) {
      this.body.push(lines[i]);
    }
  } else {
    this.body.push(lines);
  }
};

WGSLFunction.prototype.generateLines = function () {
  const lines = [`fn ${this.signature} {`];
  for (let i = 0; i < this.body.length; i++) {
    lines.push(`  ${this.body[i]}`);
  }
  lines.push("}");
  return lines;
};

// =========================================================================
// WGSLShaderBuilder
// =========================================================================

function WGSLShaderBuilder() {
  // Preprocessor defines (handled by WGSLShaderPreprocessor)
  this._defines = [];

  // Constants (const declarations)
  this._constants = [];

  // Vertex input struct fields: { location, type, name }
  this._vertexInputs = [];
  this._nextVertexLocation = 0;

  // Vertex output / fragment input struct fields: { location, type, name, builtin }
  this._vertexOutputs = [];
  this._nextVaryingLocation = 0;

  // Fragment output: { location, type, name, builtin }
  this._fragmentOutputs = [];

  // Bind group resources: uniforms, textures, samplers, storage
  // Each entry: { group, binding, declaration }
  this._bindings = [];
  this._nextBinding = {}; // { group -> nextBinding }

  // Uniform structs (for @group @binding var<uniform>)
  this._uniformStructs = {};

  // Custom structs (not vertex/fragment IO)
  this._structs = {};

  // Custom functions
  this._functions = {};

  // Shader code sections
  this._headerLines = []; // imports, etc.
  this._vertexMainLines = [];
  this._fragmentMainLines = [];
  this._helperLines = []; // code outside of main functions

  // Attribute location tracking for VertexArray compatibility
  this._attributeLocations = {};
}

Object.defineProperties(WGSLShaderBuilder.prototype, {
  /**
   * Dictionary of attribute names to integer locations.
   * @memberof WGSLShaderBuilder.prototype
   * @type {Object<string, number>}
   * @readonly
   * @private
   */
  attributeLocations: {
    get: function () {
      return this._attributeLocations;
    },
  },
});

// =========================================================================
// Preprocessor Defines
// =========================================================================

/**
 * Add a preprocessor define. These are handled by WGSLShaderPreprocessor.
 *
 * @param {string} identifier The define identifier
 * @param {*} [value] Optional value
 */
WGSLShaderBuilder.prototype.addDefine = function (identifier, value) {
  if (defined(value)) {
    this._defines.push(`${identifier} ${value}`);
  } else {
    this._defines.push(identifier);
  }
};

// =========================================================================
// Constants
// =========================================================================

/**
 * Add a WGSL const declaration.
 *
 * @param {string} type The WGSL type
 * @param {string} name The constant name
 * @param {string} value The constant value expression
 */
WGSLShaderBuilder.prototype.addConstant = function (type, name, value) {
  this._constants.push(`const ${name}: ${type} = ${value};`);
};

// =========================================================================
// Vertex Input (Attributes)
// =========================================================================

/**
 * Add a vertex input attribute.
 *
 * @param {string} type WGSL type (e.g. "vec3<f32>")
 * @param {string} name Attribute name (e.g. "position")
 * @param {number} [location] Explicit location. Auto-assigned if omitted.
 * @returns {number} The location assigned
 */
WGSLShaderBuilder.prototype.addVertexInput = function (type, name, location) {
  if (!defined(location)) {
    location = this._nextVertexLocation;
  }
  this._vertexInputs.push({
    location: location,
    type: type,
    name: name,
  });
  this._attributeLocations[name] = location;
  this._nextVertexLocation = Math.max(
    this._nextVertexLocation,
    location + getLocationCount(type),
  );
  return location;
};

/**
 * Set the position attribute (always location 0 for WebGPU compatibility).
 * @param {string} type WGSL type
 * @param {string} name Attribute name
 * @returns {number} Always 0
 */
WGSLShaderBuilder.prototype.setPositionAttribute = function (type, name) {
  this._vertexInputs.unshift({
    location: 0,
    type: type,
    name: name,
  });
  this._attributeLocations[name] = 0;
  if (this._nextVertexLocation === 0) {
    this._nextVertexLocation = getLocationCount(type);
  }
  return 0;
};

// =========================================================================
// Vertex Output / Fragment Input (Varyings)
// =========================================================================

/**
 * Add a vertex output (inter-stage variable / varying).
 *
 * @param {string} type WGSL type
 * @param {string} name Field name
 * @param {number} [location] Explicit @location. Auto-assigned if omitted.
 * @param {string} [builtin] Optional @builtin annotation (e.g. "@builtin(position)")
 * @returns {number|undefined} The location (undefined for builtins)
 */
WGSLShaderBuilder.prototype.addVertexOutput = function (
  type,
  name,
  location,
  builtin,
) {
  if (defined(builtin)) {
    this._vertexOutputs.push({ type, name, builtin });
    return undefined;
  }
  if (!defined(location)) {
    location = this._nextVaryingLocation++;
  } else {
    this._nextVaryingLocation = Math.max(
      this._nextVaryingLocation,
      location + 1,
    );
  }
  this._vertexOutputs.push({ type, name, location });
  return location;
};

/**
 * Add a fragment output.
 *
 * @param {string} type WGSL type (e.g. "vec4<f32>")
 * @param {string} name Field name
 * @param {number} [location=0] @location for MRT
 */
WGSLShaderBuilder.prototype.addFragmentOutput = function (
  type,
  name,
  location,
) {
  location = location ?? 0;
  this._fragmentOutputs.push({ type, name, location });
};

// =========================================================================
// Bind Group Resources (Uniforms, Textures, Samplers)
// =========================================================================

/**
 * Add a uniform buffer binding.
 *
 * @param {string} structName Name of the uniform struct
 * @param {string} varName Variable name for the binding
 * @param {number} group Bind group index
 * @param {number} binding Binding index within the group
 * @param {Array<{type: string, name: string}>} fields Struct fields
 */
WGSLShaderBuilder.prototype.addUniformBlock = function (
  structName,
  varName,
  group,
  binding,
  fields,
) {
  // Create the struct
  const s = new WGSLStruct(structName);
  for (let i = 0; i < fields.length; i++) {
    s.addField(fields[i].type, fields[i].name);
  }
  this._uniformStructs[structName] = s;

  this._bindings.push({
    group: group,
    binding: binding,
    declaration: `@group(${group}) @binding(${binding}) var<uniform> ${varName}: ${structName};`,
  });
};

/**
 * Add a texture binding.
 *
 * @param {string} varName Variable name
 * @param {number} group Bind group
 * @param {number} binding Binding index
 * @param {string} [textureType="texture_2d<f32>"] WGSL texture type
 */
WGSLShaderBuilder.prototype.addTexture = function (
  varName,
  group,
  binding,
  textureType,
) {
  textureType = textureType || "texture_2d<f32>";
  this._bindings.push({
    group: group,
    binding: binding,
    declaration: `@group(${group}) @binding(${binding}) var ${varName}: ${textureType};`,
  });
};

/**
 * Add a sampler binding.
 *
 * @param {string} varName Variable name
 * @param {number} group Bind group
 * @param {number} binding Binding index
 */
WGSLShaderBuilder.prototype.addSampler = function (varName, group, binding) {
  this._bindings.push({
    group: group,
    binding: binding,
    declaration: `@group(${group}) @binding(${binding}) var ${varName}: sampler;`,
  });
};

/**
 * Add a storage buffer binding.
 *
 * @param {string} varName Variable name
 * @param {string} storageType WGSL type (e.g. "array<vec4<f32>>")
 * @param {number} group Bind group
 * @param {number} binding Binding index
 * @param {string} [access="read"] Access mode: "read", "read_write"
 */
WGSLShaderBuilder.prototype.addStorageBuffer = function (
  varName,
  storageType,
  group,
  binding,
  access,
) {
  access = access || "read";
  this._bindings.push({
    group: group,
    binding: binding,
    declaration: `@group(${group}) @binding(${binding}) var<storage, ${access}> ${varName}: ${storageType};`,
  });
};

// =========================================================================
// Custom Structs and Functions
// =========================================================================

/**
 * Add a custom struct.
 *
 * @param {string} structId Unique ID
 * @param {string} structName WGSL struct name
 */
WGSLShaderBuilder.prototype.addStruct = function (structId, structName) {
  this._structs[structId] = new WGSLStruct(structName);
};

/**
 * Add a field to a custom struct.
 *
 * @param {string} structId The struct ID
 * @param {string} type WGSL type
 * @param {string} identifier Field name
 * @param {string} [annotation] Optional annotation (e.g. "@location(0)")
 */
WGSLShaderBuilder.prototype.addStructField = function (
  structId,
  type,
  identifier,
  annotation,
) {
  this._structs[structId].addField(type, identifier, annotation);
};

/**
 * Add a helper function.
 *
 * @param {string} functionName Unique name
 * @param {string} signature Full signature (e.g. "myFunc(a: f32) -> f32")
 */
WGSLShaderBuilder.prototype.addFunction = function (functionName, signature) {
  this._functions[functionName] = new WGSLFunction(signature);
};

/**
 * Add lines to a function body.
 *
 * @param {string} functionName Function name
 * @param {string|string[]} lines Code lines
 */
WGSLShaderBuilder.prototype.addFunctionLines = function (functionName, lines) {
  this._functions[functionName].addLines(lines);
};

// =========================================================================
// Shader Code Lines
// =========================================================================

/**
 * Add header lines (imports, comments).
 * @param {string|string[]} lines
 */
WGSLShaderBuilder.prototype.addHeaderLines = function (lines) {
  addLines(this._headerLines, lines);
};

/**
 * Add lines to the vertex main function body.
 * @param {string|string[]} lines
 */
WGSLShaderBuilder.prototype.addVertexMainLines = function (lines) {
  addLines(this._vertexMainLines, lines);
};

/**
 * Add lines to the fragment main function body.
 * @param {string|string[]} lines
 */
WGSLShaderBuilder.prototype.addFragmentMainLines = function (lines) {
  addLines(this._fragmentMainLines, lines);
};

/**
 * Add helper code (outside main functions).
 * @param {string|string[]} lines
 */
WGSLShaderBuilder.prototype.addHelperLines = function (lines) {
  addLines(this._helperLines, lines);
};

// =========================================================================
// Build
// =========================================================================

/**
 * Build the complete WGSL shader source.
 *
 * @returns {{
 *   source: string,
 *   defines: string[],
 *   attributeLocations: Object<string, number>
 * }}
 */
WGSLShaderBuilder.prototype.build = function () {
  const lines = [];

  // Header / imports
  if (this._headerLines.length > 0) {
    addLines(lines, this._headerLines);
    lines.push("");
  }

  // Constants
  if (this._constants.length > 0) {
    addLines(lines, this._constants);
    lines.push("");
  }

  // Uniform structs
  const uniformStructNames = Object.keys(this._uniformStructs);
  for (let i = 0; i < uniformStructNames.length; i++) {
    const s = this._uniformStructs[uniformStructNames[i]];
    addLines(lines, s.generateLines());
    lines.push("");
  }

  // Custom structs
  const structIds = Object.keys(this._structs);
  for (let i = 0; i < structIds.length; i++) {
    addLines(lines, this._structs[structIds[i]].generateLines());
    lines.push("");
  }

  // Vertex Input struct
  if (this._vertexInputs.length > 0) {
    lines.push("struct VertexInput {");
    for (let i = 0; i < this._vertexInputs.length; i++) {
      const vi = this._vertexInputs[i];
      const comma = i < this._vertexInputs.length - 1 ? "," : ",";
      lines.push(`  @location(${vi.location}) ${vi.name}: ${vi.type}${comma}`);
    }
    lines.push("};");
    lines.push("");
  }

  // Vertex Output struct (also Fragment Input)
  if (this._vertexOutputs.length > 0) {
    lines.push("struct VertexOutput {");
    for (let i = 0; i < this._vertexOutputs.length; i++) {
      const vo = this._vertexOutputs[i];
      const comma = i < this._vertexOutputs.length - 1 ? "," : ",";
      if (defined(vo.builtin)) {
        lines.push(`  ${vo.builtin} ${vo.name}: ${vo.type}${comma}`);
      } else {
        lines.push(
          `  @location(${vo.location}) ${vo.name}: ${vo.type}${comma}`,
        );
      }
    }
    lines.push("};");
    lines.push("");
  }

  // Fragment Output struct
  const fragOutputs = this._fragmentOutputs;
  if (fragOutputs.length > 0 && fragOutputs.length > 1) {
    // MRT: generate struct
    lines.push("struct FragmentOutput {");
    for (let i = 0; i < fragOutputs.length; i++) {
      const fo = fragOutputs[i];
      const comma = i < fragOutputs.length - 1 ? "," : ",";
      lines.push(`  @location(${fo.location}) ${fo.name}: ${fo.type}${comma}`);
    }
    lines.push("};");
    lines.push("");
  }

  // Bindings (uniforms, textures, samplers, storage)
  // Sort by group then binding for readability
  const sortedBindings = this._bindings.slice().sort((a, b) => {
    if (a.group !== b.group) {
      return a.group - b.group;
    }
    return a.binding - b.binding;
  });
  for (let i = 0; i < sortedBindings.length; i++) {
    lines.push(sortedBindings[i].declaration);
  }
  if (sortedBindings.length > 0) {
    lines.push("");
  }

  // Helper functions
  const functionNames = Object.keys(this._functions);
  for (let i = 0; i < functionNames.length; i++) {
    addLines(lines, this._functions[functionNames[i]].generateLines());
    lines.push("");
  }

  // Helper code
  if (this._helperLines.length > 0) {
    addLines(lines, this._helperLines);
    lines.push("");
  }

  // Vertex main
  if (this._vertexMainLines.length > 0) {
    const hasOutput = this._vertexOutputs.length > 0;
    const returnType = hasOutput ? " -> VertexOutput" : "";
    const inputParam =
      this._vertexInputs.length > 0 ? "input: VertexInput" : "";

    lines.push(`@vertex fn vertexMain(${inputParam})${returnType} {`);
    if (hasOutput) {
      lines.push("  var output: VertexOutput;");
    }
    for (let i = 0; i < this._vertexMainLines.length; i++) {
      lines.push(`  ${this._vertexMainLines[i]}`);
    }
    if (hasOutput) {
      lines.push("  return output;");
    }
    lines.push("}");
    lines.push("");
  }

  // Fragment main
  if (this._fragmentMainLines.length > 0) {
    const hasInput = this._vertexOutputs.length > 0;
    const inputParam = hasInput ? "input: VertexOutput" : "";
    let returnType;
    if (fragOutputs.length > 1) {
      returnType = " -> FragmentOutput";
    } else if (fragOutputs.length === 1) {
      returnType = ` -> @location(${fragOutputs[0].location}) ${fragOutputs[0].type}`;
    } else {
      returnType = " -> @location(0) vec4<f32>";
    }

    lines.push(`@fragment fn fragmentMain(${inputParam})${returnType} {`);
    for (let i = 0; i < this._fragmentMainLines.length; i++) {
      lines.push(`  ${this._fragmentMainLines[i]}`);
    }
    lines.push("}");
  }

  return {
    source: lines.join("\n"),
    defines: this._defines.slice(),
    attributeLocations: Object.assign({}, this._attributeLocations),
  };
};

/**
 * Clone this builder.
 * @returns {WGSLShaderBuilder}
 */
WGSLShaderBuilder.prototype.clone = function () {
  const clone = new WGSLShaderBuilder();
  clone._defines = this._defines.slice();
  clone._constants = this._constants.slice();
  clone._vertexInputs = this._vertexInputs.slice();
  clone._nextVertexLocation = this._nextVertexLocation;
  clone._vertexOutputs = this._vertexOutputs.slice();
  clone._nextVaryingLocation = this._nextVaryingLocation;
  clone._fragmentOutputs = this._fragmentOutputs.slice();
  clone._bindings = this._bindings.slice();
  clone._headerLines = this._headerLines.slice();
  clone._vertexMainLines = this._vertexMainLines.slice();
  clone._fragmentMainLines = this._fragmentMainLines.slice();
  clone._helperLines = this._helperLines.slice();
  clone._attributeLocations = Object.assign({}, this._attributeLocations);
  // Deep clone structs/functions would need more work - OK for now
  return clone;
};

// =========================================================================
// Helpers
// =========================================================================

function addLines(target, lines) {
  if (Array.isArray(lines)) {
    for (let i = 0; i < lines.length; i++) {
      target.push(lines[i]);
    }
  } else {
    target.push(lines);
  }
}

function getLocationCount(wgslType) {
  if (wgslType.includes("mat4x4")) {
    return 4;
  }
  if (wgslType.includes("mat3x3")) {
    return 3;
  }
  if (wgslType.includes("mat2x2")) {
    return 2;
  }
  return 1;
}

export default WGSLShaderBuilder;
export { WGSLStruct, WGSLFunction };
