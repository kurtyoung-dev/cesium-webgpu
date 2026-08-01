import Check from "../Core/Check.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import RuntimeError from "../Core/RuntimeError.js";
import AutomaticUniforms from "./AutomaticUniforms.js";
import createUniform from "./createUniform.js";
import createUniformArray from "./createUniformArray.js";

let nextShaderProgramId = 0;

const ShaderProgramLinkState = Object.freeze({
  UNINITIALIZED: "uninitialized",
  LINKING: "linking",
  READY: "ready",
  FAILED: "failed",
});

/**
 * @private
 */
class ShaderProgram {
  constructor(options) {
    let vertexShaderText = options.vertexShaderText;
    let fragmentShaderText = options.fragmentShaderText;

    if (typeof spector !== "undefined") {
      // The #line statements common in Cesium shaders interfere with the ability of the
      // SpectorJS to show errors on the correct line. So remove them when SpectorJS
      // is active.
      vertexShaderText = vertexShaderText.replace(/^#line/gm, "//#line");
      fragmentShaderText = fragmentShaderText.replace(/^#line/gm, "//#line");
    }

    const modifiedFS = handleUniformPrecisionMismatches(
      vertexShaderText,
      fragmentShaderText,
      options.graphicsCapabilities,
    );

    this._gl = options.gl;
    this._logShaderCompilation = options.logShaderCompilation;
    this._debugShaders = options.debugShaders;
    this._parallelShaderCompile = options.parallelShaderCompile;
    this._attributeLocations = options.attributeLocations;

    this._program = undefined;
    this._linkResources = undefined;
    this._linkState = ShaderProgramLinkState.UNINITIALIZED;
    this._linkError = undefined;
    this._linkErrorMessages = undefined;
    this._linkErrorReported = false;
    this._numberOfVertexAttributes = undefined;
    this._vertexAttributes = undefined;
    this._uniformsByName = undefined;
    this._uniforms = undefined;
    this._automaticUniforms = undefined;
    this._manualUniforms = undefined;
    this._duplicateUniformNames = modifiedFS.duplicateUniformNames;
    this._cachedShader = undefined; // Used by ShaderCache

    /**
     * @private
     */
    this.maximumTextureUnitIndex = undefined;

    this._vertexShaderSource = options.vertexShaderSource;
    this._vertexShaderText = options.vertexShaderText;
    this._fragmentShaderSource = options.fragmentShaderSource;
    this._fragmentShaderText = modifiedFS.fragmentShaderText;

    /**
     * @private
     */
    this.id = nextShaderProgramId++;
  }

  /**
   * GLSL source for the shader program's vertex shader.
   *
   * @type {ShaderSource}
   * @readonly
   */
  get vertexShaderSource() {
    return this._vertexShaderSource;
  }

  /**
   * GLSL source for the shader program's fragment shader.
   *
   * @type {ShaderSource}
   * @readonly
   */
  get fragmentShaderSource() {
    return this._fragmentShaderSource;
  }

  get vertexAttributes() {
    initialize(this);
    return this._vertexAttributes;
  }

  get numberOfVertexAttributes() {
    initialize(this);
    return this._numberOfVertexAttributes;
  }

  get allUniforms() {
    initialize(this);
    return this._uniformsByName;
  }

  _bind() {
    initialize(this);
    this._gl.useProgram(this._program);
  }

  _setUniforms(uniformMap, uniformState, validate) {
    let len;
    let i;

    if (defined(uniformMap)) {
      const manualUniforms = this._manualUniforms;
      len = manualUniforms.length;
      for (i = 0; i < len; ++i) {
        const mu = manualUniforms[i];

        //>>includeStart('debug', pragmas.debug);
        if (!defined(uniformMap[mu.name])) {
          throw new DeveloperError(`Unknown uniform: ${mu.name}`);
        }
        //>>includeEnd('debug');

        mu.value = uniformMap[mu.name]();
      }
    }

    const automaticUniforms = this._automaticUniforms;
    len = automaticUniforms.length;
    for (i = 0; i < len; ++i) {
      const au = automaticUniforms[i];
      au.uniform.value = au.automaticUniform.getValue(uniformState);
    }

    ///////////////////////////////////////////////////////////////////

    // It appears that assigning the uniform values above and then setting them here
    // (which makes the GL calls) is faster than removing this loop and making
    // the GL calls above.  I suspect this is because each GL call pollutes the
    // L2 cache making our JavaScript and the browser/driver ping-pong cache lines.
    const uniforms = this._uniforms;
    len = uniforms.length;
    for (i = 0; i < len; ++i) {
      uniforms[i].set();
    }

    if (validate) {
      const gl = this._gl;
      const program = this._program;

      gl.validateProgram(program);
      //>>includeStart('debug', pragmas.debug);
      if (!gl.getProgramParameter(program, gl.VALIDATE_STATUS)) {
        throw new DeveloperError(
          `Program validation failed.  Program info log: ${gl.getProgramInfoLog(
            program,
          )}`,
        );
      }
      //>>includeEnd('debug');
    }
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    this._cachedShader.cache.releaseShaderProgram(this);
    return undefined;
  }

  finalDestroy() {
    const cachedShader = this._cachedShader;
    if (defined(cachedShader)) {
      cachedShader.cache._shaderProgramCompilationFinished(this);
    }

    deleteLinkResources(this._gl, this._linkResources, true);
    this._linkResources = undefined;

    if (defined(this._program)) {
      this._gl.deleteProgram(this._program);
      this._program = undefined;
    }

    return destroyObject(this);
  }

  _startLink() {
    if (this._linkState !== ShaderProgramLinkState.UNINITIALIZED) {
      return this._linkState === ShaderProgramLinkState.LINKING;
    }

    try {
      this._linkResources = submitLink(this._gl, this);
      this._linkState = ShaderProgramLinkState.LINKING;
    } catch (error) {
      cacheUnexpectedLinkError(this, error);
    }

    return this._linkState === ShaderProgramLinkState.LINKING;
  }

  _isLinkPending() {
    return (
      this._linkState === ShaderProgramLinkState.UNINITIALIZED ||
      this._linkState === ShaderProgramLinkState.LINKING
    );
  }

  _pollLinkCompletion() {
    if (this._linkState !== ShaderProgramLinkState.LINKING) {
      return this._linkState !== ShaderProgramLinkState.UNINITIALIZED;
    }

    const extension = this._parallelShaderCompile;
    if (!defined(extension)) {
      return false;
    }

    let completed;
    try {
      completed = this._gl.getProgramParameter(
        this._linkResources.program,
        extension.COMPLETION_STATUS_KHR,
      );
    } catch (error) {
      cacheUnexpectedLinkError(this, error);
      return true;
    }

    if (!completed) {
      return false;
    }

    finalizeLink(this);
    return true;
  }

  _forceLinkCompletion() {
    if (this._linkState === ShaderProgramLinkState.UNINITIALIZED) {
      this._startLink();
    }

    if (this._linkState === ShaderProgramLinkState.LINKING) {
      finalizeLink(this);
    }

    return this._linkState === ShaderProgramLinkState.READY;
  }

  static fromCache(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    //>>includeStart('debug', pragmas.debug);
    Check.defined("options.context", options.context);
    //>>includeEnd('debug');

    return options.context.shaderCache.getShaderProgram(options);
  }

  static replaceCache(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    //>>includeStart('debug', pragmas.debug);
    Check.defined("options.context", options.context);
    //>>includeEnd('debug');

    return options.context.shaderCache.replaceShaderProgram(options);
  }
}

function extractUniforms(shaderText) {
  const uniformNames = [];
  const uniformLines = shaderText.match(/uniform.*?(?![^{]*})(?=[=\[;])/g);
  if (defined(uniformLines)) {
    const len = uniformLines.length;
    for (let i = 0; i < len; i++) {
      const line = uniformLines[i].trim();
      const name = line.slice(line.lastIndexOf(" ") + 1);
      uniformNames.push(name);
    }
  }
  return uniformNames;
}

function handleUniformPrecisionMismatches(
  vertexShaderText,
  fragmentShaderText,
  graphicsCapabilities,
) {
  // If a uniform exists in both the vertex and fragment shader but with different precision qualifiers,
  // give the fragment shader uniform a different name. This fixes shader compilation errors on devices
  // that only support mediump in the fragment shader.
  const duplicateUniformNames = {};

  if (
    !graphicsCapabilities.highpFloatSupported ||
    !graphicsCapabilities.highpIntSupported
  ) {
    let i, j;
    let uniformName;
    let duplicateName;
    const vertexShaderUniforms = extractUniforms(vertexShaderText);
    const fragmentShaderUniforms = extractUniforms(fragmentShaderText);
    const vertexUniformsCount = vertexShaderUniforms.length;
    const fragmentUniformsCount = fragmentShaderUniforms.length;

    for (i = 0; i < vertexUniformsCount; i++) {
      for (j = 0; j < fragmentUniformsCount; j++) {
        if (vertexShaderUniforms[i] === fragmentShaderUniforms[j]) {
          uniformName = vertexShaderUniforms[i];
          duplicateName = `czm_mediump_${uniformName}`;
          // Update fragmentShaderText with renamed uniforms
          const re = new RegExp(`${uniformName}\\b`, "g");
          fragmentShaderText = fragmentShaderText.replace(re, duplicateName);
          duplicateUniformNames[duplicateName] = uniformName;
        }
      }
    }
  }

  return {
    fragmentShaderText: fragmentShaderText,
    duplicateUniformNames: duplicateUniformNames,
  };
}

const consolePrefix = "[Cesium WebGL] ";

function submitLink(gl, shader) {
  const vsSource = shader._vertexShaderText;
  const fsSource = shader._fragmentShaderText;
  const resources = {
    vertexShader: undefined,
    fragmentShader: undefined,
    program: undefined,
  };

  try {
    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    resources.vertexShader = vertexShader;
    gl.shaderSource(vertexShader, vsSource);
    gl.compileShader(vertexShader);

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    resources.fragmentShader = fragmentShader;
    gl.shaderSource(fragmentShader, fsSource);
    gl.compileShader(fragmentShader);

    const program = gl.createProgram();
    resources.program = program;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);

    const attributeLocations = shader._attributeLocations;
    if (defined(attributeLocations)) {
      for (const attribute in attributeLocations) {
        if (Object.hasOwn(attributeLocations, attribute)) {
          gl.bindAttribLocation(
            program,
            attributeLocations[attribute],
            attribute,
          );
        }
      }
    }

    gl.linkProgram(program);
  } catch (error) {
    deleteLinkResources(gl, resources, true);
    throw error;
  }

  return resources;
}

function finalizeLink(shader) {
  if (shader._linkState !== ShaderProgramLinkState.LINKING) {
    return;
  }

  const gl = shader._gl;
  const resources = shader._linkResources;
  const program = resources.program;

  let linked;
  try {
    linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  } catch (error) {
    deleteLinkResources(gl, resources, true);
    shader._linkResources = undefined;
    cacheUnexpectedLinkError(shader, error);
    return;
  }

  if (!linked) {
    let failure;
    try {
      failure = createLinkFailure(shader, resources);
    } catch (error) {
      failure = createUnexpectedLinkFailure(error);
    }

    deleteLinkResources(gl, resources, true);
    shader._linkResources = undefined;
    cacheLinkFailure(shader, failure);
    return;
  }

  try {
    logSuccessfulCompilation(shader, resources);
    const programInfo = createProgramInfo(shader, program);
    installSpectorHook(shader, program);
    deleteLinkResources(gl, resources, false);
    shader._linkResources = undefined;
    publishProgramInfo(shader, programInfo);
    shader._linkState = ShaderProgramLinkState.READY;
    shader._linkError = undefined;
    shader._linkErrorMessages = undefined;
    shader._linkErrorReported = false;
  } catch (error) {
    deleteLinkResources(gl, resources, true);
    shader._linkResources = undefined;
    cacheUnexpectedLinkError(shader, error);
  }
}

function createLinkFailure(shader, resources) {
  const gl = shader._gl;
  const vertexShader = resources.vertexShader;
  const fragmentShader = resources.fragmentShader;
  const program = resources.program;
  const vsSource = shader._vertexShaderText;
  const fsSource = shader._fragmentShaderText;
  const messages = [];
  let errorMessage;
  let log;

  if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
    log = gl.getShaderInfoLog(fragmentShader);
    messages.push(`${consolePrefix}Fragment shader compile log: ${log}`);
    messages.push(`${consolePrefix} Fragment shader source:\n${fsSource}`);
    errorMessage = `Fragment shader failed to compile.  Compile log: ${log}`;
  } else if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
    log = gl.getShaderInfoLog(vertexShader);
    messages.push(`${consolePrefix}Vertex shader compile log: ${log}`);
    messages.push(`${consolePrefix} Vertex shader source:\n${vsSource}`);
    errorMessage = `Vertex shader failed to compile.  Compile log: ${log}`;
  } else {
    log = gl.getProgramInfoLog(program);
    messages.push(`${consolePrefix}Shader program link log: ${log}`);
    appendTranslatedSource(shader, vertexShader, "vertex", messages);
    appendTranslatedSource(shader, fragmentShader, "fragment", messages);
    errorMessage = `Program failed to link.  Link log: ${log}`;
  }

