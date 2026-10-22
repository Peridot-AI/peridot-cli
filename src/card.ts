// Windows drawn over the conversation: a rounded box on the terminal's alternate screen. When one
// closes, the conversation underneath is back exactly as it was.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dim, bold } from "./style";

import { pauseMouse, resumeMouse } from "./mouse";

const w = (s: string) => process.stdout.write(s);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const vis = (s: string) => s.replace(ANSI, "").length;
export const cut = (t: string, n: number) => (t.length > n ? t.slice(0, Math.max(0, n - 1)) + "…" : t);

/** Shortens text that contains color codes to `n` visible characters. */
export function fit(s: string, n: number): string {
  if (vis(s) <= n) return s;
  let out = "", seen = 0;
  for (let i = 0; i < s.length && seen < n - 1; ) {
    const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    out += s[i++]; seen++;
  }
  return out + "…\x1b[0m";
}

export type Key = { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string };

/** Width of the box and of the text inside it. */
export function boxSize(wide = false) {
  const cols = process.stdout.columns || 80;
  const width = wide ? Math.max(24, cols - 2) : Math.max(24, Math.min(80, cols - 4));
  return { width, text: width - 4 };
}

/** A box with `body` lines (already styled, at most `text` visible characters each). */
export function renderBox(title: string, body: string[], footer: string, width: number): string[] {
  const inner = width - 2;
  const row = (s: string) => dim("│") + " " + s + " ".repeat(Math.max(0, inner - 2 - vis(s))) + " " + dim("│");
  const head = cut(title, inner - 4);
  return [
    dim("╭─ ") + bold(head) + " " + dim("─".repeat(Math.max(0, inner - head.length - 3)) + "╮"),
    row(""),
    ...body.map((l) => row(fit(l, inner - 2))),
    row(""),
    row(dim(cut(footer, inner - 2))),
    dim("╰" + "─".repeat(inner) + "╯"),
  ];
}

/**
 * Opens a window. `render` returns the box lines for the current size (`maxRows` is how many fit),
 * `onKey` handles keys and calls `done` to close. Esc and Ctrl+C always close with `cancelValue`.
 */
export function popup<T>(
  render: (size: { width: number; text: number; maxRows: number }) => string[],
  onKey: (key: Key, done: (value: T) => void, redraw: () => void, str?: string) => void,
  cancelValue: T,
  wide = false
): Promise<T> {
  return new Promise((resolve) => {
    const draw = () => {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      const { width, text } = boxSize(wide);
      const box = render({ width, text, maxRows: Math.max(3, rows - 6) });
      const top = Math.max(1, Math.floor((rows - box.length) / 2) + 1);
      const left = Math.max(1, Math.floor((cols - width) / 2) + 1);
      w("\x1b[2J" + box.map((line, i) => `\x1b[${top + i};${left}H${line}`).join(""));
    };

    // Take the keys away from the input while the window is open
    const saved = process.stdin.listeners("keypress") as ((...a: any[]) => void)[];
    saved.forEach((l) => process.stdin.off("keypress", l));
    pauseMouse(); // clicks would arrive as stray keys
    w("\x1b[?1049h\x1b[?25l"); // alternate screen, hide the cursor
    draw();

    const done = (value: T) => {
      process.stdin.off("keypress", handler);
      process.stdout.off("resize", draw);
      saved.forEach((l) => process.stdin.on("keypress", l));
      w("\x1b[?25h\x1b[?1049l"); // back to the conversation
      resumeMouse();
      resolve(value);
    };
    const handler = (str: string | undefined, key: Key) => {
      if (!key) return;
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return done(cancelValue);
      onKey(key, done, draw, str);
    };
    process.stdin.on("keypress", handler);
    process.stdout.on("resize", draw);
  });
}

/** Arrow-key menu. Resolves to the chosen index, or null when cancelled. */
/** `details` is shown above the choices (e.g. what an approval is about). */
export function select(title: string, items: { label: string; hint?: string }[], initial = 0, details: string[] = []): Promise<number | null> {
  let index = Math.min(Math.max(initial, 0), items.length - 1);
  return popup<number | null>(
    ({ width, text }) => {
      const body = items.map((it, i) => {
        const label = cut(it.label, text - 2);
        const room = text - 2 - label.length - 1;
        const hint = it.hint && room > 4 ? " " + dim(cut(it.hint, room)) : "";
        return i === index ? `\x1b[38;2;111;211;183m❯ ${label}\x1b[0m${hint}` : `  ${label}${hint}`;
      });
      return renderBox(title, details.length ? [...details, "", ...body] : body, "↑/↓ move · Enter select · Esc cancel", width);
    },
    (key, done, redraw) => {
      if (key.name === "up") { index = (index - 1 + items.length) % items.length; redraw(); }
      else if (key.name === "down") { index = (index + 1) % items.length; redraw(); }
      else if (key.name === "return") done(index);
    },
    null
  );
}

