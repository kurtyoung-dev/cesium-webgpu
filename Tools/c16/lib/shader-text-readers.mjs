// shader-text-readers.mjs — engine code that reads shader source text, and how a comment edit reaches it.
// @purpose Harvests every string or regex literal the renderer and scene code match against text, classifies how each one uses shader source, and describes each match by where it falls (code or comment), so the comment-only gate can refuse a comment edit that one of those readers would see.
// @status ACTIVE
//
// WHY THIS EXISTS. Scene and renderer code reads shader SOURCE TEXT, not a
// parsed program, and most of those reads do not skip comments:
// `BatchTable` splices its GLSL in before the first "void main" it finds,
// `DerivedCommand` switches every pick shader to `out_FragData_0` when the
// text "out_FragData" occurs anywhere, the IBL pipeline swaps the first
// "texture_storage_2d_array<…>" it finds, and the buffer-primitive renderer
// expands the first `#import` line it finds. Prose that spells one of those
// out changes what compiles, in every build flavour that ships the comment.
//
// THE HARVEST. Every regex literal with a literal word, and every string
// literal passed as the first argument of a string search or replace method
// (a comment between the call and the literal is skipped), under `Renderer/`
// and `Scene/`, is a candidate reader. So is a `const` bound to one string
// literal and passed by name to such a method in the same file. The harvest
// runs on each call, so a new reader is checked without being listed here,
// and it works from the literal's meaning rather than its spelling: `[/][/]`
// and `\/\/` are harvested alike, and a `const` needle has the key its
// literal would have.
//
// WHAT THE HARVEST CANNOT SEE, AND HOW IT FAILS CLOSED. A regex built at
// runtime, a needle held in an array or passed to a helper, and a scan that
// walks the text around a match are not literals. Each `RegExp(...)` call
// under the reader roots is harvested as a SITE and must be classified in
// `RUNTIME_REGEX_TABLE`: modelled by a reader in `UNHARVESTED_READERS` (a
// hand-written widening of it, such as `struct\s+\w+\b` for a struct lookup
// built from a name), benign, or reading something other than shader text.
// While any site is unclassified, or any pin of a hand-written reader is
// missing from its source, every shader comment edit is refused, because the
// model no longer covers the code. Readers the site census cannot see either
// (an identifier needle that is not a same-file `const`, `.call(src, …)`,
// readers outside the roots) are listed as known limits in
// `Documentation/Contributors/CodingGuide/ForkCommentStandard.md`.
//
// THE CLASSIFICATION. `READER_USES` records how each harvested reader that
// matches tracked shader text uses it. A reader missing from the table is
// treated as `decides`, the strictest use, so an unclassified reader fails
// closed. The corpus spec pins the table to the harvest exactly, so a reader
// that is added, moved or respelled has to be classified before it lands.
//
//   - `decides`: the reader's result depends on every match, including one
//     inside a comment (a test, a search, a count, a first-match replace, or a
//     replace whose replacement starts a new line).
//   - `rewrites`: a global replace whose replacement stays on one line and
//     opens no comment, so a match that lies wholly inside one comment only
//     rewrites that comment's text. Matches that touch code still count.
//   - `exempt`: the literal is matched against something other than shader
//     source (a format name, a URL, a list of names). Each one says what.
//
// A reader may also name the view it reads: `glsl-strip` for text that has
// been through `ShaderSource`'s `removeComments`, and
// `wgsl-preprocessor-strip` for text that has been through
// `WGSLShaderPreprocessor.removeComments`.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tokenize } from "./comment-scanner.mjs";
import { inOitReach, oitReachGaps } from "./oit-reach.mjs";

/** The engine source tree the harvest paths are relative to. */
const SOURCE_ROOT = fileURLToPath(
  new URL("../../../packages/engine/Source/", import.meta.url),
);

/** The directories whose code reads shader source text. */
export const READER_ROOTS = Object.freeze(["Renderer", "Scene"]);

/** A string literal right after one of these calls is a search needle. */
const SEARCH_CALL =
  /\.(indexOf|lastIndexOf|includes|replace|replaceAll|search|startsWith|endsWith|split|match|matchAll)\(\s*$/;

/** Methods that turn a string argument into a regular expression. */
const REGEX_METHODS = new Set(["match", "matchAll", "search"]);

/** A search or replace call whose first argument is a bare identifier. */
const IDENTIFIER_CALL =
  /\.(indexOf|lastIndexOf|includes|replace|replaceAll|search|startsWith|endsWith|split|match|matchAll)\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;

/** Code that binds the string literal after it to a `const`. */
const CONST_DECLARATION =
  /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*$/;

/** Code after a string literal that ends its declaration there. */
const CONST_END = /^[ \t]*(?:[;,)\]]|\n(?![ \t]*[-+.?:|&*/%]))/;