  return {
    error: new RuntimeError(errorMessage),
    messages: messages,
  };
}

function appendTranslatedSource(shader, compiledShader, name, messages) {
  const debugShaders = shader._debugShaders;
  if (!defined(debugShaders)) {
    return;
  }

  const translation = debugShaders.getTranslatedShaderSource(compiledShader);
  if (translation === "") {
    messages.push(`${consolePrefix}${name} shader translation failed.`);
    return;
  }

  messages.push(
    `${consolePrefix}Translated ${name} shaderSource:\n${translation}`,
  );
}

function logSuccessfulCompilation(shader, resources) {
  if (!shader._logShaderCompilation) {
    return;
  }

  const gl = shader._gl;
  let log = gl.getShaderInfoLog(resources.vertexShader);
  if (defined(log) && log.length > 0) {
    console.log(`${consolePrefix}Vertex shader compile log: ${log}`);
  }

  log = gl.getShaderInfoLog(resources.fragmentShader);
  if (defined(log) && log.length > 0) {
    console.log(`${consolePrefix}Fragment shader compile log: ${log}`);
  }

  log = gl.getProgramInfoLog(resources.program);
  if (defined(log) && log.length > 0) {
    console.log(`${consolePrefix}Shader program link log: ${log}`);
  }
}

function createProgramInfo(shader, program) {
  const gl = shader._gl;
  const numberOfVertexAttributes = gl.getProgramParameter(
    program,
    gl.ACTIVE_ATTRIBUTES,
  );
  const vertexAttributes = findVertexAttributes(
    gl,
    program,
    numberOfVertexAttributes,
  );
  const uniforms = findUniforms(gl, program);
  const partitionedUniforms = partitionUniforms(
    shader,
    uniforms.uniformsByName,
  );
  const maximumTextureUnitIndex = setSamplerUniforms(
    gl,
    program,
    uniforms.samplerUniforms,
  );

  return {
    program: program,
    numberOfVertexAttributes: numberOfVertexAttributes,
    vertexAttributes: vertexAttributes,
    uniformsByName: uniforms.uniformsByName,
    uniforms: uniforms.uniforms,
    automaticUniforms: partitionedUniforms.automaticUniforms,
    manualUniforms: partitionedUniforms.manualUniforms,
    maximumTextureUnitIndex: maximumTextureUnitIndex,
  };
}

