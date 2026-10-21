// Content of the /usage window.
import { dim, bold, mint, amber, color, rgb } from "./style";

type Daily = { date: string; totalTokens: number; inputTokens: number; outputTokens: number; requestCount: number };

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n || 0);
const requests = (n: number) => `${fmt(n)} ${n === 1 ? "request" : "requests"}`;

const bar = (pct: number, width: number) => {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return (pct >= 80 ? amber : mint)("█".repeat(filled)) + dim("░".repeat(width - filled));
};

// Same shades as the heatmap on the website: from an empty day to the most active one
const SHADES = [rgb(52, 52, 49), rgb(22, 57, 47), rgb(42, 107, 88), rgb(75, 168, 141), rgb(111, 211, 183)];
const PLAIN = ["·", "░", "▒", "▓", "█"];
// "Large" cells are two columns wide (a terminal cell is about twice as tall as wide, so they look
// square) with a one column gap. "Year" cells are a single column so all 53 weeks fit.
export type HeatView = "large" | "year";
// Every level has its own symbol, so the map reads the same with or without colours
const cell = (level: number, view: HeatView) => {
  const glyph = view === "large" ? PLAIN[level].repeat(2) : PLAIN[level];
  return color ? SHADES[level](glyph) : glyph;
};

const DAY = 86400000;

/** GitHub-style grid: one column per week (Sunday first), the last column ends today. */
function heatmap(daily: Daily[], space: number, labelWidth: number, view: HeatView) {
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weeksAll = 53;
  const start = end - (52 * 7 + new Date(end).getUTCDay()) * DAY;

  type Day = { tokens: number; future: boolean };
  const weeks: Day[][] = [];
  const starts: number[] = [];
  let max = 0, total = 0, input = 0, output = 0;
  for (let t = start; t <= end + (6 - new Date(end).getUTCDay()) * DAY; t += DAY) {
    const day = t <= end ? byDate.get(new Date(t).toISOString().slice(0, 10)) : undefined;
    const tokens = day?.totalTokens ?? 0;
    if (t <= end) { max = Math.max(max, tokens); total += tokens; input += day?.inputTokens ?? 0; output += day?.outputTokens ?? 0; }
    if (((t - start) / DAY) % 7 === 0) { weeks.push([]); starts.push(t); }
    weeks[weeks.length - 1].push({ tokens, future: t > end });
  }

  // Large cells need three columns per week, so narrow terminals show the most recent weeks only
  const pitch = view === "large" ? 3 : 1;
  const keep = Math.min(weeksAll, Math.max(8, Math.floor(space / pitch)));
  const from = weeks.length - keep;
  const shown = weeks.slice(from);
  const level = (n: number) => (n <= 0 || !max ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const firstShown = starts[from];
  total = 0; input = 0; output = 0;
  for (const d of daily) {
    const t = Date.parse(d.date + "T00:00:00Z");
    if (t >= firstShown && t <= end) { total += d.totalTokens; input += d.inputTokens; output += d.outputTokens; }
  }

  // Month names above the week where a month begins, skipping ones that would touch
  const monthRow = Array(keep * pitch).fill(" ");
  let lastLabel = -10;
  starts.slice(from).forEach((t, col) => {
    const d = new Date(t);
    const x = col * pitch;
    if (d.getUTCDate() > 7 || x - lastLabel < 4 || x + 3 > monthRow.length) return;
    d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).split("").forEach((c, i) => (monthRow[x + i] = c));
    lastLabel = x;
  });

  const pad = " ".repeat(labelWidth);
  const names: Record<number, string> = { 1: "Mon", 3: "Wed", 5: "Fri" };
  const rows = [dim(pad + monthRow.join(""))];
  for (let d = 0; d < 7; d++) {
    rows.push(dim((names[d] ?? "").padEnd(labelWidth)) + shown.map((wk) => (wk[d].future ? " ".repeat(pitch) : cell(level(wk[d].tokens), view) + (view === "large" ? " " : ""))).join(""));
  }
  return { rows, total, input, output, weeks: keep, all: keep === weeksAll };
}

export function usageLines(data: { user: any; stats: any; limits?: any }, text: number, view: HeatView): string[] {
  const { user, stats, limits } = data;
  const lines: string[] = [];
  const barWidth = Math.max(10, Math.min(24, text - 46));

  lines.push(dim(`${user.email} · ${limits?.plan ?? user.plan ?? "free"} plan`), "");

  if (limits?.unlimited) {
    lines.push(dim("Your account has no usage limits."), "");
  } else if (limits) {
    const reset = limits.monthlyResetsAt
      ? new Date(limits.monthlyResetsAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })
      : "";
    const dailyPct = limits.dailyLimit ? (limits.dailyUsed / limits.dailyLimit) * 100 : 0;
    lines.push(
      `Monthly allowance  ${bar(limits.monthlyPercent, barWidth)} ${limits.monthlyPercent}% used${reset ? dim(` · resets ${reset}`) : ""}`,
      `Messages today     ${bar(dailyPct, barWidth)} ${limits.dailyUsed} / ${limits.dailyLimit}${dim(" · resets at midnight UTC")}`,
      ""
    );
  }

  const map = heatmap(stats.daily ?? [], text - 4, 4, view);
  const period = map.all ? "in the last year" : `in the last ${map.weeks} weeks`;
  lines.push(`${bold(fmt(map.total))} tokens ${period} ${dim(`· input ${fmt(map.input)} · output ${fmt(map.output)}`)}`);
  lines.push(...map.rows);
  lines.push(`${" ".repeat(4)}${dim("Less")} ${[0, 1, 2, 3, 4].map((l) => cell(l, view)).join(" ")} ${dim("More")}${dim(view === "large" ? "     Tab: whole year" : "     Tab: larger cells")}`, "");

  lines.push(
    `Total        ${bold(fmt(stats.totalTokens))} tokens ${dim(`· ${requests(stats.requestCount)}`)}`,
    `  Input      ${fmt(stats.inputTokens)}`,
    `  Output     ${fmt(stats.outputTokens)}`,
    `Today        ${fmt(stats.today?.totalTokens)} tokens ${dim(`· ${requests(stats.today?.requestCount)}`)}`,
    `Last 7 days  ${fmt(stats.week?.totalTokens)} tokens ${dim(`· ${requests(stats.week?.requestCount)}`)}`
  );

  if (stats.byModel?.length) {
    lines.push("", bold("By model"));
    for (const m of stats.byModel) {
      const pct = stats.totalTokens ? Math.round((m.totalTokens / stats.totalTokens) * 100) : 0;
      const name = (m.modelName as string).slice(0, 22).padEnd(22);
      lines.push(`  ${name} ${bar(pct, 12)} ${String(pct).padStart(3)}%  ${dim(fmt(m.totalTokens) + " tokens")}`);
    }
  }
  return lines;
}
