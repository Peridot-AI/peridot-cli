#!/usr/bin/env bun
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { startThinking } from "./thinking";
import { mint, dim, bold, red, amber } from "./style";
import * as ui from "./ui";
import { select, showCard } from "./card";
import { usageLines, type HeatView } from "./usage";
const { out, print } = ui;
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "0.3.0";
const API = (process.env.PERIDOT_API_URL || "https://peridot.ai/api").replace(/\/+$/, "");
const WEB = (process.env.PERIDOT_WEB_URL || "https://peridot.ai").replace(/\/+$/, "");
// Registered as a redirect URI of the Google OAuth client (same one the desktop app uses)
const GOOGLE_PORT = 53682;
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "peridot");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

type Msg = { role: "user" | "model"; content: string };
type Config = { token?: string; model?: string };
type Model = { id: string; name: string; badge?: string; desc: string; locked?: boolean };

let config: Config = {};
let history: Msg[] = [];
let abort: AbortController | null = null;
let cancelLogin: (() => void) | null = null;
/** Four dots, like the Peridot logo */
const LOGO = "∷";

async function saveConfig() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config), { mode: 0o600 });
}

const authToken = () => process.env.PERIDOT_TOKEN || config.token;
const headers = () => ({ "Content-Type": "application/json", ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}) });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  const data = ((await res.json().catch(() => null)) ?? {}) as any;
  if (res.status === 401 && authToken()) throw new Error("Your session has expired. Use /login to sign in again.");
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}) at ${API}${path}`);
  return data;
}

// ── Chat ──
/** Streams one answer to stdout. Returns the text received (also when interrupted). */
async function streamAnswer(thinking: { stop(): void }): Promise<string> {
  abort = new AbortController();
  let answer = "";
  // Redrawing the input area is not free, so text is shown in small batches
  let pending = "";
  let lastFlush = 0;
  const flush = (force = false) => {
    if (pending && (force || Date.now() - lastFlush > 40)) { out(pending); pending = ""; lastFlush = Date.now(); }
  };
  try {
    const res = await fetch(`${API}/chat/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ messages: history, model: config.model || "fast" }),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      const err = ((await res.json().catch(() => null)) ?? {}) as any;
      if (res.status === 401 && authToken()) throw new Error("Your session has expired. Use /login to sign in again.");
      throw new Error(err.error || `Request failed (${res.status})`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(part, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (event === "error") throw new Error(JSON.parse(data || "{}").error || "Streaming error");
        if (event === "message" && data) {
          const chunk = JSON.parse(data).chunk as string | undefined;
          if (chunk) {
            if (!answer) { thinking.stop(); pending = `${mint(LOGO)} `; }
            answer += chunk;
            pending += chunk;
            flush();
          }
        }
      }
    }
    flush(true);
    out("\n");
  } catch (e) {
    thinking.stop();
    flush(true);
    if ((e as Error).name === "AbortError") {
      out(dim("\n[interrupted]\n"));
    } else {
      if (answer) out("\n");
      throw e;
    }
  } finally {
    thinking.stop();
    abort = null;
  }
  return answer;
}

async function send(text: string) {
  history.push({ role: "user", content: text });
  out(`\n${ui.userBubble(text)}\n\n`);
  const thinking = startThinking(ui.setLine, () => ui.setLine(""));
  try {
    const answer = await streamAnswer(thinking);
    if (answer) history.push({ role: "model", content: answer });
    else history.pop();
  } catch (e) {
    history.pop();
    print(red(`Error: ${(e as Error).message}`));
  } finally {
    thinking.stop();
  }
}

// ── Slash commands ──
async function loadModels(): Promise<Model[]> {
  return (await api<{ models: Model[] }>("/models")).models;
}

async function cmdModel(arg: string) {
  const models = await loadModels();
  const current = config.model || "fast";
  const find = (q: string) => {
    const n = Number(q);
    if (Number.isInteger(n) && n >= 1 && n <= models.length) return models[n - 1];
    const lower = q.toLowerCase();
    return models.find((m) => m.id.toLowerCase() === lower) ?? models.find((m) => m.name.toLowerCase().includes(lower));
  };

  let choice = arg ? find(arg) : undefined;
  if (!arg) {
    const picked = await select(
      "Choose a model",
      models.map((m) => ({
        label: `${m.id === current ? "● " : ""}${m.name}${m.badge ? ` [${m.badge}]` : ""}`,
        hint: `— ${m.desc}${m.locked ? " (upgrade to use)" : ""}`,
      })),
      Math.max(0, models.findIndex((m) => m.id === current))
    );
    if (picked === null) return;
    choice = models[picked];
  }
  if (!choice) return print(red(`No model matches "${arg || ""}". Use /model to see the list.`));
  if (choice.locked) return print(amber(`${choice.name} is not included in your plan. See https://peridot.ai/#plans`));
  config.model = choice.id;
  await saveConfig();
  print(`Model set to ${bold(choice.name)}.`);
}

