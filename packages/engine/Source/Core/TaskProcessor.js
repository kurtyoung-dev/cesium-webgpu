import buildModuleUrl from "./buildModuleUrl.js";
import defined from "./defined.js";
import destroyObject from "./destroyObject.js";
import DeveloperError from "./DeveloperError.js";
import Event from "./Event.js";
import FeatureDetection from "./FeatureDetection.js";
import isCrossOriginUrl from "./isCrossOriginUrl.js";
import Resource from "./Resource.js";
import RuntimeError from "./RuntimeError.js";

function canTransferArrayBuffer() {
  if (!defined(TaskProcessor._canTransferArrayBuffer)) {
    const worker = createWorker("transferTypedArrayTest");
    worker.postMessage = worker.webkitPostMessage ?? worker.postMessage;

    const value = 99;
    const array = new Int8Array([value]);

    try {
      // postMessage might fail with a DataCloneError
      // if transferring array buffers is not supported.
      worker.postMessage(
        {
          array: array,
        },
        [array.buffer],
      );
    } catch (e) {
      TaskProcessor._canTransferArrayBuffer = false;
      return TaskProcessor._canTransferArrayBuffer;
    }

    TaskProcessor._canTransferArrayBuffer = new Promise((resolve) => {
      const settle = (result) => {
        resolve(result);

        worker.terminate();

        TaskProcessor._canTransferArrayBuffer = result;
      };

      worker.onmessage = function (event) {
        const array = event.data.array;

        // some versions of Firefox silently fail to transfer typed arrays.
        // https://bugzilla.mozilla.org/show_bug.cgi?id=841904
        // Check to make sure the value round-trips successfully.
        settle(defined(array) && array[0] === value);
      };

      // This answer is cached for the lifetime of the page and the first task
      // of every processor waits on it, so a probe worker that cannot load or
      // whose reply cannot be read answers "no transferables" rather than
      // nothing. Copying is always correct; stranding every later caller is not.
      worker.onerror = () => settle(false);
      worker.onmessageerror = () => settle(false);
    });
  }

  return TaskProcessor._canTransferArrayBuffer;
}

const taskCompletedEvent = new Event();

function urlFromScript(script) {
  let blob;
  try {
    blob = new Blob([script], {
      type: "application/javascript",
    });
  } catch (e) {
    const BlobBuilder =
      window.BlobBuilder ||
      window.WebKitBlobBuilder ||
      window.MozBlobBuilder ||
      window.MSBlobBuilder;
    const blobBuilder = new BlobBuilder();
    blobBuilder.append(script);
    blob = blobBuilder.getBlob("application/javascript");
  }

  const URL = window.URL || window.webkitURL;
  return URL.createObjectURL(blob);
}

function createWorker(url) {
  // Detect whether `url` is a full URI (has scheme) or a bare module ID.
  let isUri = false;
  try {
    const parsed = new URL(url);
    isUri = parsed.protocol.length > 1 && !url.includes("#");
  } catch {
    // Not a valid absolute URL → treat as module ID
  }
  const moduleID = url.replace(/\.js$/, "");

  const options = {};
  let workerPath;
  let crossOriginUrl;

  // If we are provided a fully resolved URL, check it is cross-origin
  // Or if provided a module ID, check the full absolute URL instead.
  if (isCrossOriginUrl(url)) {
    crossOriginUrl = url;
  } else if (!isUri) {
    const moduleAbsoluteUrl = buildModuleUrl(
      `${TaskProcessor._workerModulePrefix}/${moduleID}.js`,
    );

    if (isCrossOriginUrl(moduleAbsoluteUrl)) {
      crossOriginUrl = moduleAbsoluteUrl;
    }
  }

  if (crossOriginUrl) {
    // To load cross-origin, create a shim worker from a blob URL
    const script = `import "${crossOriginUrl}";`;
    workerPath = urlFromScript(script);
    options.type = "module";
    return new Worker(workerPath, options);
  }

  /* global CESIUM_WORKERS */
  if (!isUri && typeof CESIUM_WORKERS !== "undefined") {
    // If the workers are embedded, create a shim worker from the embedded script data
    const script = `
      importScripts("${urlFromScript(CESIUM_WORKERS)}");
      CesiumWorkers["${moduleID}"]();
    `;
    workerPath = urlFromScript(script);
    return new Worker(workerPath, options);
  }

  workerPath = url;

  if (!isUri) {
    workerPath = buildModuleUrl(
      `${TaskProcessor._workerModulePrefix + moduleID}.js`,
    );
  }

  if (!FeatureDetection.supportsEsmWebWorkers()) {
    throw new RuntimeError(
      "This browser is not supported. Please update your browser to continue.",
    );
  }

  options.type = "module";

  return new Worker(workerPath, options);
}

