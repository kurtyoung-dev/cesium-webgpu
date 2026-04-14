import baseConfig from "../../lint-staged.config.js";

export default {
  ...baseConfig,
  // NOTE: tsc was previously included here as `() => "tsc"` for every
  // staged .js/.ts file. This caused the pre-commit hook to run a full
  // project type-check (~30s) on top of eslint + prettier — when many
  // files are staged (600+) the combined pipeline exceeded lint-staged's
  // timeout. The tsc step is now in the husky pre-commit hook itself
  // (runs once, after lint-staged finishes), keeping the per-file
  // pipeline fast.
};
