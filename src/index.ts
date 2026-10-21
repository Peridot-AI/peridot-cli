#!/usr/bin/env bun
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { startThinking } from "./thinking";
import { MarkdownStream } from "./markdown";
import { VERSION } from "./version";
import { mint, dim, bold, red, amber } from "./style";
import * as ui from "./ui";
import { select, showCard, cut } from "./card";
import { usageLines, type HeatView } from "./usage";
import { startScreen, startLines, catchTheFly, PERI_TOP, PERI_WIDTH } from "./mascot";
import { runAgent, type ApiMessage, type ToolCall, type ToolResult, type AgentHooks } from "./agent";
import { root, runCommand, stopCommands } from "./tools";
const { out, print } = ui;
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const API = (process.env.PERIDOT_API_URL || "https://peridot.ai/api").replace(/\/+$/, "");
const WEB = (process.env.PERIDOT_WEB_URL || "https://peridot.ai").replace(/\/+$/, "");
// Registered as a redirect URI of the Google OAuth client (same one the desktop app uses)
const GOOGLE_PORT = 53682;
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "peridot");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

type Msg = { role: "user" | "model"; content: string };
type Mode = "auto" | "manual";
type Config = { token?: string; model?: string; mode?: Mode };
type Model = { id: string; name: string; badge?: string; desc: string; locked?: boolean };

let config: Config = {};
let history: Msg[] = [];
let agentMessages: ApiMessage[] = [];
let tipShown = false;
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
  const md = new MarkdownStream();
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
            pending += md.push(chunk);
            flush();
          }
        }
      }
    }
    pending += md.end();
    flush(true);
    out("\n");
  } catch (e) {
    thinking.stop();
    pending += md.end();
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

/** Provider errors sometimes arrive as raw JSON ({"error":{"message":…}}); keep just the message. */
function errorText(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  try {
    const data = JSON.parse(msg);
    return data?.error?.message ?? data?.message ?? msg;
  } catch {
    return msg;
  }
}

async function sendChat(text: string) {
  history.push({ role: "user", content: text });
  out(`\n${ui.userBubble(text)}\n\n`);
  const thinking = startThinking(ui.setLine, () => ui.setLine(""));
  try {
    const answer = await streamAnswer(thinking);
    if (answer) history.push({ role: "model", content: answer });
    else history.pop();
  } catch (e) {
    history.pop();
    print(red(`Error: ${errorText(e)}`));
  } finally {
    thinking.stop();
  }
}

// ── Agent: reads and edits files and runs commands in the folder Peridot was opened in ──
const TOOL_LABEL: Record<string, string> = {
  list_files: "List", read_file: "Read", search: "Search", write_file: "Write", edit_file: "Edit", run_command: "Run",
};

function toolArg(call: ToolCall) {
  const i = call.input;
  if (call.name === "search") return `${i.pattern}${i.path && i.path !== "." ? ` in ${i.path}` : ""}`;
  if (call.name === "run_command") return String(i.command ?? "");
  return String(i.path ?? ".");
}

/** What an action is about to do, shown in the approval window. */
function approvalDetails(call: ToolCall): string[] {
  const i = call.input;
  const lines = (t: unknown, n: number) => {
    const all = String(t ?? "").split("\n");
    return [...all.slice(0, n), ...(all.length > n ? [dim(`… ${all.length - n} more lines`)] : [])];
  };
  if (call.name === "run_command") return [bold("Run in this folder:"), ...lines(i.command, 8).map((l) => `$ ${l}`)];
  if (call.name === "edit_file") {
    return [
      bold(String(i.path)) + dim(i.replace_all ? " (all matches)" : ""),
      ...lines(i.old_string, 7).map((l) => red("- " + l)),
      ...lines(i.new_string, 7).map((l) => mint("+ " + l)),
    ];
  }
  return [bold(String(i.path)) + dim(` (${String(i.content ?? "").split("\n").length} lines)`), ...lines(i.content, 8).map((l) => dim(l))];
}

async function approve(call: ToolCall): Promise<boolean> {
  if (config.mode === "auto") return true;
  const title = call.name === "run_command" ? "Run this command?" : call.name === "edit_file" ? "Apply this edit?" : "Write this file?";
  const choice = await select(
    title,
    [{ label: "Yes" }, { label: "Yes, and don't ask again", hint: "(switches to auto approval)" }, { label: "No" }],
    0,
    approvalDetails(call)
  );
  if (choice === 1) {
    config.mode = "auto";
    paintStatus();
    await saveConfig();
  }
  return choice === 0 || choice === 1;
}

function showResult(call: ToolCall, r: ToolResult) {
  if (r.denied) return print(amber("  ⎿ Denied"));
  const out = r.output.trim();
  if (!r.ok) return print(red("  ⎿ " + cut(out.split("\n")[0], 160)));
  if (call.name === "run_command") {
    const lines = out.split("\n");
    const exit = /^\[exit code (-?\d+|null)\]$/.exec(lines[lines.length - 1] ?? "");
    const body = exit ? lines.slice(0, -1) : lines;
    const shown = body.slice(0, 8).map((l, i) => dim((i === 0 ? "  ⎿ " : "    ") + cut(l, 160)));
    if (body.length > 8) shown.push(dim(`    … ${body.length - 8} more lines`));
    if (exit && exit[1] !== "0") shown.push(red(`    exit code ${exit[1]}`));
    return print(shown.join("\n") || dim("  ⎿ (no output)"));
  }
  if (call.name === "write_file" || call.name === "edit_file") return print(dim("  ⎿ " + out));
  const n = out.split("\n").length;
  print(dim(`  ⎿ ${out === "No matches." || out === "(empty)" ? out : `${n} line${n === 1 ? "" : "s"}`}`));
}

// ── Chat history (signed in): every exchange is saved to the account, so /resume can continue it ──
let convId: number | null = null;

async function saveExchange(question: string, answer: string) {
  if (!authToken() || !question.trim() || !answer.trim()) return;
  try {
    if (convId === null) {
      const title = question.replace(/\s+/g, " ").trim().slice(0, 60);
      convId = (await api<{ conversation: { id: number } }>("/conversations", { method: "POST", body: JSON.stringify({ title }) })).conversation.id;
    }
    await api(`/conversations/${convId}/messages`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: question }, { role: "model", content: answer }] }),
    });
  } catch {
    // History is a convenience: a failed save never gets in the way of the chat
  }
}