function publishProgramInfo(shader, programInfo) {
  shader._program = programInfo.program;
  shader._numberOfVertexAttributes = programInfo.numberOfVertexAttributes;
  shader._vertexAttributes = programInfo.vertexAttributes;
  shader._uniformsByName = programInfo.uniformsByName;
  shader._uniforms = programInfo.uniforms;
  shader._automaticUniforms = programInfo.automaticUniforms;
  shader._manualUniforms = programInfo.manualUniforms;
  shader.maximumTextureUnitIndex = programInfo.maximumTextureUnitIndex;
}

function cacheLinkFailure(shader, failure) {
  shader._linkState = ShaderProgramLinkState.FAILED;
  shader._linkError = failure.error;
  shader._linkErrorMessages = failure.messages;
  shader._linkErrorReported = false;

  // A speculatively prepared program may never be bound, so the compile and link
  // logs have to reach the console when the failure is discovered instead of only
  // when the program is first used. reportLinkFailure() stays quiet afterward.
  logLinkFailure(shader);
}

function createUnexpectedLinkFailure(error) {
  const message = defined(error) ? error.message : undefined;
  return {
    error:
      error instanceof RuntimeError
        ? error
        : new RuntimeError(
            defined(message) ? message : "Shader program failed to link.",
          ),
    messages: [],
  };
}

