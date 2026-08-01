import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import ShaderProgram from "./ShaderProgram.js";
import ShaderSource from "./ShaderSource.js";

const defaultMaximumPendingShaderPreparations = 32;
const defaultMinimumShaderPreparationTimeRemaining = 8.0;
const defaultShaderCompileIdleTimeout = 1000;

/**
 * @alias ShaderCache
 * @private
 */
class ShaderCache {
  constructor(context, options) {
    options = options ?? {};

    this._context = context;
    this._shaders = {};
    this._numberOfShaders = 0;
    this._shadersToRelease = {};

    const hasRequestIdleCallback = Object.hasOwn(
      options,
      "requestIdleCallback",
    );
    const hasCancelIdleCallback = Object.hasOwn(options, "cancelIdleCallback");
    this._requestIdleCallback = hasRequestIdleCallback
      ? options.requestIdleCallback
      : getGlobalIdleCallback("requestIdleCallback");
    this._cancelIdleCallback = hasCancelIdleCallback
      ? options.cancelIdleCallback
      : getGlobalIdleCallback("cancelIdleCallback");
    this._activeParallelShaderPrograms = new Set();
    this._parallelShaderPreparationQueue = [];
    this._maximumPendingShaderPreparations = getNonnegativeIntegerOption(
      options.maximumPendingShaderPreparations,
      defaultMaximumPendingShaderPreparations,
    );
    this._minimumShaderPreparationTimeRemaining = getNonnegativeNumberOption(
      options.minimumShaderPreparationTimeRemaining,
      defaultMinimumShaderPreparationTimeRemaining,
    );
    this._shaderCompileIdleTimeout = getNonnegativeIntegerOption(
      options.shaderCompileIdleTimeout,
      defaultShaderCompileIdleTimeout,
    );
    this._getTimestamp =
      typeof options.getTimestamp === "function"
        ? options.getTimestamp
        : getTimestamp;
    this._parallelShaderCompileIdleCallback = undefined;
    this._destroying = false;
  }

  get numberOfShaders() {
    return this._numberOfShaders;
  }

  /**
   * Returns a shader program from the cache, or creates and caches a new shader program,
   * given the GLSL vertex and fragment shader source and attribute locations.
   * <p>
   * The difference between this and {@link ShaderCache#getShaderProgram}, is this is used to
   * replace an existing reference to a shader program, which is passed as the first argument.
   * </p>
   *
   * @param {object} options Object with the following properties:
   * @param {ShaderProgram} [options.shaderProgram] The shader program that is being reassigned.
   * @param {string|ShaderSource} options.vertexShaderSource The GLSL source for the vertex shader.
   * @param {string|ShaderSource} options.fragmentShaderSource The GLSL source for the fragment shader.
   * @param {object} options.attributeLocations Indices for the attribute inputs to the vertex shader.
   * @returns {ShaderProgram} The cached or newly created shader program.
   *
   * @example
   * this._shaderProgram = context.shaderCache.replaceShaderProgram({
   *     shaderProgram : this._shaderProgram,
   *     vertexShaderSource : vs,
   *     fragmentShaderSource : fs,
   *     attributeLocations : attributeLocations
   * });
   *
   * @see ShaderCache#getShaderProgram
   */
  replaceShaderProgram(options) {
    if (defined(options.shaderProgram)) {
      options.shaderProgram.destroy();
    }

    return this.getShaderProgram(options);
  }

