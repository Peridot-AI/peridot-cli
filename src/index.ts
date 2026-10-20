#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const API = (process.env.PERIDOT_API_URL || "https://peridot.ai/api").replace(/\/+$/, "");
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "peridot");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

type Msg = { role: "user" | "model"; content: string };

const HELP = `Peridot CLI

Usage:
  peridot                     interactive chat
  peridot "your question"     one answer, then exit
  echo "text" | peridot       read the prompt from stdin
  peridot login               sign in (token is stored in ${CONFIG_FILE})
  peridot logout              forget the stored token

Options:
  -m, --model <id>            model to use (default: fast)
  -h, --help                  show this help

Environment:
  PERIDOT_TOKEN               use this token instead of the stored one
  PERIDOT_API_URL             API base URL (default: https://peridot.ai/api)
`;

async function readConfig(): Promise<{ token?: string }> {
  try { return JSON.parse(await readFile(CONFIG_FILE, "utf8")); } catch { return {}; }
}

async function token() {
  return process.env.PERIDOT_TOKEN || (await readConfig()).token;
}

/** Streams one answer to stdout and returns the full text. */
async function ask(messages: Msg[], model: string): Promise<string> {
  const t = await token();
  const res = await fetch(`${API}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify({ messages, model }),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }

  let answer = "";
  let buffer = "";
  const decoder = new TextDecoder();
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
          answer += chunk;
          process.stdout.write(chunk);
        }
      }
    }
  }
  process.stdout.write("\n");
  return answer;
}

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Don't echo the password back
    (rl as any)._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(s); };
  }
  const answer = await rl.question(question);
  rl.close();
  if (hidden) process.stdout.write("\n");
  return answer.trim();
}

async function login() {
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Login failed");
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify({ token: data.token }), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
  console.log(`Signed in as ${data.user?.email ?? email}.`);
}

async function chat(model: string) {
  const history: Msg[] = [];
  console.log("Peridot — type your message, Ctrl+C or 'exit' to quit.\n");
  while (true) {
    const line = await prompt("> ");
    if (!line) continue;
    if (line === "exit" || line === "quit") return;
    history.push({ role: "user", content: line });
    try {
      history.push({ role: "model", content: await ask(history, model) });
    } catch (e) {
      history.pop();
      console.error(`Error: ${(e as Error).message}`);
    }
    console.log();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let model = "fast";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-h" || args[i] === "--help") return void console.log(HELP);
    if (args[i] === "-m" || args[i] === "--model") model = args[++i] ?? model;
    else rest.push(args[i]);
  }

  if (rest[0] === "login") return login();
  if (rest[0] === "logout") {
    await writeFile(CONFIG_FILE, "{}").catch(() => {});
    return void console.log("Signed out.");
  }

  let text = rest.join(" ").trim();
  if (!text && !process.stdin.isTTY) text = (await Bun.stdin.text()).trim();
  if (text) await ask([{ role: "user", content: text }], model);
  else await chat(model);
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
