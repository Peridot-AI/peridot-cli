// /team: look at your AI team and change it, either in windows (just /team) or with subcommands.
// The team is saved in <project>/.peridot/team.json after every change, so it is shared with the desktop app.
import { bold, dim, mint, red } from "./style";
import { select, showCard, checklist, promptText, editInEditor, cut } from "./card";
import {
  BOT_TEMPLATES, LEAD_ID, MAX_BOTS, botName, canEdit, canRun, findBot, addBot, removeBot, updateBot, setAccess, setLink, treeLines, loadTeam, saveTeam,
  type Bot, type TeamConfig,
} from "./team";

export interface TeamUiDeps {
  root: string;
  print: (...parts: unknown[]) => void;
  /** Models for the model picker; may fail when offline */
  models: () => Promise<{ id: string; name: string; locked?: boolean }[]>;
  /** How many tasks went from one to another in this session: "from>to" → count */
  counts: () => Record<string, number>;
}

const USAGE = [
  ["/team", "Open your team: look at it, add and edit bots"],
  ["/team list", "The bots and what each can do"],
  ["/team graph", "Who may hand work to whom, as a tree"],
  ["/team add [template|name]", `Add a bot (templates: ${BOT_TEMPLATES.map((t) => t.key).join(", ")})`],
  ["/team show <bot>", "All settings of a bot"],
  ["/team set <bot> <name|role|model|instructions> <text>", "Change a setting (model: an id, or - for the chat's model)"],
  ["/team access <bot> <edit|run> <on|off>", "Let a bot edit files or run commands"],
  ["/team link <from> <to>", "Let <from> (lead or a bot) hand work to <to>"],
  ["/team unlink <from> <to>", "Take that away again"],
  ["/team remove <bot>", "Delete a bot"],
];

const access = (b: Bot) => ["read", ...(canEdit(b) ? ["edit"] : []), ...(canRun(b) ? ["run"] : [])].join(" · ");
const preview = (s: string, n: number) => (s.trim() ? cut(s.replace(/\s+/g, " ").trim(), n) : "(empty)");

