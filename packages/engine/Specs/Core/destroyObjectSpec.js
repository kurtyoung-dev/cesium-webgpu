import { destroyObject, DeveloperError } from "../../index.js";

describe("Core/destroyObject", function () {
  it("replaces instance-owned functions", function () {
    const object = {
      teardownCount: 0,
    };
    object.destroy = function () {
      ++this.teardownCount;
      return destroyObject(this);
    };
    object.doWork = function () {
      return 42;
    };

    object.destroy();

    expect(object.isDestroyed()).toBe(true);
    expect(object.teardownCount).toBe(1);
    expect(function () {
      object.doWork();
    }).toThrowDeveloperError();
    expect(function () {
      object.destroy();
    }).toThrowDeveloperError();
    expect(object.teardownCount).toBe(1);
  });

  it("replaces legacy prototype functions", function () {
    function Legacy() {
      this.teardownCount = 0;
    }
    Legacy.prototype.destroy = function () {
      ++this.teardownCount;
      return destroyObject(this);
    };
    Legacy.prototype.doWork = function () {
      return 42;
    };

    const object = new Legacy();
    object.destroy();

    expect(object.isDestroyed()).toBe(true);
    expect(function () {
      object.doWork();
    }).toThrowDeveloperError();
    expect(function () {
      object.destroy();
    }).toThrowDeveloperError();
    expect(object.teardownCount).toBe(1);
  });

  it("replaces ES6 class prototype methods so a second destroy cannot repeat native teardown", function () {
    class Resource {
      constructor() {
        this.teardownCount = 0;
      }
      isDestroyed() {
        return false;
      }
      doWork() {
        return 42;
      }
      destroy() {
        ++this.teardownCount;
        return destroyObject(this);
      }
    }

    const object = new Resource();
    expect(object.isDestroyed()).toBe(false);
    object.destroy();

    expect(object.isDestroyed()).toBe(true);
    expect(function () {
      object.doWork();
    }).toThrowDeveloperError();
    expect(function () {
      object.destroy();
    }).toThrowDeveloperError();
    expect(object.teardownCount).toBe(1);
  });

  it("replaces inherited ES6 superclass methods", function () {
    class Base {
      baseWork() {
        return 1;
      }
    }
    class Derived extends Base {
      isDestroyed() {
        return false;
      }
      destroy() {
        return destroyObject(this);
      }
    }

    const object = new Derived();
    object.destroy();

    expect(object.isDestroyed()).toBe(true);
    expect(function () {
      object.baseWork();
    }).toThrowDeveloperError();
    // The shared prototypes themselves must not be mutated.
    expect(new Derived().baseWork()).toBe(1);
    expect(new Base().baseWork()).toBe(1);
  });

  it("does not invoke accessor getters", function () {
    let getterCalls = 0;
    class Resource {
      get lazyValue() {
        ++getterCalls;
        return function () {};
      }
      isDestroyed() {
        return false;
      }
      destroy() {
        return destroyObject(this);
      }
    }

    const object = new Resource();
    Object.defineProperty(object, "ownAccessor", {
      get: function () {
        ++getterCalls;
        return function () {};
      },
      configurable: true,
      enumerable: true,
    });

    object.destroy();

    expect(getterCalls).toBe(0);
    expect(object.isDestroyed()).toBe(true);
  });

  it("does not touch class statics", function () {
    class Resource {
      static create() {
        return new Resource();
      }
      isDestroyed() {
        return false;
      }
      destroy() {
        return destroyObject(this);
      }
    }

    const object = new Resource();
    object.destroy();

    expect(object.isDestroyed()).toBe(true);
    expect(Resource.create() instanceof Resource).toBe(true);
  });

  it("throws with the provided message", function () {
    const object = {
      destroy: function () {
        return destroyObject(this, "custom message");
      },
      doWork: function () {},
    };
    object.destroy();

    let thrown;
    try {
      object.doWork();
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof DeveloperError).toBe(true);
    expect(thrown.message).toEqual("custom message");
  });
});
