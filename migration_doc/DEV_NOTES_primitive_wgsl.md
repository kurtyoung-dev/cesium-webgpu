# DEV notes — primitive WGSL

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

### `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongColor.wgsl` — `fragmentMain`

_Moved 2026-08-21._

```text
NEW-PERINSTANCE-DIFFUSE-PARITY (Batch 326) — match the GLSL reference
`czm_phong` (Builtin/Functions/phong.glsl) used by
PerInstanceColorAppearance / ColorAppearance (`PerInstanceColorAppearanceFS`).
The prior ad-hoc Blinn-Phong (ambient 0.15 + 0.7·N·L_sun + 0.15·spec)
diverged badly: it keyed diffuse on the SUN direction and used a 0.15
ambient floor, rendering lit per-instance surfaces ~40% darker than
WebGL (~92 vs ~154 surface luminance).

czm_phong (3D scene mode, the renderer's dominant case) computes diffuse
from two FIXED eye-space light directions — +Z (toward the eye, for
top-down) and +Y (up, for 3D horizon views) — NOT the sun direction:
    diffuse = max(dot(N,+Z),0) + max(dot(N,+Y),0)            (0..2)
and folds a 0.5 ambient term in via `materialDiffuse = color*0.5`:
    out = color*0.5 + color*0.5*diffuse*czm_lightColor + spec*...
        = color * 0.5 * (1 + diffuse)        (czm_lightColor = white)
For PerInstanceColor/Color the material's specular is 0, so the
specular term contributes nothing — we drop it to keep parity.
The shadow factor darkens only the directional (diffuse) term; the 0.5
ambient floor stays lit even in full shadow. NOTE: this DIVERGES from
WebGL czm_shadowVisibility, which multiplies the ENTIRE czm_phong output
(ambient included) by visibility, so a fully-shadowed primitive renders
darker on WebGL than here. Kept intentionally (avoids crushing shadowed
primitives toward black); a known low-severity shadow-contrast residual.
```

Kept because it records the measured luminance mismatch and the discarded
sun-directed lighting model. The shader comment retains the current fixed-light
equations and intentional ambient-shadow behavior without the development
history.

### `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongTexturedColor.wgsl` — `fragmentMain`

_Moved 2026-08-21._

```text
NEW-PERINSTANCE-DIFFUSE-PARITY (Batch 326) — match the GLSL reference
`czm_phong` (Builtin/Functions/phong.glsl) used by the lit color/material
appearances. See the matching comment in PrimitivePhongColor.wgsl for the
full derivation. czm_phong (3D scene mode) computes diffuse from two
FIXED eye-space light directions (+Z toward the eye, +Y up) — NOT the sun
— and folds a 0.5 ambient term in:  out = color * 0.5 * (1 + diffuse).
The prior ad-hoc Blinn-Phong keyed diffuse on the sun direction with a
0.15 ambient floor, rendering lit surfaces ~40% darker than WebGL.
material.specular is 0 for these appearances, so the specular term is
dropped to keep parity.
```

Kept because it links the textured path to the same rejected lighting model
and measured mismatch. The rewritten shader comment states only the equations
and current material constraint.
