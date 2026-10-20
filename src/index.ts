#!/usr/bin/env bun
import { createInterface, type Interface } from "node:readline";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { startThinking } from "./thinking";
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

// ── Output helpers ──
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const mint = sgr("38;2;111;211;183");
const dim = sgr("2");
const bold = sgr("1");
const red = sgr("38;2;248;113;113");
const amber = sgr("38;2;245;158;107");

type Msg = { role: "user" | "model"; content: string };
type Config = { token?: string; model?: string };
type Model = { id: string; name: string; badge?: string; desc: string; locked?: boolean };

let config: Config = {};
let history: Msg[] = [];
let rl: Interface;
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

// ── Prompting ──
function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    if (hidden) (rl as any)._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => {
      if (hidden) { (rl as any)._writeToOutput = (s: string) => process.stdout.write(s); process.stdout.write("\n"); }
      resolve(answer.trim());
    });
  });
}

/**
 * Arrow-key menu shown as its own window: a box on the terminal's alternate screen. It disappears
 * when closed and the conversation underneath is back exactly as it was.
 * ↑/↓ to move, Enter to choose, Esc or Ctrl+C to cancel (resolves to null).
 */
function select(title: string, items: { label: string; hint?: string }[], initial = 0): Promise<number | null> {
  return new Promise((resolve) => {
    let index = Math.min(Math.max(initial, 0), items.length - 1);
    const write = (s: string) => process.stdout.write(s);
    const cut = (t: string, n: number) => (t.length > n ? t.slice(0, Math.max(0, n - 1)) + "…" : t);

    const draw = () => {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      const width = Math.max(24, Math.min(76, cols - 4));
      const inner = width - 2;
      const room = inner - 4; // one space and the marker on the left, one space on the right

      const row = (plain: string, styled: string) => dim("│") + " " + styled + " ".repeat(Math.max(0, inner - 2 - plain.length)) + " " + dim("│");
      const head = cut(title, inner - 4);
      const body = items.map((it, i) => {
        const label = cut(it.label, room - 2);
        const left = room - 2 - label.length - 1;
        const hint = it.hint && left > 4 ? cut(it.hint, left) : "";
        const plain = `  ${label}${hint ? " " + hint : ""}`;
        const styled = i === index ? `${mint("❯")} ${mint(label)}${hint ? " " + dim(hint) : ""}` : plain.replace(hint, hint ? dim(hint) : "");
        return row(plain, styled);
      });
      const foot = cut("↑/↓ move · Enter select · Esc cancel", inner - 2);
      const box = [
        dim("╭─ ") + bold(head) + " " + dim("─".repeat(Math.max(0, inner - head.length - 3)) + "╮"),
        row("", ""),
        ...body,
        row("", ""),
        row(foot, dim(foot)),
        dim("╰" + "─".repeat(inner) + "╯"),
      ];

      const top = Math.max(1, Math.floor((rows - box.length) / 2) + 1);
      const left = Math.max(1, Math.floor((cols - width) / 2) + 1);
      write("\x1b[2J" + box.map((line, i) => `\x1b[${top + i};${left}H${line}`).join(""));
    };

    // Take the keys away from readline while the menu is open, so it can't echo or move the cursor
    const saved = process.stdin.listeners("keypress") as ((...a: any[]) => void)[];
    saved.forEach((l) => process.stdin.off("keypress", l));
    write("\x1b[?1049h\x1b[?25l"); // alternate screen, hide the cursor
    draw();

    const finish = (value: number | null) => {
      process.stdin.off("keypress", onKey);
      process.stdout.off("resize", draw);
      cancelLogin = null;
      saved.forEach((l) => process.stdin.on("keypress", l));
      (rl as any).line = "";
      (rl as any).cursor = 0;
      write("\x1b[?25h\x1b[?1049l"); // back to the conversation
      resolve(value);
    };

    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (!key) return;
      if (key.name === "up") { index = (index - 1 + items.length) % items.length; draw(); }
      else if (key.name === "down") { index = (index + 1) % items.length; draw(); }
      else if (key.name === "return") finish(index);
      else if (key.name === "escape" || (key.ctrl && key.name === "c")) finish(null);
    };
    cancelLogin = () => finish(null);
    process.stdin.on("keypress", onKey);
    process.stdout.on("resize", draw);
  });
}

