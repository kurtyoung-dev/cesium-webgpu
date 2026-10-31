/**
 * Where a runtime probe treats as its repository and writes its output.
 * @purpose Resolves a probe's repository root and output directory from the kit's own location instead of process.cwd(), and refuses an output directory outside that root unless the caller named a repository root explicitly.
 * @status ACTIVE
 *
 * The runtime used to default both to `process.cwd()`, so a probe or a spec
 * started with another checkout as its working directory wrote its output into
 * THAT checkout (a water lane's early spec drafts created `output/fft-ocean`
 * and `output/ssr-water` under the seat this way). The default is now the
 * checkout that holds this module, a relative `--output` resolves against that
 * root, and an output that would land outside it is refused unless a
 * `--repository-root` (or the runtime's `repositoryRoot` seam) says the caller
 * meant it, which is how every spec points a probe at a temporary directory.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout that holds the kit: `<root>/Tools/visual-regression/lib/`. */
export const KIT_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * @param {object} options
 * @param {string|null} [options.repositoryRoot] `--repository-root` as parsed.
 * @param {string|null} [options.repositoryRootOverride] The runtime's injection seam.
 * @param {string|null} [options.outputDirectory] `--output` as parsed.
 * @param {string} options.outputSubdirectory Default folder under `Tools/visual-regression/output/`.
 * @param {string} [options.kitRepositoryRoot] The default root; a seam for specs.
 * @returns {{ repositoryRoot: string, outputDirectory: string }}
 */
export function resolveProbeLocations({
  repositoryRoot = null,
  repositoryRootOverride = null,
  outputDirectory = null,
  outputSubdirectory,
  kitRepositoryRoot = KIT_REPOSITORY_ROOT,
}) {
  const explicitRoot = repositoryRoot ?? repositoryRootOverride ?? null;
  const root = path.resolve(explicitRoot ?? kitRepositoryRoot);
  const output =
    outputDirectory !== null && outputDirectory !== undefined
      ? path.resolve(root, outputDirectory)
      : path.join(
          root,
          "Tools",
          "visual-regression",
          "output",
          outputSubdirectory,
        );
  if (explicitRoot === null && !isInside(root, output)) {
    throw new Error(
      `--output ${output} is outside the kit's repository root ${root}; ` +
        "pass --repository-root as well if writing there is intended",
    );
  }
  return { repositoryRoot: root, outputDirectory: output };
}
