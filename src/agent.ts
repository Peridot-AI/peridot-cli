// Client side of the coding agent. The server runs one model turn at a time and returns the
// model's tool calls; the tools run here, so the loop lives in the CLI.
import { NEEDS_APPROVAL, runTool, type ToolName } from "./tools";
import { LEAD_ID, MAX_BOT_RESULT, TEAM_MAX_DEPTH, type Bot, type BotToolName, type TeamConfig } from "./team";
import { normalizePlan, type PlanStep } from "./cowork";

export type Block = { type: string; [k: string]: any };
export type ApiMessage = { role: "user" | "assistant"; content: string | Block[] };
/** `by` is the id of the teammate running the call; none for the lead agent */
export interface ToolCall { id: string; name: string; input: Record<string, any>; by?: string }

/** Hand-offs between the lead and the bots */
export type TeamEvent =
  | { type: "delegate"; id: string; from: string; to: string; task: string }
  | { type: "result"; id: string; from: string; to: string; ok: boolean; output: string };

/** An agent tool added by a plugin, under its <plugin>__<tool> name */
export interface ExtraTool {
  def: { name: string; description: string; input_schema: Record<string, unknown> };
  approval: "edit" | "command" | null;
  run(input: Record<string, any>): Promise<ToolResult>;
}
export type ToolResult = { ok: boolean; output: string; denied?: boolean };

export interface AgentHooks {
  /** A request to the model is about to start */
  onModelStart(): void;
  onText(chunk: string): void;
  /** The model finished a block of text, before its tool calls run */
  onTurnEnd(): void;
  /** Resolves true to run the tool, false to deny it */
  approve(call: ToolCall): Promise<boolean>;
  onToolStart(call: ToolCall): void;
  onToolEnd(call: ToolCall, result: ToolResult): void;
  onTeam?(event: TeamEvent): void;
  /** Cowork: the agent's plan, whole, each time it changes */
  onPlan?(steps: PlanStep[]): void;
}

export interface AgentOptions {
  url: string;
  headers: () => Record<string, string>;
  model: string;
  effort: string;
  workspace: string;
  extraTools?: Record<string, ExtraTool>;
  /** Your AI team. With it, the agent gets the delegate tool for the bots it may hand work to. */
  team?: TeamConfig;
  /** The bot running this loop (none = the lead agent), who gave it the task, and how deep in hand-offs it is */
  actor?: string;
  caller?: string;
  depth?: number;
  maxSteps?: number;
  /** Cowork: the agent plans the work, does it and shows its progress */
  cowork?: boolean;
}

const MAX_STEPS = 40;
const BOT_MAX_STEPS = 25;