// ── Chat ──
/** Streams one answer to stdout. Returns the text received (also when interrupted). */
async function streamAnswer(thinking: { stop(): void }): Promise<string> {
  abort = new AbortController();
  let answer = "";
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
            if (!answer) { thinking.stop(); process.stdout.write(`${mint(LOGO)} `); }
            answer += chunk;
            process.stdout.write(chunk);
          }
        }
      }
    }
    process.stdout.write("\n");
  } catch (e) {
    thinking.stop();
    if ((e as Error).name === "AbortError") {
      process.stdout.write(dim("\n[interrupted]\n"));
    } else {
      if (answer) process.stdout.write("\n");
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
  process.stdout.write("\n");
  const thinking = startThinking();
  try {
    const answer = await streamAnswer(thinking);
    if (answer) history.push({ role: "model", content: answer });
    else history.pop();
  } catch (e) {
    history.pop();
    console.log(red(`Error: ${(e as Error).message}`));
  } finally {
    thinking.stop();
  }
  console.log();
}

// ── Slash commands ──
const bar = (pct: number, width = 24) => {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return (pct >= 80 ? amber : mint)("█".repeat(filled)) + dim("░".repeat(width - filled));
};
const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n || 0);
const requests = (n: number) => `${fmt(n)} ${n === 1 ? "request" : "requests"}`;

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
  if (!choice) return console.log(red(`No model matches "${arg || ""}". Use /model to see the list.`));
  if (choice.locked) return console.log(amber(`${choice.name} is not included in your plan. See https://peridot.ai/#plans`));
  config.model = choice.id;
  await saveConfig();
  console.log(`Model set to ${bold(choice.name)}.`);
}

async function cmdUsage() {
  if (!authToken()) return console.log("Sign in with /login to see your usage.");
  const { user, stats, limits } = await api<{ user: any; stats: any; limits?: any }>("/auth/me");
  console.log(`${bold("Usage")}  ${dim(`${user.email} · ${limits?.plan ?? user.plan ?? "free"} plan`)}\n`);

  if (limits?.unlimited) {
    console.log(dim("Your account has no usage limits.\n"));
  } else if (limits) {
    const reset = limits.monthlyResetsAt
      ? new Date(limits.monthlyResetsAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })
      : "";
    console.log(`Monthly allowance  ${bar(limits.monthlyPercent)} ${limits.monthlyPercent}% used ${dim(reset ? `· resets ${reset}` : "")}`);
    const dailyPct = limits.dailyLimit ? (limits.dailyUsed / limits.dailyLimit) * 100 : 0;
    console.log(`Messages today     ${bar(dailyPct)} ${limits.dailyUsed} / ${limits.dailyLimit} ${dim("· resets at midnight UTC")}\n`);
  }

  console.log(`Total        ${fmt(stats.totalTokens)} tokens ${dim(`· ${requests(stats.requestCount)}`)}`);
  console.log(`  Input      ${fmt(stats.inputTokens)}`);
  console.log(`  Output     ${fmt(stats.outputTokens)}`);
  console.log(`Today        ${fmt(stats.today?.totalTokens)} tokens ${dim(`· ${requests(stats.today?.requestCount)}`)}`);
  console.log(`Last 7 days  ${fmt(stats.week?.totalTokens)} tokens ${dim(`· ${requests(stats.week?.requestCount)}`)}`);

  if (stats.byModel?.length) {
    console.log(`\n${bold("By model")}`);
    for (const m of stats.byModel) {
      const pct = stats.totalTokens ? Math.round((m.totalTokens / stats.totalTokens) * 100) : 0;
      console.log(`  ${m.modelName.padEnd(24)} ${bar(pct, 16)} ${String(pct).padStart(3)}%  ${dim(fmt(m.totalTokens) + " tokens")}`);
    }
  }
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
  console.log(dim(`Opening your browser. If nothing happens, open this link:\n${link}\n`));
  console.log(dim("Waiting for sign-in… (Ctrl+C to cancel)"));
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
  console.log(dim(`Opening your browser. If nothing happens, open this link:\n${link}\n`));
  console.log(dim("Waiting for sign-in… (Ctrl+C to cancel)"));
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
    console.log(`Signed in as ${bold(me.user.email)}.`);
  } catch (e) {
    config.token = previous;
    throw e;
  }
}