/** "5 min ago" for a database time ("YYYY-MM-DD HH:MM:SS", UTC). */
function ago(when: string): string {
  const t = Date.parse(when.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) { const d = Math.floor(s / 86400); return `${d} day${d === 1 ? "" : "s"} ago`; }
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** /resume [count]: pick one of the latest chats (newest first) and carry on with it. */
async function cmdResume(arg: string) {
  if (!authToken()) return print("Chat history is kept for signed-in users. Use /login.");
  const count = Math.max(1, Math.min(100, Math.floor(Number(arg)) || 10));
  const { conversations } = await api<{ conversations: { id: number; title: string; updated_at: string }[] }>("/conversations");
  const latest = conversations.slice(0, count);
  if (!latest.length) return print(dim("No saved chats yet."));

  const pick = await select("Resume a chat", latest.map((c) => ({ label: c.title || "Untitled", hint: ago(c.updated_at) })));
  if (pick === null) return;
  const chosen = latest[pick];
  const { messages } = await api<{ messages: { role: "user" | "model"; content: string }[] }>(`/conversations/${chosen.id}`);

  convId = chosen.id;
  history = messages.map((m) => ({ role: m.role, content: m.content }));
  agentMessages = messages.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));

  // A clean screen, then the end of the chat so you know where you left off
  freshScreen();
  out("\n");
  const SHOWN = 10;
  if (messages.length > SHOWN) print(dim(`… ${messages.length - SHOWN} earlier messages`));
  for (const m of messages.slice(-SHOWN)) {
    if (m.role === "user") out(`${ui.userBubble(m.content)}\n\n`);
    else {
      const md = new MarkdownStream();
      out(`${mint(LOGO)} ${md.push(m.content)}${md.end()}\n\n`);
    }
  }
  print(dim(`Resumed "${chosen.title}" · ${messages.length} messages. Keep typing to continue.`));
}

