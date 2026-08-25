# DEV notes — lighting and compute

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

Scope: clustered-lighting bindings and compute-instance rendering across the
WebGPU and WebGL backends.

---

### `packages/engine/Source/Scene/LightTypes.ts` — `(module docblock)`

_Moved 2026-08-24._

````text
Light source classes for CesiumJS multi-light rendering.
Addresses upstream issue #8518 — currently CesiumJS only supports
one directional sun light.

## Light Types
- {@link DirectionalLight} — Parallel rays (sun, moon). Default.
- {@link PointLight} — Omni-directional (street lamps, explosions).
- {@link SpotLight} — Cone of light (flashlights, headlights).

## Usage
```javascript
// Add lights to the scene
scene.lights.add(new Cesium.DirectionalLight({
  direction: new Cesium.Cartesian3(-1, -1, -1),
  color: Cesium.Color.WHITE,
  intensity: 1.0,
}));
scene.lights.add(new Cesium.PointLight({
  position: Cesium.Cartesian3.fromDegrees(-75.0, 40.0, 100.0),
  color: Cesium.Color.YELLOW,
  intensity: 2.0,
  range: 500.0,
}));
```

## Shader Integration
The `LightUniforms.wgsl` struct is updated to support an array of lights.
Lit shaders loop over `lightCount` active lights in the uniform buffer.

@see https://github.com/CesiumGS/cesium/issues/8518
@module Light
````

Kept because the upstream issue and one-sun baseline explain why this fork
owns the multi-light surface, but neither is a constraint on the current
implementation. The rewritten module documentation describes the current
types and packing contract without making a stale claim about upstream state.
