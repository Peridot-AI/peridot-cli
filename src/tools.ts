// File and shell tools for the coding agent. Everything is confined to the folder Peridot was
// opened in (the workspace); paths that resolve outside it, also through symlinks, are refused.
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".svelte-kit", "target", "__pycache__", ".venv", "release"]);
const MAX_FILE_BYTES = 400_000;
const MAX_OUTPUT = 30_000;

export const root = fs.realpathSync(process.cwd());

export type ToolName = "list_files" | "read_file" | "search" | "write_file" | "edit_file" | "run_command";
export const NEEDS_APPROVAL: Record<ToolName, "edit" | "command" | null> = {
  list_files: null,
  read_file: null,
  search: null,
  write_file: "edit",
  edit_file: "edit",
  run_command: "command",
};

const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Resolves a path supplied by the user or the model inside the workspace, following symlinks. */
function inside(rel: unknown = "."): string {
  const abs = path.resolve(root, String(rel));
  let probe = abs; // for files that don't exist yet, check the nearest existing parent
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = fs.realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`Path is outside the workspace: ${rel}`);
  return abs;
}
const relOf = (abs: string) => path.relative(root, abs) || ".";

type Input = Record<string, any>;

function listFiles({ path: p = ".", recursive = false }: Input) {
  const base = inside(p);
  if (!isDir(base)) throw new Error(`Not a directory: ${p}`);
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= 500) return;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      out.push(relOf(abs) + (e.isDirectory() ? "/" : ""));
      if (recursive && e.isDirectory() && depth < 3) walk(abs, depth + 1);
    }
  };
  walk(base, 1);
  return out.join("\n") || "(empty)";
}

function readText(abs: string) {
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error("Not a file.");
  if (st.size > MAX_FILE_BYTES) throw new Error(`File is too large (${st.size} bytes). Use search or read part of it.`);
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error("Binary file.");
  return buf.toString("utf8");
}

function readFile({ path: p, offset = 1, limit = 400 }: Input) {
  const lines = readText(inside(p)).split("\n");
  const start = Math.max(1, offset);
  const slice = lines.slice(start - 1, start - 1 + limit);
  const body = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
  return body + (start - 1 + limit < lines.length ? `\n… (${lines.length} lines total)` : "");
}

function search({ pattern, path: p = ".", ignore_case = false }: Input) {
  let re: RegExp;
  try { re = new RegExp(pattern, ignore_case ? "i" : ""); } catch (e) { throw new Error(`Bad regex: ${(e as Error).message}`); }
  const hits: string[] = [];
  const visit = (abs: string) => {
    if (hits.length >= 100) return;
    const st = fs.lstatSync(abs); // never follow symlinks out of the workspace
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs)) if (!SKIP_DIRS.has(e)) visit(path.join(abs, e));
    } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) return;
      buf.toString("utf8").split("\n").forEach((line, i) => {
        if (hits.length < 100 && re.test(line)) hits.push(`${relOf(abs)}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
    }
  };
  visit(inside(p));
  return hits.join("\n") || "No matches.";
}

function writeFile({ path: p, content }: Input) {
  const abs = inside(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, String(content));
  return `${existed ? "Overwrote" : "Created"} ${relOf(abs)} (${String(content).split("\n").length} lines).`;
}

function editFile({ path: p, old_string, new_string, replace_all = false }: Input) {
  const abs = inside(p);
  const text = readText(abs);
  if (!old_string) throw new Error("old_string is empty.");
  const count = text.split(old_string).length - 1;
  if (count === 0) throw new Error("old_string was not found. Read the file again and copy the text exactly.");
  if (count > 1 && !replace_all) throw new Error(`old_string appears ${count} times. Add more context or set replace_all.`);
  fs.writeFileSync(abs, replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string));
  return `Edited ${relOf(abs)} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? "s" : ""}).`;
}

const running = new Set<ChildProcess>();

/** Runs a shell command in the workspace. Never rejects: failures come back in the text. */
export function runCommand({ command }: Input): Promise<string> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd.exe" : "/bin/sh", isWin ? ["/d", "/s", "/c", String(command)] : ["-c", String(command)], { cwd: root, env: process.env });
    running.add(child);
    let out = "";
    const add = (d: Buffer) => { if (out.length < MAX_OUTPUT * 2) out += d.toString(); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => { out += "\n[timed out after 120s]"; child.kill("SIGKILL"); }, 120_000);
    const end = (code: number | null) => {
      clearTimeout(timer);
      running.delete(child);
      const text = out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT / 2) + "\n… (output cut) …\n" + out.slice(-MAX_OUTPUT / 2) : out;
      resolve(`${text.trim() || "(no output)"}\n[exit code ${code}]`);
    };
    child.on("error", (e) => { out += String(e.message); end(-1); });
    child.on("close", end);
  });
}

/** Stops every command that is still running (Ctrl+C). */
export function stopCommands() {
  for (const c of running) c.kill("SIGKILL");
}

const TOOLS: Record<string, (input: Input) => string | Promise<string>> = {
  list_files: listFiles,
  read_file: readFile,
  search,
  write_file: writeFile,
  edit_file: editFile,
  run_command: runCommand,
};

export async function runTool(name: string, input: unknown): Promise<{ ok: boolean; output: string }> {
  const fn = TOOLS[name];
  if (!fn) return { ok: false, output: `Unknown tool: ${name}` };
  try {
    return { ok: true, output: String(await fn((input ?? {}) as Input)) };
  } catch (err) {
    return { ok: false, output: (err as Error).message || String(err) };
  }
}