function cacheUnexpectedLinkError(shader, error) {
  deleteLinkResources(shader._gl, shader._linkResources, true);
  shader._linkResources = undefined;
  cacheLinkFailure(shader, createUnexpectedLinkFailure(error));
}

function logLinkFailure(shader) {
  if (shader._linkErrorReported) {
    return;
  }

  const messages = shader._linkErrorMessages;
  if (defined(messages)) {
    for (let i = 0; i < messages.length; ++i) {
      console.error(messages[i]);
    }
  }
  shader._linkErrorReported = true;
}

function reportLinkFailure(shader) {
  logLinkFailure(shader);

  throw shader._linkError;
}

function deleteLinkResources(gl, resources, deleteProgram) {
  if (!defined(resources)) {
    return;
  }

  const vertexShader = resources.vertexShader;
  const fragmentShader = resources.fragmentShader;
  const program = resources.program;
  resources.vertexShader = undefined;
  resources.fragmentShader = undefined;
  if (deleteProgram) {
    resources.program = undefined;
  }

  if (defined(vertexShader)) {
    gl.deleteShader(vertexShader);
  }
  if (defined(fragmentShader)) {
    gl.deleteShader(fragmentShader);
  }
  if (deleteProgram && defined(program)) {
    gl.deleteProgram(program);
  }
}

