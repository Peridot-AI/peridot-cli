// Installed plugins live in ~/.config/peridot/plugins/<name>, shared with the desktop app.
// Installing downloads the exact commit that was approved on peridot.ai from the plugin's GitHub repository.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const PLUGINS_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "peridot", "plugins");
const INDEX = join(PLUGINS_DIR, "installed.json");

// Same rule as the server: what people type in /plugin install <name>
export const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export type InstalledPlugin = { name: string; version: string; repo: string; sha?: string; installedAt: string };

export async function installedPlugins(): Promise<Record<string, InstalledPlugin>> {
  try {
    return JSON.parse(await readFile(INDEX, "utf8"));
  } catch {
    return {};
  }
}

async function saveIndex(index: Record<string, InstalledPlugin>) {
  await mkdir(PLUGINS_DIR, { recursive: true });
  await writeFile(INDEX, JSON.stringify(index, null, 2));
}

/** https://github.com/owner/repo → owner/repo, or null for anything else. */
function githubSlug(url: string): string | null {
  const m = /^https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

function untar(file: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("tar", ["-xzf", file, "-C", dest, "--strip-components=1"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => reject(new Error("Could not run tar to unpack the plugin.")));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `tar exited with ${code}`))));
  });
}

export async function installPlugin(name: string, repoUrl: string, sha: string): Promise<InstalledPlugin> {
  if (!PLUGIN_NAME.test(name)) throw new Error(`Invalid plugin name: ${name}`);
  const slug = githubSlug(repoUrl);
  if (!slug) throw new Error(`This plugin has no GitHub repository to install from (${repoUrl || "none"}).`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("This plugin has no approved version to install yet.");

  const res = await fetch(`https://codeload.github.com/${slug}/tar.gz/${sha}`);
  if (!res.ok) throw new Error(`Could not download ${slug} from GitHub (${res.status}).`);

  await mkdir(PLUGINS_DIR, { recursive: true });
  const archive = join(tmpdir(), `peridot-plugin-${name}-${Date.now()}.tar.gz`);
  const staging = join(PLUGINS_DIR, `.${name}-${Date.now()}`);
  const dest = join(PLUGINS_DIR, name);
  try {
    await writeFile(archive, new Uint8Array(await res.arrayBuffer()));
    await mkdir(staging);
    await untar(archive, staging);
    if (!existsSync(join(staging, "src", "index.ts")) && !existsSync(join(staging, "package.json"))) {
      throw new Error(`${slug} does not look like a Peridot plugin (no package.json or src/index.ts).`);
    }
    let version = "0.0.0";
    try {
      version = JSON.parse(await readFile(join(staging, "package.json"), "utf8")).version || version;
    } catch {}
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);

    const entry: InstalledPlugin = { name, version, repo: `https://github.com/${slug}`, sha, installedAt: new Date().toISOString() };
    const index = await installedPlugins();
    index[name] = entry;
    await saveIndex(index);
    return entry;
  } finally {
    await rm(archive, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

export async function uninstallPlugin(name: string): Promise<boolean> {
  if (!PLUGIN_NAME.test(name)) throw new Error(`Invalid plugin name: ${name}`);
  const index = await installedPlugins();
  const had = !!index[name] || existsSync(join(PLUGINS_DIR, name));
  await rm(join(PLUGINS_DIR, name), { recursive: true, force: true });
  delete index[name];
  await saveIndex(index);
  return had;
}
