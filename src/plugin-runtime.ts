// Loads installed plugins (see plugins.ts) and runs their commands and agent tools.
// Plugins are TypeScript modules whose default export is definePlugin({ ... }); Bun runs them directly.
// They run with the CLI's own permissions: only plugins approved on peridot.ai can be installed.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { installedPlugins, PLUGINS_DIR } from "./plugins";

export type Approval = null | "edit" | "command";

export interface PluginContext {
  client: "cli" | "desktop";
  platform: string;
  user: { name?: string; email: string } | null;
  workspace: {
    root: string | null;
    readFile(path: string): string;
    writeFile(path: string, content: string): void;
    listFiles(path?: string, recursive?: boolean): string[];
    search(pattern: string, path?: string): string[];
  };
  print(text: string): void;
  log(text: string): void;
}

export interface PluginCommand {
  desc: string;
  usage?: string;
  run(args: string[], ctx: PluginContext): unknown;
}

export interface PluginTool {
  description: string;
  input?: Record<string, unknown>;
  approval?: Approval;
  run(input: any, ctx: PluginContext): unknown;
}

export interface LoadedPlugin {
  name: string;
  version: string;
  description: string;
  commands: Record<string, PluginCommand>;
  tools: Record<string, PluginTool>;
}

/** Tool name the model sees: <plugin>__<tool>, with dashes as underscores. */
export const toolId = (plugin: string, tool: string) => `${plugin.replace(/-/g, "_")}__${tool}`;

const COMMAND_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;

// `import { definePlugin } from "@peridot/plugin"` resolves to this small module, written next to each plugin
const SHIM_JS = `export const definePlugin = (plugin) => plugin;\nexport default { definePlugin };\n`;
const SHIM_DTS = `export type Approval = null | "edit" | "command";
export interface PluginContext {
  client: "cli" | "desktop";
  platform: string;
  user: { name?: string; email: string } | null;
  workspace: {
    root: string | null;
    readFile(path: string): string;
    writeFile(path: string, content: string): void;
    listFiles(path?: string, recursive?: boolean): string[];
    search(pattern: string, path?: string): string[];
  };
  print(text: string): void;
  log(text: string): void;
}
export interface PluginCommand { desc: string; usage?: string; run(args: string[], ctx: PluginContext): unknown }
export interface PluginTool { description: string; input?: Record<string, unknown>; approval?: Approval; run(input: any, ctx: PluginContext): unknown }
export interface Plugin {
  name: string;
  version?: string;
  description?: string;
  commands?: Record<string, PluginCommand>;
  tools?: Record<string, PluginTool>;
  activate?(ctx: PluginContext): unknown;
}
export declare function definePlugin<T extends Plugin>(plugin: T): T;
`;

async function ensureShim(dir: string) {
  const shim = join(dir, "node_modules", "@peridot", "plugin");
  if (existsSync(join(shim, "index.js"))) return;
  await mkdir(shim, { recursive: true });
  await writeFile(join(shim, "package.json"), JSON.stringify({ name: "@peridot/plugin", type: "module", main: "index.js", types: "index.d.ts" }));
  await writeFile(join(shim, "index.js"), SHIM_JS);
  await writeFile(join(shim, "index.d.ts"), SHIM_DTS);
}

async function entryOf(dir: string): Promise<string> {
  let main: string | undefined;
  try {
    main = JSON.parse(await readFile(join(dir, "package.json"), "utf8")).main;
  } catch {}
  for (const rel of [main, "src/index.ts", "index.ts", "index.js"]) {
    if (!rel) continue;
    const abs = resolve(dir, rel);
    if (!abs.startsWith(dir + sep)) continue; // main must stay inside the plugin folder
    if (existsSync(abs)) return abs;
  }
  throw new Error("no entry file (package.json main or src/index.ts)");
}

/** Checks the shape of a plugin's default export and keeps only valid commands and tools. */
export function normalizePlugin(name: string, mod: any, warn: (m: string) => void): LoadedPlugin {
  const def = mod?.default ?? mod;
  if (!def || typeof def !== "object") throw new Error("the default export is not a plugin");
  const commands: Record<string, PluginCommand> = {};
  for (const [k, c] of Object.entries<any>(def.commands ?? {})) {
    if (COMMAND_NAME.test(k) && typeof c?.run === "function") commands[k] = { desc: String(c.desc ?? ""), usage: c.usage, run: c.run };
    else warn(`${name}: skipped command "${k}"`);
  }
  const tools: Record<string, PluginTool> = {};
  for (const [k, t] of Object.entries<any>(def.tools ?? {})) {
    if (TOOL_NAME.test(k) && typeof t?.run === "function" && typeof t.description === "string") {
      const approval = t.approval === "edit" || t.approval === "command" ? t.approval : null;
      tools[k] = { description: t.description, input: t.input, approval, run: t.run };
    } else warn(`${name}: skipped tool "${k}"`);
  }
  return { name, version: String(def.version ?? "0.0.0"), description: String(def.description ?? ""), commands, tools, ...(def.activate ? { activate: def.activate } : {}) } as LoadedPlugin;
}

/** Imports every installed plugin. One broken plugin never stops the others. */
export async function loadPlugins(ctxFor: (plugin: string) => PluginContext): Promise<{ plugins: LoadedPlugin[]; errors: string[] }> {
  const plugins: LoadedPlugin[] = [];
  const errors: string[] = [];
  for (const name of Object.keys(await installedPlugins())) {
    const dir = join(PLUGINS_DIR, name);
    try {
      await ensureShim(dir);
      // The query makes a reinstalled plugin load fresh instead of from the module cache
      const mod = await import(`${pathToFileURL(await entryOf(dir)).href}?v=${Date.now()}`);
      const p = normalizePlugin(name, mod, (m) => errors.push(m));
      await (p as any).activate?.(ctxFor(name));
      plugins.push(p);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message || e}`);
    }
  }
  return { plugins, errors };
}

/** Runs a plugin tool for the agent; whatever it returns becomes the tool result text. */
export async function runPluginTool(tool: PluginTool, input: unknown, ctx: PluginContext): Promise<{ ok: boolean; output: string }> {
  try {
    const r: any = await tool.run(input ?? {}, ctx);
    if (r && typeof r === "object" && "output" in r) return { ok: r.ok !== false, output: String(r.output) };
    return { ok: true, output: r === undefined ? "(done)" : typeof r === "string" ? r : JSON.stringify(r) };
  } catch (e) {
    return { ok: false, output: (e as Error).message || String(e) };
  }
}
