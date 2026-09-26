// A browser-shaped `document`, installed before any engine module is imported.
//
// `node --import ./packages/engine/Specs/browserDocumentPreload.mjs --test <spec>`
// runs a Node spec in the environment karma runs it in. It is not a convenience:
// `getAbsoluteUri` returns its argument untouched when no `document` exists, so
// every url measurement taken in bare Node is blind to what the same code does
// in a browser, and a spec that only ever runs bare certifies its harness rather
// than the engine. Modules read this at import time as well as at call time
// (`RequestScheduler.js` reads `document.location.href` while it loads), which is
// why this is a preload and not an assignment inside a test.
//
// The values are the ones karma serves specs from.
globalThis.document = {
  baseURI: "http://localhost:9876/context.html",
  location: { href: "http://localhost:9876/context.html" },
};
