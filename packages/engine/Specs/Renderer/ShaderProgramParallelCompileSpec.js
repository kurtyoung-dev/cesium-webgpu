import { RuntimeError, ShaderCache } from "../../index.js";

describe("Renderer/ShaderProgram parallel compilation", function () {
  let cache;

  afterEach(function () {
    if (cache && !cache.isDestroyed()) {
      cache.destroy();
    }
    cache = undefined;
  });

  it("submits only the explicitly opted-in final derivative", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    const context = createContextStub(gl);
    cache = createCache(context, scheduler);

    const base = cache.getShaderProgram(shaderOptions("unused-base"));
    const intermediate = cache.createDerivedShaderProgram(
      base,
      "intermediate",
      shaderOptions("unused-intermediate"),
    );
    const final = cache.createDerivedShaderProgram(
      intermediate,
      "final",
      shaderOptions("visible-final"),
    );

    expect(base._linkState).toBe("uninitialized");
    expect(intermediate._linkState).toBe("uninitialized");
    expect(final._linkState).toBe("uninitialized");
    expect(gl.programs.length).toBe(0);
    expect(gl.shaders.length).toBe(0);
    expect(scheduler.pendingCount).toBe(0);

    expect(cache.scheduleShaderProgramCompilation(final)).toBe(true);

    expect(base._linkState).toBe("uninitialized");
    expect(intermediate._linkState).toBe("uninitialized");
    expect(final._linkState).toBe("linking");
    expect(gl.programs.length).toBe(1);
    expect(gl.shaders.length).toBe(2);
    expect(gl.parameterQueries).toEqual([]);
    expect(base._cachedShader.count).toBe(1);
    expect(intermediate._cachedShader.count).toBe(0);
    expect(final._cachedShader.count).toBe(0);
    expect(scheduler.pendingCount).toBe(1);
  });

  it("submits every required link before polling either program", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const first = cache.getShaderProgram(shaderOptions("required-first"));
    const second = cache.getShaderProgram(shaderOptions("required-second"));

    expect(cache.scheduleShaderProgramCompilation(first)).toBe(true);
    expect(cache.scheduleShaderProgramCompilation(second)).toBe(true);

    expect(first._linkState).toBe("linking");
    expect(second._linkState).toBe("linking");
    expect(gl.programs.length).toBe(2);
    expect(gl.shaders.length).toBe(4);
    expect(gl.parameterQueries).toEqual([]);
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runNext();

    expect(gl.parameterQueryPrograms).toEqual([gl.programs[0], gl.programs[1]]);
    expect(gl.parameterQueries).toEqual([
      gl.parallelShaderCompile.COMPLETION_STATUS_KHR,
      gl.parallelShaderCompile.COMPLETION_STATUS_KHR,
    ]);
  });

  it("defers speculative program construction until an idle callback", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);
    let preparedProgram;
    const prepare = jasmine.createSpy("prepare").and.callFake(function () {
      preparedProgram = cache.getShaderProgram(shaderOptions("prepared"));
      return preparedProgram;
    });

    expect(cache.scheduleShaderProgramPreparation(prepare)).toBe(true);

    expect(prepare).not.toHaveBeenCalled();
    expect(gl.programs.length).toBe(0);
    expect(gl.shaders.length).toBe(0);
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runNext();

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(preparedProgram._linkState).toBe("linking");
    expect(gl.programs.length).toBe(1);
    expect(gl.shaders.length).toBe(2);
    expect(gl.parameterQueries).toEqual([]);
    expect(scheduler.pendingCount).toBe(1);

    gl.programs[0].completionStatus = true;
    scheduler.runNext();
    expect(preparedProgram._linkState).toBe("ready");
  });

  it("does not run a heavy preparation factory on a tiny idle budget", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler, {
      minimumShaderPreparationTimeRemaining: 5,
    });
    const prepare = jasmine.createSpy("prepare").and.returnValue(undefined);

    expect(cache.scheduleShaderProgramPreparation(prepare)).toBe(true);
    scheduler.runNext(1);

    expect(prepare).not.toHaveBeenCalled();
    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.requestCount).toBe(2);

    scheduler.runNext(5);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("polls every active completion even when the idle budget is zero", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);
    const first = cache.getShaderProgram(
      shaderOptions("zero-budget-poll-first"),
    );
    const second = cache.getShaderProgram(
      shaderOptions("zero-budget-poll-second"),
    );

    expect(cache.scheduleShaderProgramCompilation(first)).toBe(true);
    expect(cache.scheduleShaderProgramCompilation(second)).toBe(true);
    gl.programs[0].completionStatus = true;
    scheduler.runNext(0);

    expect(first._linkState).toBe("ready");
    expect(second._linkState).toBe("linking");
    expect(cache._activeParallelShaderPrograms.size).toBe(1);
    expect(
      count(
        gl.parameterQueries,
        gl.parallelShaderCompile.COMPLETION_STATUS_KHR,
      ),
    ).toBe(2);
    expect(
      gl.parameterQueryPrograms.filter(function (program, index) {
        return (
          gl.parameterQueries[index] ===
          gl.parallelShaderCompile.COMPLETION_STATUS_KHR
        );
      }),
    ).toEqual([gl.programs[0], gl.programs[1]]);
    expect(scheduler.pendingCount).toBe(1);
  });

  it("uses a bounded timeout to make preparation progress after idle starvation", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    let timestamp = 0;
    cache = createCache(createContextStub(gl), scheduler, {
      minimumShaderPreparationTimeRemaining: 20,
      shaderCompileIdleTimeout: 250,
      getTimestamp: function () {
        return timestamp;
      },
    });
    let preparedProgram;
    const prepare = jasmine.createSpy("prepare").and.callFake(function () {
      preparedProgram = cache.getShaderProgram(
        shaderOptions("timed-out-preparation"),
      );
      return preparedProgram;
    });

    expect(cache.scheduleShaderProgramPreparation(prepare)).toBe(true);
    expect(scheduler.lastRequestOptions).toEqual({
      timeout: 250,
    });

    timestamp = 100;
    scheduler.runNext(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(scheduler.lastRequestOptions).toEqual({
      timeout: 150,
    });

    scheduler.runNext(0, true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(preparedProgram._linkState).toBe("linking");
    expect(scheduler.pendingCount).toBe(1);

    gl.programs[0].completionStatus = true;
    scheduler.runNext(0);
    expect(preparedProgram._linkState).toBe("ready");
    expect(scheduler.pendingCount).toBe(0);
  });

  it("caps pending speculative preparation without broadening eager work", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler, {
      maximumPendingShaderPreparations: 2,
    });
    const first = jasmine
      .createSpy("first preparation")
      .and.returnValue(undefined);
    const second = jasmine
      .createSpy("second preparation")
      .and.returnValue(undefined);
    const rejected = jasmine
      .createSpy("rejected preparation")
      .and.returnValue(undefined);

    expect(cache.scheduleShaderProgramPreparation(first)).toBe(true);
    expect(cache.scheduleShaderProgramPreparation(second)).toBe(true);
    expect(cache.scheduleShaderProgramPreparation(rejected)).toBe(false);
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runNext();
    scheduler.runNext();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
    expect(scheduler.pendingCount).toBe(0);
  });

  it("prioritizes required links and serializes speculative preparation", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);
    let firstPreparedProgram;
    let secondPreparedProgram;
    const firstPreparation = jasmine
      .createSpy("first speculative preparation")
      .and.callFake(function () {
        firstPreparedProgram = cache.getShaderProgram(
          shaderOptions("speculative-first"),
        );
        return firstPreparedProgram;
      });
    const secondPreparation = jasmine
      .createSpy("second speculative preparation")
      .and.callFake(function () {
        secondPreparedProgram = cache.getShaderProgram(
          shaderOptions("speculative-second"),
        );
        return secondPreparedProgram;
      });

    expect(cache.scheduleShaderProgramPreparation(firstPreparation)).toBe(true);
    expect(cache.scheduleShaderProgramPreparation(secondPreparation)).toBe(
      true,
    );

    const firstRequired = cache.getShaderProgram(
      shaderOptions("priority-required-first"),
    );
    const secondRequired = cache.getShaderProgram(
      shaderOptions("priority-required-second"),
    );
    expect(cache.scheduleShaderProgramCompilation(firstRequired)).toBe(true);
    expect(cache.scheduleShaderProgramCompilation(secondRequired)).toBe(true);

    scheduler.runNext();
    expect(firstPreparation).not.toHaveBeenCalled();
    expect(secondPreparation).not.toHaveBeenCalled();
    expect(gl.parameterQueryPrograms).toEqual([gl.programs[0], gl.programs[1]]);

    gl.programs[0].completionStatus = true;
    gl.programs[1].completionStatus = true;
    scheduler.runNext();
    expect(firstRequired._linkState).toBe("ready");
    expect(secondRequired._linkState).toBe("ready");
    expect(firstPreparation).not.toHaveBeenCalled();

    scheduler.runNext();
    expect(firstPreparation).toHaveBeenCalledTimes(1);
    expect(secondPreparation).not.toHaveBeenCalled();
    expect(firstPreparedProgram._linkState).toBe("linking");

    gl.programs[2].completionStatus = true;
    scheduler.runNext();
    expect(firstPreparedProgram._linkState).toBe("ready");
    expect(secondPreparation).not.toHaveBeenCalled();

    scheduler.runNext();
    expect(secondPreparation).toHaveBeenCalledTimes(1);
    expect(secondPreparedProgram._linkState).toBe("linking");
  });

  it("cancels owner preparation and releases its queued closure", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);
    const owner = {};
    const prepare = jasmine.createSpy("owner preparation");

    expect(cache.scheduleShaderProgramPreparation(prepare, owner)).toBe(true);
    expect(cache.cancelShaderProgramPreparations(owner)).toBe(1);
    expect(cache.cancelShaderProgramPreparations(owner)).toBe(0);
    expect(cache._parallelShaderPreparationQueue.length).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
    expect(scheduler.cancelCount).toBe(1);

    scheduler.runLastCanceled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("cancels only preparations belonging to the requested owner", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);
    const canceledOwner = {};
    const retainedOwner = {};
    const canceled = jasmine.createSpy("canceled owner preparation");
    const retained = jasmine
      .createSpy("retained owner preparation")
      .and.returnValue(undefined);

    expect(
      cache.scheduleShaderProgramPreparation(canceled, canceledOwner),
    ).toBe(true);
    expect(
      cache.scheduleShaderProgramPreparation(retained, retainedOwner),
    ).toBe(true);

    expect(cache.cancelShaderProgramPreparations(canceledOwner)).toBe(1);
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runNext();

    expect(canceled).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("drops unstarted speculative preparation when the cache is destroyed", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);
    const prepare = jasmine.createSpy("prepare");

    expect(cache.scheduleShaderProgramPreparation(prepare)).toBe(true);
    cache.destroy();
    scheduler.runLastCanceled();

    expect(prepare).not.toHaveBeenCalled();
    expect(gl.programs.length).toBe(0);
    expect(gl.shaders.length).toBe(0);
  });

  it("polls only the nonblocking completion status while linking", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const shaderProgram = cache.getShaderProgram(shaderOptions("poll"));
    expect(cache.scheduleShaderProgramCompilation(shaderProgram)).toBe(true);
    scheduler.runNext();

    expect(shaderProgram._linkState).toBe("linking");
    expect(gl.parameterQueries).toEqual([
      gl.parallelShaderCompile.COMPLETION_STATUS_KHR,
    ]);
    expect(gl.deletedShaders.length).toBe(0);
    expect(scheduler.pendingCount).toBe(1);
  });

  it("caches a completion-query exception without throwing from idle", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const shaderProgram = cache.getShaderProgram(
      shaderOptions("completion-exception"),
    );
    expect(cache.scheduleShaderProgramCompilation(shaderProgram)).toBe(true);
    gl.throwNextCompletionQuery = true;

    expect(function () {
      scheduler.runNext();
    }).not.toThrow();
    expect(shaderProgram._linkState).toBe("failed");
    expect(gl.deletedShaders.length).toBe(2);
    expect(gl.deletedPrograms.length).toBe(1);
    expect(function () {
      shaderProgram._bind();
    }).toThrowError(RuntimeError, "completion query failed");
  });

  it("finalizes each completed program and its reflection exactly once", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const first = cache.getShaderProgram(shaderOptions("first-ready"));
    const second = cache.getShaderProgram(shaderOptions("second-ready"));
    expect(cache.scheduleShaderProgramCompilation(first)).toBe(true);
    expect(cache.scheduleShaderProgramCompilation(second)).toBe(true);
    gl.programs[0].completionStatus = true;

    scheduler.runNext();

    expect(first._linkState).toBe("ready");
    expect(second._linkState).toBe("linking");
    expect(cache._activeParallelShaderPrograms.size).toBe(1);
    expect(gl.programs.length).toBe(2);
    expect(
      count(
        gl.parameterQueries,
        gl.parallelShaderCompile.COMPLETION_STATUS_KHR,
      ),
    ).toBe(2);
    expect(count(gl.parameterQueries, gl.LINK_STATUS)).toBe(1);
    expect(count(gl.parameterQueries, gl.ACTIVE_ATTRIBUTES)).toBe(1);
    expect(count(gl.parameterQueries, gl.ACTIVE_UNIFORMS)).toBe(1);
    expect(gl.deletedShaders.length).toBe(2);

    gl.programs[1].completionStatus = true;
    scheduler.runNext();
    first._bind();
    second._bind();

    expect(first._linkState).toBe("ready");
    expect(second._linkState).toBe("ready");
    expect(cache._activeParallelShaderPrograms.size).toBe(0);
    expect(count(gl.parameterQueries, gl.LINK_STATUS)).toBe(2);
    expect(count(gl.parameterQueries, gl.ACTIVE_ATTRIBUTES)).toBe(2);
    expect(count(gl.parameterQueries, gl.ACTIVE_UNIFORMS)).toBe(2);
    expect(gl.deletedShaders.length).toBe(4);
    expect(scheduler.pendingCount).toBe(0);

    cache.destroy();
    expect(gl.deletedPrograms.length).toBe(2);
  });

  it("forces an incomplete active program to finalize before binding", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const shaderProgram = cache.getShaderProgram(shaderOptions("bind"));
    expect(cache.scheduleShaderProgramCompilation(shaderProgram)).toBe(true);
    shaderProgram._bind();

    expect(shaderProgram._linkState).toBe("ready");
    expect(
      count(
        gl.parameterQueries,
        gl.parallelShaderCompile.COMPLETION_STATUS_KHR,
      ),
    ).toBe(0);
    expect(count(gl.parameterQueries, gl.LINK_STATUS)).toBe(1);
    expect(count(gl.parameterQueries, gl.ACTIVE_ATTRIBUTES)).toBe(1);
    expect(count(gl.parameterQueries, gl.ACTIVE_UNIFORMS)).toBe(1);
    expect(gl.usedPrograms[gl.usedPrograms.length - 1]).toBe(gl.programs[0]);
    expect(scheduler.pendingCount).toBe(0);
    expect(scheduler.cancelCount).toBe(1);
  });

  it("keeps another submitted link active during immediate use", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const first = cache.getShaderProgram(shaderOptions("force-first"));
    const second = cache.getShaderProgram(shaderOptions("overlap-second"));
    expect(cache.scheduleShaderProgramCompilation(first)).toBe(true);
    expect(cache.scheduleShaderProgramCompilation(second)).toBe(true);
    expect(second._linkState).toBe("linking");
    first._bind();

    expect(first._linkState).toBe("ready");
    expect(second._linkState).toBe("linking");
    expect(gl.programs.length).toBe(2);
    expect(gl.linkStatusProgramCounts).toEqual([2]);
    expect(scheduler.pendingCount).toBe(1);
  });

  it("continues after one required program link submission fails", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const first = cache.getShaderProgram(shaderOptions("submit-first"));
    const failed = cache.getShaderProgram(shaderOptions("submit-failed"));
    const third = cache.getShaderProgram(shaderOptions("submit-third"));
    expect(cache.scheduleShaderProgramCompilation(first)).toBe(true);
    gl.failNextCreateShader = true;
    expect(cache.scheduleShaderProgramCompilation(failed)).toBe(false);
    expect(cache.scheduleShaderProgramCompilation(third)).toBe(true);

    first._bind();

    expect(first._linkState).toBe("ready");
    expect(failed._linkState).toBe("failed");
    expect(third._linkState).toBe("linking");
    expect(gl.programs.length).toBe(2);
    expect(function () {
      failed._bind();
    }).toThrowError(RuntimeError, "shader creation failed");
    expect(scheduler.pendingCount).toBe(1);
  });

  it("forces a queued getter without blocking on an unrelated active program", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const first = cache.getShaderProgram(shaderOptions("active"));
    const second = cache.getShaderProgram(shaderOptions("getter"));
    expect(cache.scheduleShaderProgramCompilation(first)).toBe(true);
    expect(cache.scheduleShaderProgramCompilation(second)).toBe(true);

    expect(second.numberOfVertexAttributes).toBe(0);

    expect(first._linkState).toBe("linking");
    expect(second._linkState).toBe("ready");
    expect(gl.programs.length).toBe(2);
    expect(
      count(
        gl.parameterQueries,
        gl.parallelShaderCompile.COMPLETION_STATUS_KHR,
      ),
    ).toBe(0);
    expect(count(gl.parameterQueries, gl.LINK_STATUS)).toBe(1);
    expect(scheduler.pendingCount).toBe(1);
  });

  it("caches an idle fragment compile failure with exact teardown", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);
    spyOn(console, "error");

    const shaderProgram = cache.getShaderProgram(
      shaderOptions("fragment-failure"),
    );
    expect(cache.scheduleShaderProgramCompilation(shaderProgram)).toBe(true);
    gl.shaders[1].compileStatus = false;
    gl.programs[0].completionStatus = true;
    gl.programs[0].linkStatus = false;

    scheduler.runNext();

    let error;
    try {
      shaderProgram._bind();
    } catch (thrownError) {
      error = thrownError;
    }

    expect(error).toEqual(jasmine.any(RuntimeError));
    expect(error.message).toContain("Fragment shader failed to compile");
    expect(gl.shaderParameterQueries).toEqual([gl.shaders[1]]);
    expect(gl.deletedShaders.length).toBe(2);
    expect(gl.deletedPrograms.length).toBe(1);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("caches an idle vertex compile failure with exact teardown", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);
    spyOn(console, "error");

    const shaderProgram = cache.getShaderProgram(
      shaderOptions("vertex-failure"),
    );
    expect(cache.scheduleShaderProgramCompilation(shaderProgram)).toBe(true);
    gl.shaders[0].compileStatus = false;
    gl.programs[0].completionStatus = true;
    gl.programs[0].linkStatus = false;

    scheduler.runNext();

    let error;
    try {
      shaderProgram._bind();
    } catch (thrownError) {
      error = thrownError;
    }

    expect(error).toEqual(jasmine.any(RuntimeError));
    expect(error.message).toContain("Vertex shader failed to compile");
    expect(gl.shaderParameterQueries).toEqual([gl.shaders[1], gl.shaders[0]]);
    expect(gl.deletedShaders.length).toBe(2);
    expect(gl.deletedPrograms.length).toBe(1);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("caches an idle link failure and throws it on every first-use path", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);
    spyOn(console, "error");

    const shaderProgram = cache.getShaderProgram(shaderOptions("failure"));
    expect(cache.scheduleShaderProgramCompilation(shaderProgram)).toBe(true);
    gl.programs[0].completionStatus = true;
    gl.programs[0].linkStatus = false;

    expect(function () {
      scheduler.runNext();
    }).not.toThrow();
    expect(shaderProgram._linkState).toBe("failed");
    expect(gl.deletedShaders.length).toBe(2);
    expect(gl.deletedPrograms.length).toBe(1);

    let firstError;
    let secondError;
    try {
      shaderProgram._bind();
    } catch (error) {
      firstError = error;
    }
    try {
      shaderProgram._bind();
    } catch (error) {
      secondError = error;
    }

    expect(firstError).toEqual(jasmine.any(RuntimeError));
    expect(firstError.message).toContain("Program failed to link");
    expect(secondError).toBe(firstError);
    expect(count(gl.parameterQueries, gl.LINK_STATUS)).toBe(1);
    expect(gl.programs.length).toBe(1);
    expect(console.error).toHaveBeenCalledTimes(1);

    cache.destroy();
    expect(gl.deletedShaders.length).toBe(2);
    expect(gl.deletedPrograms.length).toBe(1);
  });

  it("reflects samplers once and publishes the maximum texture unit", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const shaderProgram = cache.getShaderProgram(shaderOptions("sampler"));
    expect(cache.scheduleShaderProgramCompilation(shaderProgram)).toBe(true);
    gl.programs[0].activeUniforms.push({
      name: "u_texture",
      size: 1,
      type: gl.SAMPLER_2D,
    });
    gl.programs[0].completionStatus = true;

    scheduler.runNext();

    expect(shaderProgram.maximumTextureUnitIndex).toBe(1);
    expect(shaderProgram.allUniforms.u_texture.name).toBe("u_texture");
    expect(gl.uniform1iCalls).toEqual([
      {
        location: {
          name: "u_texture",
        },
        value: 0,
      },
    ]);
    expect(count(gl.parameterQueries, gl.ACTIVE_UNIFORMS)).toBe(1);

    shaderProgram._bind();
    expect(shaderProgram.allUniforms.u_texture.name).toBe("u_texture");
    expect(count(gl.parameterQueries, gl.LINK_STATUS)).toBe(1);
    expect(count(gl.parameterQueries, gl.ACTIVE_UNIFORMS)).toBe(1);
    expect(gl.uniform1iCalls.length).toBe(1);
  });

  it("keeps the exact lazy synchronous path when the extension is absent", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    const context = createContextStub(gl);
    context._parallelShaderCompile = undefined;
    cache = createCache(context, scheduler);

    const shaderProgram = cache.getShaderProgram(shaderOptions("no-extension"));

    expect(shaderProgram._linkState).toBe("uninitialized");
    expect(gl.programs.length).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
    expect(cache.scheduleShaderProgramCompilation(shaderProgram)).toBe(false);

    shaderProgram._bind();

    expect(shaderProgram._linkState).toBe("ready");
    expect(gl.programs.length).toBe(1);
    expect(count(gl.parameterQueries, gl.LINK_STATUS)).toBe(1);
  });

  it("keeps the exact lazy synchronous path when idle callbacks are absent", function () {
    const gl = createGlStub();
    const context = createContextStub(gl);
    cache = new ShaderCache(context, {
      requestIdleCallback: undefined,
      cancelIdleCallback: undefined,
    });

    const shaderProgram = cache.getShaderProgram(shaderOptions("no-idle"));

    expect(shaderProgram._linkState).toBe("uninitialized");
    expect(gl.programs.length).toBe(0);
    expect(cache.scheduleShaderProgramCompilation(shaderProgram)).toBe(false);

    shaderProgram._bind();

    expect(shaderProgram._linkState).toBe("ready");
    expect(gl.programs.length).toBe(1);
    expect(count(gl.parameterQueries, gl.LINK_STATUS)).toBe(1);
  });

  it("cancels idle work and deletes every submitted resource on destroy", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const first = cache.getShaderProgram(shaderOptions("destroy-active"));
    const second = cache.getShaderProgram(shaderOptions("destroy-queued"));
    expect(cache.scheduleShaderProgramCompilation(first)).toBe(true);
    expect(cache.scheduleShaderProgramCompilation(second)).toBe(true);
    expect(first._linkState).toBe("linking");
    expect(second._linkState).toBe("linking");

    cache.destroy();

    expect(scheduler.pendingCount).toBe(0);
    expect(scheduler.cancelCount).toBe(1);
    expect(gl.deletedShaders.length).toBe(4);
    expect(gl.deletedPrograms.length).toBe(2);
    expect(first.isDestroyed()).toBe(true);
    expect(second.isDestroyed()).toBe(true);

    scheduler.runLastCanceled();
    expect(gl.deletedShaders.length).toBe(4);
    expect(gl.deletedPrograms.length).toBe(2);
  });

  it("stops polling only the released program from the active set", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const released = cache.getShaderProgram(shaderOptions("released"));
    const retained = cache.getShaderProgram(shaderOptions("retained"));
    expect(cache.scheduleShaderProgramCompilation(released)).toBe(true);
    expect(cache.scheduleShaderProgramCompilation(retained)).toBe(true);
    expect(released._linkState).toBe("linking");
    expect(retained._linkState).toBe("linking");

    released.destroy();
    scheduler.runNext();

    expect(released._cachedShader.count).toBe(0);
    expect(released._linkState).toBe("linking");
    expect(retained._linkState).toBe("linking");
    expect(gl.programs.length).toBe(2);
    expect(gl.parameterQueryPrograms).toEqual([gl.programs[1]]);
    expect(scheduler.pendingCount).toBe(1);
  });

  it("requires explicit rescheduling after a released cache hit", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);
    const options = shaderOptions("reused");

    const released = cache.getShaderProgram(options);
    expect(cache.scheduleShaderProgramCompilation(released)).toBe(true);
    released.destroy();

    expect(released._cachedShader.count).toBe(0);
    expect(scheduler.pendingCount).toBe(0);

    const reused = cache.getShaderProgram(options);

    expect(reused).toBe(released);
    expect(reused._cachedShader.count).toBe(1);
    expect(gl.programs.length).toBe(1);
    expect(gl.shaders.length).toBe(2);
    expect(scheduler.pendingCount).toBe(0);

    const ownershipCount = reused._cachedShader.count;
    expect(cache.scheduleShaderProgramCompilation(reused)).toBe(true);
    expect(reused._cachedShader.count).toBe(ownershipCount);
    expect(gl.programs.length).toBe(1);
    expect(gl.shaders.length).toBe(2);
    expect(scheduler.pendingCount).toBe(1);

    gl.programs[0].completionStatus = true;
    scheduler.runNext();

    expect(reused._linkState).toBe("ready");
    expect(count(gl.parameterQueries, gl.LINK_STATUS)).toBe(1);
  });

  it("keeps a multiply-owned pending program scheduled until count zero", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);
    const options = shaderOptions("multiply-owned");

    const first = cache.getShaderProgram(options);
    const second = cache.getShaderProgram(options);
    expect(cache.scheduleShaderProgramCompilation(first)).toBe(true);
    first.destroy();

    expect(second).toBe(first);
    expect(second._cachedShader.count).toBe(1);
    expect(second._linkState).toBe("linking");
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runNext();
    expect(gl.parameterQueryPrograms).toEqual([gl.programs[0]]);
  });

  it("unschedules pending descendants with a released parent", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const base = cache.getShaderProgram(shaderOptions("release-parent"));
    const derived = cache.createDerivedShaderProgram(
      base,
      "derived",
      shaderOptions("release-child"),
    );
    expect(cache.scheduleShaderProgramCompilation(base)).toBe(true);
    expect(cache.scheduleShaderProgramCompilation(derived)).toBe(true);

    base.destroy();

    expect(base._cachedShader.count).toBe(0);
    expect(base._linkState).toBe("linking");
    expect(derived._linkState).toBe("linking");
    expect(scheduler.pendingCount).toBe(0);

    expect(cache.getDerivedShaderProgram(base, "derived")).toBe(derived);
    expect(derived._linkState).toBe("linking");
    expect(scheduler.pendingCount).toBe(0);

    expect(cache.scheduleShaderProgramCompilation(derived)).toBe(true);
    expect(derived._linkState).toBe("linking");
    expect(scheduler.pendingCount).toBe(1);
  });

  it("schedules derived programs without changing cache ownership counts", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const base = cache.getShaderProgram(shaderOptions("base"));
    const derived = cache.createDerivedShaderProgram(
      base,
      "derived",
      shaderOptions("derived"),
    );

    expect(base._cachedShader.count).toBe(1);
    expect(derived._cachedShader.count).toBe(0);
    expect(base._linkState).toBe("uninitialized");
    expect(derived._linkState).toBe("uninitialized");
    expect(gl.programs.length).toBe(0);

    expect(cache.scheduleShaderProgramCompilation(derived)).toBe(true);

    expect(base._cachedShader.count).toBe(1);
    expect(derived._cachedShader.count).toBe(0);
    expect(base._linkState).toBe("uninitialized");
    expect(derived._linkState).toBe("linking");
    expect(gl.programs.length).toBe(1);
  });

  it("destroys a submitted derived program when it is replaced", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const base = cache.getShaderProgram(shaderOptions("replace-base"));
    const stale = cache.createDerivedShaderProgram(
      base,
      "derived",
      shaderOptions("stale-derived"),
    );
    expect(cache.scheduleShaderProgramCompilation(base)).toBe(true);
    expect(cache.scheduleShaderProgramCompilation(stale)).toBe(true);
    const replacement = cache.replaceDerivedShaderProgram(
      base,
      "derived",
      shaderOptions("replacement-derived"),
    );

    expect(stale.isDestroyed()).toBe(true);
    expect(replacement.isDestroyed()).toBe(false);
    expect(replacement._linkState).toBe("uninitialized");
    expect(gl.programs.length).toBe(2);
    expect(gl.shaders.length).toBe(4);
    expect(gl.deletedPrograms).toEqual([gl.programs[1]]);
    expect(gl.deletedShaders).toEqual([gl.shaders[2], gl.shaders[3]]);
    expect(base._cachedShader.derivedKeywords).toEqual(["derived"]);
  });

  it("destroys pending derived programs when their parent is evicted", function () {
    const gl = createGlStub();
    const scheduler = createIdleScheduler();
    cache = createCache(createContextStub(gl), scheduler);

    const base = cache.getShaderProgram(shaderOptions("cascade-base"));
    const derived = cache.createDerivedShaderProgram(
      base,
      "derived",
      shaderOptions("cascade-derived"),
    );
    expect(cache.scheduleShaderProgramCompilation(base)).toBe(true);
    expect(cache.scheduleShaderProgramCompilation(derived)).toBe(true);

    base.destroy();
    cache.destroyReleasedShaderPrograms();

    expect(base.isDestroyed()).toBe(true);
    expect(derived.isDestroyed()).toBe(true);
    expect(cache.numberOfShaders).toBe(0);
    expect(gl.deletedShaders.length).toBe(4);
    expect(gl.deletedPrograms.length).toBe(2);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("keeps Spector rebuilds synchronous and atomic", function () {
    const originalSpector = globalThis.spector;
    globalThis.spector = {};

    try {
      const gl = createGlStub();
      const scheduler = createIdleScheduler();
      cache = createCache(createContextStub(gl), scheduler);
      spyOn(console, "error");

      const shaderProgram = cache.getShaderProgram(shaderOptions("spector"));
      shaderProgram._bind();
      const initialProgram = shaderProgram._program;

      let compiledProgram;
      let compileError;
      initialProgram.__SPECTOR_rebuildProgram(
        "// edited vertex\nvoid main() {}",
        "// edited fragment\nvoid main() {}",
        function (program) {
          compiledProgram = program;
        },
        function (error) {
          compileError = error;
        },
      );

      expect(compileError).toBeUndefined();
      expect(compiledProgram).toBe(gl.programs[1]);
      expect(shaderProgram._program).toBe(compiledProgram);
      expect(gl.deletedPrograms).toEqual([initialProgram]);

      const liveProgram = shaderProgram._program;
      const liveUniforms = shaderProgram._uniforms;
      const liveVertexSource = shaderProgram._vertexShaderText;
      const liveFragmentSource = shaderProgram._fragmentShaderText;
      gl.nextVertexCompileStatus = false;
      gl.nextProgramLinkStatus = false;
      let linkError;

      liveProgram.__SPECTOR_rebuildProgram(
        "// broken vertex\nvoid main() {}",
        "// broken fragment\nvoid main() {}",
        function () {},
        function (error) {
          linkError = error;
        },
      );

      expect(linkError).toContain("Vertex shader failed to compile");
      expect(shaderProgram._program).toBe(liveProgram);
      expect(shaderProgram._uniforms).toBe(liveUniforms);
      expect(shaderProgram._linkState).toBe("ready");
      expect(shaderProgram._vertexShaderText).toBe(liveVertexSource);
      expect(shaderProgram._fragmentShaderText).toBe(liveFragmentSource);
      expect(count(gl.deletedPrograms, liveProgram)).toBe(0);

      gl.failNextProgramReflection = true;
      let reflectionError;
      liveProgram.__SPECTOR_rebuildProgram(
        "// reflection vertex\nvoid main() {}",
        "// reflection fragment\nvoid main() {}",
        function () {},
        function (error) {
          reflectionError = error;
        },
      );

      expect(reflectionError).toContain("reflection failed");
      expect(shaderProgram._program).toBe(liveProgram);
      expect(shaderProgram._uniforms).toBe(liveUniforms);
      expect(shaderProgram._linkState).toBe("ready");
      expect(shaderProgram._vertexShaderText).toBe(liveVertexSource);
      expect(shaderProgram._fragmentShaderText).toBe(liveFragmentSource);
      expect(count(gl.deletedPrograms, liveProgram)).toBe(0);
    } finally {
      if (originalSpector === undefined) {
        delete globalThis.spector;
      } else {
        globalThis.spector = originalSpector;
      }
    }
  });
});

