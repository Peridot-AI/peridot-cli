// Client side of the coding agent. The server runs one model turn at a time and returns the
// model's tool calls; the tools run here, so the loop lives in the CLI.
import { NEEDS_APPROVAL, runTool, type ToolName } from "./tools";

export type Block = { type: string; [k: string]: any };
export type ApiMessage = { role: "user" | "assistant"; content: string | Block[] };
export interface ToolCall { id: string; name: string; input: Record<string, any> }

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
}

export interface AgentOptions {
  url: string;
  headers: () => Record<string, string>;
  model: string;
  effort: string;
  workspace: string;
  extraTools?: Record<string, ExtraTool>;
}

const MAX_STEPS = 40;

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

/**
 * Runs the agent until the model stops asking for tools. `messages` is extended in place, always
 * with complete steps (an assistant message plus the results of its tool calls), so it stays valid
 * even when the run is interrupted.
 */
export async function runAgent(messages: ApiMessage[], opts: AgentOptions, hooks: AgentHooks, signal: AbortSignal): Promise<void> {
  for (let step = 0; step < MAX_STEPS; step++) {
    hooks.onModelStart();
    const { content, stopReason } = await modelTurn(messages, opts, hooks.onText, signal);
    hooks.onTurnEnd();

    const calls = content.filter((b) => b.type === "tool_use") as unknown as ToolCall[];
    if (stopReason !== "tool_use" || calls.length === 0) {
      messages.push({ role: "assistant", content });
      return;
    }

    const results: Block[] = [];
    let interrupted = false;
    for (const call of calls) {
      let result: ToolResult;
      if (interrupted || signal.aborted) {
        interrupted = true;
        result = { ok: false, output: "Interrupted by the user before this ran." };
      } else {
        hooks.onToolStart(call);
        const extra = opts.extraTools?.[call.name];
        const approval = extra ? extra.approval : NEEDS_APPROVAL[call.name as ToolName];
        if (approval && !(await hooks.approve(call))) {
          result = { ok: false, output: "The user denied this action. Do not retry it; ask what they want instead.", denied: true };
        } else {
          result = extra ? await extra.run(call.input) : await runTool(call.name, call.input);
        }
        hooks.onToolEnd(call, result);
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: result.output, ...(result.ok ? {} : { is_error: true }) });
    }
    messages.push({ role: "assistant", content }, { role: "user", content: results });
    if (interrupted) throw aborted();
  }
  throw new Error("Stopped after too many steps. Tell me to continue if you want more.");
}