/** A call that builds a regular expression at runtime. */
const REGEX_CONSTRUCTION = /(?<![\w$.])(?:new\s+)?RegExp\s*\(/g;

/**
 * How each harvested reader that matches tracked shader text uses it. Keys are
 * the harvest's `file|literal` keys; see the header for the three uses.
 */
const READER_TABLE = [
  [
    "Renderer/ShaderProgram.js",
    "gl_",
    "exempt",
    "a uniform name reported by the driver",
  ],
  [
    "Renderer/ShaderProgram.js",
    "[0]",
    "exempt",
    "a uniform name reported by the driver",
  ],
  ["Renderer/ShaderProgram.js", /uniform.*?(?![^{]*})(?=[=\[;])/g, "decides"],
  ["Renderer/ShaderSource.js", /\bczm_[a-zA-Z0-9_]*/g, "decides", "glsl-strip"],
  [
    "Renderer/ShaderSource.js",
    /layout\s*\(location\s*=\s*0\)\s*out\s+vec4\s+out_FragColor;/g,
    "decides",
    "glsl-strip",
  ],
  ["Renderer/ShaderSource.js", /out_FragColor/g, "decides", "glsl-strip"],
  [
    "Renderer/ShaderSource.js",
    /precision\s(lowp|mediump|highp)\s(float|int);/,
    "decides",
    "glsl-strip",
  ],
  [
    "Renderer/ShaderSource.js",
    /void\s+main\s*\(\s*(?:void)?\s*\)/g,
    "rewrites",
  ],
  [
    "Renderer/WebGPU/Stubs/WebGLStubShader.ts",
    "glsl",
    "exempt",
    "a translator's supported-language list",
  ],
  [
    "Renderer/WebGPU/Stubs/WebGLStubShader.ts",
    /\bczm_[a-zA-Z0-9_]+/,
    "exempt",
    "a translator error message",
  ],
  [
    "Renderer/WebGPU/WGSLShaderBuilder.js",
    "mat2x2",
    "exempt",
    "a WGSL type name",
  ],
  [
    "Renderer/WebGPU/WGSLShaderBuilder.js",
    "mat3x3",
    "exempt",
    "a WGSL type name",
  ],
  [
    "Renderer/WebGPU/WGSLShaderBuilder.js",
    "mat4x4",
    "exempt",
    "a WGSL type name",
  ],
  [
    "Renderer/WebGPU/WGSLShaderPreprocessor.ts",
    /(?:\/\/\s*)?#import\s+["']([^"']+)["']/g,
    "decides",
  ],
  [
    "Renderer/WebGPU/WGSLShaderPreprocessor.ts",
    /(?:\/\/\s*)?#import\s+["'][^"']+["']\s*;?\s*\n?/g,
    "decides",
  ],
  [
    "Renderer/WebGPU/WGSLShaderPreprocessor.ts",
    /\b(Csm[a-zA-Z0-9_]+|[A-Z][a-zA-Z0-9_]*Uniforms|PBRMaterial|LightingUniforms)\b/g,
    "decides",
    "wgsl-preprocessor-strip",
  ],
  [
    "Renderer/WebGPU/WGSLShaderPreprocessor.ts",
    /\b(csm_[a-zA-Z0-9_]+)\b/g,
    "decides",
    "wgsl-preprocessor-strip",
  ],
  [
    "Renderer/WebGPU/WGSLShaderPreprocessor.ts",
    /\bcsm_[a-zA-Z0-9_]*/g,
    "decides",
    "wgsl-preprocessor-strip",
  ],
  [
    "Renderer/WebGPU/WGSLShaderPreprocessor.ts",
    /\bstruct\s+(Csm[a-zA-Z0-9_]+|[A-Z][a-zA-Z0-9_]*Uniforms|PBRMaterial|LightingUniforms)\b/g,
    "decides",
    "wgsl-preprocessor-strip",
  ],
  [
    "Renderer/WebGPU/WGSLShaderPreprocessor.ts",
    /^(?:\/\/\s*)?#(ifdef|ifndef|else|endif|define)\s*(.*)?$/,
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUAutoUniforms.js",
    "csm_",
    "exempt",
    "an auto-uniform entry name",
  ],
  [
    "Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts",
    /^[ \t]*#import\s+([A-Za-z_]\w*)\s*;?[ \t]*\r?\n?/gm,
    "decides",
  ],
  ["Renderer/WebGPU/WebGPUClusteredLightingBGL.ts", "__CL_GROUP__", "rewrites"],
  ["Renderer/WebGPU/WebGPUContext.ts", "@fragment", "decides"],
  ["Renderer/WebGPU/WebGPUContext.ts", "@vertex", "decides"],
  [
    "Renderer/WebGPU/WebGPUContext.ts",
    "eac",
    "exempt",
    "a texture format name",
  ],
  [
    "Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
    "texture_storage_2d_array<rgba16float, write>",
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
    "texture_storage_2d_array<rgba8unorm, write>",
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUGPUCuller.ts",
    /\/\/ __SUBGROUP_BLOCK_START__[\s\S]*?\/\/ __SUBGROUP_BLOCK_END__/,
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUGlobeMaterial.ts",
    "http",
    "exempt",
    "a material uniform value",
  ],
  [
    "Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
    "@location(4) v_distance: f32,\n",
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
    /(\(\s*input:\s*)VertexOutput\b/g,
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
    /struct VertexOutput \{[\s\S]*?\n\};/,
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
    "struct VertexOutput {",
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
    "if (globeClipByPlanes(input.v_positionEC)) { discard; }",
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
    "out.position.z = min(out.position.z, out.position.w);\n\n  return out;",
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUIBLPipeline.ts",
    "texture_storage_2d_array<rgba16float, write>",
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPULibraryPostProcessStage.ts",
    "color",
    "exempt",
    "a post-process stage's binding-name list",
  ],
  [
    "Renderer/WebGPU/WebGPULibraryPostProcessStage.ts",
    "depth",
    "exempt",
    "a post-process stage's binding-name list",
  ],
  [
    "Renderer/WebGPU/WebGPULibraryPostProcessStage.ts",
    "edge",
    "exempt",
    "a post-process stage's binding-name list",
  ],
  [
    "Renderer/WebGPU/WebGPULibraryPostProcessStage.ts",
    "sampler",
    "exempt",
    "a post-process stage's binding-name list",
  ],
  [
    "Renderer/WebGPU/WebGPUModelRenderer.ts",
    "_FEATURE_ID_",
    "exempt",
    "a vertex attribute name",
  ],
  [
    "Renderer/WebGPU/WebGPUModelRenderer.ts",
    "stencil",
    "exempt",
    "a depth texture format name",
  ],
  ["Renderer/WebGPU/WebGPUOIT.ts", /@builtin\([^)]*\)\s*/g, "rewrites"],
  [
    "Renderer/WebGPU/WebGPUOIT.ts",
    /@builtin\(position\)\s+([A-Za-z_]\w*)\s*:/,
    "decides",
  ],
  ["Renderer/WebGPU/WebGPUOIT.ts", /@location\(0\)\s*/, "decides"],
  [
    "Renderer/WebGPU/WebGPUOIT.ts",
    /@location\(0\)\s+([A-Za-z_]\w*)\s*:/,
    "decides",
  ],
  ["Renderer/WebGPU/WebGPUOIT.ts", /@location\([^)]*\)\s*/g, "rewrites"],
  [
    "Renderer/WebGPU/WebGPUPerformanceManager.ts",
    /\/\/ __SUBGROUP_BLOCK_START__[\s\S]*?\/\/ __SUBGROUP_BLOCK_END__/,
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUPointCloudLODProcessor.ts",
    /\/\/ __SUBGROUP_BLOCK_START__[\s\S]*?\/\/ __SUBGROUP_BLOCK_END__/,
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUPrimitiveCommands.ts",
    "BumpMap",
    "exempt",
    "a primitive shader-type name",
  ],
  [
    "Renderer/WebGPU/WebGPUPrimitiveCommands.ts",
    "ElevBand",
    "exempt",
    "a primitive shader-type name",
  ],
  [
    "Renderer/WebGPU/WebGPUPrimitiveCommands.ts",
    "NormalMap",
    "exempt",
    "a primitive shader-type name",
  ],
  [
    "Renderer/WebGPU/WebGPUPrimitiveCommands.ts",
    "Water",
    "exempt",
    "a primitive shader-type name",
  ],
  [
    "Renderer/WebGPU/WebGPUPrimitiveCommands.ts",
    "evalClusteredLights(",
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUPrimitiveCommands.ts",
    "line",
    "exempt",
    "a primitive topology name",
  ],
  [
    "Renderer/WebGPU/WebGPUPrimitiveShaders.js",
    "Lit",
    "exempt",
    "a primitive shader-type name",
  ],
  [
    "Renderer/WebGPU/WebGPUPrimitiveShaders.js",
    "mat",
    "exempt",
    "a primitive shader-type name",
  ],
  [
    "Renderer/WebGPU/WebGPUPrimitiveShaders.js",
    /^\s*\/\/.*@chunk\s+csm_samplePointShadow\b/m,
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPUPrimitiveShaders.js",
    /^\s*\/\/.*@chunk\s+functions\/csm_polylineCommon\b/m,
    "decides",
  ],
  [
    "Renderer/WebGPU/WebGPURenderTarget.ts",
    "stencil",
    "exempt",
    "a depth texture format name",
  ],
  [
    "Renderer/WebGPU/WebGPUSceneRendererEnvironmentalEffects.ts",
    "stencil",
    "exempt",
    "a depth texture format name",
  ],
  [
    "Renderer/WebGPU/WebGPUShaderPreprocessor.ts",
    /^\s*\/\/>>\s*(ifdef|else|endif)(?:\s+([A-Z_][A-Z0-9_]*))?\s*$/,
    "decides",
  ],
  [
    "Renderer/demodernizeShader.js",
    /(in)\s+(vec\d|mat\d|float)/g,
    "rewrites",
    "glsl-strip",
  ],
  [
    "Renderer/demodernizeShader.js",
    /(out)\s+(vec\d|mat\d|float)\s+([\w]+);/g,
    "rewrites",
    "glsl-strip",
  ],
  ["Renderer/demodernizeShader.js", /(texture\()/g, "rewrites", "glsl-strip"],
  [
    "Renderer/demodernizeShader.js",
    /\n\s*(in)\s+(vec\d|mat\d|float)/g,
    "rewrites",
    "glsl-strip",
  ],
  ["Renderer/demodernizeShader.js", /gl_FragDepth/, "decides", "glsl-strip"],
  ["Renderer/demodernizeShader.js", /gl_FragDepth/g, "rewrites", "glsl-strip"],
  [
    "Renderer/demodernizeShader.js",
    /layout\s+\(location\s*=\s*0\)\s*out\s+vec4\s+out_FragColor;/g,
    "rewrites",
    "glsl-strip",
  ],
  [
    "Renderer/demodernizeShader.js",
    /layout\s+\(location\s*=\s*\d+\)\s*out\s+vec4\s+out_FragData_\d+;/g,
    "rewrites",
    "glsl-strip",
  ],
  ["Renderer/demodernizeShader.js", /out_FragColor/g, "rewrites", "glsl-strip"],
  [
    "Renderer/demodernizeShader.js",
    /out_FragData_(\d+)/,
    "decides",
    "glsl-strip",
  ],
  [
    "Renderer/demodernizeShader.js",
    /out_FragData_(\d+)/g,
    "rewrites",
    "glsl-strip",
  ],
  ["Scene/BatchTable.js", "void main", "decides"],
  [
    "Scene/ClassificationPrimitive.js",
    /in\s+vec3\s+extrudeDirection;/g,
    "decides",
  ],
  ["Scene/ComputeInstanceCollection.js", "csm_computeInstance", "decides"],
  ["Scene/CreditDisplay.js", "data:", "exempt", "a credit logo URL"],
  ["Scene/CreditDisplay.js", "http://", "exempt", "a credit logo URL"],
  ["Scene/CreditDisplay.js", "https://", "exempt", "a credit logo URL"],
  ["Scene/DebugInspector.js", /out_FragData_(\d+)/g, "decides"],
  ["Scene/DerivedCommand.js", "LOG_DEPTH", "exempt", "a shader's define list"],
  [
    "Scene/DerivedCommand.js",
    "LOG_DEPTH_READ_ONLY",
    "exempt",
    "a shader's define list",
  ],
  ["Scene/DerivedCommand.js", "out_FragData", "decides"],
  ["Scene/DerivedCommand.js", /\bdiscard\b/, "decides"],
  ["Scene/DerivedCommand.js", /\bgl_FragDepth\b/, "decides"],
  ["Scene/DerivedCommand.js", /\s+czm_vertexLogDepth\(/, "decides"],
  ["Scene/DerivedCommand.js", /\s+czm_writeLogDepth\(/, "decides"],
  ["Scene/Globe.js", "normalEC", "decides"],
  ["Scene/Globe.js", /slope/, "decides"],
  [
    "Scene/GroundPolylinePrimitive.js",
    /in\s+float\s+v_polylineAngle;/g,
    "decides",
  ],
  ["Scene/GroundPolylinePrimitive.js", /in\s+float\s+v_width;/g, "decides"],
  [
    "Scene/I3SDataProvider.js",
    "404",
    "exempt",
    "a binary response decoded as text",
  ],
  [
    "Scene/ImageryLayerFeatureInfo.js",
    /name/i,
    "exempt",
    "a feature property name",
  ],
  ["Scene/MaterialHelpers.js", "mat", "exempt", "a material uniform type name"],
  ["Scene/Model/CustomShader.js", /material\.(\w+)/g, "decides"],
  ["Scene/Model/MetadataWGSLHelpers.js", "f32", "exempt", "a WGSL type name"],
  [
    "Scene/Model/ModelUtility.js",
    /^gl_/,
    "exempt",
    "a glTF identifier being sanitized",
  ],
  [
    "Scene/Model/MetadataWGSLPipelineStage.js",
    "f32",
    "exempt",
    "a WGSL type name",
  ],
  [
    "Scene/Model/PointCloudStylingPipelineStage.js",
    "normalMC",
    "exempt",
    "a style's property-name list",
  ],
  [
    "Scene/Model/PointCloudStylingPipelineStage.js",
    /attributes\.(\w+)/g,
    "decides",
  ],
  ["Scene/OIT.js", /\bdiscard\b/g, "rewrites"],
  ["Scene/OIT.js", /czm_phong/g, "rewrites"],
  [
    "Scene/OIT.js",
    /layout\s*\(location\s*=\s*0\)\s*out\s+vec4\s+out_FragColor;/g,
    "rewrites",
  ],
  ["Scene/OIT.js", /out_FragColor/g, "rewrites"],
  ["Scene/OIT.js", /out_FragData_(\d+)/g, "decides"],
  ["Scene/PointCloud.js", "COLOR", "exempt", "a style's property-name list"],
  ["Scene/PointCloud.js", "NORMAL", "exempt", "a style's property-name list"],
  ["Scene/PointCloudEyeDomeLighting.js", /out_FragColor/g, "rewrites"],
  ["Scene/PolylineCollection.js", /in\s+float\s+v_polylineAngle;/g, "decides"],
  [
    "Scene/PolylineMaterialAppearance.js",
    /in\s+float\s+v_polylineAngle;/g,
    "decides",
  ],
  [
    "Scene/PostProcessStage.js",
    /in\s+vec2\s+v_textureCoordinates;/g,
    "rewrites",
  ],
  [
    "Scene/PostProcessStage.js",
    /uniform\s+sampler2D\s+depthTexture/g,
    "decides",
  ],
  [
    "Scene/PrimitiveCommandHelpers.js",
    "mat",
    "exempt",
    "a primitive shader-type name",
  ],
  [
    "Scene/PrimitiveCommandHelpers.js",
    "pbr",
    "exempt",
    "a primitive shader-type name",
  ],
  [
    "Scene/PrimitiveGeometryHelpers.js",
    "distanceDisplayCondition",
    "exempt",
    "a geometry attribute-name list",
  ],
  [
    "Scene/PrimitiveGeometryHelpers.js",
    "offset",
    "exempt",
    "a geometry attribute-name list",
  ],
  ["Scene/PrimitiveShaderHelpers.js", /(\b)color(\b)/g, "rewrites"],
  ["Scene/PrimitiveShaderHelpers.js", /(\b)pickColor(\b)/g, "rewrites"],
  [
    "Scene/PrimitiveShaderHelpers.js",
    /czm_modelViewProjectionRelativeToEye/g,
    "rewrites",
  ],
  [
    "Scene/PrimitiveShaderHelpers.js",
    /czm_modelViewRelativeToEye\s+\*\s+/g,
    "rewrites",
  ],
  ["Scene/PrimitiveShaderHelpers.js", /in\s+float\s+batchId;/g, "decides"],
  [
    "Scene/PrimitiveShaderHelpers.js",
    /in\s+vec(?:3|4)\s+(.*)3DHigh;/g,
    "decides",
  ],
  [
    "Scene/PrimitiveShaderHelpers.js",
    /in\s+vec(?:3|4)\s+position3DHigh;/g,
    "rewrites",
  ],
  [
    "Scene/PrimitiveShaderHelpers.js",
    /in\s+vec(?:3|4)\s+position3DLow;/g,
    "rewrites",
  ],
  ["Scene/PrimitiveShaderHelpers.js", /in\s+vec2\s+st;/g, "decides"],
  ["Scene/PrimitiveShaderHelpers.js", /in\s+vec3\s+bitangent;/g, "decides"],
  ["Scene/PrimitiveShaderHelpers.js", /in\s+vec3\s+normal;/g, "decides"],
  ["Scene/PrimitiveShaderHelpers.js", /in\s+vec3\s+tangent;/g, "decides"],
  ["Scene/PrimitiveShaderHelpers.js", /in\s+vec4\s+color;/g, "decides"],
  ["Scene/PrimitiveShaderHelpers.js", /in\s+vec4\s+pickColor;/g, "rewrites"],
  [
    "Scene/PrimitiveShaderHelpers.js",
    /vec4\s+([A-Za-z0-9_]+)\s+=\s+czm_computePosition\(\);/g,
    "decides",
  ],
  ["Scene/ShadowVolumeAppearance.js", "czm_getDefaultMaterial", "decides"],
  ["Scene/ShadowVolumeAppearance.js", "materialInput.normalEC", "decides"],
  [
    "Scene/ShadowVolumeAppearance.js",
    "materialInput.positionToEyeEC",
    "decides",
  ],
  ["Scene/ShadowVolumeAppearance.js", "materialInput.st", "decides"],
  [
    "Scene/ShadowVolumeAppearance.js",
    "materialInput.tangentToEyeMatrix",
    "decides",
  ],
  [
    "Scene/TileMapServiceImageryProvider.js",
    /boundingbox/i,
    "exempt",
    "an XML tag name",
  ],
  [
    "Scene/TileMapServiceImageryProvider.js",
    /tileset/i,
    "exempt",
    "an XML tag name",
  ],
  [
    "Scene/TileMapServiceImageryProvider.js",
    /tilesets/i,
    "exempt",
    "an XML tag name",
  ],
];

/**
 * The harvest key of a reader: its file and its literal as written.
 *
 * @param {string} file Path under `packages/engine/Source/`.
 * @param {RegExp|string} literal The regex, or the string needle.
 * @returns {string} Key.
 */
export function readerKey(file, literal) {
  return `${file}|${literal instanceof RegExp ? literal.toString() : JSON.stringify(literal)}`;
}

/** The classification, keyed by harvest key. */
export const READER_USES = Object.freeze(
  Object.fromEntries(
    READER_TABLE.map(([file, literal, use, detail]) => [
      readerKey(file, literal),
      Object.freeze(
        use === "exempt"
          ? { use, reason: detail }
          : { use, view: detail ?? "raw" },
      ),
    ]),
  ),
);

/**
 * Words a regex body requires literally, ignoring classes and escapes. A
 * regex with none (`\s+`, `[^\s,]+`) reads text in general, not a marker, and
 * is not a candidate.
 *
 * @param {string} body Regex source.
 * @returns {string[]} Literal words of three or more characters.
 */
export function literalWords(body) {
  const flattened = body
    .replace(/\[(?:\\.|[^\]\\])*\]/g, " ")
    .replace(/\\[dDsSwWbBnrtfv0]/g, " ")
    .replace(/\\(.)/g, "$1");
  return [...flattened.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)].map(
    (match) => match[0],
  );
}

/**
 * The value of a quoted string literal's body.
 *
 * @param {string} body Text between the quotes.
 * @returns {string} Value.
 */
function unescapeLiteral(body) {
  return body.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(.))/gs,
    (_, braced, four, two, other) => {
      const code = braced ?? four ?? two;
      if (code !== undefined) {
        return String.fromCodePoint(parseInt(code, 16));
      }
      // A backslash before a line break continues the literal and adds
      // nothing to its value.
      return (
        { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" }[
          other
        ] ?? (other === "\n" ? "" : other)
      );
    },
  );
}

