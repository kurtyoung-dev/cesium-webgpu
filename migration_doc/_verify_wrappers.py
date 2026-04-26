"""Verify each PrimitiveMat*.js wrapper matches its .wgsl source after
the BUG-36.2 Option B shader rewrites.
"""
import pathlib
import re


def verify():
    base = pathlib.Path("packages/engine/Source/Shaders/WebGPU/Primitive")
    bs = chr(92)  # backslash
    mismatches = []
    checked = 0
    for wgsl_path in sorted(base.glob("PrimitiveMat*.wgsl")):
        js_path = wgsl_path.with_suffix(".js")
        if not js_path.exists():
            mismatches.append(f"MISSING: {js_path}")
            continue
        wgsl = (
            wgsl_path.read_text(encoding="utf-8")
            .replace("\r\n", "\n")
            .rstrip("\n")
        )
        js = js_path.read_text(encoding="utf-8")
        m = re.search(r'export default "(.*)";', js, re.DOTALL)
        if not m:
            mismatches.append(f"UNPARSEABLE: {js_path}")
            continue
        raw = m.group(1)
        # Line continuation: each source line ends with "\n\<newline>" → that
        # sequence is two characters in the file: backslash-n, backslash,
        # newline. Replace the literal sequence with a single newline.
        cont = bs + "n" + bs + "\n"
        unescaped = raw.replace(cont, "\n")
        # Unescape double-quotes and backslashes.
        unescaped = unescaped.replace(bs + '"', '"').replace(bs * 2, bs)
        if unescaped.rstrip("\n") != wgsl:
            mismatches.append(f"DRIFT: {wgsl_path.name}")
            lines_w = wgsl.split("\n")
            lines_j = unescaped.rstrip("\n").split("\n")
            for i in range(min(len(lines_w), len(lines_j))):
                if lines_w[i] != lines_j[i]:
                    print(f"  {wgsl_path.name} first diff at line {i + 1}:")
                    print(f"    wgsl: {lines_w[i]!r}")
                    print(f"    js:   {lines_j[i]!r}")
                    break
            if len(lines_w) != len(lines_j):
                print(f"  {wgsl_path.name} length: wgsl={len(lines_w)} js={len(lines_j)}")
        checked += 1
    if not mismatches:
        print(f"ALL IN SYNC: {checked} .js wrappers match .wgsl")
    else:
        print(f"MISMATCHES ({len(mismatches)} of {checked}):")
        for m in mismatches:
            print(" ", m)


if __name__ == "__main__":
    verify()