export async function cmdTeam(arg: string, d: TeamUiDeps) {
  const [sub = "", ...rest] = arg.trim().split(/\s+/);
  const text = rest.join(" ");
  const team = () => loadTeam(d.root);
  const save = (t: TeamConfig) => saveTeam(d.root, t);
  const need = (t: TeamConfig, query: string, what = "bot") => {
    const id = findBot(t, query);
    if (!id) throw new Error(query ? `No ${what} "${query}". See /team list.` : `Name a ${what}. See /team list.`);
    return id;
  };
  const needBot = (t: TeamConfig, query: string) => {
    const id = need(t, query);
    if (id === LEAD_ID) throw new Error("That is the lead, the agent you chat with. It has no settings of its own: choose its bots with /team link.");
    return t.bots.find((b) => b.id === id)!;
  };

  switch (sub.toLowerCase()) {
    case "":
      return openTeam(d);

    case "help":
    case "?":
      return printUsage(d);

    case "list":
    case "ls": {
      const t = team();
      if (!t.bots.length) return d.print(dim("No bots yet. Add one with /team add researcher, or open /team."));
      d.print(bold("Your AI team") + dim(`  ·  ${t.bots.length} bot${t.bots.length === 1 ? "" : "s"}`));
      for (const b of t.bots) {
        const lead = t.lead.delegates.includes(b.id) ? "" : dim("  (the lead can't use it)");
        d.print(`  ${mint(b.id.padEnd(16))}${b.name}${dim(`  ·  ${access(b)}${b.model ? "  ·  " + b.model : ""}`)}${lead}`);
        if (b.role) d.print(dim(`  ${" ".repeat(16)}${cut(b.role, 90)}`));
      }
      return;
    }

    case "graph":
    case "tree":
      return d.print(graphLines(team(), d).join("\n"));

    case "add":
    case "new": {
      const t = team();
      const q = text.trim().toLowerCase();
      const tpl = BOT_TEMPLATES.find((x) => x.key === q || x.name.toLowerCase() === q);
      const made = addBot(t, tpl ? { name: tpl.name, role: tpl.role, prompt: tpl.prompt, tools: [...tpl.tools] } : { name: text.trim() || "New bot" }, tpl ? tpl.key : text.trim() || "bot");
      save(made.team);
      d.print(`${mint("✓")} Added ${bold(botName(made.team, made.id))} ${dim(`(${made.id}) · ${access(made.team.bots.find((b) => b.id === made.id)!)}`)}`);
      return d.print(dim("Change it with /team, or /team set / access / link."));
    }

    case "remove":
    case "rm":
    case "delete": {
      const t = team();
      const b = needBot(t, text);
      save(removeBot(t, b.id));
      return d.print(`${mint("✓")} Deleted ${bold(b.name)}.`);
    }

    case "show": {
      const t = team();
      const b = needBot(t, text);
      d.print(bold(b.name) + dim(`  ${b.id}`));
      d.print(`  ${dim("role        ")}${b.role || dim("(empty)")}`);
      d.print(`  ${dim("model       ")}${b.model || dim("same as the chat")}`);
      d.print(`  ${dim("access      ")}${access(b)}`);
      d.print(`  ${dim("hands work to ")}${b.delegates.map((x) => botName(t, x)).join(", ") || dim("nobody")}`);
      d.print(`  ${dim("lead may use")} ${t.lead.delegates.includes(b.id) ? "yes" : "no"}`);
      d.print(`  ${dim("instructions")}\n${(b.prompt || dim("(empty)")).split("\n").map((l) => "    " + l).join("\n")}`);
      return;
    }

    case "set": {
      const t = team();
      const [who, field = "", ...value] = text.split(/\s+/);
      const b = needBot(t, who ?? "");
      const v = value.join(" ").trim();
      const key = field.toLowerCase();
      if (!["name", "role", "model", "instructions", "prompt"].includes(key)) throw new Error("Choose what to change: name, role, model or instructions.");
      if (key === "name" && !v) throw new Error("Give the bot a name.");
      const change: Partial<Bot> =
        key === "name" ? { name: v } : key === "role" ? { role: v } : key === "model" ? { model: v === "-" ? "" : v } : { prompt: v };
      save(updateBot(t, b.id, change));
      return d.print(`${mint("✓")} ${bold(b.name)}: ${key} changed.`);
    }

    case "access": {
      const t = team();
      const [who, kind = "", state = ""] = text.split(/\s+/);
      const b = needBot(t, who ?? "");
      if (kind !== "edit" && kind !== "run") throw new Error("Use /team access <bot> <edit|run> <on|off>.");
      if (!["on", "off"].includes(state)) throw new Error("Say on or off.");
      save(updateBot(t, b.id, { tools: setAccess(b, kind, state === "on") }));
      return d.print(`${mint("✓")} ${bold(b.name)} can ${kind === "edit" ? "edit files" : "run commands"}: ${state}.`);
    }

    case "link":
    case "unlink": {
      const t = team();
      const [from, to] = text.split(/\s+/);
      const a = need(t, from ?? "", "bot or lead");
      const b = need(t, to ?? "");
      save(setLink(t, a, b, sub === "link"));
      return d.print(`${mint("✓")} ${bold(botName(t, a))} ${sub === "link" ? "may now hand work to" : "can no longer hand work to"} ${bold(botName(t, b))}.`);
    }
  }
  printUsage(d);
}

function printUsage(d: TeamUiDeps) {
  d.print(bold("Your AI team"));
  const w = Math.max(...USAGE.map(([c]) => c.length)) + 2;
  for (const [c, text] of USAGE) d.print(`  ${mint(c.padEnd(w))}${text}`);
  d.print(dim("\nThe team is saved in .peridot/team.json of this project and shared with the desktop app. Ask Peridot for something that fits your bots and the lead hands them work."));
}

