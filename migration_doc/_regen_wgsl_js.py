"""Regenerate .js wrapper next to a .wgsl file.

The .js wrapper is a single `export default "..."` string with each line
ending in `\n\` so the JS is still valid multi-line. This is what
`gulp buildWGSL` would produce; we do it by hand when we edit WGSL
without running the full build.
"""
import pathlib
import sys


def regenerate(wgsl_path: pathlib.Path) -> None:
    js_path = wgsl_path.with_suffix(".js")
    src = wgsl_path.read_text(encoding="utf-8")
    # Normalize line endings — the .wgsl may have CRLF on Windows.
    lines = src.replace("\r\n", "\n").split("\n")
    # Trailing newline produces a final empty line; drop it for cleaner output.
    if lines and lines[-1] == "":
        lines.pop()
    out = ["//This file is automatically rebuilt by the Cesium build process.\n"]
    out.append('export default "')
    bs = chr(92)  # backslash
    for i, line in enumerate(lines):
        escaped = line.replace(bs, bs + bs).replace('"', bs + '"')
        if i < len(lines) - 1:
            out.append(escaped + bs + "n" + bs + "\n")
        else:
            out.append(escaped + bs + "n" + bs + "\n")
    out.append('";\n')
    js_path.write_text("".join(out), encoding="utf-8", newline="\n")
    print(f"regenerated {js_path.name}")


if __name__ == "__main__":
    names = sys.argv[1:]
    base = pathlib.Path("packages/engine/Source/Shaders/WebGPU/Primitive")
    for name in names:
        wgsl = base / f"{name}.wgsl"
        if not wgsl.exists():
            print(f"NOT FOUND: {wgsl}")
            sys.exit(1)
        regenerate(wgsl)