function createCache(context, scheduler, options) {
  return new ShaderCache(context, {
    ...options,
    requestIdleCallback: scheduler.requestIdleCallback,
    cancelIdleCallback: scheduler.cancelIdleCallback,
  });
}

function createContextStub(gl) {
  return {
    _gl: gl,
    _parallelShaderCompile: gl.parallelShaderCompile,
    graphicsCapabilities: {
      highpFloatSupported: true,
      highpIntSupported: true,
    },
    logShaderCompilation: false,
    debugShaders: undefined,
    webgl2: true,
    textureFloatLinear: false,
    floatingPointTexture: false,
  };
}

function shaderOptions(name) {
  return {
    vertexShaderSource: `// ${name}\nvoid main() { gl_Position = vec4(1.0); }`,
    fragmentShaderSource: `// ${name}\nvoid main() { out_FragColor = vec4(1.0); }`,
  };
}

function count(values, value) {
  return values.filter(function (item) {
    return item === value;
  }).length;
}

function createIdleScheduler() {
  let nextId = 0;
  let cancelCount = 0;
  let requestCount = 0;
  let lastRequestOptions;
  const callbacks = new Map();
  const canceledCallbacks = [];

  return {
    requestIdleCallback: function (callback, options) {
      const id = ++nextId;
      ++requestCount;
      lastRequestOptions = options;
      callbacks.set(id, {
        callback: callback,
        options: options,
      });
      return id;
    },
    cancelIdleCallback: function (id) {
      const entry = callbacks.get(id);
      if (callbacks.delete(id)) {
        canceledCallbacks.push(entry.callback);
        ++cancelCount;
      }
    },
    runNext: function (timeRemaining, didTimeout) {
      const entry = callbacks.entries().next().value;
      if (!entry) {
        throw new Error("No idle callback is pending.");
      }
      callbacks.delete(entry[0]);
      entry[1].callback({
        didTimeout: didTimeout === true,
        timeRemaining: function () {
          return timeRemaining ?? 10;
        },
      });
    },
    runLastCanceled: function () {
      const callback = canceledCallbacks[canceledCallbacks.length - 1];
      if (!callback) {
        throw new Error("No canceled idle callback was captured.");
      }
      callback({
        timeRemaining: function () {
          return 10;
        },
      });
    },
    get pendingCount() {
      return callbacks.size;
    },
    get cancelCount() {
      return cancelCount;
    },
    get requestCount() {
      return requestCount;
    },
    get lastRequestOptions() {
      return lastRequestOptions;
    },
  };
}

