// Start screen: Peri, a little frog, next to the app name, model/plan and folder.
// Clicking Peri plays a short animation: a fly buzzes in, Peri catches it and hops with joy.
import { bold, dim, mint, rgb } from "./style";

const PERI = [
  " ▟█▙   ▟█▙ ",
  "▐█▘▝███▘▝█▌",
  " ▜███████▛ ",
  "  ▀▘   ▝▀  ",
];

/** Rows of the start screen above Peri (the intro starts with an empty line). */
export const PERI_TOP = 1;
export const PERI_WIDTH = PERI[0].length;

/** Peri on the left, three lines of text beside it (like Claude Code's start screen). */
export function startScreen(lines: [string, string, string]): string {
  return PERI.map((art, i) => `${mint(art)}   ${lines[i] ?? ""}`.trimEnd()).join("\n");
}

export function startLines(o: { version: string; model: string; plan: string; folder: string }): [string, string, string] {
  return [`${bold("Peridot")} ${dim("v" + o.version)}`, `${o.model} ${dim("·")} ${o.plan}`, dim(o.folder)];
}

// ── Click animation ──
// Frames cover the empty row above Peri plus Peri's four rows, 13 columns wide, so the text to the
// right is never touched. Each frame is built on a blank grid: Peri's pose, then small extras.

const W = 13;
const H = 5;
type Paint = (s: string) => string;
type Cell = { ch: string; paint: Paint };
const tongue = rgb(240, 128, 150);
const heart = rgb(240, 128, 150);
const fly = dim;

const POSES: Record<string, string[]> = {
  idle: PERI,
  blink: [" ▟█▙   ▟█▙ ", "▐█▀▀███▀▀█▌", " ▜███████▛ ", "  ▀▘   ▝▀  "],
  // Squashed and wide, ready to jump
  crouch: [" ▟█▙   ▟█▙ ", "▐█▘▝███▘▝█▌", "▝▀▀▀▀▀▀▀▀▀▘"],
  // In the air, legs hanging
  jump: [" ▟█▙   ▟█▙ ", "▐█▘▝███▘▝█▌", " ▜███████▛ ", "  ▐▌   ▐▌  "],
  happy: [" ▟█▙   ▟█▙ ", "▐█▄▄███▄▄█▌", " ▜███████▛ ", "  ▀▘   ▝▀  "],
};

function grid(): Cell[][] {
  return Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: " ", paint: (s: string) => s })));
}

function put(g: Cell[][], row: number, col: number, text: string, paint: Paint) {
  [...text].forEach((ch, i) => {
    if (ch !== " " && g[row]?.[col + i]) g[row][col + i] = { ch, paint };
  });
}

/** `lift` raises Peri by that many rows; poses with fewer rows sit on the ground (bottom row). */
function frame(pose: keyof typeof POSES, extras: [number, number, string, Paint][] = [], lift = 0): string[] {
  const g = grid();
  const art = POSES[pose];
  const top = H - art.length - lift;
  art.forEach((line, i) => put(g, top + i, 0, line, mint));
  for (const [row, col, text, paint] of extras) put(g, row, col, text, paint);
  return g.map((r) => {
    // Join runs of the same colour so each row stays a short string
    let out = "";
    let run = "";
    let paint: Paint | null = null;
    for (const c of r) {
      if (paint && c.paint !== paint) { out += paint(run); run = ""; }
      paint = c.paint;
      run += c.ch;
    }
    return out + (paint ? paint(run) : "");
  });
}

/** The click animation as a list of frames (5 rows each) and how long each one stays. */
export function catchTheFly(): { rows: string[]; ms: number }[] {
  const f = (rows: string[], ms = 90) => ({ rows, ms });
  // The fly buzzes around above Peri's right eye, then drifts down in front of its mouth
  const buzz: [number, number][] = [[0, 12], [1, 11], [0, 12], [1, 12], [0, 11], [2, 12]];
  const frames = buzz.map(([r, c], i) => f(frame(i === 3 ? "blink" : "idle", [[r, c, "•", fly]]), 110));
  frames.push(
    f(frame("crouch", [[3, 12, "•", fly]]), 140),
    // The tongue shoots out from the mouth to the fly...
    f(frame("idle", [[3, 10, "━", tongue], [3, 12, "•", fly]]), 60),
    f(frame("idle", [[3, 10, "━━", tongue], [3, 12, "•", fly]]), 60),
    f(frame("idle", [[3, 10, "━━━", tongue]]), 90),
    // ...and back, with the fly stuck to it
    f(frame("idle", [[3, 10, "━", tongue], [3, 11, "•", fly]]), 70),
    f(frame("blink"), 160),
    // Gulp, then a happy hop
    f(frame("happy"), 200),
    f(frame("crouch"), 110),
    f(frame("jump", [], 1), 160),
    f(frame("jump", [[0, 5, "♥", heart]], 1), 220),
    f(frame("idle", [[0, 5, "♥", heart]]), 260),
    f(frame("happy", [[0, 6, "˙", heart]]), 200),
    f(frame("idle"), 0),
  );
  return frames;
}