async function cmdLogout() {
  delete config.token;
  await saveConfig();
  console.log("Signed out.");
}

async function cmdWhoami() {
  if (!authToken()) return console.log("Not signed in (anonymous). Use /login.");
  const { user, limits } = await api<{ user: any; limits?: any }>("/auth/me");
  console.log(`${bold(user.name || user.email)} ${dim(`${user.email} · ${limits?.plan ?? user.plan ?? "free"} plan`)}`);
}

type Command = { desc: string; usage?: string; run: (arg: string) => Promise<void> | void };
const COMMANDS: Record<string, Command> = {
  help: { desc: "Show this list", run: () => printHelp() },
  model: { desc: "Show or change the model", usage: "[name|number]", run: cmdModel },
  usage: { desc: "Show your token usage and limits", run: cmdUsage },
  login: { desc: "Sign in to your Peridot account", run: cmdLogin },
  logout: { desc: "Sign out", run: cmdLogout },
  whoami: { desc: "Show the signed-in account", run: cmdWhoami },
  clear: { desc: "Start a new conversation", run: () => { history = []; console.log(dim("Conversation cleared.")); } },
  exit: { desc: "Quit Peridot", run: () => quit() },
};
const ALIASES: Record<string, string> = { quit: "exit", q: "exit", new: "clear", "?": "help" };

function printHelp() {
  console.log(bold("Commands"));
  for (const [name, c] of Object.entries(COMMANDS)) {
    console.log(`  ${mint(("/" + name + (c.usage ? " " + c.usage : "")).padEnd(24))}${c.desc}`);
  }
  console.log(dim("\nCtrl+C stops a response · Tab completes commands · anything else is sent as a message."));
}

function quit() {
  console.log(dim("Bye."));
  process.exit(0);
}

async function banner() {
  console.log(`\n${mint(LOGO)} ${bold("Peridot")} ${dim("v" + VERSION)}`);
  let who = dim("not signed in · /login");
  if (authToken()) {
    who = await api<{ user: any }>("/auth/me").then((r) => dim(r.user.email), () => amber("session expired · /login"));
  }
  const model = (await loadModels().catch(() => [])).find((m) => m.id === (config.model || ""))?.name ?? config.model ?? "default model";
  console.log(`${who}\n${dim("model: " + model + " · /help for commands")}\n`);
}

// ── Main ──
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Peridot is an interactive app. Run `peridot` in a terminal.");
    process.exit(1);
  }
  config = JSON.parse(await readFile(CONFIG_FILE, "utf8").catch(() => "{}"));

  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string): [string[], string] => {
      if (!line.startsWith("/") || line.includes(" ")) return [[], line];
      const all = Object.keys(COMMANDS).map((c) => "/" + c);
      const hits = all.filter((c) => c.startsWith(line));
      return [hits.length ? hits : all, line];
    },
  });

  let lastInterrupt = 0;
  rl.on("SIGINT", () => {
    if (abort) return abort.abort();
    if (cancelLogin) return cancelLogin();
    if (rl.line) { (rl as any).line = ""; (rl as any).cursor = 0; process.stdout.write("\n"); return rl.prompt(); }
    if (Date.now() - lastInterrupt < 2000) return quit();
    lastInterrupt = Date.now();
    console.log(dim("\n(press Ctrl+C again or type /exit to quit)"));
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));

  await banner();
  rl.setPrompt(`${mint("›")} `);

  for (;;) {
    const line = await ask(`${mint("›")} `);
    if (!line) continue;

    if (line.startsWith("/")) {
      const [raw, ...rest] = line.slice(1).split(/\s+/);
      const name = ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
      const cmd = COMMANDS[name];
      if (!cmd) { console.log(red(`Unknown command /${raw}.`) + dim(" Type /help for the list.")); continue; }
      try { await cmd.run(rest.join(" ")); } catch (e) { console.log(red(`Error: ${(e as Error).message}`)); }
      console.log();
      continue;
    }
    await send(line);
  }
}

process.on("exit", () => process.stdout.write("\x1b[?25h"));

main().catch((e) => {
  console.error(red(`Error: ${(e as Error).message}`));
  process.exit(1);
});
