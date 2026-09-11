# tsd-jsdoc compatibility package provenance

This package is derived from the published `tsd-jsdoc@2.5.0` npm artifact.

- Registry metadata: `https://registry.npmjs.org/tsd-jsdoc/2.5.0`
- Tarball: `https://registry.npmjs.org/tsd-jsdoc/-/tsd-jsdoc-2.5.0.tgz`
- Tarball SHA-256: `318f9410250e8321bd76e0606f38a7a2a0d5dde2381b7d00b887ed644811942f`
- Tarball SHA-512 integrity: `sha512-80fcJLAiUeerg4xPftp+iEEKWUjJjHk9AvcHwJqA8Zw0R4oASdu3kT/plE/Zj19QUTz8KupyOX25zStlNJjS9g==`
- Upstream license: MIT, retained verbatim in `LICENSE`

The `dist` entrypoints, emitter, source maps, README, author, repository, and
runtime TypeScript dependency range are unchanged from the upstream artifact.
The Cesium compatibility revision changes the package version, marks the package
private, adds `PROVENANCE.md` and `npm-shrinkwrap.json` to the packed `files`,
and changes the JSDoc development/peer contract from JSDoc 3 to exactly JSDoc
4.0.5. The added shrinkwrap pins the reproducible TypeScript resolution to
3.9.10. The published runtime dependency range `typescript: ^3.2.1` remains
unchanged.

The local tarball must be produced with `pack-compat.mjs`. That recipe disables
lifecycle scripts, performs two independent local packs, and accepts the result
only when their bytes and exact package membership match.

The upstream manifest line `"prepare": "npm run build"` is removed in this
local package. The published artifact contains precompiled `dist` files but no
TypeScript source or `tsconfig.json`, its runtime entrypoints do not invoke the
hook, and an observed npm 10.9.8/Pacote 19.0.2 pack attempt ran `prepare` despite
the recipe's ignore-scripts argument. Retained upstream `build`, `watch`, and
`test` metadata is not runnable from this standalone published payload. This
bounded disposition was independently approved in
`GALADRIEL_PREPARE_HOOK_DISPOSITION_01.md` (SHA-256
`873c31e831872c31950a856e32ea9312126fc8a820e73bd96eb626a661a85d68`) and
`ELENDIL_PREPARE_HOOK_DISPOSITION_01.md` (SHA-256
`e544a8b3d0863119647381991d7240def18092fd41d26da43ce246e1205da709`).
