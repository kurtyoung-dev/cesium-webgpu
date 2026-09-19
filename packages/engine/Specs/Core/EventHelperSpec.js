import { Event, EventHelper } from "../../index.js";

describe("Core/EventHelper", function () {
  let helper;
  let event;
  let spyListener;
  beforeEach(function () {
    helper = new EventHelper();
    event = new Event();
    spyListener = jasmine.createSpy("listener");
  });

  it("add registers the listener with the event", function () {
    const someValue = 123;
    helper.add(event, spyListener);
    event.raiseEvent(someValue);

    expect(spyListener).toHaveBeenCalledWith(someValue);
  });

  it("add registers the listener with a scope", function () {
    const scope = {};
    helper.add(event, spyListener, scope);
    event.raiseEvent();

    expect(spyListener.calls.first().object).toBe(scope);
  });

  it("the returned function removes only its own registration", function () {
    const otherEvent = new Event();
    const otherListener = jasmine.createSpy("otherListener");

    const remove = helper.add(event, spyListener);
    helper.add(otherEvent, otherListener);

    remove();
    event.raiseEvent();
    otherEvent.raiseEvent();

    expect(spyListener).not.toHaveBeenCalled();
    expect(otherListener).toHaveBeenCalled();
  });

  it("removeAll unregisters every listener it added", function () {
    const otherEvent = new Event();
    const otherListener = jasmine.createSpy("otherListener");

    helper.add(event, spyListener);
    helper.add(otherEvent, otherListener);

    helper.removeAll();
    event.raiseEvent();
    otherEvent.raiseEvent();

    expect(spyListener).not.toHaveBeenCalled();
    expect(otherListener).not.toHaveBeenCalled();
  });

  it("a remover called twice leaves the other registration under removeAll", function () {
    const otherEvent = new Event();
    const otherListener = jasmine.createSpy("otherListener");

    const remove = helper.add(event, spyListener);
    helper.add(otherEvent, otherListener);

    remove();
    remove();

    helper.removeAll();
    event.raiseEvent();
    otherEvent.raiseEvent();

    expect(spyListener).not.toHaveBeenCalled();
    expect(otherListener).not.toHaveBeenCalled();
  });

  it("a remover captured before removeAll does not orphan a later registration", function () {
    const laterEvent = new Event();
    const laterListener = jasmine.createSpy("laterListener");

    const remove = helper.add(event, spyListener);
    helper.removeAll();

    helper.add(laterEvent, laterListener);
    remove();

    helper.removeAll();
    laterEvent.raiseEvent();

    expect(laterListener).not.toHaveBeenCalled();
  });

  it("add throws with undefined event", function () {
    expect(function () {
      helper.add(undefined, spyListener);
    }).toThrowDeveloperError();
  });
});