async function modelTurn(messages: ApiMessage[], opts: AgentOptions, onText: (c: string) => void, signal: AbortSignal) {
  const res = await fetch(opts.url, {
    method: "POST",
    headers: opts.headers(),
    body: JSON.stringify({
      messages,
      model: opts.model,
      effort: opts.effort,
      workspace: opts.workspace,
      platform: process.platform,
      tools: Object.values(opts.extraTools ?? {}).map((t) => t.def),
      ...(opts.team?.bots.length ? { team: opts.team, actor: opts.actor ?? null, caller: opts.caller ?? null, depth: opts.depth ?? 0 } : {}),
      ...(opts.cowork && !opts.actor ? { mode: "cowork" } : {}),
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = ((await res.json().catch(() => null)) ?? {}) as any;
    throw new Error(err.error || `Request failed (${res.status})`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const block of parts) {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (event === "message" && parsed.chunk) onText(parsed.chunk);
      else if (event === "done") return { content: parsed.content as Block[], stopReason: parsed.stopReason as string | null };
      else if (event === "error") throw new Error(parsed.error || "The agent failed.");
    }
  }
  throw new Error("The connection closed before the model finished.");
}

const aborted = () => Object.assign(new Error("Aborted"), { name: "AbortError" });

const textOf = (content: string | Block[]) =>
  typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");

/** Runs one teammate on a task, in its own conversation, and returns its final report to the caller. */
async function delegate(call: ToolCall, opts: AgentOptions, hooks: AgentHooks, signal: AbortSignal): Promise<ToolResult> {
  const from = opts.actor ?? LEAD_ID;
  const team = opts.team;
  const caller = team?.bots.find((b) => b.id === opts.actor);
  const allowed = (opts.actor ? caller?.delegates : team?.lead.delegates) ?? [];
  const target: Bot | undefined = team?.bots.find((b) => b.id === call.input.bot);
  const task = String(call.input.task ?? "").trim();
  const depth = opts.depth ?? 0;
  if (!target || !allowed.includes(target.id) || depth >= TEAM_MAX_DEPTH) {
    return { ok: false, output: `You can't hand work to "${call.input.bot}". Teammates you can use: ${allowed.join(", ") || "none"}.` };
  }
  if (!task) return { ok: false, output: "The task is empty. Describe what the teammate should do." };

  hooks.onTeam?.({ type: "delegate", id: call.id, from, to: target.id, task });
  let result: ToolResult;
  try {
    const messages: ApiMessage[] = [{ role: "user", content: task }];
    await runAgent(
      messages,
      { ...opts, extraTools: undefined, model: target.model || opts.model, actor: target.id, caller: from, depth: depth + 1, maxSteps: BOT_MAX_STEPS, cowork: false },
      {
        // The teammate's own words go back to the caller as its report, not to the screen
        onModelStart: () => {},
        onText: () => {},
        onTurnEnd: () => {},
        approve: (c) => hooks.approve({ ...c, by: target.id }),
        onToolStart: (c) => hooks.onToolStart({ ...c, by: target.id }),
        onToolEnd: (c, r) => hooks.onToolEnd({ ...c, by: target.id }, r),
        onTeam: hooks.onTeam,
      },
      signal
    );
    const report = textOf(messages[messages.length - 1].content).trim();
    result = { ok: true, output: (report || "(The teammate finished without a report.)").slice(0, MAX_BOT_RESULT) };
  } catch (err: any) {
    result = err?.name === "AbortError"
      ? { ok: false, output: "Interrupted by the user." }
      : { ok: false, output: `${target.name} failed: ${err?.message || "unknown error"}` };
  }
  hooks.onTeam?.({ type: "result", id: call.id, from: target.id, to: from, ok: result.ok, output: result.output });
  return result;
}

/**
 * Runs the agent until the model stops asking for tools. `messages` is extended in place, always
 * with complete steps (an assistant message plus the results of its tool calls), so it stays valid
 * even when the run is interrupted.
 */
export async function runAgent(messages: ApiMessage[], opts: AgentOptions, hooks: AgentHooks, signal: AbortSignal): Promise<void> {
  for (let step = 0; step < (opts.maxSteps ?? MAX_STEPS); step++) {
    hooks.onModelStart();
    const { content, stopReason } = await modelTurn(messages, opts, hooks.onText, signal);
    hooks.onTurnEnd();

    const calls = content.filter((b) => b.type === "tool_use") as unknown as ToolCall[];
    if (stopReason !== "tool_use" || calls.length === 0) {
      messages.push({ role: "assistant", content });
      return;
    }

    const self = opts.actor ? opts.team?.bots.find((b) => b.id === opts.actor) : undefined;
    const runOne = async (call: ToolCall): Promise<ToolResult> => {
      hooks.onToolStart(call);
      let result: ToolResult;
      const extra = opts.extraTools?.[call.name];
      const approval = extra ? extra.approval : NEEDS_APPROVAL[call.name as ToolName];
      if (call.name === "update_plan" && !opts.actor) {
        // Cowork's plan only shows the user what the agent is doing: nothing to approve, nothing to run
        hooks.onPlan?.(normalizePlan(call.input.steps));
        result = { ok: true, output: "Plan updated." };
      } else if (opts.actor && call.name !== "delegate" && !self?.tools.includes(call.name as BotToolName)) {
        // A teammate only gets the tools the user gave it, even if the model asks for another
        result = { ok: false, output: `You don't have the tool "${call.name}".` };
      } else if (call.name === "delegate") {
        result = await delegate(call, opts, hooks, signal);
      } else if (approval && !(await hooks.approve(call))) {
        result = { ok: false, output: "The user denied this action. Do not retry it; ask what they want instead.", denied: true };
      } else {
        result = extra ? await extra.run(call.input) : await runTool(call.name, call.input);
      }
      hooks.onToolEnd(call, result);
      return result;
    };

    // Teammates start right away and work in parallel; the other tools run one after another
    const results: ToolResult[] = new Array(calls.length);
    const handoffs: Promise<void>[] = [];
    let interrupted = false;
    let failure: unknown;
    try {
      for (let i = 0; i < calls.length; i++) {
        if (interrupted || signal.aborted) {
          interrupted = true;
          results[i] = { ok: false, output: "Interrupted by the user before this ran." };
        } else if (calls[i].name === "delegate") {
          handoffs.push(runOne(calls[i]).then((r) => void (results[i] = r)));
        } else {
          results[i] = await runOne(calls[i]);
        }
      }
    } catch (err) {
      failure = err;
    }
    // Let the teammates that are working finish (or stop) before going on
    await Promise.allSettled(handoffs);
    if (failure) throw failure;
    interrupted = interrupted || signal.aborted;

    messages.push(
      { role: "assistant", content },
      {
        role: "user",
        content: calls.map((call, i) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: results[i].output,
          ...(results[i].ok ? {} : { is_error: true }),
        })),
      }
    );
    if (interrupted) throw aborted();
  }
  throw new Error(opts.actor ? "The teammate used up its steps before finishing." : "Stopped after too many steps. Tell me to continue if you want more.");
}