async function sendAgent(text: string) {
  out(`\n${ui.userBubble(text)}\n\n`);
  // After an interrupted step the history ends with tool results: the new text joins that message
  const last = agentMessages[agentMessages.length - 1];
  const before = agentMessages.length;
  if (last && last.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text });
  else agentMessages.push({ role: "user", content: text });

  abort = new AbortController();
  let thinking: { stop(): void } = { stop() {} };
  let started = false;
  let reply = ""; // all answer text of this run, saved to the chat history at the end
  let md = new MarkdownStream();
  let pending = "";
  let lastFlush = 0;
  const flush = (force = false) => {
    if (pending && (force || Date.now() - lastFlush > 40)) { out(pending); pending = ""; lastFlush = Date.now(); }
  };

  const hooks: AgentHooks = {
    onModelStart: () => { thinking = startThinking(ui.setLine, () => ui.setLine("")); },
    onText: (chunk) => {
      if (!started) { thinking.stop(); started = true; pending = `${mint(LOGO)} `; md = new MarkdownStream(); }
      reply += chunk;
      pending += md.push(chunk);
      flush();
    },
    onTurnEnd: () => {
      thinking.stop();
      pending += md.end();
      flush(true);
      if (started) out("\n");
      started = false;
    },
    approve,
    onToolStart: (call) => print(`${mint("●")} ${bold(TOOL_LABEL[call.name] ?? call.name)}${dim("(" + cut(toolArg(call), 100) + ")")}`),
    onToolEnd: showResult,
  };

  try {
    await runAgent(agentMessages, {
      url: `${API}/chat/agent`,
      headers,
      model: config.model || "fast",
      effort: "Medium",
      workspace: root.split(/[\\/]/).pop() || root,
    }, hooks, abort.signal);
  } catch (e) {
    thinking.stop();
    pending += md.end();
    flush(true);
    if ((e as Error).name === "AbortError") print(dim("[interrupted]"));
    else {
      const msg = errorText(e);
      print(red(`Error: ${/401|Sign in/.test(msg) ? "Your session has expired or you are not signed in. Use /login." : msg}`));
    }
    // Nothing was done yet: forget the message so the next one starts clean
    if (agentMessages.length === before + 1 && agentMessages[before]?.role === "user" && agentMessages[before].content === text) agentMessages.pop();
  } finally {
    thinking.stop();
    abort = null;
    stopCommands();
  }
  await saveExchange(text, reply);
}

async function send(text: string) {
  if (authToken()) return sendAgent(text);
  if (!tipShown) {
    tipShown = true;
    print(dim("Tip: sign in with /login to let Peridot read and edit files and run commands in this folder.\n"));
  }
  return sendChat(text);
}