/**
 * The candidate readers one JS or TS file declares.
 *
 * @param {string} file Path under `packages/engine/Source/`.
 * @param {string} source File text.
 * @returns {Array<{key: string, where: string, matcher: RegExp, perLine: boolean}>}
 *   Candidates in source order.
 */
export function readersInSource(file, source) {
  const text = source.replace(/\r\n?/g, "\n");
  const segments = tokenize(text, "js");
  const found = [];
  segments.forEach((segment, index) => {
    if (segment.kind !== "string") {
      return;
    }
    const literal = text.slice(segment.start, segment.end);
    const line = text.slice(0, segment.start).split("\n").length;
    if (literal[0] === "/") {
      const closing = literal.lastIndexOf("/");
      const body = literal.slice(1, closing);
      const flags = literal.slice(closing + 1);
      if (literalWords(body).length === 0) {
        return;
      }
      let matcher;
      try {
        matcher = new RegExp(body, flags);
      } catch {
        return;
      }
      found.push({
        key: `${file}|${literal}`,
        where: `${file}:${line}`,
        matcher,
        // A `^` pattern without the `m` flag is applied by its caller to one
        // line at a time, so it is applied line by line here too.
        perLine: body.startsWith("^") && !flags.includes("m"),
      });
      return;
    }
    // A comment between the call and its needle does not change the call.
    let before = index - 1;
    while (
      before >= 0 &&
      (segments[before].kind === "comment" ||
        (segments[before].kind === "code" &&
          text.slice(segments[before].start, segments[before].end).trim() ===
            ""))
    ) {
      before -= 1;
    }
    const previous = segments[before];
    if (
      previous === undefined ||
      previous.kind !== "code" ||
      (literal[0] === "`" && literal.includes("${"))
    ) {
      return;
    }
    const call = text
      .slice(Math.max(previous.start, previous.end - 40), previous.end)
      .match(SEARCH_CALL);
    if (call === null) {
      return;
    }
    const reader = needleReader(
      file,
      line,
      call[1],
      unescapeLiteral(literal.slice(1, -1)),
    );
    if (reader !== null) {
      found.push(reader);
    }
  });

  // A `const` bound to one plain string literal and passed by name to a
  // search or replace method reads what the literal would read.
  const constants = new Map();
  segments.forEach((segment, index) => {
    const literal = text.slice(segment.start, segment.end);
    const previous = segments[index - 1];
    const next = segments[index + 1];
    if (
      segment.kind !== "string" ||
      literal[0] === "/" ||
      (literal[0] === "`" && literal.includes("${")) ||
      previous?.kind !== "code"
    ) {
      return;
    }
    const declared = text
      .slice(previous.start, previous.end)
      .match(CONST_DECLARATION);
    if (
      declared === null ||
      (next !== undefined &&
        (next.kind !== "code" ||
          !CONST_END.test(text.slice(next.start, next.end))))
    ) {
      return;
    }
    constants.set(declared[1], unescapeLiteral(literal.slice(1, -1)));
  });
  for (const segment of segments) {
    if (segment.kind !== "code" || constants.size === 0) {
      continue;
    }
    const code = text.slice(segment.start, segment.end);
    for (const call of code.matchAll(IDENTIFIER_CALL)) {
      if (!constants.has(call[2])) {
        continue;
      }
      const line = text.slice(0, segment.start + call.index).split("\n").length;
      const reader = needleReader(file, line, call[1], constants.get(call[2]));
      if (reader !== null) {
        found.push(reader);
      }
    }
  }
  return found;
}

