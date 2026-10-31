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
  if (!record || record.installed !== true) {
    return { id, pass: false, notRun: true, before, after, assignments };
  }
  const pass = record.changed === false;
  return { id, pass, before, after, assignments };
}
