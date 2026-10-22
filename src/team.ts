// Your AI team: the bots saved in <project>/.peridot/team.json, the same file the desktop app uses.
// Self-contained (the CLI is published on its own): a test keeps normalizeTeam and the templates equal
// to the desktop app's copy in src/lib/team-schema.ts.
import fs from "node:fs";
import path from "node:path";

/** Built-in tools a bot can be given. Reading is always allowed. */
export type BotToolName = "list_files" | "read_file" | "search" | "write_file" | "edit_file" | "run_command";
export const READ_TOOLS: BotToolName[] = ["list_files", "read_file", "search"];
export const EDIT_TOOLS: BotToolName[] = ["write_file", "edit_file"];
export const RUN_TOOLS: BotToolName[] = ["run_command"];
const ALL_TOOLS = new Set<string>([...READ_TOOLS, ...EDIT_TOOLS, ...RUN_TOOLS]);

/** Id of the agent you chat with; it is not stored in the bot list */
export const LEAD_ID = "lead";
/** Lead → bot → bot. A bot at this depth can't hand work on. */
export const TEAM_MAX_DEPTH = 2;
export const MAX_BOTS = 12;
/** A bot's report is cut to this many characters */
export const MAX_BOT_RESULT = 8000;
const MAX_FILE_BYTES = 200_000;

export interface Bot {
  id: string;
  name: string;
  role: string;
  prompt: string;
  /** Model id, or "" to use the one picked in the chat */
  model: string;
  tools: BotToolName[];
  /** Ids of the bots this one may hand work to */
  delegates: string[];
  /** Position in the desktop app's graph; kept as it is */
  x?: number;
  y?: number;
}

export interface TeamConfig {
  lead: { delegates: string[] };
  bots: Bot[];
}

export const emptyTeam = (): TeamConfig => ({ lead: { delegates: [] }, bots: [] });

const ID = /^[a-z0-9][a-z0-9-]{0,29}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e5 ? v : undefined);

/** Turns whatever was read from disk into a valid team: drops malformed bots, unknown tools and dangling links. */
export function normalizeTeam(raw: unknown): TeamConfig {
  const r = raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
  const bots: Bot[] = [];
  const seen = new Set<string>();
  for (const b of Array.isArray(r.bots) ? r.bots : []) {
    if (!b || typeof b !== "object" || bots.length >= MAX_BOTS) continue;
    const id = typeof b.id === "string" ? b.id : "";
    if (!ID.test(id) || id === LEAD_ID || seen.has(id)) continue;
    seen.add(id);
    const tools = new Set<string>(READ_TOOLS);
    for (const t of Array.isArray(b.tools) ? b.tools : []) if (typeof t === "string" && ALL_TOOLS.has(t)) tools.add(t);
    bots.push({
      id,
      name: str(b.name, 40).trim() || id,
      role: str(b.role, 200),
      prompt: str(b.prompt, 4000),
      model: str(b.model, 80),
      tools: [...tools] as BotToolName[],
      delegates: Array.isArray(b.delegates) ? b.delegates.filter((d: unknown) => typeof d === "string") : [],
      x: num(b.x),
      y: num(b.y),
    });
  }
  const links = (list: unknown, self?: string) =>
    [...new Set(Array.isArray(list) ? list : [])].filter((d): d is string => typeof d === "string" && d !== self && seen.has(d));
  for (const b of bots) b.delegates = links(b.delegates, b.id);
  return { lead: { delegates: links(r.lead?.delegates) }, bots };
}

/** An unused id for a new bot, from its name */
export function makeBotId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "bot";
  let id = base === LEAD_ID ? "bot" : base;
  for (let n = 2; used.has(id); n++) id = `${base.slice(0, 24)}-${n}`;
  return id;
}

/** Starting points offered when adding a bot */
export const BOT_TEMPLATES: { key: string; name: string; role: string; prompt: string; tools: BotToolName[] }[] = [
  {
    key: "researcher",
    name: "Researcher",
    role: "Explores the codebase and answers questions about how things work. Read-only.",
    prompt:
      "You investigate the codebase. Find the relevant files, read only what you need, and report exactly what you found: file paths with line numbers, how the pieces connect, and anything surprising. Do not change anything.",
    tools: READ_TOOLS,
  },
  {
    key: "reviewer",
    name: "Reviewer",
    role: "Reviews code or a set of changes for bugs, security problems and style. Read-only.",
    prompt:
      "You are a strict code reviewer. Read the code you are pointed at and look for bugs, edge cases, security problems and deviations from the project's style. Report a short list of concrete findings (file:line, what is wrong, how to fix it), most serious first. If it is fine, say so briefly. Do not change anything.",
    tools: READ_TOOLS,
  },
  {
    key: "tester",
    name: "Tester",
    role: "Runs the build and tests, and writes or fixes tests.",
    prompt:
      "You make sure the code works. Run the project's tests, type check or build, read failures carefully, and report what fails and why. When asked, write or fix tests. Do not change production code unless the task says so.",
    tools: [...READ_TOOLS, ...EDIT_TOOLS, ...RUN_TOOLS],
  },
  {
    key: "writer",
    name: "Writer",
    role: "Writes and updates documentation, READMEs and comments.",
    prompt:
      "You write clear, accurate documentation. Read the code first so every statement is true, match the tone and format of the existing docs, and keep it short. Report which files you changed.",
    tools: [...READ_TOOLS, ...EDIT_TOOLS],
  },
];