async function getWebAssemblyLoaderConfig(processor, wasmOptions) {
  const config = {
    modulePath: undefined,
    wasmBinaryFile: undefined,
    wasmBinary: undefined,
  };

  // Web assembly not supported, use fallback js module if provided
  if (!FeatureDetection.supportsWebAssembly()) {
    if (!defined(wasmOptions.fallbackModulePath)) {
      throw new RuntimeError(
        `This browser does not support Web Assembly, and no backup module was provided for ${processor._workerPath}`,
      );
    }

    config.modulePath = buildModuleUrl(wasmOptions.fallbackModulePath);
    return config;
  }

  config.wasmBinaryFile = buildModuleUrl(wasmOptions.wasmBinaryFile);

  const arrayBuffer = await Resource.fetchArrayBuffer({
    url: config.wasmBinaryFile,
  });

  config.wasmBinary = arrayBuffer;
  return config;
}

function workerErrorMessage(workerPath, event) {
  const reason =
    event?.message ??
    "the worker script failed to load or threw before it could respond";
  const filename = defined(event?.filename) ? ` (${event.filename})` : "";
  return `An error occurred in the worker ${workerPath}${filename}: ${reason}`;
}

function workerMessageErrorMessage(workerPath) {
  return `A message from the worker ${workerPath} could not be deserialized.`;
}

/**
 * A wrapper around a web worker that allows scheduling tasks for a given worker,
 * returning results asynchronously via a promise.
 *
 * The Worker is not constructed until a task is scheduled.
 *
 * @alias TaskProcessor
 * @constructor
 *
 * @param {string} workerPath The Url to the worker. This can either be an absolute path or relative to the Cesium Workers folder.
 * @param {number} [maximumActiveTasks=Number.POSITIVE_INFINITY] The maximum number of active tasks.  Once exceeded,
 *                                        scheduleTask will not queue any more tasks, allowing
 *                                        work to be rescheduled in future frames.
 */
class TaskProcessor {
  constructor(workerPath, maximumActiveTasks) {
    this._workerPath = workerPath;
    this._maximumActiveTasks = maximumActiveTasks ?? Number.POSITIVE_INFINITY;
    this._activeTasks = 0;
    this._nextID = 0;
    this._webAssemblyPromise = undefined;
  }

  /**
   * Schedule a task to be processed by the web worker asynchronously.  If there are currently more
   * tasks active than the maximum set by the constructor, will immediately return undefined.
   * Otherwise, returns a promise that will resolve to the result posted back by the worker when
   * finished.
   *
   * @param {object} parameters Any input data that will be posted to the worker.
   * @param {object[]} [transferableObjects] An array of objects contained in parameters that should be
   *                                      transferred to the worker instead of copied.
   * @returns {Promise<object>|undefined} Either a promise that will resolve to the result when available, or undefined
   *                    if there are too many active tasks,
   *
   * @example
   * const taskProcessor = new Cesium.TaskProcessor('myWorkerPath');
   * const promise = taskProcessor.scheduleTask({
   *     someParameter : true,
   *     another : 'hello'
   * });
   * if (!Cesium.defined(promise)) {
   *     // too many active tasks - try again later
   * } else {
   *     promise.then(function(result) {
   *         // use the result of the task
   *     });
   * }
   */
  scheduleTask(parameters, transferableObjects) {
    if (!defined(this._worker)) {
      this._worker = createWorker(this._workerPath);
    }

    if (this._activeTasks >= this._maximumActiveTasks) {
      return undefined;
    }

    return scheduleTask(this, parameters, transferableObjects);
  }