/** `!command`: runs a shell command in the folder, without asking. */
async function shell(command: string) {
  if (!command.trim()) return print(dim("Type a command after !, e.g. !ls"));
  abort = new AbortController();
  try {
    print((await runCommand({ command })).replace(/\n\[exit code (-?\d+|null)\]$/, (_m, c) => (c === "0" ? "" : red(`\n[exit code ${c}]`))));
  } finally {
    abort = null;
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
  convId = null;
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
  resume: { desc: "Continue one of your recent chats", usage: "[count]", run: cmdResume },
  clear: { desc: "Start a new conversation", run: () => { history = []; agentMessages = []; convId = null; freshScreen(); } },
  exit: { desc: "Quit Peridot", run: () => quit() },
};
const ALIASES: Record<string, string> = { quit: "exit", q: "exit", new: "clear", "?": "help" };

function printHelp() {
  print(bold("Commands"));
  for (const [name, c] of Object.entries(COMMANDS)) {
    print(`  ${mint(("/" + name + (c.usage ? " " + c.usage : "")).padEnd(24))}${c.desc}`);
  }
  print(`  ${mint("!command".padEnd(24))}Run a shell command in this folder`);
  print(dim("\nWhen you are signed in, Peridot can read and edit files here and run commands (it asks first in manual mode).\nTab completes commands · Ctrl+C stops a response."));
}

function quit() {
  ui.end(dim("Bye."));
  process.exit(0);
}

// ── Status line under the input: approval mode on the left, model on the right ──
let modelName = "";
let signedIn = false;

function paintStatus() {
  const auto = config.mode === "auto";
  const left = auto
    ? `${bold(amber("▶▶ auto approval on"))} ${dim("(shift+tab to cycle)")}`
    : `${bold(mint("▶ manual approval"))} ${dim("(shift+tab to cycle)")}`;
  ui.setStatus(left, `${signedIn ? "" : "not signed in · "}${modelName || "default model"} · /help`);
}

async function cycleMode() {
  config.mode = config.mode === "auto" ? "manual" : "auto";
  paintStatus();
  await saveConfig();
}

async function refreshStatus() {
  paintStatus();
  const me = authToken() ? await api<{ user: any; limits?: any }>("/auth/me").catch(() => null) : null;
  signedIn = !!me;
  const models = await loadModels().catch(() => []);
  modelName = models.find((m) => m.id === (config.model || ""))?.name ?? config.model ?? "";
  start.plan = planName(me);
  start.model = models.find((m) => m.id === (config.model || "fast"))?.name ?? (config.model || start.model);
  paintStatus();
}

// ── Peri, the mascot: clicking it on the start screen plays a little animation ──
let periTimer: ReturnType<typeof setTimeout> | null = null;
let periPlaying = false;

function playPeri() {
  if (periPlaying) return;
  periPlaying = true;
  const frames = catchTheFly();
  let i = 0;
  const next = () => {
    const f = frames[i++];
    if (!f) { periPlaying = false; periTimer = null; return; }
    // The empty line above Peri plus its four rows, so it can jump up into it
    ui.drawAt(PERI_TOP, 1, f.rows);
    periTimer = setTimeout(next, f.ms);
  };
  next();
}

function stopPeri() {
  if (periTimer) clearTimeout(periTimer);
  periTimer = null;
  periPlaying = false;
}

// ── Start screen (also drawn again by /clear and /resume) ──
const PLAN_NAMES: Record<string, string> = { free: "Peridot Free", plus: "Peridot Plus", extended: "Peridot Extended 5x", extended10: "Peridot Extended 10x" };
const start = { model: "", plan: "", folder: "", broad: false };

function planName(me: { user: any; limits?: any } | null): string {
  if (!me) return "not signed in";
  return me.user.role === "admin" ? "Admin" : PLAN_NAMES[me.limits?.plan ?? me.user.plan ?? "free"] ?? "Peridot Free";
}

function introText(): string {
  return (
    `\n${startScreen(startLines({ version: VERSION, model: start.model, plan: start.plan, folder: start.folder }))}\n\n` +
    (start.broad ? `${amber("This is a very broad folder. Open Peridot in your project folder to keep it focused.")}\n` : "") +
    `${dim("Type a message, / for commands, ! for a shell command.")}\n`
  );
}

/** Clears the screen and shows the start screen again (Peri is clickable again too). */
function freshScreen() {
  stopPeri();
  ui.restart(introText());
}

// ── Main ──
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Peridot is an interactive app. Run `peridot` in a terminal.");
    process.exit(1);
  }
  config = JSON.parse(await readFile(CONFIG_FILE, "utf8").catch(() => "{}"));

  let lastInterrupt = 0;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const where = home && root.startsWith(home) ? "~" + root.slice(home.length) : root;
  const broad = root === home || root === "/" || /^[A-Za-z]:\\?$/.test(root);
  // Model and plan for the start screen; never hold up the start for more than a moment
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 1500));
  const [me, models] = await Promise.all([
    authToken() ? Promise.race([api<{ user: any; limits?: any }>("/auth/me").catch(() => null), timeout]) : null,
    Promise.race([loadModels().catch(() => null), timeout]),
  ]);
  start.folder = where;
  start.broad = broad;
  start.model = models?.find((m) => m.id === (config.model || "fast"))?.name ?? (config.model || "Default model");
  start.plan = planName(me);

  ui.begin(introText(),
    {
    // Commands starting with what was typed first, then ones that only contain it
    commands: (text) => {
      const q = text.slice(1).toLowerCase();
      const all = Object.entries(COMMANDS).map(([name, c]) => ({ name: "/" + name, desc: c.desc }));
      return [...all.filter((c) => c.name.slice(1).startsWith(q)), ...all.filter((c) => !c.name.slice(1).startsWith(q) && c.name.includes(q))];
    },
    onCycle: () => void cycleMode(),
    onClick: (x, y) => {
      if (x <= PERI_WIDTH && y > PERI_TOP && y <= PERI_TOP + 4) playPeri();
    },
    mouseRows: PERI_TOP + 4,
    onStartGone: stopPeri,
    onInterrupt: (hasInput) => {
      if (abort) { abort.abort(); stopCommands(); return; }
      if (cancelLogin) return cancelLogin();
      if (hasInput) return ui.clearInput();
      if (Date.now() - lastInterrupt < 2000) return quit();
      lastInterrupt = Date.now();
      print(dim("(press Ctrl+C again or type /exit to quit)"));
    },
    onSubmit: async (line) => {
      ui.setBusy(true);
      try {
        if (line.startsWith("!")) {
          out(`\n${ui.userBubble(line)}\n\n`);
          try { await shell(line.slice(1)); } catch (e) { print(red(`Error: ${(e as Error).message}`)); }
        } else if (line.startsWith("/")) {
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

process.on("exit", () => { ui.mouseOff(); process.stdout.write("\x1b[?25h"); });
process.on("SIGINT", () => quit());
process.on("SIGTERM", () => quit());

main().catch((e) => {
  ui.end();
  console.error(red(`Error: ${(e as Error).message}`));
  process.exit(1);
});
