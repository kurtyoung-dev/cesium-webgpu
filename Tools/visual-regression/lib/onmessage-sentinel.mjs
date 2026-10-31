/**
 * window.onmessage sentinel for Playwright probes.
 * @purpose Page init script that records window.onmessage before any page script runs, plus the page-side reader and the pure verdict that fail when loading Cesium replaced it (the X1 shape: a Worker module imported from Globe.js self-registers `self.onmessage = ...`, which on the main thread is `window.onmessage`).
 * @status ACTIVE
 *
 * WHY IDENTITY, NOT THE DESCRIPTION. A worker-style module registers a handler
 * with the same shape a page handler has (a function taking an event), and two
 * different handlers can print the same source. The verdict therefore compares
 * the stored original REFERENCE with the current `window.onmessage` by `!==`;
 * the JSON-safe description (type, name, first 160 chars of source) exists only
 * so a failing record says WHICH handler took over. The reference never leaves
 * the page: a function cannot be serialised, and holding it in Node is not
 * needed.
 *
 * WHY THE ACCESSOR WRAP IS OPTIONAL AND FORWARDING. `onmessage` is an accessor
 * on the Window prototype chain in browsers, so a forwarding accessor defined
 * on `window` can count assignments and keep a few stack excerpts, which names
 * the module that did it. It forwards every get and set to the original
 * accessor, so the page behaves exactly as without the sentinel. Where the
 * property is a data property or a non-configurable accessor, or the wrap
 * throws, the reason is recorded and the identity comparison alone still works;
 * the wrap is evidence, never the verdict. Assignments through
 * `addEventListener("message", ...)` are not `onmessage` and are not counted.
 *
 * WHAT addInitScript GUARANTEES. Playwright runs an init script in every new
 * document before any script of that document, so the original value is read
 * before Cesium loads and the first recorded assignment is a Cesium-era one.
 * A page where the script did not run (installed false) has recorded no
 * original: the verdict reports that as notRun, never as a pass.
 *
 * USAGE.
 *   await page.addInitScript(installOnmessageSentinel); // before page.goto
 *   ... load Cesium, wait for the viewer ...
 *   const record = await readOnmessageSentinel(page);
 *   const verdict = onmessageVerdict("rig-id", record);
 *
 * TWO READS. A module loaded lazily after the first read can still replace
 * `window.onmessage`. A landing page reads once when the viewer exists and
 * again after its captures, and `combineOnmessageReads` joins them into one
 * record for `onmessageVerdict`: changed if either read saw a replacement,
 * notRun if the second read is missing.
 *
 * POSITIVE CONTROL. A sentinel that reads "unchanged" is only evidence if it
 * could have read "changed". At the END of a page (after capture and every
 * measurement, so nothing measured is touched) a landing run may call
 * `runOnmessagePositiveControl(page)`, which assigns a NAMED handler to
 * `window.onmessage` and reads the sentinel a second time;
 * `onmessagePositiveControlVerdict` passes only if that second reading shows
 * the change. A FAIL is the finding: the sentinel is dead and every
 * `onmessage-unchanged` pass in the run is void.
 *
 * @module Tools/visual-regression/lib/onmessage-sentinel
 */

/** Suffix of the verdict id: `<idPrefix>:onmessage-unchanged`. */
export const ONMESSAGE_VERDICT = "onmessage-unchanged";

/**
 * Page-context initializer. Pass to `page.addInitScript`. Self-contained: it is
 * serialised by Playwright and runs in the browser with no Node scope. Never
 * throws.
 */
