#!/usr/bin/env bun
import { createInterface, type Interface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "0.2.0";
const API = (process.env.PERIDOT_API_URL || "https://peridot.ai/api").replace(/\/+$/, "");
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

async function saveConfig() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config), { mode: 0o600 });
}

const authToken = () => process.env.PERIDOT_TOKEN || config.token;
const headers = () => ({ "Content-Type": "application/json", ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}) });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  const data = (await res.json().catch(() => ({}))) as any;
  if (res.status === 401 && authToken()) throw new Error("Your session has expired. Use /login to sign in again.");
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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

// ── Chat ──
/** Streams one answer to stdout. Returns the text received (also when interrupted). */
async function streamAnswer(): Promise<string> {
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
      const err = (await res.json().catch(() => ({}))) as any;
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
          if (chunk) { answer += chunk; process.stdout.write(chunk); }
        }
      }
    }
    process.stdout.write("\n");
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      process.stdout.write(dim("\n[interrupted]\n"));
    } else {
      if (answer) process.stdout.write("\n");
      throw e;
    }
  } finally {
    abort = null;
  }
  return answer;
}

async function send(text: string) {
  history.push({ role: "user", content: text });
  process.stdout.write(`\n${mint("◆")} `);
  try {
    const answer = await streamAnswer();
    if (answer) history.push({ role: "model", content: answer });
    else history.pop();
  } catch (e) {
    history.pop();
    console.log(red(`Error: ${(e as Error).message}`));
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
    console.log(bold("Models"));
    models.forEach((m, i) => {
      const active = m.id === current;
      const line = `${String(i + 1).padStart(2)}. ${m.name}${m.badge ? ` ${dim(`[${m.badge}]`)}` : ""} ${dim("— " + m.desc)}${m.locked ? " " + amber("(upgrade to use)") : ""}`;
      console.log(`${active ? mint("●") : " "} ${line}`);
    });
    const pick = await ask(dim("\nNumber or name (Enter to keep the current model): "));
    if (!pick) return;
    choice = find(pick);
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

async function cmdLogin() {
  const email = await ask("Email: ");
  if (!email) return;
  const password = await ask("Password: ", true);
  const data = await api<{ token: string; user: { email: string } }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  config.token = data.token;
  await saveConfig();
  console.log(`Signed in as ${bold(data.user?.email ?? email)}.`);
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
  console.log(`\n${mint("◆")} ${bold("Peridot")} ${dim("v" + VERSION)}`);
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

main().catch((e) => {
  console.error(red(`Error: ${(e as Error).message}`));
  process.exit(1);
});
