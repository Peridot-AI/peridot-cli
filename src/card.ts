// Windows drawn over the conversation: a rounded box on the terminal's alternate screen. When one
// closes, the conversation underneath is back exactly as it was.
import { dim, bold } from "./style";

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

export type Key = { name?: string; ctrl?: boolean; meta?: boolean };

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
  onKey: (key: Key, done: (value: T) => void, redraw: () => void) => void,
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
    w("\x1b[?1049h\x1b[?25l"); // alternate screen, hide the cursor
    draw();

    const done = (value: T) => {
      process.stdin.off("keypress", handler);
      process.stdout.off("resize", draw);
      saved.forEach((l) => process.stdin.on("keypress", l));
      w("\x1b[?25h\x1b[?1049l"); // back to the conversation
      resolve(value);
    };
    const handler = (_: string, key: Key) => {
      if (!key) return;
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return done(cancelValue);
      onKey(key, done, draw);
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
