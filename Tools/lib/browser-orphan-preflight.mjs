/**
 * Reports browser process trees whose immediate parent is absent.
 * @purpose Lists parent-dead msedge/chrome/chromium/firefox/webkit/playwright roots, their descendant trees, each tree's memory and the machine's free memory. Reports only; it never kills a process.
 * @status ACTIVE
 *
 * WHY POWERSHELL: Node does not expose Windows parent process IDs. The native
 * Win32_Process query supplies that missing field; parsing and classification
 * stay in Node, which is preferred wherever a shell is not required.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROCESS_QUERY = Object.freeze({
  command: "powershell.exe",
  args: Object.freeze([
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Csv -NoTypeInformation",
  ]),
});

export function parseProcessCsv(text) {
  const lines = text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const header = lines.shift();
  if (header !== '"ProcessId","ParentProcessId","Name","WorkingSetSize"') {
    throw new Error("unexpected header: " + header);
  }
  return lines.map((line) => {
    const match = /^"(\d+)","(\d+)","([^"]*)","(\d+)"$/.exec(line);
    if (!match) throw new Error("unparsable row: " + line);
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: match[3],
      rss: Number(match[4]),
    };
  });
}

export function findOrphanRoots(rows) {
  const pids = new Set(rows.map((row) => row.pid));
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const roots = rows.filter(
    (row) =>
      /^(msedge|chrome|chromium|firefox|playwright|webkit)\.exe$/i.test(
        row.name,
      ) && !pids.has(row.ppid),
  );
  return roots
    .map((root) => {
      const seen = new Set();
      const tree = [];
      const pending = [root];
      while (pending.length > 0) {
        const row = pending.pop();
        if (seen.has(row.pid)) continue;
        seen.add(row.pid);
        tree.push(row);
        pending.push(...(children.get(row.pid) ?? []));
      }
      return { root, tree, bytes: tree.reduce((sum, row) => sum + row.rss, 0) };
    })
    .sort((a, b) => b.bytes - a.bytes || a.root.pid - b.root.pid);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  if (process.platform !== "win32") {
    console.error(
      `browser-orphan-preflight: unsupported platform ${process.platform}; this preflight reads Win32_Process`,
    );
    process.exitCode = 2;
  } else {
    try {
      const text = execFileSync(PROCESS_QUERY.command, PROCESS_QUERY.args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60000,
        windowsHide: true,
      });
      const rows = parseProcessCsv(text);
      const roots = findOrphanRoots(rows);
      const gib = (bytes) => (bytes / 1024 ** 3).toFixed(2);
      console.log(
        `browser-orphan-preflight: ${rows.length} processes, ${roots.length} parent-dead browser root(s)`,
      );
      for (const { root, tree, bytes } of roots) {
        console.log(
          `  pid ${root.pid} ${root.name} parent ${root.ppid} (dead) tree ${tree.length} proc ${gib(bytes)} GiB`,
        );
      }
      console.log(
        `memory: free ${gib(os.freemem())} GiB of ${gib(os.totalmem())} GiB`,
      );
      console.log(
        roots.length === 0
          ? "PASS: no parent-dead browser processes"
          : `FAIL: ${roots.length} parent-dead browser root(s)`,
      );
      process.exitCode = roots.length === 0 ? 0 : 1;
    } catch (error) {
      console.error(
        `browser-orphan-preflight: process query failed: ${error.message}`,
      );
      process.exitCode = 2;
    }
  }
}