  /**
   * Posts a message to a web worker with configuration to initialize loading
   * and compiling a web assembly module asynchronously, as well as an optional
   * fallback JavaScript module to use if Web Assembly is not supported.
   *
   * @param {object} [webAssemblyOptions] An object with the following properties:
   * @param {string} [webAssemblyOptions.modulePath] The path of the web assembly JavaScript wrapper module.
   * @param {string} [webAssemblyOptions.wasmBinaryFile] The path of the web assembly binary file.
   * @param {string} [webAssemblyOptions.fallbackModulePath] The path of the fallback JavaScript module to use if web assembly is not supported.
   * @returns {Promise<*>} A promise that resolves to the result when the web worker has loaded and compiled the web assembly module and is ready to process tasks.
   *
   * @exception {RuntimeError} This browser does not support Web Assembly, and no backup module was provided
   */
  initWebAssemblyModule(webAssemblyOptions) {
    if (defined(this._webAssemblyPromise)) {
      return this._webAssemblyPromise;
    }

    const init = async () => {
      const worker = (this._worker = createWorker(this._workerPath));

      // Installed before the first await for the reason runTask subscribes
      // early — the worker's `error` event is one-shot and the config below
      // costs a fetch — and this promise is cached for the lifetime of the
      // processor, so a lost event leaves every caller waiting on a promise
      // that can neither resolve nor reject.
      const promise = new Promise((resolve, reject) => {
        worker.onmessage = function ({ data }) {
          if (defined(data)) {
            resolve(data.result);
          } else {
            reject(new RuntimeError("Could not configure wasm module"));
          }
        };
        worker.onerror = (event) => {
          const message = workerErrorMessage(this._workerPath, event);
          event?.preventDefault?.();
          console.error(message);
          reject(new RuntimeError(message));
        };
        worker.onmessageerror = () => {
          reject(new RuntimeError(workerMessageErrorMessage(this._workerPath)));
        };
      });
      promise.catch(() => {});

      const wasmConfig = await getWebAssemblyLoaderConfig(
        this,
        webAssemblyOptions,
      );
      const canTransfer = await Promise.resolve(canTransferArrayBuffer());
      let transferableObjects;
      const binary = wasmConfig.wasmBinary;
      if (defined(binary) && canTransfer) {
        transferableObjects = [binary];
      }

      worker.postMessage(
        {
          canTransferArrayBuffer: canTransfer,
          parameters: { webAssemblyConfig: wasmConfig },
        },
        transferableObjects,
      );

      return promise;
    };

    this._webAssemblyPromise = init();
    return this._webAssemblyPromise;
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} True if this object was destroyed; otherwise, false.
   *
   * @see TaskProcessor#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys this object.  This will immediately terminate the Worker.
   * <br /><br />
   * Once an object is destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   */
  destroy() {
    if (defined(this._worker)) {
      this._worker.terminate();
    }
    return destroyObject(this);
  }
}

