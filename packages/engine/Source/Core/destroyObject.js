import DeveloperError from "./DeveloperError.js";

function returnTrue() {
  return true;
}

/**
 * Destroys an object.  Each of the object's functions, including functions in its prototype
 * chain, is replaced with a function that throws a {@link DeveloperError}, except for the
 * object's <code>isDestroyed</code> function, which is set to a function that returns
 * <code>true</code>.
 * <br /><br />
 * This function is used by objects that hold native resources, e.g., WebGL resources, which
 * need to be explicitly released.  Client code calls an object's <code>destroy</code> function,
 * which then releases the native resource and calls <code>destroyObject</code> to put itself
 * in a destroyed state.
 *
 * @function
 *
 * @param {object} object The object to destroy.
 * @param {string} [message] The message to include in the exception that is thrown if
 *                           a destroyed object's function is called.
 *
 *
 * @example
 * // How a texture would destroy itself.
 * this.destroy = function () {
 *     _gl.deleteTexture(_texture);
 *     return Cesium.destroyObject(this);
 * };
 *
 * @see DeveloperError
 */
function destroyObject(object, message) {
  message = message ?? "This object was destroyed, i.e., destroy() was called.";

  function throwOnDestroyed() {
    //>>includeStart('debug', pragmas.debug);
    throw new DeveloperError(message);
    //>>includeEnd('debug');
  }

  // Walk own properties plus the full prototype chain. ES6 class methods are
  // non-enumerable prototype properties, so the historical for...in loop never
  // saw them — a destroyed ES6-class instance kept live methods and a second
  // destroy() could repeat native resource teardown. Property descriptors are
  // inspected instead of property values so accessor getters are never
  // invoked. The walk stops before Object.prototype, and `constructor` is
  // skipped so class statics are never reachable or modified.
  const processed = new Set(["isDestroyed", "constructor"]);
  for (
    let current = object;
    current !== null && current !== Object.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    const names = Object.getOwnPropertyNames(current);
    for (let i = 0; i < names.length; ++i) {
      const key = names[i];
      if (processed.has(key)) {
        continue;
      }
      // Nearest-to-instance descriptor wins, matching property lookup.
      processed.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      // Accessors are skipped without invoking their getters; only data
      // properties holding functions become throwOnDestroyed.
      if (typeof descriptor.value !== "function") {
        continue;
      }
      const own = current === object ? descriptor : undefined;
      if (own !== undefined && !own.configurable) {
        if (own.writable) {
          object[key] = throwOnDestroyed;
        }
        // A non-configurable, non-writable own function cannot be replaced.
        continue;
      }
      Object.defineProperty(object, key, {
        value: throwOnDestroyed,
        writable: true,
        configurable: true,
        // Preserve the visibility the caller saw: own properties keep their
        // enumerability; shadowed prototype methods stay non-enumerable.
        enumerable: own !== undefined ? own.enumerable : false,
      });
    }
  }

  Object.defineProperty(object, "isDestroyed", {
    value: returnTrue,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  return undefined;
}
export default destroyObject;