/**
 * The candidate reader for a string needle passed to a search method.
 *
 * @param {string} file Path under `packages/engine/Source/`.
 * @param {number} line 1-based line of the call.
 * @param {string} method The method called.
 * @param {string} value The needle's value.
 * @returns {{key: string, where: string, matcher: RegExp, perLine: boolean}|null}
 *   The reader, or null for a needle too short to be a marker.
 */
function needleReader(file, line, method, value) {
  if (value.length < 3) {
    return null;
  }
  let matcher;
  // `split` and `replaceAll` act on every occurrence, as a global regex does.
  const flags = method === "split" || method === "replaceAll" ? "g" : "";
  try {
    matcher = REGEX_METHODS.has(method)
      ? new RegExp(value)
      : new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch {
    return null;
  }
  return {
    key: `${file}|${JSON.stringify(value)}`,
    where: `${file}:${line}`,
    matcher,
    perLine: false,
  };
}

/**
 * The `RegExp(...)` calls one JS or TS file makes, keyed by their argument
 * text with whitespace collapsed, so a site moved to another line keeps its
 * key and a site whose pattern changes gets a new one.
 *
 * @param {string} file Path under `packages/engine/Source/`.
 * @param {string} source File text.
 * @returns {Array<{key: string, where: string}>} Sites in source order.
 */
export function runtimeRegexSitesInSource(file, source) {
  const text = source.replace(/\r\n?/g, "\n");
  const segments = tokenize(text, "js");
  const sites = [];
  segments.forEach((segment, index) => {
    if (segment.kind !== "code") {
      return;
    }
    const code = text.slice(segment.start, segment.end);
    for (const call of code.matchAll(REGEX_CONSTRUCTION)) {
      const open = segment.start + call.index + call[0].length;
      let depth = 1;
      let argument = "";
      for (let at = index; at < segments.length && depth > 0; at++) {
        const part = segments[at];
        const from = Math.max(open, part.start);
        if (part.kind === "string") {
          argument += text.slice(from, part.end);
          continue;
        }
        if (part.kind === "comment") {
          argument += " ";
          continue;
        }
        for (let offset = from; offset < part.end; offset++) {
          const character = text[offset];
          depth += character === "(" ? 1 : character === ")" ? -1 : 0;
          if (depth === 0) {
            break;
          }
          argument += character;
        }
      }
      const line = text.slice(0, segment.start + call.index).split("\n").length;
      sites.push({
        key: `${file}|RegExp(${argument.replace(/\s+/g, " ").trim()})`,
        where: `${file}:${line}`,
      });
    }
  });
  return sites;
}

/**
 * Hand-written readers for engine code the harvest cannot see: a regex built
 * at runtime from a name, a needle held in an array and passed to a helper,
 * a scan between two braces. Each widens its reader to every name the
 * runtime could supply (`struct\s+\w+\b` for `struct\s+${name}\b`), so it
 * refuses at least every edit the real reader would read differently, and
 * more. `language` limits it to the shaders the real reader is given. A
 * reader is tied to its source by the `RUNTIME_REGEX_TABLE` rows that name
 * it, or by `pins`: text that must still occur in the file, whitespace
 * collapsed.
 */
const UNHARVESTED_READERS = [
  {
    id: "material-uniform-declaration",
    file: "Scene/MaterialHelpers.js",
    reads:
      "the declaration test that decides whether a fabric uniform is declared for the shader",
    matcher: /uniform\s+\w+\s+\w+\s*;/g,
    language: "glsl",
  },
  {
    id: "material-dimensions-token",
    file: "Scene/MaterialHelpers.js",
    reads:
      "the token count that decides whether a sampler gets a <name>Dimensions uniform",
    matcher: /\b\w+Dimensions\b/g,
    language: "glsl",
    pins: [
      "getNumberOfTokens(material, imageDimensionsUniformName) > 0",
      "return replaceToken(material, token, token, excludePeriod);",
    ],
  },
  {
    id: "shader-source-normals-define",
    file: "Renderer/ShaderSource.js",
    reads: "the HAS_NORMALS test that picks a shadow shader's normal varying",
    matcher: /#ifdef HAS_NORMALS/g,
    language: "glsl",
    pins: [
      'containsString(shaderSource, "#ifdef HAS_NORMALS")',
      "if (sources[i].includes(string)) {",
    ],
  },
  {
    id: "shader-source-normal-varying",
    file: "Renderer/ShaderSource.js",
    reads: "the first normal varying name a shadow shader finds (v_normalEC)",
    matcher: /v_normalEC/g,
    language: "glsl",
    pins: ['const normalVaryingNames = ["v_normalEC", "v_normal"];'],
  },
  {
    id: "shader-source-normal-varying-short",
    file: "Renderer/ShaderSource.js",
    reads: "the first normal varying name a shadow shader finds (v_normal)",
    matcher: /v_normal/g,
    language: "glsl",
    pins: ['const normalVaryingNames = ["v_normalEC", "v_normal"];'],
  },
  {
    id: "shader-source-position-varying",
    file: "Renderer/ShaderSource.js",
    reads: "the position varying name a shadow shader finds",
    matcher: /v_positionEC/g,
    language: "glsl",
    pins: ['const positionVaryingNames = ["v_positionEC"];'],
  },
  {
    id: "oit-entry",
    file: "Renderer/WebGPU/WebGPUOIT.ts",
    reads: "the fragment entry point OIT renames, attribute on its own line",
    matcher: /@fragment\s*\n\s*fn\s+\w+\s*\(/g,
    language: "wgsl",
  },
  {
    id: "oit-entry-lenient",
    file: "Renderer/WebGPU/WebGPUOIT.ts",
    reads:
      "the fragment entry point OIT renames, from the attribute to the name",
    matcher: /@fragment[\s\S]*?fn\s+\w+/g,
    language: "wgsl",
  },
  {
    id: "oit-entry-parameters",
    file: "Renderer/WebGPU/WebGPUOIT.ts",
    reads: "the renamed entry point's parameter list",
    matcher: /fn\s+\w+\s*\(([^)]+)\)/g,
    language: "wgsl",
    // The transform copies a comment in this list into the signature it
    // builds, so the reader matters for every shader the transform is given
    // and for no other (oit-reach.mjs derives which).
    scope: "oit-reach",
  },
  {
    id: "oit-entry-signature",
    file: "Renderer/WebGPU/WebGPUOIT.ts",
    reads: "the fragment entry signature and its return type",
    matcher:
      /@fragment\s+fn\s+\w+\s*\(([^)]*)\)\s*->\s*([A-Za-z_]\w*|@[\s\S]*?)\s*\{/g,
    language: "wgsl",
  },
  {
    id: "oit-struct",
    file: "Renderer/WebGPU/WebGPUOIT.ts",
    // Every struct the tracked WGSL declares is named in PascalCase or with
    // the czm_ prefix, so prose such as "the struct layout" is not a lookup.
    reads: "the struct OIT looks up by the entry point's return or input type",
    matcher: /struct\s+(?:[A-Z]|czm_)\w*\b/g,
    language: "wgsl",
  },
  {
    id: "oit-struct-braces",
    file: "Renderer/WebGPU/WebGPUOIT.ts",
    reads: "the struct body OIT takes from the first { to the first } after it",
    matcher: /[{}]/g,
    language: "wgsl",
    pins: [
      'const open = wgsl.indexOf("{", decl.index);',
      'const close = wgsl.indexOf("}", open);',
    ],
  },
];

/**
 * Every `RegExp(...)` call under `READER_ROOTS`, keyed as
 * `runtimeRegexSitesInSource` keys it, with what it is: `modelled` by the
 * named `UNHARVESTED_READERS` entry, `benign` (why a comment edit cannot
 * change its result), or `unrelated` (what it reads instead of a tracked
 * shader).
 */
const RUNTIME_REGEX_TABLE = [
  [
    "Renderer/ShaderProgram.js",
    'RegExp(`${uniformName}\\\\b`, "g")',
    "benign",
    "renames a duplicate uniform in place on devices without highp; a match inside a comment stays inside it",
  ],
  [
    "Renderer/WebGPU/WGSLShaderPreprocessor.ts",
    'RegExp(`\\\\b(?:fn|const|var|let|struct)\\\\s+${identifier.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\\\b`,)',
    "benign",
    "looks a definition up in the removeComments output, which has no comments",
  ],
  [
    "Renderer/WebGPU/WebGPUGlobeMaterial.ts",
    'RegExp(`(^|[^A-Za-z0-9_.])(${escaped.join("|")})(?![A-Za-z0-9_])`, "g",)',
    "benign",
    "renames material uniforms in place; a match inside a comment stays inside it",
  ],
  [
    "Renderer/WebGPU/WebGPUOIT.ts",
    "RegExp(`(@fragment\\\\s*\\\\n\\\\s*fn\\\\s+)(${fragmentEntryPoint})(\\\\s*\\\\()`,)",
    "modelled",
    "oit-entry",
  ],
  [
    "Renderer/WebGPU/WebGPUOIT.ts",
    "RegExp(`(@fragment[\\\\s\\\\S]*?fn\\\\s+)(${fragmentEntryPoint})(\\\\s*\\\\()`,)",
    "modelled",
    "oit-entry-lenient",
  ],
  [
    "Renderer/WebGPU/WebGPUOIT.ts",
    "RegExp(`@fragment([\\\\s\\\\S]*?)fn\\\\s+${fragmentEntryPoint}`)",
    "modelled",
    "oit-entry-lenient",
  ],
  [
    "Renderer/WebGPU/WebGPUOIT.ts",
    "RegExp(`fn _oit_base_${fragmentEntryPoint}\\\\(([^)]+)\\\\)`)",
    "modelled",
    "oit-entry-parameters",
  ],
  [
    "Renderer/WebGPU/WebGPUOIT.ts",
    "RegExp(`@fragment\\\\s+fn\\\\s+${fragmentEntryPoint}\\\\s*\\\\(([^)]*)\\\\)\\\\s*->\\\\s*([A-Za-z_]\\\\w*|@[\\\\s\\\\S]*?)\\\\s*\\\\{`,)",
    "modelled",
    "oit-entry-signature",
  ],
  [
    "Renderer/WebGPU/WebGPUOIT.ts",
    "RegExp(`struct\\\\s+${structName}\\\\b`)",
    "modelled",
    "oit-struct",
  ],
  [
    "Scene/Cesium3DTileBatchTable.js",
    "RegExp(`(uniform|attribute|in)\\\\s+(vec[34]|sampler2D)\\\\s+${diffuseAttributeOrUniformName};`,)",
    "unrelated",
    "a glTF shader carrying the _3DTILESDIFFUSE semantic; the tracked shaders reach this code with no diffuse name",
  ],
  [
    "Scene/Cesium3DTileBatchTable.js",
    'RegExp(diffuseAttributeOrUniformName, "g")',
    "unrelated",
    "a glTF shader carrying the _3DTILESDIFFUSE semantic; the tracked shaders reach this code with no diffuse name",
  ],
  [
    "Scene/Expression.js",
    'RegExp(`\\\\$\\\\{${key}\\\\}`, "g")',
    "unrelated",
    "a 3D Tiles style expression",
  ],
  ["Scene/Expression.js", "RegExp()", "unrelated", "a 3D Tiles style regex"],
  [
    "Scene/Expression.js",
    "RegExp(replaceBackslashes(String(pattern._value)), flags._value,)",
    "unrelated",
    "a 3D Tiles style regex",
  ],
  [
    "Scene/Expression.js",
    "RegExp(replaceBackslashes(String(pattern._value)))",
    "unrelated",
    "a 3D Tiles style regex",
  ],
  [
    "Scene/Expression.js",
    "RegExp(pattern, flags)",
    "unrelated",
    "a 3D Tiles style regex",
  ],
  [
    "Scene/Label.js",
    'RegExp(/[\\u0000-\\u0008\\u000E-\\u001F\\u00ad\\u202a-\\u206f\\u200b-\\u200f]/, "g",)',
    "unrelated",
    "a label's text",
  ],
  [
    "Scene/Label.js",
    "RegExp(`[${hebrew}${arabic}]`)",
    "unrelated",
    "a label's text",
  ],
  [
    "Scene/MaterialHelpers.js",
    "RegExp(`uniform\\\\s+${uniformType}\\\\s+${uniformId}\\\\s*;`,)",
    "modelled",
    "material-uniform-declaration",
  ],
  [
    "Scene/MaterialHelpers.js",
    'RegExp(prefixChars + token + suffixChars, "g")',
    "modelled",
    "material-dimensions-token",
  ],
];

/** The runtime-regex classification, keyed by site key. */
export const RUNTIME_REGEX_USES = Object.freeze(
  Object.fromEntries(
    RUNTIME_REGEX_TABLE.map(([file, argument, use, detail]) => [
      `${file}|${argument}`,
      Object.freeze({ use, detail }),
    ]),
  ),
);

/** The hand-written readers, by id. */
export const UNHARVESTED_READER_IDS = Object.freeze(
  UNHARVESTED_READERS.map((reader) => reader.id),
);

let harvested;
let harvestedSites;
let missingPins;

/**
 * Every `RegExp(...)` site under `READER_ROOTS`, merged by key, with its
 * classification (undefined when unclassified).
 *
 * @returns {Array<{key: string, wheres: string[], use?: string, detail?: string}>}
 *   Sites, sorted by key.
 */
export function runtimeRegexSites() {
  shaderTextReaders();
  return harvestedSites;
}

/**
 * Why the reader model no longer covers the engine: `RegExp(...)` sites that
 * are not classified, and pins of hand-written readers missing from their
 * source. While this is not empty every shader comment edit is refused.
 *
 * @returns {string[]} One line per gap.
 */
export function readerModelGaps() {
  shaderTextReaders();
  return [
    ...harvestedSites
      .filter((site) => site.use === undefined)
      .map(
        (site) =>
          `an unclassified runtime-built reader ${site.key} (${site.wheres[0]}); classify it in shader-text-readers.mjs RUNTIME_REGEX_TABLE`,
      ),
    ...missingPins.map(
      (pin) =>
        `the hand-written reader ${pin.id} no longer finds its source text in ${pin.file}: ${JSON.stringify(pin.text)}`,
    ),
    ...oitReachGaps(),
  ];
}

/**
 * Whether a reader reads the shader at a path. A reader with no scope reads
 * every shader of its language. A scoped reader reads the shaders of its scope
 * and every shader when the path is not known, so a caller that cannot say
 * which file it holds is refused rather than excused.
 *
 * @param {{scope?: string}} reader Reader.
 * @param {string|undefined} relPath Repo-relative path of the shader.
 * @returns {boolean} Whether the reader applies.
 */
export function readerAppliesToPath(reader, relPath) {
  return reader.scope === "oit-reach" ? inOitReach(relPath) : true;
}

/**
 * Every candidate reader under `READER_ROOTS`, merged by key, with its use,
 * then the hand-written readers (`unharvested: true`). Exempt readers are
 * included, so the corpus spec can pin the whole table.
 *
 * @returns {Array<{key: string, wheres: string[], matcher: RegExp, perLine: boolean, use: string, view: string, reason?: string, language?: string, unharvested?: boolean}>}
 *   Readers, sorted by key.
 */
export function shaderTextReaders() {
  if (harvested !== undefined) {
    return harvested;
  }
  const byKey = new Map();
  const sites = new Map();
  const sources = new Map();
  for (const root of READER_ROOTS) {
    const entries = readdirSync(path.join(SOURCE_ROOT, root), {
      recursive: true,
    })
      .map((entry) => `${root}/${String(entry).split(path.sep).join("/")}`)
      .filter((entry) => /\.(?:js|ts)$/.test(entry) && !entry.endsWith(".d.ts"))
      .sort();
    for (const file of entries) {
      const source = readFileSync(path.join(SOURCE_ROOT, file), "utf8");
      sources.set(file, source);
      for (const site of runtimeRegexSitesInSource(file, source)) {
        const known = sites.get(site.key);
        if (known !== undefined) {
          known.wheres.push(site.where);
          continue;
        }
        sites.set(site.key, {
          key: site.key,
          wheres: [site.where],
          ...RUNTIME_REGEX_USES[site.key],
        });
      }
      for (const reader of readersInSource(file, source)) {
        const known = byKey.get(reader.key);
        if (known !== undefined) {
          known.wheres.push(reader.where);
          continue;
        }
        const classified = READER_USES[reader.key] ?? {
          use: "decides",
          view: "raw",
        };
        byKey.set(reader.key, {
          key: reader.key,
          wheres: [reader.where],
          matcher: reader.matcher,
          perLine: reader.perLine,
          ...classified,
        });
      }
    }
  }
  harvestedSites = [...sites.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  const collapse = (text) => text.replace(/\s+/g, " ");
  missingPins = UNHARVESTED_READERS.flatMap((reader) =>
    (reader.pins ?? [])
      .filter(
        (pin) =>
          !collapse(sources.get(reader.file) ?? "").includes(collapse(pin)),
      )
      .map((text) => ({ id: reader.id, file: reader.file, text })),
  );
  harvested = [
    ...[...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    ...UNHARVESTED_READERS.map((reader) => ({
      key: `${reader.file}|unharvested:${reader.id}`,
      wheres: [reader.file],
      matcher: reader.matcher,
      perLine: false,
      use: "decides",
      view: "raw",
      language: reader.language,
      scope: reader.scope,
      unharvested: true,
      pinned: (reader.pins ?? []).length > 0,
    })),
  ];
  return harvested;
}

/**
 * The spans a reader matches in a text, as its caller applies it: over the
 * whole text, or line by line (and on each trimmed line) for a per-line
 * pattern.
 *
 * @param {{matcher: RegExp, perLine: boolean}} reader Reader.
 * @param {string} text Text, with LF line endings.
 * @returns {Array<[number, number]>} `[start, end)` spans, in order.
 */
export function readerSpans(reader, text) {
  const spans = [];
  if (reader.perLine) {
    const single = new RegExp(
      reader.matcher.source,
      reader.matcher.flags.replace(/[gy]/g, ""),
    );
    let start = 0;
    for (const line of text.split("\n")) {
      if (single.test(line) || single.test(line.trim())) {
        const lead = line.length - line.trimStart().length;
        spans.push([start + lead, start + line.trimEnd().length]);
      }
      start += line.length + 1;
    }
    return spans;
  }
  const global = new RegExp(
    reader.matcher.source,
    `${reader.matcher.flags.replace(/[gy]/g, "")}g`,
  );
  for (const match of text.matchAll(global)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

/**
 * Index of the segment holding an offset.
 *
 * @param {Array<{start: number, end: number}>} segments Gap-free segments.
 * @param {number} offset Offset.
 * @returns {number} Segment index.
 */
function segmentAt(segments, offset) {
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (segments[middle].start <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/**
 * What a reader reads in one shader text, one element per match.
 *
 * Each element names whether the match starts and ends in code (`k`) or in a
 * comment (`c`), then the matched text: code with its whitespace collapsed,
 * the comment text at either end of the match verbatim, and a comment the
 * match spans in full as one space. Two texts whose code is equal read the
 * same to the reader exactly when their elements are equal: a match gained,
 * lost or moved in prose changes the list, and so does comment text the
 * match reads at its ends. A comment wholly inside a match does not.
 *
 * @param {{matcher: RegExp, perLine: boolean, use: string}} reader Reader.
 * @param {string} text Shader text, with LF line endings.
 * @param {("wgsl"|"glsl")} language Grammar of the text.
 * @returns {string[]} Elements, in match order.
 */
export function readerElements(reader, text, language) {
  const spans = readerSpans(reader, text);
  if (spans.length === 0) {
    return [];
  }
  const segments = tokenize(text, language);
  const kindOf = (index) => (segments[index].kind === "comment" ? "c" : "k");
  const elements = [];
  for (const [start, end] of spans) {
    const first = segmentAt(segments, start);
    const last = segmentAt(segments, Math.max(start, end - 1));
    if (
      reader.use === "rewrites" &&
      first === last &&
      segments[first].kind === "comment"
    ) {
      continue;
    }
    let read = "";
    for (let index = first; index <= last; index++) {
      const segment = segments[index];
      const slice = text.slice(
        Math.max(segment.start, start),
        Math.min(segment.end, end),
      );
      if (segment.kind !== "comment") {
        read += slice.replace(/\s+/g, " ");
      } else {
        read += index === first || index === last ? slice : " ";
      }
    }
    elements.push(`${kindOf(first)}${kindOf(last)}:${read}`);
  }
  return elements;
}