export function installOnmessageSentinel() {
  try {
    const g = /** @type {any} */ (globalThis);
    if (g.__onmessageSentinel) {
      return;
    }
    const describe = (value) => {
      try {
        if (value === null || value === undefined) {
          return null;
        }
        return {
          type: typeof value,
          name: typeof value === "function" ? String(value.name) : "",
          source: Function.prototype.toString.call(value).slice(0, 160),
        };
      } catch (e) {
        return { type: typeof value, name: "", source: "(not describable)" };
      }
    };
    const state = {
      installed: true,
      original: undefined,
      before: null,
      assignments: 0,
      stacks: [],
      reason: undefined,
      describe,
    };
    g.__onmessageSentinel = state;
    try {
      state.original = g.onmessage;
      state.before = describe(state.original);
    } catch (e) {
      state.reason = `could not read onmessage: ${String(e)}`;
    }
    try {
      let owner = g;
      let desc;
      while (owner && !desc) {
        desc = Object.getOwnPropertyDescriptor(owner, "onmessage");
        owner = desc ? owner : Object.getPrototypeOf(owner);
      }
      const own = owner === g;
      if (!desc) {
        state.reason = "no onmessage property descriptor to wrap";
      } else if (
        typeof desc.get !== "function" &&
        typeof desc.set !== "function"
      ) {
        state.reason = "onmessage is a data property, identity comparison only";
      } else if (own && !desc.configurable) {
        state.reason =
          "onmessage is a non-configurable accessor, identity comparison only";
      } else if (!own && !Object.isExtensible(g)) {
        state.reason = "window is not extensible, identity comparison only";
      } else {
        Object.defineProperty(g, "onmessage", {
          configurable: true,
          enumerable: desc.enumerable,
          get() {
            return desc.get ? desc.get.call(this) : undefined;
          },
          set(value) {
            try {
              state.assignments++;
              if (state.stacks.length < 3) {
                state.stacks.push(
                  String(new Error("onmessage assigned").stack).slice(0, 600),
                );
              }
            } catch (e) {
              // Counting must never block the assignment it observes.
            }
            if (desc.set) {
              desc.set.call(this, value);
            }
          },
        });
      }
    } catch (e) {
      state.reason = `accessor wrap failed: ${String(e)}`;
    }
  } catch (e) {
    // The sentinel must never break the page it observes.
  }
}

/**
 * Page function returning the sentinel record. Self-contained, JSON-safe.
 *
 * @returns {{installed: boolean, before: object|null, after: object|null, changed: boolean, assignments: number, stacks: string[], reason?: string}}
 */
export function pageReadOnmessageSentinel() {
  const state = /** @type {any} */ (globalThis).__onmessageSentinel;
  if (!state) {
    return {
      installed: false,
      before: null,
      after: null,
      changed: false,
      assignments: 0,
      stacks: [],
      reason: "init script did not run",
    };
  }
  const current = /** @type {any} */ (globalThis).onmessage;
  const changed = state.original !== current;
  const record = {
    installed: true,
    before: state.before,
    after: state.describe(current),
    changed,
    assignments: state.assignments,
    stacks: state.stacks.slice(),
  };
  if (state.reason) {
    record.reason = state.reason;
  }
  return record;
}

/**
 * Node wrapper: read the sentinel from the page.
 *
 * @param {{evaluate: Function}} page A Playwright page.
 * @returns {Promise<ReturnType<typeof pageReadOnmessageSentinel>>}
 */
export async function readOnmessageSentinel(page) {
  return await page.evaluate(pageReadOnmessageSentinel);
}

/**
 * Pure verdict. Passes only when the sentinel was installed and
 * `window.onmessage` is still the value it had before any page script ran.
 * A record from a page where the init script did not run is notRun and fails.
 *
 * @param {string} idPrefix Rig or probe id.
 * @param {{installed?: boolean, changed?: boolean, before?: object|null, after?: object|null, assignments?: number}|null|undefined} record
 * @returns {{id: string, pass: boolean, notRun?: boolean, before: object|null, after: object|null, assignments: number}}
 */
export function onmessageVerdict(idPrefix, record) {
  const id = `${idPrefix}:${ONMESSAGE_VERDICT}`;
  const before = record?.before ?? null;
  const after = record?.after ?? null;
  const assignments = record?.assignments ?? 0;
  const reads = record?.reads ? { reads: record.reads } : {};
  if (!record || record.installed !== true) {
    return {
      id,
      pass: false,
      notRun: true,
      before,
      after,
      assignments,
      ...reads,
    };
  }
  const pass = record.changed === false;
  return { id, pass, before, after, assignments, ...reads };
}

/**
 * Pure combiner for the two reads a landing page takes: one when the viewer
 * exists and one after the page's captures. A module loaded lazily mid-page
 * can assign `window.onmessage` after the first read, so the verdict is
 * judged over both. Returns the record shape {@link onmessageVerdict} reads,
 * with both reads kept under `reads`.
 *
 * Changed when EITHER read saw a replacement, whatever the other says (a
 * handler put back is still a finding). Otherwise a missing or uninstalled
 * second read (the page died, the reader failed) is `installed: false`, which
 * the verdict reports notRun: a first read alone is never a pass. A first
 * read from a page without the sentinel is notRun too.
 *
 * @param {object|null|undefined} first The read taken when the viewer exists.
 * @param {object|null|undefined} second The read taken after the captures, or null when none was taken.
 * @returns {{installed: boolean, changed: boolean, before: object|null, after: object|null, assignments: number, stacks: string[], reason?: string, reads: {first: object|null, second: object|null}}}
 */