/** A read-only window with scrolling for content taller than the screen. */
export function showCard(title: string, lines: (text: number) => string[], onKey?: (key: Key) => boolean): Promise<void> {
  let offset = 0;
  let total = 0;
  let page = 1;
  return popup<void>(
    ({ width, text, maxRows }) => {
      const all = lines(text);
      total = all.length;
      page = maxRows;
      offset = Math.max(0, Math.min(offset, total - maxRows));
      const shown = all.slice(offset, offset + maxRows);
      const more = total > maxRows ? `↑/↓ scroll (${offset + 1}–${offset + shown.length} of ${total}) · ` : "";
      return renderBox(title, shown, `${more}Esc close`, width);
    },
    (key, done, redraw) => {
      const to = (n: number) => { offset = Math.max(0, Math.min(n, Math.max(0, total - page))); redraw(); };
      if (key.name === "up") to(offset - 1);
      else if (key.name === "down") to(offset + 1);
      else if (key.name === "pageup") to(offset - page);
      else if (key.name === "pagedown" || key.name === "space") to(offset + page);
      else if (key.name === "home") to(0);
      else if (key.name === "end") to(total);
      else if (key.name === "return" || key.name === "q") done();
      else if (onKey?.(key)) redraw(); // the caller changed what `lines` returns
    },
    undefined,
    true
  );
}

/** Window with check boxes: Space toggles, Enter confirms. Resolves to the new states, or null when cancelled. */
export function checklist(
  title: string,
  items: { label: string; hint?: string; checked: boolean }[],
  details: string[] = []
): Promise<boolean[] | null> {
  const state = items.map((i) => i.checked);
  let index = 0;
  return popup<boolean[] | null>(
    ({ width, text }) => {
      const body = items.map((it, i) => {
        const label = cut(`${state[i] ? "[x]" : "[ ]"} ${it.label}`, text - 2);
        const room = text - 2 - label.length - 1;
        const hint = it.hint && room > 4 ? " " + dim(cut(it.hint, room)) : "";
        return i === index ? `\x1b[38;2;111;211;183m❯ ${label}\x1b[0m${hint}` : `  ${label}${hint}`;
      });
      return renderBox(title, details.length ? [...details, "", ...body] : body, "↑/↓ move · Space toggle · Enter save · Esc cancel", width);
    },
    (key, done, redraw) => {
      if (key.name === "up") { index = (index - 1 + items.length) % items.length; redraw(); }
      else if (key.name === "down") { index = (index + 1) % items.length; redraw(); }
      else if (key.name === "space") { state[index] = !state[index]; redraw(); }
      else if (key.name === "return") done([...state]);
    },
    null
  );
}

/** One line of text to type. Resolves to the text (Enter), or null when cancelled (Esc). */
export function promptText(title: string, initial = "", details: string[] = [], max = 200): Promise<string | null> {
  let value = initial;
  let cur = value.length;
  return popup<string | null>(
    ({ width, text }) => {
      // The text wraps inside the window; a block marks the cursor
      const room = text - 2;
      const shown = value.slice(0, cur) + "█" + value.slice(cur);
      const rows: string[] = [];
      for (let i = 0; i < shown.length; i += room) rows.push(shown.slice(i, i + room));
      const body = [...details, ...(details.length ? [""] : []), ...(rows.length ? rows : ["█"])];
      return renderBox(title, body, `Enter save · Esc cancel${value.length > max * 0.9 ? ` · ${value.length}/${max}` : ""}`, width);
    },
    (key, done, redraw, str) => {
      if (key.name === "return") return done(value.trim());
      if (key.name === "backspace") { if (cur > 0) { value = value.slice(0, cur - 1) + value.slice(cur); cur--; } return redraw(); }
      if (key.name === "delete") { value = value.slice(0, cur) + value.slice(cur + 1); return redraw(); }
      if (key.name === "left") { cur = Math.max(0, cur - 1); return redraw(); }
      if (key.name === "right") { cur = Math.min(value.length, cur + 1); return redraw(); }
      if (key.name === "home" || (key.ctrl && key.name === "a")) { cur = 0; return redraw(); }
      if (key.name === "end" || (key.ctrl && key.name === "e")) { cur = value.length; return redraw(); }
      if (key.ctrl && key.name === "u") { value = value.slice(cur); cur = 0; return redraw(); }
      if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str) && value.length < max) {
        value = value.slice(0, cur) + str + value.slice(cur);
        cur += str.length;
        redraw();
      }
    },
    null
  );
}

/** Opens `text` in $VISUAL / $EDITOR and returns what was saved, or null when the editor failed. */
export function editInEditor(text: string, extension = "md"): string | null {
  const dir = mkdtempSync(join(tmpdir(), "peridot-"));
  const file = join(dir, `edit.${extension}`);
  writeFileSync(file, text);
  const editor = (process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi")).trim();
  const [cmd, ...args] = editor.split(/\s+/);

  // The editor owns the terminal while it runs
  const saved = process.stdin.listeners("keypress") as ((...a: any[]) => void)[];
  saved.forEach((l) => process.stdin.off("keypress", l));
  pauseMouse();
  process.stdin.pause();
  try { process.stdin.setRawMode(false); } catch {}
  w("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25h");
  let result: string | null = null;
  try {
    const run = spawnSync(cmd, [...args, file], { stdio: "inherit" });
    if (!run.error && run.status === 0) result = readFileSync(file, "utf8");
  } finally {
    w("\x1b[?1049l\x1b[?25h");
    try { process.stdin.setRawMode(true); } catch {}
    process.stdin.resume();
    saved.forEach((l) => process.stdin.on("keypress", l));
    resumeMouse();
    rmSync(dir, { recursive: true, force: true });
  }
  return result;
}