async function cmdUsage() {
  if (!authToken()) return print("Sign in with /login to see your usage.");
  const data = await api<{ user: any; stats: any; limits?: any }>("/auth/me");
  let view: HeatView = "large";
  await showCard("Usage", (text) => usageLines(data, text, view), (key) => {
    if (key.name !== "tab") return false;
    view = view === "large" ? "year" : "large";
    return true;
  });
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
    : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
}

const page = (title: string, extra = "") =>
  `<!doctype html><meta charset="utf-8"><title>Peridot</title><body style="font-family:sans-serif;background:#141413;color:#e8e6e0;text-align:center;padding-top:20vh"><h2 id="m">${title}</h2>${extra}`;

/**
 * Listens on 127.0.0.1 until `handle` returns the final value (or throws). Used to receive the
 * result of a sign-in that happens in the browser. Times out after 5 minutes, Ctrl+C cancels.
 */
function loopback(port: number, handle: (url: URL, res: http.ServerResponse) => string | undefined) {
  let settle!: { ok: (v: string) => void; fail: (e: Error) => void };
  const result = new Promise<string>((ok, fail) => (settle = { ok, fail }));
  const server = http.createServer((req, res) => {
    try {
      const value = handle(new URL(req.url || "/", "http://127.0.0.1"), res);
      if (value !== undefined) settle.ok(value);
    } catch (e) {
      settle.fail(e as Error);
    }
  });
  const timer = setTimeout(() => settle.fail(new Error("Sign-in timed out.")), 5 * 60 * 1000);
  cancelLogin = () => settle.fail(new Error("Sign-in cancelled."));
  server.on("error", (e) => settle.fail(e));
  const ready = new Promise<number>((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve((server.address() as any).port))
  );
  const done = result.finally(() => { clearTimeout(timer); cancelLogin = null; server.close(); server.closeAllConnections?.(); });
  done.catch(() => {});
  return { ready, result: done };
}

/** Email (or Google) sign-in on the Peridot website; the site hands the token back to us. */
async function loginViaWebsite(): Promise<string> {
  const state = randomBytes(16).toString("hex");
  const server = loopback(0, (url, res) => {
    if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.searchParams.get("state") !== state) { res.end(page("Invalid sign-in request.")); throw new Error("Sign-in failed (state mismatch)."); }
    const token = url.searchParams.get("token");
    if (!token) { res.end(page("Sign-in cancelled.")); throw new Error("Sign-in was cancelled."); }
    res.end(page("Signed in. You can close this tab and return to Peridot."));
    return token;
  });
  const port = await server.ready;
  const link = `${WEB}/cli-login?${new URLSearchParams({ port: String(port), state })}`;
  print(dim(`Opening your browser. If nothing happens, open this link:\n${link}\n`));
  print(dim("Waiting for sign-in… (Ctrl+C to cancel)"));
  openBrowser(link);
  return server.result;
}