function installSpectorHook(shader, program) {
  // If SpectorJS is active, add the hook to make the shader editor work.
  // https://github.com/BabylonJS/Spector.js/blob/master/documentation/extension.md#shader-editor
  if (typeof spector === "undefined") {
    return;
  }

  program.__SPECTOR_rebuildProgram = function (
    vertexSourceCode, // The new vertex shader source
    fragmentSourceCode, // The new fragment shader source
    onCompiled, // Callback triggered by your engine when the compilation is successful. It needs to send back the new linked program.
    onError, // Callback triggered by your engine in case of error. It needs to send the WebGL error to allow the editor to display the error in the gutter.
  ) {
    const originalVS = shader._vertexShaderText;
    const originalFS = shader._fragmentShaderText;

    // SpectorJS likes to replace `!=` with `! =` for unknown reasons,
    // and that causes glsl compile failures. So fix that up.
    const regex = / ! = /g;
    shader._vertexShaderText = vertexSourceCode.replace(regex, " != ");
    shader._fragmentShaderText = fragmentSourceCode.replace(regex, " != ");

    try {
      reinitializeSynchronously(shader);
      onCompiled(shader._program);
    } catch (e) {
      shader._vertexShaderText = originalVS;
      shader._fragmentShaderText = originalFS;

      // Only pass on the WebGL error:
      const errorMatcher = /(?:Compile|Link) error: ([^]*)/;
      const match = errorMatcher.exec(e.message);
      if (match) {
        onError(match[1]);
      } else {
        onError(e.message);
      }
    }
  };
}

