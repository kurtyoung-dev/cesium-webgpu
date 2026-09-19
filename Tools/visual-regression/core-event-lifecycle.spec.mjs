// @purpose Asserts Event survives a throwing listener and EventHelper's remover never orphans another registration, through the engine's own Core modules.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";

import Event from "../../packages/engine/Source/Core/Event.js";
import EventHelper from "../../packages/engine/Source/Core/EventHelper.js";

/**
 * Raises the event and returns the error a listener threw, or undefined when
 * the raise completed. The throw belongs to the listener, not to the event, so
 * these cases assert what the event does afterwards.
 * @param {Event} event
 * @param {...unknown} args
 * @returns {Error|undefined}
 */
function raiseCatching(event, ...args) {
  try {
    event.raiseEvent(...args);
    return undefined;
  } catch (error) {
    return error;
  }
}

test("a listener that threw can be unsubscribed and stops firing", () => {
  const event = new Event();
  let throwingCalls = 0;
  let survivorCalls = 0;
  const throwing = () => {
    throwingCalls++;
    throw new Error("listener failure");
  };
  const survivor = () => {
    survivorCalls++;
  };

  event.addEventListener(throwing);
  event.addEventListener(survivor);

  assert.equal(raiseCatching(event)?.message, "listener failure");
  assert.equal(throwingCalls, 1);

  assert.equal(event.removeEventListener(throwing), true);
  assert.equal(event.numberOfListeners, 1);

  assert.equal(raiseCatching(event), undefined);
  assert.equal(throwingCalls, 1);
  assert.equal(survivorCalls, 1);
});

test("a listener added during a throwing raise fires on the next raise", () => {
  const event = new Event();
  let deferredCalls = 0;
  let queued = false;
  let throwsLeft = 1;
  const deferred = () => {
    deferredCalls++;
  };
  const adder = () => {
    if (!queued) {
      queued = true;
      event.addEventListener(deferred);
    }
  };
  const throwing = () => {
    if (throwsLeft-- > 0) {
      throw new Error("listener failure");
    }
  };

  event.addEventListener(adder);
  event.addEventListener(throwing);

  assert.equal(raiseCatching(event)?.message, "listener failure");
  assert.equal(deferredCalls, 0);

  assert.equal(raiseCatching(event), undefined);
  assert.equal(deferredCalls, 1);
});

test("numberOfListeners matches the listeners a raise invokes after a throw and a re-add", () => {
  const event = new Event();
  const invoked = new Set();
  let queued = false;
  let throwsLeft = 1;
  const deferred = () => invoked.add("deferred");
  const adder = () => {
    invoked.add("adder");
    if (!queued) {
      queued = true;
      event.addEventListener(deferred);
    }
  };
  const throwing = () => {
    invoked.add("throwing");
    if (throwsLeft-- > 0) {
      throw new Error("listener failure");
    }
  };

  event.addEventListener(adder);
  event.addEventListener(throwing);
  assert.equal(raiseCatching(event)?.message, "listener failure");

  // The caller re-registers the listener it queued during the throwing raise.
  event.addEventListener(deferred);

  invoked.clear();
  assert.equal(raiseCatching(event), undefined);
  assert.deepEqual([...invoked].sort(), ["adder", "deferred", "throwing"]);
  assert.equal(event.numberOfListeners, invoked.size);
});

test("an EventHelper remover called twice leaves the other registration under removeAll", () => {
  const first = new Event();
  const second = new Event();
  let firstCalls = 0;
  let secondCalls = 0;
  const helper = new EventHelper();

  const removeFirst = helper.add(first, () => firstCalls++);
  helper.add(second, () => secondCalls++);

  removeFirst();
  removeFirst();

  helper.removeAll();
  first.raiseEvent();
  second.raiseEvent();

  assert.equal(firstCalls, 0);
  assert.equal(secondCalls, 0);
});

test("a remover captured before removeAll does not orphan a later registration", () => {
  const early = new Event();
  const late = new Event();
  let lateCalls = 0;
  const helper = new EventHelper();

  const removeEarly = helper.add(early, () => {});
  helper.removeAll();

  helper.add(late, () => lateCalls++);
  removeEarly();

  helper.removeAll();
  late.raiseEvent();

  assert.equal(lateCalls, 0);
});

test("EventHelper unsubscribes through its remover and through removeAll", () => {
  const event = new Event();
  const other = new Event();
  let calls = 0;
  let otherCalls = 0;
  const helper = new EventHelper();

  const remove = helper.add(event, () => calls++);
  event.raiseEvent();
  assert.equal(calls, 1);

  remove();
  event.raiseEvent();
  assert.equal(calls, 1);

  helper.add(other, () => otherCalls++);
  other.raiseEvent();
  assert.equal(otherCalls, 1);

  helper.removeAll();
  other.raiseEvent();
  assert.equal(otherCalls, 1);
});

test("a listener added during a raise does not fire in that same raise", () => {
  const event = new Event();
  let addedCalls = 0;
  let queued = false;
  const added = () => {
    addedCalls++;
  };
  const adder = () => {
    if (!queued) {
      queued = true;
      event.addEventListener(added);
    }
  };

  event.addEventListener(adder);
  event.addEventListener(() => {});

  event.raiseEvent();
  assert.equal(addedCalls, 0);

  event.raiseEvent();
  assert.equal(addedCalls, 1);
});