const createTaskListeners = (worker, workerPath, id, resolve, reject) => {
  const listeners = {};

  // The three listeners are removed together: the task settles once, and a
  // worker-level failure settles every task that worker is carrying.
  const removeListeners = () => {
    worker.removeEventListener("message", listeners.message);
    worker.removeEventListener("error", listeners.error);
    worker.removeEventListener("messageerror", listeners.messageerror);
  };

  listeners.message = ({ data }) => {
    if (data.id !== id) {
      return;
    }

    if (defined(data.error)) {
      let error = data.error;
      if (error.name === "RuntimeError") {
        error = new RuntimeError(data.error.message);
        error.stack = data.error.stack;
      } else if (error.name === "DeveloperError") {
        error = new DeveloperError(data.error.message);
        error.stack = data.error.stack;
      } else if (error.name === "Error") {
        error = new Error(data.error.message);
        error.stack = data.error.stack;
      }
      taskCompletedEvent.raiseEvent(error);
      reject(error);
    } else {
      taskCompletedEvent.raiseEvent();
      resolve(data.result);
    }

    removeListeners();
  };

  // A worker that fails to load, is blocked, or throws at the top level posts
  // no message at all; without this the task promise never settles and the
  // active-task slot it holds is never released.
  listeners.error = (event) => {
    const message = workerErrorMessage(workerPath, event);
    // The rejection is this failure's handled channel. Left unmarked, the event
    // also reaches the page's global error handler, where it surfaces as an
    // uncaught error from a worker the caller already heard about.
    event?.preventDefault?.();
    console.error(message);
    const error = new RuntimeError(message);
    taskCompletedEvent.raiseEvent(error);
    reject(error);
    removeListeners();
  };

  listeners.messageerror = () => {
    const error = new RuntimeError(workerMessageErrorMessage(workerPath));
    taskCompletedEvent.raiseEvent(error);
    reject(error);
    removeListeners();
  };

  listeners.remove = removeListeners;

  return listeners;
};

const emptyTransferableObjectArray = [];
function runTask(processor, parameters, transferableObjects) {
  // The worker was built synchronously by the caller and its `error` event is
  // one-shot, so the task subscribes before anything asynchronous happens.
  const id = processor._nextID++;
  let rejectTask;
  let taskListeners;
  const promise = new Promise((resolve, reject) => {
    rejectTask = reject;
    taskListeners = createTaskListeners(
      processor._worker,
      processor._workerPath,
      id,
      resolve,
      reject,
    );
    processor._worker.addEventListener("message", taskListeners.message);
    processor._worker.addEventListener("error", taskListeners.error);
    processor._worker.addEventListener(
      "messageerror",
      taskListeners.messageerror,
    );
  });

  // The message is posted once the transferable-array capability is known, but
  // the promise is returned without waiting for it: that probe is a worker
  // round trip of its own, and a task whose worker is already failing must be
  // able to reject whatever the probe does.
  Promise.resolve(canTransferArrayBuffer())
    .then((canTransfer) => {
      if (!defined(transferableObjects)) {
        transferableObjects = emptyTransferableObjectArray;
      } else if (!canTransfer) {
        transferableObjects.length = 0;
      }

      processor._worker.postMessage(
        {
          id: id,
          baseUrl: buildModuleUrl.getCesiumBaseUrl().url,
          parameters: parameters,
          canTransferArrayBuffer: canTransfer,
        },
        transferableObjects,
      );
    })
    // A probe that rejects, or a `postMessage` that throws on an uncloneable
    // parameter, settles the task the way the await used to. No listener has
    // fired on this route, so the subscriptions are released here.
    .catch((error) => {
      rejectTask(error);
      taskListeners.remove();
    });

  return promise;
}

async function scheduleTask(processor, parameters, transferableObjects) {
  ++processor._activeTasks;

  try {
    const result = await runTask(processor, parameters, transferableObjects);
    --processor._activeTasks;
    return result;
  } catch (error) {
    --processor._activeTasks;
    throw error;
  }
}

/**
 * An event that's raised when a task is completed successfully.  Event handlers are passed
 * the error object is a task fails.
 *
 * @type {Event}
 *
 * @private
 */
TaskProcessor.taskCompletedEvent = taskCompletedEvent;

// exposed for testing purposes
TaskProcessor._defaultWorkerModulePrefix = "Workers/";
TaskProcessor._workerModulePrefix = TaskProcessor._defaultWorkerModulePrefix;
TaskProcessor._canTransferArrayBuffer = undefined;
export default TaskProcessor;