/** The tree and a table of the bots, for the graph window and /team graph */
function graphLines(t: TeamConfig, d: TeamUiDeps): string[] {
  const counts = d.counts();
  if (!t.bots.length) return [dim("No bots yet. Add one with /team add researcher.")];
  const lines = [bold("Who may hand work to whom"), "", ...treeLines(t, counts, () => "").map((l, i) => (i === 0 ? mint(l) : l)), ""];
  lines.push(dim("▶ may hand work to · ↻ already shown above · counts are tasks handed over in this session"), "");
  for (const b of t.bots) lines.push(`${mint(b.name.padEnd(18))}${dim(access(b))}${b.model ? dim("  ·  " + b.model) : ""}`);
  return lines;
}

// ── Windows ──
async function openTeam(d: TeamUiDeps) {
  let last = 0;
  for (;;) {
    const t = loadTeam(d.root);
    const items = [
      { label: "Lead", hint: t.lead.delegates.length ? `— hands work to ${t.lead.delegates.map((x) => botName(t, x)).join(", ")}` : "— hands work to nobody yet" },
      ...t.bots.map((b) => ({ label: b.name, hint: `— ${access(b)}${b.role ? " · " + b.role : ""}` })),
      { label: "+ Add a bot", hint: t.bots.length >= MAX_BOTS ? "(the team is full)" : "" },
      { label: "Show the graph" },
    ];
    const pick = await select("Your AI team", items, last, t.bots.length ? [dim("Pick the lead or a bot to change it.")] : [dim("No bots yet. Add one, then ask Peridot for something that fits it.")]);
    if (pick === null) return;
    last = pick;
    try {
      if (pick === 0) await leadWindow(d);
      else if (pick <= t.bots.length) await botWindow(d, t.bots[pick - 1].id);
      else if (pick === t.bots.length + 1) {
        const added = await addWindow(d);
        if (added) await botWindow(d, added);
      } else await showCard("Team graph", () => graphLines(loadTeam(d.root), d));
    } catch (e) {
      d.print(red(`Error: ${(e as Error).message}`));
      return;
    }
  }
}

/** Which bots the lead may hand work to */
async function leadWindow(d: TeamUiDeps) {
  const t = loadTeam(d.root);
  if (!t.bots.length) return;
  const picked = await checklist(
    "Lead: may hand work to",
    t.bots.map((b) => ({ label: b.name, hint: b.role ? `— ${cut(b.role, 50)}` : "", checked: t.lead.delegates.includes(b.id) })),
    [dim("The lead is the agent you chat with.")]
  );
  if (!picked) return;
  let next = t;
  t.bots.forEach((b, i) => (next = setLink(next, LEAD_ID, b.id, picked[i])));
  saveTeam(d.root, next);
}

async function addWindow(d: TeamUiDeps): Promise<string | null> {
  const t = loadTeam(d.root);
  if (t.bots.length >= MAX_BOTS) throw new Error(`Your team is full (${MAX_BOTS} bots).`);
  const pick = await select("Add a bot", [...BOT_TEMPLATES.map((x) => ({ label: x.name, hint: `— ${cut(x.role, 60)}` })), { label: "Blank bot", hint: "— write its instructions yourself" }]);
  if (pick === null) return null;
  const tpl = BOT_TEMPLATES[pick];
  const made = addBot(t, tpl ? { name: tpl.name, role: tpl.role, prompt: tpl.prompt, tools: [...tpl.tools] } : { name: "New bot" }, tpl ? tpl.key : "bot");
  saveTeam(d.root, made.team);
  return made.id;
}

