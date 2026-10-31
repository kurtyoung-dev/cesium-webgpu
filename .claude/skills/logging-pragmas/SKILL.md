---
name: logging-pragmas
description: Engine logging rules — which logs take debug pragmas, which stay permanent, pragma-aware predicates, sentinels for new subsystems. Read before adding or changing engine logs.
---

# Logging & Debug Pragmas — CRITICAL

Part of the fork's rules: moved here from `CLAUDE.md` (see its "On-demand Skills" section) so it loads only when needed, and it binds exactly as `CLAUDE.md` does.

CesiumJS has a pragma stripping system that removes debug-only code from
production builds with **zero runtime cost**. Our `stripPragmaPlugin`
(in `scripts/build.js`) now handles both `.js` and `.ts` files, so WebGPU
TypeScript diagnostics can use the same pattern as upstream JavaScript.

The rule applies engine-wide, but the CI guard (`npm run lint-debug-pragmas`,
`Tools/lint-debug-pragmas.mjs`) only scans `packages/engine/Source/Renderer/WebGPU`
(277 of the engine's 1,508 `.js`/`.ts` files, measured 2026-09-05) — a violation
elsewhere in the engine is not caught mechanically.

Where a context is in hand, **prefer `context.log(level, message)`
(`GraphicsContext.ts:1961`) over a bare `console.*`** for renderer diagnostics, so the
context id reaches the message (Principle 3). This is a preference, not a MUST: the
pragma rules below still govern what gets wrapped, and `console.error` for a real error
stays exactly as this skill describes it.

## When to wrap a log in pragmas

**ALWAYS wrap with pragma tags** when the log is any of:

- Per-frame or per-tile diagnostic (center3D, UV uniforms, pass counts)
- Init-time informational messages (feature detection, resource creation success)
- Informational `console.log` or `console.warn` that helps debugging but isn't a real error
- Any log with string interpolation, `.toFixed()`, object stringification, or other
  work that has runtime cost even if the user doesn't look at the console

```javascript
//>>includeStart('debug', pragmas.debug);
console.log(`[WebGPU:GlobeTile] center3D: (${center.x.toFixed(1)}, ...)`);
//>>includeEnd('debug');
```

## When to keep a log permanent (no pragma)

**NEVER wrap** a log that is any of:

- `console.error` that indicates a real bug producing broken output (null blit
  target, index buffer overflow, command buffer invalidation, device lost)
- Shader compile errors or pipeline creation failures
- Recovery attempt failures / retry exhaustion
- Clear loop detectors and other infinite-loop sentinels
- Any message the user NEEDS to see to diagnose a production problem

Real errors must always reach the console — that's how bugs get reported.

## Helper functions (pragma-aware predicates)

When a diagnostic is called from many sites, put the throttle logic in a
predicate method whose body is pragma-stripped. The method returns `false`
in production and the call sites become dead code that esbuild removes:

```typescript
private _diagShouldLog(): boolean {
  //>>includeStart('debug', pragmas.debug);
  if (this._diagTileCount !== 0) return false;
  const now = performance.now();
  if (now - this._diagLastLogTime < 3000) return false;
  this._diagLastLogTime = now;
  return true;
  //>>includeEnd('debug');
  return false;
}
```

## Permanent sentinels to add for new subsystems

Every new renderer / pipeline subsystem SHOULD add these permanent checks:

1. **Re-entry / infinite loop guard** — counter in the per-frame entry point,
   `console.error` with throttle if it exceeds a sane limit
2. **Null target guard** — check source/destination texture views at render
   pass boundaries, `console.error` if null
3. **Size validation** — check buffer sizes vs index/vertex counts before
   submitting draw commands, `console.error` if overflow, clamp to safe value

These catch the failure modes of BUG-12 (clear loop), BUG-13 (null PP views),
and BUG-15 (index overflow) without needing deep debugging.
