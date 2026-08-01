// Static Node coverage for the Gulp/Karma completion bridge. No browser is
// launched: FakeKarmaServer invokes the same callback contract Karma uses.
//
// Run with: node scripts/__tests__/karmaTestRun.spec.mjs

import assert from "node:assert/strict";
import {
  runKarmaTestServer,
  strictKarmaResultConfig,
} from "../karmaTestRun.js";

function makeFakeKarmaServer(exitCode, state) {
  return class FakeKarmaServer {
    constructor(config, done) {
      state.config = config;
      state.done = done;
    }

    start() {
      state.started = true;
      state.done(exitCode);
    }
  };
}

async function run() {
  assert.deepEqual(strictKarmaResultConfig, {
    failOnEmptyTestSuite: true,
    failOnFailingTestSuite: true,
  });

  {
    const state = {};
    await runKarmaTestServer(makeFakeKarmaServer(0, state), {
      name: "success",
    });
    assert.equal(state.started, true, "a successful Karma run starts");
    assert.deepEqual(state.config, { name: "success" });
  }

  for (const exitCode of [1, 2]) {
    const state = {};
    await assert.rejects(
      runKarmaTestServer(makeFakeKarmaServer(exitCode, state), {}),
      new RegExp(`Karma test run failed with exit code ${exitCode}`),
      `exit code ${exitCode} rejects the Gulp task by default`,
    );
    assert.equal(state.started, true);
  }

  {
    const state = {};
    await runKarmaTestServer(
      makeFakeKarmaServer(1, state),
      {},
      {
        failTaskOnError: false,
      },
    );
    assert.equal(
      state.started,
      true,
      "the explicit legacy opt-out still permits diagnostic runs",
    );
  }

  console.log("karmaTestRun policy: all checks passed");
}

await run();
