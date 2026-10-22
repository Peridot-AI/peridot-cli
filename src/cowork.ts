// Cowork: describe the outcome, the agent plans the work, does it and shows its progress. The agent keeps its
// plan up to date through the update_plan tool; here it is checked and drawn. Self-contained (the CLI is published
// on its own): a test keeps normalizePlan equal to the desktop app's copy in src/lib/cowork.ts.
import { bold, dim, mint } from "./style";

export type PlanStatus = "todo" | "doing" | "done";
export interface PlanStep {
  title: string;
  status: PlanStatus;
}

const STATUSES = new Set<string>(["todo", "doing", "done"]);
export const MAX_PLAN_STEPS = 12;

/** The steps of an update_plan call, made safe to show: no more than 12, titles cut, unknown status = todo */
export function normalizePlan(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: PlanStep[] = [];
  for (const s of raw.slice(0, MAX_PLAN_STEPS)) {
    if (!s || typeof s !== "object") continue;
    const title = typeof (s as any).title === "string" ? (s as any).title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (!title) continue;
    const status = String((s as any).status);
    steps.push({ title, status: STATUSES.has(status) ? (status as PlanStatus) : "todo" });
  }
  return steps;
}

/** The task is over: a step still shown as in progress was the last thing done */
export const finishPlan = (steps: PlanStep[]): PlanStep[] => steps.map((s) => (s.status === "doing" ? { ...s, status: "done" } : s));

export const planProgress = (steps: PlanStep[]) => ({ done: steps.filter((s) => s.status === "done").length, total: steps.length });

/** The plan as lines for the conversation: a header with the progress, then one line per step */
export function planLines(steps: PlanStep[], width = 80): string[] {
  const { done, total } = planProgress(steps);
  const cut = (t: string) => (t.length > width - 6 ? t.slice(0, Math.max(0, width - 7)) + "…" : t);
  return [
    `${mint("◆")} ${bold("Plan")} ${dim(`${done}/${total}`)}`,
    ...steps.map((s) =>
      s.status === "done" ? dim(`  ${mint("✓")} ${cut(s.title)}`) : s.status === "doing" ? `  ${mint("●")} ${bold(cut(s.title))}` : dim(`  ○ ${cut(s.title)}`)
    ),
  ];
}