function createGlStub() {
  const parallelShaderCompile = {
    COMPLETION_STATUS_KHR: 0x91b1,
  };
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86,
    ACTIVE_ATTRIBUTES: 0x8b89,
    VALIDATE_STATUS: 0x8b83,
    SAMPLER_2D: 0x8b5e,
    parallelShaderCompile: parallelShaderCompile,
    shaders: [],
    programs: [],
    parameterQueries: [],
    parameterQueryPrograms: [],
    linkStatusProgramCounts: [],
    shaderParameterQueries: [],
    deletedShaders: [],
    deletedPrograms: [],
    usedPrograms: [],
    uniform1iCalls: [],
    nextVertexCompileStatus: undefined,
    nextFragmentCompileStatus: undefined,
    nextProgramLinkStatus: undefined,
    failNextProgramReflection: false,
    failNextCreateShader: false,
    throwNextCompletionQuery: false,
  };

  gl.createShader = function (type) {
    if (gl.failNextCreateShader) {
      gl.failNextCreateShader = false;
      throw new Error("shader creation failed");
    }
    const nextCompileStatus =
      type === gl.VERTEX_SHADER
        ? gl.nextVertexCompileStatus
        : gl.nextFragmentCompileStatus;
    const shader = {
      type: type,
      compileStatus: nextCompileStatus ?? true,
      id: gl.shaders.length,
    };
    if (type === gl.VERTEX_SHADER) {
      gl.nextVertexCompileStatus = undefined;
    } else {
      gl.nextFragmentCompileStatus = undefined;
    }
    gl.shaders.push(shader);
    return shader;
  };
  gl.shaderSource = function () {};
  gl.compileShader = function () {};
  gl.createProgram = function () {
    const program = {
      completionStatus: false,
      linkStatus: gl.nextProgramLinkStatus ?? true,
      id: gl.programs.length,
      activeUniforms: [],
      failReflection: gl.failNextProgramReflection,
    };
    gl.nextProgramLinkStatus = undefined;
    gl.failNextProgramReflection = false;
    gl.programs.push(program);
    return program;
  };
  gl.attachShader = function () {};
  gl.bindAttribLocation = function () {};
  gl.linkProgram = function () {};
  gl.getProgramParameter = function (program, parameter) {
    gl.parameterQueries.push(parameter);
    gl.parameterQueryPrograms.push(program);
    if (parameter === parallelShaderCompile.COMPLETION_STATUS_KHR) {
      if (gl.throwNextCompletionQuery) {
        gl.throwNextCompletionQuery = false;
        throw new Error("completion query failed");
      }
      return program.completionStatus;
    }
    if (parameter === gl.LINK_STATUS) {
      gl.linkStatusProgramCounts.push(gl.programs.length);
      return program.linkStatus;
    }
    if (parameter === gl.ACTIVE_UNIFORMS) {
      return program.activeUniforms.length;
    }
    if (parameter === gl.ACTIVE_ATTRIBUTES) {
      if (program.failReflection) {
        throw new Error("reflection failed");
      }
      return 0;
    }
    return true;
  };
  gl.getShaderParameter = function (shader) {
    gl.shaderParameterQueries.push(shader);
    return shader.compileStatus;
  };
  gl.getShaderInfoLog = function () {
    return "";
  };
  gl.getProgramInfoLog = function () {
    return "link failed";
  };
  gl.deleteShader = function (shader) {
    gl.deletedShaders.push(shader);
  };
  gl.deleteProgram = function (program) {
    gl.deletedPrograms.push(program);
  };
  gl.useProgram = function (program) {
    gl.usedPrograms.push(program);
  };
  gl.getActiveUniform = function (program, index) {
    return program.activeUniforms[index];
  };
  gl.getUniformLocation = function (program, name) {
    return {
      name: name,
    };
  };
  gl.uniform1i = function (location, value) {
    gl.uniform1iCalls.push({
      location: location,
      value: value,
    });
  };

  return gl;
}