// ── The file ──
const REL = path.join(".peridot", "team.json");

/** The .peridot folder must not be a link that leaves the project */
function checkInside(root: string, file: string) {
  let probe = file;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = fs.realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error("The .peridot folder points outside the project.");
}

/** The team of a project; empty when there is no file, or it isn't valid. */
export function loadTeam(root: string): TeamConfig {
  try {
    const file = path.join(root, REL);
    checkInside(root, file);
    if (fs.statSync(file).size > MAX_FILE_BYTES) return emptyTeam();
    return normalizeTeam(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return emptyTeam();
  }
}

export function saveTeam(root: string, team: TeamConfig) {
  const clean = normalizeTeam(team);
  const text = JSON.stringify({ version: 1, ...clean }, null, 2) + "\n";
  if (text.length > MAX_FILE_BYTES) throw new Error("The team is too large.");
  const file = path.join(root, REL);
  checkInside(root, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  checkInside(root, file);
  fs.writeFileSync(file + ".tmp", text);
  fs.renameSync(file + ".tmp", file);
  return clean;
}

// ── Lookups and edits (all return a new team; nothing is saved here) ──
export const botName = (team: TeamConfig, id: string) => (id === LEAD_ID ? "Lead" : team.bots.find((b) => b.id === id)?.name ?? id);

/** A bot (or "lead") by id or name, ignoring case. */
export function findBot(team: TeamConfig, query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if (q === LEAD_ID) return LEAD_ID;
  return team.bots.find((b) => b.id === q)?.id ?? team.bots.find((b) => b.name.toLowerCase() === q)?.id ?? null;
}

export function addBot(team: TeamConfig, fields: Partial<Omit<Bot, "id">> & { name: string }, idHint = fields.name): { team: TeamConfig; id: string } {
  if (team.bots.length >= MAX_BOTS) throw new Error(`Your team is full (${MAX_BOTS} bots).`);
  const id = makeBotId(idHint, team.bots.map((b) => b.id));
  const bot: Bot = { role: "", prompt: "", model: "", tools: [...READ_TOOLS], delegates: [], ...fields, id };
  return { team: normalizeTeam({ lead: { delegates: [...team.lead.delegates, id] }, bots: [...team.bots, bot] }), id };
}

export function removeBot(team: TeamConfig, id: string): TeamConfig {
  return normalizeTeam({
    lead: { delegates: team.lead.delegates.filter((d) => d !== id) },
    bots: team.bots.filter((b) => b.id !== id).map((b) => ({ ...b, delegates: b.delegates.filter((d) => d !== id) })),
  });
}

export function updateBot(team: TeamConfig, id: string, change: Partial<Omit<Bot, "id">>): TeamConfig {
  return normalizeTeam({ ...team, bots: team.bots.map((b) => (b.id === id ? { ...b, ...change } : b)) });
}

/** Lets `from` ("lead" or a bot) hand work to `to`, or stops it. */
export function setLink(team: TeamConfig, from: string, to: string, on: boolean): TeamConfig {
  if (to === LEAD_ID || from === to) throw new Error("Work is only handed to bots, and not to the same bot.");
  const apply = (list: string[]) => (on ? [...new Set([...list, to])] : list.filter((d) => d !== to));
  if (from === LEAD_ID) return normalizeTeam({ ...team, lead: { delegates: apply(team.lead.delegates) } });
  return normalizeTeam({ ...team, bots: team.bots.map((b) => (b.id === from ? { ...b, delegates: apply(b.delegates) } : b)) });
}

export const canEdit = (b: Bot) => EDIT_TOOLS.some((t) => b.tools.includes(t));
export const canRun = (b: Bot) => RUN_TOOLS.some((t) => b.tools.includes(t));

/** Gives or takes away editing or running commands. Reading stays. */
export function setAccess(b: Bot, kind: "edit" | "run", on: boolean): BotToolName[] {
  const edit = kind === "edit" ? on : canEdit(b);
  const run = kind === "run" ? on : canRun(b);
  return [...READ_TOOLS, ...(edit ? EDIT_TOOLS : []), ...(run ? RUN_TOOLS : [])];
}

/** The tree of who may hand work to whom, starting at the lead. `plain` gives text without styling. */
export function treeLines(team: TeamConfig, counts: Record<string, number> = {}, mark: (id: string) => string = () => ""): string[] {
  const out: string[] = [`Lead${mark(LEAD_ID)}`];
  const shown = new Set<string>([LEAD_ID]);
  const walk = (id: string, prefix: string) => {
    const kids = id === LEAD_ID ? team.lead.delegates : team.bots.find((b) => b.id === id)?.delegates ?? [];
    kids.forEach((kid, i) => {
      const last = i === kids.length - 1;
      const n = counts[`${id}>${kid}`];
      const seen = shown.has(kid);
      out.push(`${prefix}${last ? "└─▶ " : "├─▶ "}${botName(team, kid)}${seen ? " ↻" : mark(kid)}${n ? ` (${n} task${n === 1 ? "" : "s"})` : ""}`);
      if (!seen) {
        shown.add(kid);
        walk(kid, prefix + (last ? "    " : "│   "));
      }
    });
  };
  walk(LEAD_ID, "");
  // Bots nobody may hand work to
  const loose = team.bots.filter((b) => !shown.has(b.id));
  for (const b of loose) out.push(`${b.name}${mark(b.id)}  (not reachable)`);
  return out;
}