export function combineOnmessageReads(first, second) {
  const reads = { first: first ?? null, second: second ?? null };
  const firstSaw = first?.installed === true && first.changed === true;
  const secondSaw = second?.installed === true && second.changed === true;
  const source = firstSaw ? first : secondSaw ? second : (second ?? first);
  const combined = {
    installed: false,
    changed: false,
    before: first?.before ?? null,
    after: source?.after ?? null,
    assignments: Math.max(first?.assignments ?? 0, second?.assignments ?? 0),
    stacks: [...(source?.stacks ?? [])],
    reads,
  };
  const reason = source?.reason ?? first?.reason;
  if (reason) {
    combined.reason = reason;
  }
  if (firstSaw || secondSaw) {
    combined.installed = true;
    combined.changed = true;
  } else if (first?.installed !== true) {
    combined.reason ??= "first read missing";
  } else if (second?.installed !== true) {
    combined.reason = "second read missing";
  } else {
    combined.installed = true;
  }
  return combined;
}

/** Suffix of the control verdict id: `<idPrefix>:onmessage-positive-control`. */
export const ONMESSAGE_POSITIVE_CONTROL_VERDICT = "onmessage-positive-control";

/** Name of the handler the positive control assigns; the control verdict requires it as `after.name`. */
export const ONMESSAGE_POSITIVE_CONTROL_NAME =
  "onmessagePositiveControlHandler";

/**
 * Page function: assign a NAMED handler to `window.onmessage`. Self-contained
 * (serialised by Playwright, no Node scope; the name is spelled out inside
 * because a module constant is not visible there) and JSON-safe. The handler is
 * inert: it ignores every message. Never throws.
 *
 * @returns {{assigned: boolean, name: string, error?: string}}
 */
export function pageAssignOnmessagePositiveControl() {
  const name = "onmessagePositiveControlHandler";
  try {
    /** @type {any} */ (globalThis).onmessage =
      function onmessagePositiveControlHandler(event) {
        return event;
      };
    return { assigned: true, name };
  } catch (e) {
    return { assigned: false, name, error: String(e) };
  }
}

/**
 * Node wrapper: run the positive control in the page, then read the sentinel
 * again. Call it after everything else on the page is measured.
 *
 * @param {{evaluate: Function}} page A Playwright page.
 * @returns {Promise<ReturnType<typeof pageReadOnmessageSentinel> & {control: {assigned: boolean, name: string, error?: string}}>}
 *   The second sentinel record, plus what the control did under `control`.
 */
export async function runOnmessagePositiveControl(page) {
  const control = await page.evaluate(pageAssignOnmessagePositiveControl);
  const record = await readOnmessageSentinel(page);
  return { ...record, control };
}

/**
 * Pure control verdict over the record `runOnmessagePositiveControl` returned.
 * notRun when the sentinel was not installed (nothing to prove live). Passes
 * only when the record shows the change, names the control handler, and, when
 * the accessor wrap was taken (no `reason`), counted at least one assignment.
 * Where only the identity comparison was available (`reason` set) the
 * identity change alone passes. Anything else fails: the sentinel is dead.
 *
 * @param {string} idPrefix Rig or probe id.
 * @param {{installed?: boolean, changed?: boolean, before?: object|null, after?: {name?: string}|null, assignments?: number, reason?: string}|null|undefined} record
 * @returns {{id: string, pass: boolean, notRun?: boolean, before: object|null, after: object|null, assignments: number}}
 */
export function onmessagePositiveControlVerdict(idPrefix, record) {
  const id = `${idPrefix}:${ONMESSAGE_POSITIVE_CONTROL_VERDICT}`;
  const before = record?.before ?? null;
  const after = record?.after ?? null;
  const assignments = record?.assignments ?? 0;
  if (!record || record.installed !== true) {
    return { id, pass: false, notRun: true, before, after, assignments };
  }
  const sawChange = record.changed === true;
  const sawName = record.after?.name === ONMESSAGE_POSITIVE_CONTROL_NAME;
  const sawAssignment = record.reason ? true : assignments >= 1;
  const pass = sawChange && sawName && sawAssignment;
  return { id, pass, before, after, assignments };
}