  /**
   * Returns a shader program from the cache, or creates and caches a new shader program,
   * given the GLSL vertex and fragment shader source and attribute locations.
   *
   * @param {object} options Object with the following properties:
   * @param {string|ShaderSource} options.vertexShaderSource The GLSL source for the vertex shader.
   * @param {string|ShaderSource} options.fragmentShaderSource The GLSL source for the fragment shader.
   * @param {object} options.attributeLocations Indices for the attribute inputs to the vertex shader.
   *
   * @returns {ShaderProgram} The cached or newly created shader program.
   */
  getShaderProgram(options) {
    // convert shaders which are provided as strings into ShaderSource objects
    // because ShaderSource handles all the automatic including of built-in functions, etc.

    let vertexShaderSource = options.vertexShaderSource;
    let fragmentShaderSource = options.fragmentShaderSource;
    const attributeLocations = options.attributeLocations;

    if (typeof vertexShaderSource === "string") {
      vertexShaderSource = new ShaderSource({
        sources: [vertexShaderSource],
      });
    }

    if (typeof fragmentShaderSource === "string") {
      fragmentShaderSource = new ShaderSource({
        sources: [fragmentShaderSource],
      });
    }

    // Since ShaderSource.createCombinedXxxShader() can be expensive, use a
    // simpler key for caching. This way, the function does not have to be called
    // for each cache lookup.
    const vertexShaderKey = vertexShaderSource.getCacheKey();
    const fragmentShaderKey = fragmentShaderSource.getCacheKey();
    // Sort the keys in the JSON to ensure a consistent order
    const attributeLocationKey = defined(attributeLocations)
      ? toSortedJson(attributeLocations)
      : "";
    const keyword = `${vertexShaderKey}:${fragmentShaderKey}:${attributeLocationKey}`;

    let cachedShader;
    if (defined(this._shaders[keyword])) {
      cachedShader = this._shaders[keyword];

      // No longer want to release this if it was previously released.
      delete this._shadersToRelease[keyword];
    } else {
      const context = this._context;

      const vertexShaderText =
        vertexShaderSource.createCombinedVertexShader(context);
      const fragmentShaderText =
        fragmentShaderSource.createCombinedFragmentShader(context);

      const shaderProgram = new ShaderProgram({
        gl: context._gl,
        graphicsCapabilities: context.graphicsCapabilities,
        logShaderCompilation: context.logShaderCompilation,
        debugShaders: context.debugShaders,
        parallelShaderCompile: context._parallelShaderCompile,
        vertexShaderSource: vertexShaderSource,
        vertexShaderText: vertexShaderText,
        fragmentShaderSource: fragmentShaderSource,
        fragmentShaderText: fragmentShaderText,
        attributeLocations: attributeLocations,
      });

      cachedShader = {
        cache: this,
        shaderProgram: shaderProgram,
        keyword: keyword,
        derivedKeywords: [],
        count: 0,
      };

      // A shader can't be in more than one cache.
      shaderProgram._cachedShader = cachedShader;
      this._shaders[keyword] = cachedShader;
      ++this._numberOfShaders;
    }

    ++cachedShader.count;
    return cachedShader.shaderProgram;
  }

  replaceDerivedShaderProgram(shaderProgram, keyword, options) {
    const cachedShader = shaderProgram._cachedShader;
    const derivedKeyword = keyword + cachedShader.keyword;
    const cachedDerivedShader = this._shaders[derivedKeyword];
    if (defined(cachedDerivedShader)) {
      destroyShader(this, cachedDerivedShader);
      const index = cachedShader.derivedKeywords.indexOf(keyword);
      if (index > -1) {
        cachedShader.derivedKeywords.splice(index, 1);
      }
    }

    return this.createDerivedShaderProgram(shaderProgram, keyword, options);
  }

  getDerivedShaderProgram(shaderProgram, keyword) {
    const cachedShader = shaderProgram._cachedShader;
    const derivedKeyword = keyword + cachedShader.keyword;
    const cachedDerivedShader = this._shaders[derivedKeyword];
    if (!defined(cachedDerivedShader)) {
      return undefined;
    }

    return cachedDerivedShader.shaderProgram;
  }

  createDerivedShaderProgram(shaderProgram, keyword, options) {
    const cachedShader = shaderProgram._cachedShader;
    const derivedKeyword = keyword + cachedShader.keyword;

    let vertexShaderSource = options.vertexShaderSource;
    let fragmentShaderSource = options.fragmentShaderSource;
    const attributeLocations = options.attributeLocations;

    if (typeof vertexShaderSource === "string") {
      vertexShaderSource = new ShaderSource({
        sources: [vertexShaderSource],
      });
    }

    if (typeof fragmentShaderSource === "string") {
      fragmentShaderSource = new ShaderSource({
        sources: [fragmentShaderSource],
      });
    }

    const context = this._context;

    const vertexShaderText =
      vertexShaderSource.createCombinedVertexShader(context);
    const fragmentShaderText =
      fragmentShaderSource.createCombinedFragmentShader(context);

    const derivedShaderProgram = new ShaderProgram({
      gl: context._gl,
      graphicsCapabilities: context.graphicsCapabilities,
      logShaderCompilation: context.logShaderCompilation,
      debugShaders: context.debugShaders,
      parallelShaderCompile: context._parallelShaderCompile,
      vertexShaderSource: vertexShaderSource,
      vertexShaderText: vertexShaderText,
      fragmentShaderSource: fragmentShaderSource,
      fragmentShaderText: fragmentShaderText,
      attributeLocations: attributeLocations,
    });

    const derivedCachedShader = {
      cache: this,
      shaderProgram: derivedShaderProgram,
      keyword: derivedKeyword,
      derivedKeywords: [],
      count: 0,
    };

    cachedShader.derivedKeywords.push(keyword);
    derivedShaderProgram._cachedShader = derivedCachedShader;
    this._shaders[derivedKeyword] = derivedCachedShader;
    return derivedShaderProgram;
  }

