// attach-page-diagnostics.mjs — a general-purpose Playwright page
// console/pageerror listener pair, with ownership-safe detachment.
//
// @purpose General Playwright page diagnostics: separate console-message and
//   page-error arrays, a text filter, a per-array cap with overflow counting,
//   and a detach() that removes only the listeners it added.
// @status ACTIVE
//
// WHY THIS EXISTS. A census of the probe fleet found several hundred files
// hand-rolling `page.on("console", ...)` / `page.on("pageerror", ...)` pairs,
// with real variance between them: some merge both streams into one array,
// some keep two; some filter to `type === "error"` only, others keep every
// console type; some prefix page errors (`"PAGEERR:" + message`), others
// don't; none of the surveyed variants counted what they dropped when a cap
// was in play, because none of them had a cap. This helper is the one home
// for the common shape — two arrays, a shared record format, an optional
// filter, and an optional cap that counts what it discards — so a new probe
// can call one function instead of re-deriving the pair.
//
// WHAT THIS IS NOT. The WebGPU validation/device-loss gate
// (`Tools/lib/webgpu-error-gate.mjs`) stays a separate, specialised module:
// it matches a specific fault pattern across a merged stream and arms GPU
// devices in-page. This helper does not know about WebGPU at all — it is
// the general console/pageerror capture that a gate, or a plain probe, can
// build on top of.
//
// OWNERSHIP. `attach` stores its own bound listener functions and calls
// `page.off(event, thatExactFunction)` in `detach()`. A page can carry other
// listeners for the same events — from another `attachPageDiagnostics` call,
// or from caller code — and `detach()` never touches them: it removes the
// two functions it registered and nothing else.

/**
 * @typedef {object} PageDiagnosticRecord
 * @property {string} type Console message type (`"log"`, `"error"`,
 *   `"warning"`, ...) or `"pageerror"` for an uncaught page exception.
 * @property {string} text The message text, or the error's message.
 * @property {{url: string, lineNumber: number, columnNumber: number}|null} location
 *   Source location when the underlying event exposes one; `null` otherwise
 *   (Playwright's `pageerror` payload carries no location).
 * @property {number} timestamp `Date.now()` at the moment the event arrived.
 *   Millisecond resolution only — two records from different streams in the
 *   same tick can tie. Use `seq`, not `timestamp`, to reconstruct order.
 * @property {number} seq A sequence number, unique and increasing across
 *   BOTH the `console` and `errors` streams together, assigned in the exact
 *   order the events were delivered to this handle's listeners. A consumer
 *   that needs the original single-stream arrival order back — the two
 *   arrays exist for separation, not to discard order — sorts the
 *   concatenation of both arrays by `seq`.
 */

/**
 * @typedef {object} PageDiagnosticsHandle
 * @property {PageDiagnosticRecord[]} console Console-message records, in
 *   arrival order.
 * @property {PageDiagnosticRecord[]} errors Page-error records
 *   (`type: "pageerror"`), in arrival order.
 * @property {{console: number, errors: number}} overflow Count of records
 *   that matched the filter (or were unfiltered) but were dropped because
 *   their array had already reached `cap`. Zero when no `cap` is set.
 * @property {() => void} detach Remove exactly the two listeners this call
 *   added. Idempotent — a second call is a no-op.
 */

/**
 * Attach a console-message listener and a page-error listener to a
 * Playwright `page`, collecting each into its own array of plain records.
 *
 * Call once per page, before the navigation that is expected to produce the
 * diagnostics of interest — Playwright delivers `console`/`pageerror` events
 * only to listeners already attached when they fire.
 *
 * @param {{on: Function, off: Function}} page A Playwright `Page` (or
 *   anything shaped like one — an `EventEmitter`-based test double included).
 * @param {object} [options]
 * @param {(record: PageDiagnosticRecord) => boolean} [options.filter]
 *   Predicate deciding whether a record is kept at all. Runs before the cap,
 *   on both streams (a page-error record has `type: "pageerror"`, so a
 *   filter can select or exclude it the same way it would a console type).
 *   Omit to keep every record.
 * @param {number} [options.cap] Maximum records retained in EACH of
 *   `console` and `errors` (the two arrays are capped independently, not
 *   jointly). Records that pass the filter after an array is already at
 *   `cap` are dropped and counted in the matching `overflow` field, never
 *   silently. Omit (or a non-finite value) for no cap.
 * @returns {PageDiagnosticsHandle}
 */
export function attachPageDiagnostics(page, options = {}) {
  const filter = typeof options.filter === "function" ? options.filter : null;
  const cap = Number.isFinite(options.cap)
    ? Math.max(0, Math.floor(options.cap))
    : Infinity;

  const consoleMessages = [];
  const errors = [];
  const overflow = { console: 0, errors: 0 };
  let seq = 0;

  function push(array, kind, record) {
    if (filter && !filter(record)) {
      return;
    }
    if (array.length >= cap) {
      overflow[kind] += 1;
      return;
    }
    // Assigned only to records that actually land in an array, in the exact
    // order `push` is entered for the two listeners below — the shared
    // ordering key `timestamp` alone cannot give back (see the typedef).
    record.seq = seq++;
    array.push(record);
  }

  function readLocation(msg) {
    if (typeof msg.location !== "function") {
      return null;
    }
    try {
      return msg.location() ?? null;
    } catch {
      // A test double or an exotic message type may not implement this;
      // a missing location is not a reason to lose the message.
      return null;
    }
  }

  const onConsole = (msg) => {
    push(consoleMessages, "console", {
      type: msg.type(),
      text: msg.text(),
      location: readLocation(msg),
      timestamp: Date.now(),
    });
  };

  const onPageError = (err) => {
    const text = err && err.message ? err.message : String(err);
    push(errors, "errors", {
      type: "pageerror",
      text,
      location: null,
      timestamp: Date.now(),
    });
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  let detached = false;
  function detach() {
    if (detached) {
      return;
    }
    detached = true;
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }

  return { console: consoleMessages, errors, overflow, detach };
}