async function botWindow(d: TeamUiDeps, id: string) {
  let last = 0;
  for (;;) {
    const t = loadTeam(d.root);
    const b = t.bots.find((x) => x.id === id);
    if (!b) return;
    const leadUses = t.lead.delegates.includes(b.id);
    const items = [
      { label: "Name", hint: `— ${b.name}` },
      { label: "Role", hint: `— ${preview(b.role, 60)}` },
      { label: "Instructions", hint: `— ${preview(b.prompt, 50)}` },
      { label: "Model", hint: `— ${b.model || "same as the chat"}` },
      { label: `Edit files: ${canEdit(b) ? "on" : "off"}`, hint: "— Enter toggles" },
      { label: `Run commands: ${canRun(b) ? "on" : "off"}`, hint: "— Enter toggles" },
      { label: "Hands work to", hint: `— ${b.delegates.map((x) => botName(t, x)).join(", ") || "nobody"}` },
      { label: `The lead can use this bot: ${leadUses ? "yes" : "no"}`, hint: "— Enter toggles" },
      { label: "Delete this bot" },
      { label: "Back" },
    ];
    const pick = await select(b.name, items, last, [dim(b.role ? cut(b.role, 70) : "Reading files is always allowed. Edits and commands still ask you first.")]);
    if (pick === null || pick === 9) return;
    last = pick;

    if (pick === 0) {
      const v = await promptText("Name", b.name, [], 40);
      if (v) saveTeam(d.root, updateBot(t, b.id, { name: v }));
    } else if (pick === 1) {
      const v = await promptText("Role", b.role, [dim("One line the lead reads to decide when to hand work to this bot.")], 200);
      if (v !== null) saveTeam(d.root, updateBot(t, b.id, { role: v }));
    } else if (pick === 2) {
      const v = editInEditor(b.prompt + (b.prompt.endsWith("\n") || !b.prompt ? "" : "\n"));
      if (v === null) d.print(red("The editor did not finish. Set $EDITOR, or use /team set <bot> instructions <text>."));
      else saveTeam(d.root, updateBot(t, b.id, { prompt: v.trim() }));
    } else if (pick === 3) {
      const m = await chooseModel(d, b);
      if (m !== null) saveTeam(d.root, updateBot(t, b.id, { model: m }));
    } else if (pick === 4) saveTeam(d.root, updateBot(t, b.id, { tools: setAccess(b, "edit", !canEdit(b)) }));
    else if (pick === 5) saveTeam(d.root, updateBot(t, b.id, { tools: setAccess(b, "run", !canRun(b)) }));
    else if (pick === 6) {
      const others = t.bots.filter((x) => x.id !== b.id);
      if (!others.length) continue;
      const picked = await checklist("Hands work to", others.map((x) => ({ label: x.name, hint: x.role ? `— ${cut(x.role, 50)}` : "", checked: b.delegates.includes(x.id) })), [dim("Bots this one may give tasks to. Chains stop two hand-offs deep.")]);
      if (picked) {
        let next = t;
        others.forEach((x, i) => (next = setLink(next, b.id, x.id, picked[i])));
        saveTeam(d.root, next);
      }
    } else if (pick === 7) saveTeam(d.root, setLink(t, LEAD_ID, b.id, !leadUses));
    else if (pick === 8) {
      const sure = await select(`Delete ${b.name}?`, [{ label: "Delete" }, { label: "Cancel" }], 1);
      if (sure === 0) {
        saveTeam(d.root, removeBot(t, b.id));
        return;
      }
    }
  }
}

/** Returns the chosen model id ("" for the chat's model), or null when cancelled */
async function chooseModel(d: TeamUiDeps, b: Bot): Promise<string | null> {
  const models = await d.models().catch(() => []);
  if (!models.length) return promptText("Model id (empty: same as the chat)", b.model, [], 80);
  const usable = models.filter((m) => !m.locked);
  const current = b.model ? usable.findIndex((m) => m.id === b.model) + 1 : 0;
  const pick = await select("Model", [{ label: "Same as the chat", hint: "(default)" }, ...usable.map((m) => ({ label: m.name, hint: m.id }))], Math.max(0, current));
  if (pick === null) return null;
  return pick === 0 ? "" : usable[pick - 1].id;
}