  scheduleShaderProgramCompilation(shaderProgram) {
    if (
      !this._canCompileShadersInParallel() ||
      !defined(shaderProgram) ||
      this._activeParallelShaderPrograms.has(shaderProgram) ||
      !defined(shaderProgram._cachedShader) ||
      shaderProgram._cachedShader.cache !== this ||
      !shaderProgram._isLinkPending()
    ) {
      return false;
    }

    // KHR_parallel_shader_compile is most effective when every required link
    // is submitted before completion is polled. Required programs are already
    // fully selected by the caller, so submit each one immediately instead of
    // serializing their links behind a single active slot.
    if (!shaderProgram._startLink()) {
      return false;
    }

    this._activeParallelShaderPrograms.add(shaderProgram);
    this._scheduleParallelShaderCompileIdleCallback();
    return true;
  }

  scheduleShaderProgramPreparation(prepareShaderProgram, owner) {
    if (
      !this._canCompileShadersInParallel() ||
      typeof prepareShaderProgram !== "function" ||
      this._parallelShaderPreparationQueue.length >=
        this._maximumPendingShaderPreparations
    ) {
      return false;
    }

    this._parallelShaderPreparationQueue.push({
      prepareShaderProgram: prepareShaderProgram,
      owner: owner,
      enqueueTime: this._getTimestamp(),
    });
    this._scheduleParallelShaderCompileIdleCallback();
    return true;
  }

  cancelShaderProgramPreparations(owner) {
    if (!defined(owner)) {
      return 0;
    }

    const queue = this._parallelShaderPreparationQueue;
    let writeIndex = 0;
    let canceledCount = 0;
    for (let readIndex = 0; readIndex < queue.length; ++readIndex) {
      const preparation = queue[readIndex];
      if (preparation.owner === owner) {
        ++canceledCount;
      } else {
        queue[writeIndex++] = preparation;
      }
    }
    queue.length = writeIndex;

    this._cancelParallelShaderCompileIdleCallbackIfFinished();
    return canceledCount;
  }

  _prepareShaderProgramForImmediateUse(shaderProgram) {
    if (this._destroying) {
      return;
    }

    this._removeShaderProgramFromParallelCompile(shaderProgram);
  }

  _shaderProgramCompilationFinished(shaderProgram) {
    if (this._destroying) {
      return;
    }

    this._removeShaderProgramFromParallelCompile(shaderProgram);
  }

  _removeShaderProgramFromParallelCompile(shaderProgram) {
    this._activeParallelShaderPrograms.delete(shaderProgram);

    this._cancelParallelShaderCompileIdleCallbackIfFinished();
  }

  _canCompileShadersInParallel() {
    return (
      !this._destroying &&
      defined(this._context._parallelShaderCompile) &&
      typeof this._requestIdleCallback === "function" &&
      typeof this._cancelIdleCallback === "function"
    );
  }

  _scheduleParallelShaderCompileIdleCallback() {
    if (
      this._destroying ||
      defined(this._parallelShaderCompileIdleCallback) ||
      (this._activeParallelShaderPrograms.size === 0 &&
        this._parallelShaderPreparationQueue.length === 0)
    ) {
      return;
    }

    let timeout = this._shaderCompileIdleTimeout;
    const oldestPreparation = this._parallelShaderPreparationQueue[0];
    if (defined(oldestPreparation)) {
      timeout = Math.max(
        0,
        timeout - (this._getTimestamp() - oldestPreparation.enqueueTime),
      );
    }

    this._parallelShaderCompileIdleCallback = this._requestIdleCallback(
      (deadline) => {
        this._parallelShaderCompileIdleCallback = undefined;
        if (this._destroying) {
          return;
        }
        this._processParallelShaderCompileIdleCallback(deadline);
      },
      {
        timeout: timeout,
      },
    );
  }

  _processParallelShaderCompileIdleCallback(deadline) {
    if (this._destroying) {
      return;
    }

    // Completion polling is intentionally independent of the remaining idle
    // budget. COMPLETION_STATUS_KHR is the nonblocking operation in this
    // lifecycle, and polling it lets every required program make progress even
    // when a continuously animated page receives zero-budget idle callbacks.
    const activeShaderPrograms = this._activeParallelShaderPrograms;
    const processedActiveShaderPrograms = activeShaderPrograms.size > 0;
    for (const shaderProgram of activeShaderPrograms) {
      if (shaderProgram._pollLinkCompletion()) {
        activeShaderPrograms.delete(shaderProgram);
      }
    }

    if (
      !processedActiveShaderPrograms &&
      activeShaderPrograms.size === 0 &&
      this._parallelShaderPreparationQueue.length > 0 &&
      canRunShaderPreparation(
        deadline,
        this._minimumShaderPreparationTimeRemaining,
        this._parallelShaderPreparationQueue[0],
        this._getTimestamp(),
        this._shaderCompileIdleTimeout,
      )
    ) {
      const preparation = this._parallelShaderPreparationQueue.shift();
      try {
        const shaderProgram = preparation.prepareShaderProgram();
        this.scheduleShaderProgramCompilation(shaderProgram);
      } catch (error) {
        console.error("Asynchronous shader preparation failed.", error);
      }
    }

    this._scheduleParallelShaderCompileIdleCallback();
  }