function findVertexAttributes(gl, program, numberOfAttributes) {
  const attributes = {};
  for (let i = 0; i < numberOfAttributes; ++i) {
    const attr = gl.getActiveAttrib(program, i);
    const location = gl.getAttribLocation(program, attr.name);

    attributes[attr.name] = {
      name: attr.name,
      type: attr.type,
      index: location,
    };
  }

  return attributes;
}

function findUniforms(gl, program) {
  const uniformsByName = {};
  const uniforms = [];
  const samplerUniforms = [];

  const numberOfUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);

  for (let i = 0; i < numberOfUniforms; ++i) {
    const activeUniform = gl.getActiveUniform(program, i);
    const suffix = "[0]";
    const uniformName =
      activeUniform.name.indexOf(
        suffix,
        activeUniform.name.length - suffix.length,
      ) !== -1
        ? activeUniform.name.slice(0, activeUniform.name.length - 3)
        : activeUniform.name;

    // Ignore GLSL built-in uniforms returned in Firefox.
    if (uniformName.indexOf("gl_") !== 0) {
      if (!activeUniform.name.includes("[")) {
        // Single uniform
        const location = gl.getUniformLocation(program, uniformName);

        // IE 11.0.9 needs this check since getUniformLocation can return null
        // if the uniform is not active (e.g., it is optimized out).  Looks like
        // getActiveUniform() above returns uniforms that are not actually active.
        if (location !== null) {
          const uniform = createUniform(
            gl,
            activeUniform,
            uniformName,
            location,
          );

          uniformsByName[uniformName] = uniform;
          uniforms.push(uniform);

          if (uniform._setSampler) {
            samplerUniforms.push(uniform);
          }
        }
      } else {
        // Uniform array

        let uniformArray;
        let locations;
        let value;
        let loc;

        // On some platforms - Nexus 4 in Firefox for one - an array of sampler2D ends up being represented
        // as separate uniforms, one for each array element.  Check for and handle that case.
        const indexOfBracket = uniformName.indexOf("[");
        if (indexOfBracket >= 0) {
          // We're assuming the array elements show up in numerical order - it seems to be true.
          uniformArray = uniformsByName[uniformName.slice(0, indexOfBracket)];

          // Nexus 4 with Android 4.3 needs this check, because it reports a uniform
          // with the strange name webgl_3467e0265d05c3c1[1] in our globe surface shader.
          if (!defined(uniformArray)) {
            continue;
          }

          locations = uniformArray._locations;

          // On the Nexus 4 in Chrome, we get one uniform per sampler, just like in Firefox,
          // but the size is not 1 like it is in Firefox.  So if we push locations here,
          // we'll end up adding too many locations.
          if (locations.length <= 1) {
            value = uniformArray.value;
            loc = gl.getUniformLocation(program, uniformName);

            // Workaround for IE 11.0.9.  See above.
            if (loc !== null) {
              locations.push(loc);
              value.push(gl.getUniform(program, loc));
            }
          }
        } else {
          locations = [];
          for (let j = 0; j < activeUniform.size; ++j) {
            loc = gl.getUniformLocation(program, `${uniformName}[${j}]`);

            // Workaround for IE 11.0.9.  See above.
            if (loc !== null) {
              locations.push(loc);
            }
          }
          uniformArray = createUniformArray(
            gl,
            activeUniform,
            uniformName,
            locations,
          );

          uniformsByName[uniformName] = uniformArray;
          uniforms.push(uniformArray);

          if (uniformArray._setSampler) {
            samplerUniforms.push(uniformArray);
          }
        }
      }
    }
  }

  return {
    uniformsByName: uniformsByName,
    uniforms: uniforms,
    samplerUniforms: samplerUniforms,
  };
}