/** Google OAuth in the browser (implicit flow, loopback redirect), then exchange for a Peridot token. */
async function loginWithGoogle(): Promise<string> {
  const { googleClientId } = await api<{ googleClientId: string }>("/auth/config");
  if (!googleClientId) throw new Error("Google sign-in is not configured on this server.");
  const state = randomBytes(16).toString("hex");
  const redirect = `http://127.0.0.1:${GOOGLE_PORT}/callback`;
  const server = loopback(GOOGLE_PORT, (url, res) => {
    if (url.pathname === "/callback") {
      // The token comes back in the URL fragment, which the browser never sends: forward it to /token
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page("Signing you in…", `<script>fetch("/token?"+location.hash.slice(1)).then(function(){document.getElementById("m").textContent="Signed in. You can close this tab and return to Peridot."})</script>`));
      return;
    }
    if (url.pathname === "/token") {
      res.writeHead(204).end();
      if (url.searchParams.get("state") !== state) throw new Error("Google sign-in failed (state mismatch).");
      const t = url.searchParams.get("access_token");
      if (!t) throw new Error(url.searchParams.get("error") || "Google sign-in failed.");
      return t;
    }
    res.writeHead(404).end();
  });
  await server.ready.catch(() => {});
  const q = new URLSearchParams({ client_id: googleClientId, redirect_uri: redirect, response_type: "token", scope: "openid email profile", state, prompt: "select_account" });
  const link = `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  print(dim(`Opening your browser. If nothing happens, open this link:\n${link}\n`));
  print(dim("Waiting for sign-in… (Ctrl+C to cancel)"));
  openBrowser(link);
  const accessToken = await server.result;
  return (await api<{ token: string }>("/auth/google", { method: "POST", body: JSON.stringify({ accessToken }) })).token;
}

async function cmdLogin() {
  const method = await select("Sign in with", [
    { label: "Email", hint: "— on the Peridot website" },
    { label: "Google" },
  ]);
  if (method === null) return;

  let token: string;
  if (method === 0) token = await loginViaWebsite();
  else token = await loginWithGoogle();

  const previous = config.token;
  config.token = token;
  try {
    const me = await api<{ user: { email: string } }>("/auth/me");
    await saveConfig();
    print(`Signed in as ${bold(me.user.email)}.`);
  } catch (e) {
    config.token = previous;
    throw e;
  }
}

async function cmdLogout() {
  delete config.token;
  await saveConfig();
  print("Signed out.");
}

async function cmdWhoami() {
  if (!authToken()) return print("Not signed in (anonymous). Use /login.");
  const { user, limits } = await api<{ user: any; limits?: any }>("/auth/me");
  print(`${bold(user.name || user.email)} ${dim(`${user.email} · ${limits?.plan ?? user.plan ?? "free"} plan`)}`);
}

type Command = { desc: string; usage?: string; run: (arg: string) => Promise<void> | void };
const COMMANDS: Record<string, Command> = {
  help: { desc: "Show this list", run: () => printHelp() },
  model: { desc: "Show or change the model", usage: "[name|number]", run: cmdModel },
  usage: { desc: "Show your token usage and limits", run: cmdUsage },
  login: { desc: "Sign in to your Peridot account", run: cmdLogin },
  logout: { desc: "Sign out", run: cmdLogout },
  whoami: { desc: "Show the signed-in account", run: cmdWhoami },
  clear: { desc: "Start a new conversation", run: () => { history = []; print(dim("Conversation cleared.")); } },
  exit: { desc: "Quit Peridot", run: () => quit() },
};
const ALIASES: Record<string, string> = { quit: "exit", q: "exit", new: "clear", "?": "help" };

function printHelp() {
  print(bold("Commands"));
  for (const [name, c] of Object.entries(COMMANDS)) {
    print(`  ${mint(("/" + name + (c.usage ? " " + c.usage : "")).padEnd(24))}${c.desc}`);
  }
  print(dim("\nTab completes commands · Ctrl+C stops a response."));
}

function quit() {
  ui.end(dim("Bye."));
  process.exit(0);
}

/** Account and model shown on the status line under the input. */
async function refreshStatus() {
  let who = "not signed in · /login";
  if (authToken()) {
    who = await api<{ user: any }>("/auth/me").then((r) => r.user.email as string, () => "session expired · /login");
  }
  const model = (await loadModels().catch(() => [])).find((m) => m.id === (config.model || ""))?.name ?? config.model ?? "default model";
  ui.setStatus(who, `${model} · /help`);
}

// ── Main ──
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Peridot is an interactive app. Run `peridot` in a terminal.");
    process.exit(1);
  }
  config = JSON.parse(await readFile(CONFIG_FILE, "utf8").catch(() => "{}"));

  let lastInterrupt = 0;
  ui.begin(`\n${mint(LOGO)} ${bold("Peridot")} ${dim("v" + VERSION)}\n${dim("Type a message, or / for commands.")}\n`, {
    complete: (text) => Object.keys(COMMANDS).map((c) => "/" + c).filter((c) => c.startsWith(text)),
    onInterrupt: (hasInput) => {
      if (abort) return abort.abort();
      if (cancelLogin) return cancelLogin();
      if (hasInput) return ui.clearInput();
      if (Date.now() - lastInterrupt < 2000) return quit();
      lastInterrupt = Date.now();
      print(dim("(press Ctrl+C again or type /exit to quit)"));
    },
    onSubmit: async (line) => {
      ui.setBusy(true);
      try {
        if (line.startsWith("/")) {
          out(`\n${ui.userBubble(line)}\n\n`);
          const [raw, ...rest] = line.slice(1).split(/\s+/);
          const name = ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
          const cmd = COMMANDS[name];
          if (!cmd) print(red(`Unknown command /${raw}.`) + dim(" Type /help for the list."));
          else {
            try { await cmd.run(rest.join(" ")); } catch (e) { print(red(`Error: ${(e as Error).message}`)); }
            if (["login", "logout", "model"].includes(name)) refreshStatus();
          }
        } else {
          await send(line);
        }
      } finally {
        ui.setBusy(false);
      }
    },
  });
  refreshStatus();
}

process.on("exit", () => process.stdout.write("\x1b[?25h"));
process.on("SIGINT", () => quit());
process.on("SIGTERM", () => quit());

main().catch((e) => {
  ui.end();
  console.error(red(`Error: ${(e as Error).message}`));
  process.exit(1);
});