  _cancelParallelShaderCompileIdleCallbackIfFinished() {
    if (
      this._activeParallelShaderPrograms.size === 0 &&
      this._parallelShaderPreparationQueue.length === 0 &&
      defined(this._parallelShaderCompileIdleCallback)
    ) {
      this._cancelIdleCallback(this._parallelShaderCompileIdleCallback);
      this._parallelShaderCompileIdleCallback = undefined;
    }
  }

  destroyReleasedShaderPrograms() {
    const shadersToRelease = this._shadersToRelease;

    for (const keyword in shadersToRelease) {
      if (Object.hasOwn(shadersToRelease, keyword)) {
        const cachedShader = shadersToRelease[keyword];
        destroyShader(this, cachedShader);
        --this._numberOfShaders;
      }
    }

    this._shadersToRelease = {};
  }

  releaseShaderProgram(shaderProgram) {
    if (defined(shaderProgram)) {
      const cachedShader = shaderProgram._cachedShader;
      if (cachedShader && --cachedShader.count === 0) {
        unscheduleShaderTree(this, cachedShader);
        this._shadersToRelease[cachedShader.keyword] = cachedShader;
      }
    }
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    this._destroying = true;
    if (defined(this._parallelShaderCompileIdleCallback)) {
      this._cancelIdleCallback(this._parallelShaderCompileIdleCallback);
      this._parallelShaderCompileIdleCallback = undefined;
    }
    this._activeParallelShaderPrograms.clear();
    this._parallelShaderPreparationQueue.length = 0;

    const shaders = this._shaders;
    for (const keyword in shaders) {
      if (Object.hasOwn(shaders, keyword)) {
        shaders[keyword].shaderProgram.finalDestroy();
      }
    }
    return destroyObject(this);
  }
}

function getGlobalIdleCallback(name) {
  if (
    typeof globalThis === "undefined" ||
    typeof globalThis[name] !== "function"
  ) {
    return undefined;
  }

  return globalThis[name].bind(globalThis);
}

function getNonnegativeIntegerOption(value, defaultValue) {
  return Number.isInteger(value) && value >= 0 ? value : defaultValue;
}

function getNonnegativeNumberOption(value, defaultValue) {
  return typeof value === "number" && value >= 0 ? value : defaultValue;
}

function getTimestamp() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function canRunShaderPreparation(
  deadline,
  minimumTimeRemaining,
  preparation,
  timestamp,
  timeout,
) {
  if (defined(preparation) && timestamp - preparation.enqueueTime >= timeout) {
    return true;
  }
  if (!defined(deadline)) {
    return true;
  }
  if (deadline.didTimeout === true) {
    return true;
  }
  if (typeof deadline.timeRemaining !== "function") {
    return true;
  }
  return deadline.timeRemaining() >= minimumTimeRemaining;
}

function toSortedJson(dictionary) {
  const sortedKeys = Object.keys(dictionary).sort();
  return JSON.stringify(dictionary, sortedKeys);
}

function destroyShader(cache, cachedShader) {
  const derivedKeywords = cachedShader.derivedKeywords;
  const length = derivedKeywords.length;
  for (let i = 0; i < length; ++i) {
    const keyword = derivedKeywords[i] + cachedShader.keyword;
    const derivedCachedShader = cache._shaders[keyword];
    destroyShader(cache, derivedCachedShader);
  }

  delete cache._shaders[cachedShader.keyword];
  cachedShader.shaderProgram.finalDestroy();
}

function unscheduleShaderTree(cache, cachedShader) {
  const derivedKeywords = cachedShader.derivedKeywords;
  const length = derivedKeywords.length;
  for (let i = 0; i < length; ++i) {
    const keyword = derivedKeywords[i] + cachedShader.keyword;
    const derivedCachedShader = cache._shaders[keyword];
    if (defined(derivedCachedShader)) {
      unscheduleShaderTree(cache, derivedCachedShader);
    }
  }

  cache._removeShaderProgramFromParallelCompile(cachedShader.shaderProgram);
}

export default ShaderCache;