function partitionUniforms(shader, uniforms) {
  const automaticUniforms = [];
  const manualUniforms = [];

  for (const uniform in uniforms) {
    if (Object.hasOwn(uniforms, uniform)) {
      const uniformObject = uniforms[uniform];
      let uniformName = uniform;
      // if it's a duplicate uniform, use its original name so it is updated correctly
      const duplicateUniform = shader._duplicateUniformNames[uniformName];
      if (defined(duplicateUniform)) {
        uniformObject.name = duplicateUniform;
        uniformName = duplicateUniform;
      }
      const automaticUniform = AutomaticUniforms[uniformName];
      if (defined(automaticUniform)) {
        automaticUniforms.push({
          uniform: uniformObject,
          automaticUniform: automaticUniform,
        });
      } else {
        manualUniforms.push(uniformObject);
      }
    }
  }

  return {
    automaticUniforms: automaticUniforms,
    manualUniforms: manualUniforms,
  };
}

function setSamplerUniforms(gl, program, samplerUniforms) {
  gl.useProgram(program);

  let textureUnitIndex = 0;
  const length = samplerUniforms.length;
  for (let i = 0; i < length; ++i) {
    textureUnitIndex = samplerUniforms[i]._setSampler(textureUnitIndex);
  }

  gl.useProgram(null);

  return textureUnitIndex;
}

function initialize(shader) {
  if (shader._linkState === ShaderProgramLinkState.READY) {
    return;
  }

  if (shader._linkState === ShaderProgramLinkState.FAILED) {
    reportLinkFailure(shader);
  }

  const cachedShader = shader._cachedShader;
  const cache = defined(cachedShader) ? cachedShader.cache : undefined;
  if (defined(cache)) {
    cache._prepareShaderProgramForImmediateUse(shader);
  }

  shader._forceLinkCompletion();

  if (defined(cache)) {
    cache._shaderProgramCompilationFinished(shader);
  }

  if (shader._linkState === ShaderProgramLinkState.FAILED) {
    reportLinkFailure(shader);
  }
}

function reinitializeSynchronously(shader) {
  const oldProgram = shader._program;
  const gl = shader._gl;
  const cachedShader = shader._cachedShader;
  if (defined(cachedShader)) {
    cachedShader.cache._prepareShaderProgramForImmediateUse(shader);
  }

  const resources = submitLink(gl, shader);
  const program = resources.program;
  let linked;
  try {
    linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  } catch (error) {
    deleteLinkResources(gl, resources, true);
    throw createUnexpectedLinkFailure(error).error;
  }

  if (!linked) {
    let failure;
    try {
      failure = createLinkFailure(shader, resources);
    } catch (error) {
      failure = createUnexpectedLinkFailure(error);
    }
    deleteLinkResources(gl, resources, true);
    reportFailure(failure);
  }

  let programInfo;
  try {
    logSuccessfulCompilation(shader, resources);
    programInfo = createProgramInfo(shader, program);
    installSpectorHook(shader, program);
  } catch (error) {
    deleteLinkResources(gl, resources, true);
    throw createUnexpectedLinkFailure(error).error;
  }

  deleteLinkResources(gl, resources, false);
  publishProgramInfo(shader, programInfo);
  shader._linkState = ShaderProgramLinkState.READY;
  shader._linkError = undefined;
  shader._linkErrorMessages = undefined;
  shader._linkErrorReported = false;

  if (defined(oldProgram)) {
    gl.deleteProgram(oldProgram);
  }
}

function reportFailure(failure) {
  const messages = failure.messages;
  for (let i = 0; i < messages.length; ++i) {
    console.error(messages[i]);
  }
  throw failure.error;
}

export default ShaderProgram;
