// Terminal layout: the conversation scrolls normally above, and a fixed input area sits at the
// bottom of the screen:
//
//   <output row>       where text is appended (this is also where the thinking animation lives)
//   (empty rows)       while the conversation is shorter than the screen, so the input stays at the bottom
//   ──────────────     rule
//   › your message     input row — the cursor lives here while you type
//   ──────────────     rule
//   status             account on the left, model on the right
//
// Output is written by erasing the input area, printing, and drawing it again below the new text,
// so everything still ends up in the terminal's own scrollback.
import { emitKeypressEvents } from "node:readline";
import { spawn } from "node:child_process";
import { dim, mint, bold, bubbleLine } from "./style";
import { fit, vis, cut } from "./card";
import { Screen } from "./screen";
import { setMouse, mouseIsOn } from "./mouse";

// While Peri is on screen the mouse is ours, and `screen` keeps a copy of everything written, so we
// can select and copy text ourselves (see screen.ts)
let screen: Screen | null = null;
let mouseRows = 0; // intro rows that must stay on screen for the mouse to stay ours
const w = (s: string) => {
  process.stdout.write(s);
  if (!screen) return;
  screen.feed(s);
  if (screen.scrolled >= mouseRows) stopMouse();
};
const cols = () => Math.max(20, process.stdout.columns || 80);
const rowsN = () => process.stdout.rows || 24;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

let outCol = 0; // characters already on the output row
let buf = "";
let cur = 0;
let busy = false;
let started = false;
// Command menu shown above the input while typing "/…"
type MenuItem = { name: string; desc: string };
const MENU_MAX = 6;
let menu: MenuItem[] = [];
let menuSel = 0;
let menuShown = 0; // menu rows currently on screen, between the output row and the input
let gapShown = 0; // empty rows between the output row and the menu / input area
let outRow = 1; // screen row of the output row (1-based)
let chromeW = 0; // terminal width the input area was last drawn for
const lines: string[] = [];
let histIdx = -1;
let draft = "";
let status = { left: "", right: "" };

type Handlers = {
  onSubmit: (line: string) => void | Promise<void>;
  /** Commands matching the typed text, for the menu above the input */
  commands: (text: string) => MenuItem[];
  /** Ctrl+C. `hasInput` tells whether there is text in the input */
  onInterrupt: (hasInput: boolean) => void;
  /** Shift+Tab */
  onCycle: () => void;
  /** A left click on the start screen. `y` counts rows of the intro (1 = its first row), wherever it scrolled to. */
  onClick?: (x: number, y: number) => void;
  /** Intro rows that must stay visible for clicks to work (Peri's rows) */
  mouseRows?: number;
  /** Peri scrolled off the screen; anything drawn on it must stop. */
  onStartGone?: () => void;
};
let handlers: Handlers;

// ── Mouse (while Peri is on screen) ──
// Mouse reporting takes over the wheel and the terminal's own text selection, so it is on only while
// Peri can still be clicked. Once Peri scrolls away (or the window is resized), the terminal gets the
// mouse back for good. Until then we select and copy text ourselves.
let mouseSeq: string | null = null; // the rest of an "ESC [ <" report while it arrives key by key

/** Also used on exit, so a crash never leaves the terminal reporting the mouse. */
export const mouseOff = () => setMouse(false);

function stopMouse() {
  if (!screen) return;
  screen = null;
  sel = null;
  setMouse(false);
  handlers.onStartGone?.();
}

/** Mouse reports reach us as ordinary keys ("ESC [ <", "0", ";", "5", …, "M"). Returns true when it ate the key. */
function mouseKey(str: string | undefined, key: { sequence?: string; code?: string }) {
  if (key.code === "[<") { mouseSeq = ""; return true; }
  if (mouseSeq === null) return false;
  const ch = str ?? key.sequence ?? "";
  if (ch !== "M" && ch !== "m") { mouseSeq += ch; return true; }
  const [button, x, y] = mouseSeq.split(";").map(Number);
  mouseSeq = null;
  if (!screen || !mouseIsOn()) return true;
  if (ch === "M" && button === 0) sel = { x, y, x2: x, y2: y, moved: false };
  else if (ch === "M" && button === 32 && sel) {
    if (x !== sel.x2 || y !== sel.y2) { sel.x2 = x; sel.y2 = y; sel.moved = true; paintSelection(); }
  } else if (ch === "m" && sel) {
    const done = sel;
    sel = null;
    if (!done.moved) handlers.onClick?.(x, y + screen.scrolled);
    else {
      const text = selectedText(done);
      paintSelection();
      if (text) copyToClipboard(text);
    }
  }
  return true;
}

// ── Selecting and copying text ──
// Drag to highlight, release to copy. The highlight is drawn straight to the terminal (not into
// `screen`), and rows are put back from `screen` with their own colours.
type Selection = { x: number; y: number; x2: number; y2: number; moved: boolean };
let sel: Selection | null = null;
let highlighted = new Set<number>();
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

/** Columns [from, to) of screen row y (1-based) that the selection covers, or null. */
function range(s: Selection, y: number): [number, number] | null {
  const [a, b] = s.y < s.y2 || (s.y === s.y2 && s.x <= s.x2) ? [[s.x, s.y], [s.x2, s.y2]] : [[s.x2, s.y2], [s.x, s.y]];
  if (y < a[1] || y > b[1]) return null;
  return [y === a[1] ? a[0] - 1 : 0, y === b[1] ? b[0] : cols()];
}

function selectedText(s: Selection) {
  if (!screen) return "";
  const out: string[] = [];
  for (let y = 1; y <= screen.rows; y++) {
    const r = range(s, y);
    if (r) out.push([...screen.text(y)].slice(r[0], r[1]).join("").trimEnd());
  }
  return out.join("\n").replace(/^\n+|\n+$/g, "");
}

/** Draws the current selection in reverse video, and puts back rows that are no longer selected. */
function paintSelection() {
  if (!screen) return;
  const next = new Set<number>();
  let draw = "";
  for (let y = 1; y <= screen.rows; y++) {
    const r = sel ? range(sel, y) : null;
    if (r) next.add(y);
    if (r || highlighted.has(y)) draw += `\x1b[${y};1H${screen.styled(y, r?.[0] ?? 0, r?.[1] ?? 0)}`;
  }
  highlighted = next;
  if (draw) process.stdout.write("\x1b7" + draw + "\x1b8");
}

function copyToClipboard(text: string) {
  // OSC 52 asks the terminal itself (works over SSH too); the system tool covers terminals without it
  w(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  const tool =
    process.platform === "darwin" ? ["pbcopy"]
    : process.platform === "win32" ? ["clip"]
    : process.env.WAYLAND_DISPLAY ? ["wl-copy"]
    : ["xclip", "-selection", "clipboard"];
  try {
    const p = spawn(tool[0], tool.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
    p.on("error", () => {});
    p.stdin.on("error", () => {});
    p.stdin.end(text);
  } catch {}
  const n = [...text].length;
  showCopied(`copied ${n} ${n === 1 ? "char" : "chars"} to clipboard`);
}

/** A short note at the right end of the row above the input. */
function showCopied(note: string) {
  const col = Math.max(1, cols() - note.length);
  const at = (s: string) => w(`\x1b7\x1b[${2 + menuShown}A\x1b[${col}G${s}\x1b8`);
  if (copiedTimer) clearTimeout(copiedTimer);
  at(mint(note));
  copiedTimer = setTimeout(() => { copiedTimer = null; at(" ".repeat(note.length)); }, 2500);
}

/** Draws rows at a place given in intro rows (1-based), following the intro as it scrolls. */
export function drawAt(row: number, col: number, rows: string[]) {
  if (!started || !screen) return;
  const top = row - screen.scrolled;
  const draw = rows.map((r, i) => (top + i >= 1 ? `\x1b[${top + i};${col}H${r}` : "")).join("");
  if (draw) w("\x1b7" + draw + "\x1b8");
}

/** Follows the cursor through `text` written on the output row: its column, and the rows it moved down. */
function track(text: string) {
  const W = cols();
  let down = 0;
  for (const ch of text.replace(ANSI, "")) {
    if (ch === "\n") { outCol = 0; down++; }
    else if (ch === "\r") outCol = 0;
    else {
      if (outCol >= W) { outCol = 0; down++; }
      outCol++;
    }
  }
  outRow = Math.min(outRow + down, rowsN());
}

function view() {
  const avail = cols() - 4;
  const start = Math.max(0, cur - (avail - 1));
  return { text: buf.slice(start, start + avail), start };
}
const inputCol = () => 3 + cur - view().start;

/** `status.left` may carry its own colors. */
function statusRow() {
  const W = cols();
  const right = status.right;
  const left = fit(status.left, Math.max(0, W - right.length - 3));
  const gap = Math.max(1, W - vis(left) - right.length - 1);
  return " " + left + " ".repeat(gap) + dim(right);
}

/** The rest of the command you are typing, e.g. "age" for "/us" (shown in grey, Tab accepts it). */
function suggestion() {
  if (!buf.startsWith("/") || buf.includes(" ") || cur !== buf.length) return "";
  const hit = menu[menuSel]?.name;
  return hit && hit.startsWith(buf) && hit.length > buf.length ? hit.slice(buf.length) : "";
}

/** The visible part of the menu: up to MENU_MAX rows around the selected command. */
function menuLines(): string[] {
  if (!menu.length) return [];
  const W = cols();
  const top = Math.max(0, Math.min(menuSel - MENU_MAX + 1, menu.length - MENU_MAX));
  const nameW = Math.min(24, Math.max(...menu.map((m) => m.name.length)) + 4);
  return menu.slice(top, top + MENU_MAX).map((m, i) => {
    const selected = top + i === menuSel;
    const name = "  " + m.name.padEnd(nameW);
    const desc = cut(m.desc, Math.max(0, W - name.length - 2));
    return selected ? bold(mint(name)) + mint(desc) : dim(name + desc);
  });
}

/** Recomputes the menu for what is typed and redraws the input area when it changed. */
function refreshMenu(force = false) {
  const items = buf.startsWith("/") && !buf.includes(" ") && !busy ? handlers.commands(buf) : [];
  const same = items.length === menu.length && items.every((m, i) => m.name === menu[i].name);
  if (!same) menuSel = 0;
  menu = items;
  if (!same || force) {
    toOutput();
    w("\x1b[0J");
    writeChrome();
  } else redrawInput();
}

function inputRow() {
  const { text } = view();
  if (!text) return `${mint("›")} ${dim('Try "/help" or just ask something')}`;
  const room = cols() - 4 - text.length;
  return `${mint("›")} ${text}${room > 0 ? dim(suggestion().slice(0, room)) : ""}`;
}

/** Draws the input area at the bottom of the screen, below the output row. The cursor must be on the output row. */
function writeChrome() {
  chromeW = cols();
  const rule = dim("─".repeat(cols()));
  const lines = menuLines();
  menuShown = lines.length;
  // Empty rows down to the input area; once the conversation fills the screen there are none and
  // writing the input area scrolls the conversation up instead
  const height = menuShown + 4;
  gapShown = Math.max(0, rowsN() - height - outRow);
  outRow = Math.min(outRow, rowsN() - height);
  w(`${"\r\n\x1b[2K".repeat(gapShown)}${lines.map((l) => `\r\n\x1b[2K${l}`).join("")}\r\n${rule}\r\n\x1b[2K${inputRow()}\r\n${rule}\r\n\x1b[2K${statusRow()}\x1b[2A\x1b[${inputCol()}G`);
}

/** Rows from the input row up to the output row */
const aboveInput = () => 2 + menuShown + gapShown;
const toOutput = () => w(`\x1b[${aboveInput()}A\x1b[${outCol + 1}G`);

/** Appends text to the conversation. */
export function out(text: string) {
  if (!started) return void w(crlf(text));
  // The note sits on the output row, which this text is about to fill
  if (copiedTimer) { clearTimeout(copiedTimer); copiedTimer = null; }
  const t = crlf(text);
  toOutput();
  w("\x1b[0J" + t);
  track(t);
  if (outCol >= cols()) { w("\r\n"); outCol = 0; outRow = Math.min(outRow + 1, rowsN()); }
  writeChrome();
}

export const print = (...parts: unknown[]) => out(parts.join(" ") + "\n");

/** Replaces the content of the output row (used by the thinking animation). */
export function setLine(line: string) {
  if (!started) return;
  w(`\x1b[${aboveInput()}A\r\x1b[2K${line}\x1b[${aboveInput()}B\x1b[${inputCol()}G`);
  outCol = 0;
}

/** A message you sent, shown on a slightly lighter background across the full width. */
export function userBubble(text: string) {
  const W = cols();
  const width = W - 4;
  const rows: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) rows.push("");
    for (let i = 0; i < para.length; i += width) rows.push(para.slice(i, i + width));
  }
  return rows.map((r) => bubbleLine(r, W)).join("\n");
}

function redrawInput() {
  w(`\r\x1b[2K${inputRow()}\x1b[${inputCol()}G`);
}


export function setStatus(left: string, right: string) {
  status = { left, right };
  if (!started) return;
  w(`\x1b[2B\r\x1b[2K${statusRow()}\x1b[2A\x1b[${inputCol()}G`);
}

export function setBusy(value: boolean) {
  busy = value;
  if (started) w(value ? "\x1b[?25l" : "\x1b[?25h");
}

export const hasInput = () => buf.length > 0;
export function clearInput() {
  buf = "";
  cur = 0;
  histIdx = -1;
  refreshMenu();
}

// ── Keys ──
const isWord = (c: string) => /\w/.test(c);
function wordLeft() {
  let i = cur;
  while (i > 0 && !isWord(buf[i - 1])) i--;
  while (i > 0 && isWord(buf[i - 1])) i--;
  return i;
}
function wordRight() {
  let i = cur;
  while (i < buf.length && !isWord(buf[i])) i++;
  while (i < buf.length && isWord(buf[i])) i++;
  return i;
}

function edit(next: string, nextCur: number) {
  buf = next;
  cur = Math.max(0, Math.min(nextCur, next.length));
  histIdx = -1;
  refreshMenu();
}

function recall(delta: number) {
  if (!lines.length) return;
  if (histIdx === -1) {
    if (delta > 0) return;
    draft = buf;
    histIdx = lines.length;
  }
  histIdx = Math.max(0, Math.min(lines.length, histIdx + delta));
  buf = histIdx === lines.length ? draft : lines[histIdx];
  if (histIdx === lines.length) histIdx = -1;
  cur = buf.length;
  refreshMenu();
}

/** Accepts the grey suggestion. Returns false when there is none. */
function acceptSuggestion() {
  const rest = suggestion();
  if (!rest) return false;
  edit(buf + rest + " ", buf.length + rest.length + 1);
  return true;
}

function tab() {
  acceptSuggestion();
}

async function submit() {
  const line = buf.trim();
  if (line) lines.push(line);
  buf = "";
  cur = 0;
  histIdx = -1;
  refreshMenu();
  if (line) await handlers.onSubmit(line);
}

function onKey(str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string; code?: string } | undefined) {
  if (!key) return;
  if (mouseKey(str, key)) return;
  if (key.ctrl && key.name === "c") return handlers.onInterrupt(buf.length > 0);
  if (busy) return;
  const word = key.ctrl || key.meta;

  switch (key.name) {
    case "return": {
      // Enter on the menu runs the highlighted command
      const pick = menu[menuSel]?.name;
      if (pick && pick !== buf.trim()) { buf = pick; cur = buf.length; }
      return void submit();
    }
    case "tab": return key.shift ? handlers.onCycle() : tab();
    case "backspace": return cur > 0 ? edit(buf.slice(0, cur - 1) + buf.slice(cur), cur - 1) : undefined;
    case "delete": return edit(buf.slice(0, cur) + buf.slice(cur + 1), cur);
    case "left": return void ((cur = word ? wordLeft() : Math.max(0, cur - 1)), redrawInput());
    case "right":
      if (cur === buf.length && acceptSuggestion()) return;
      return void ((cur = word ? wordRight() : Math.min(buf.length, cur + 1)), redrawInput());
    case "home": return void ((cur = 0), redrawInput());
    case "end": return void ((cur = buf.length), redrawInput());
    case "up":
      if (menu.length) { menuSel = (menuSel - 1 + menu.length) % menu.length; return refreshMenu(true); }
      return recall(-1);
    case "down":
      if (menu.length) { menuSel = (menuSel + 1) % menu.length; return refreshMenu(true); }
      return recall(1);
  }
  if (key.ctrl) {
    switch (key.name) {
      case "a": return void ((cur = 0), redrawInput());
      case "e": return void ((cur = buf.length), redrawInput());
      case "u": return edit(buf.slice(cur), 0);
      case "k": return edit(buf.slice(0, cur), cur);
      case "w": { const i = wordLeft(); return edit(buf.slice(0, i) + buf.slice(cur), i); }
      case "d": return buf ? undefined : handlers.onInterrupt(false);
    }
    return;
  }
  if (str && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) edit(buf.slice(0, cur) + str + buf.slice(cur), cur + str.length);
}

function relayout() {
  if (!started) return;
  stopMouse(); // the terminal re-wrapped the screen, so our copy of it no longer matches
  const W = cols();
  // The terminal re-wrapped what was on screen: the old full-width rule now takes several rows
  const ruleRows = Math.max(1, Math.ceil(chromeW / W));
  outCol = Math.min(outCol, W - 1);
  w(`\x1b[${ruleRows + 1 + menuShown + gapShown}A\x1b[${outCol + 1}G\x1b[0J`); // erase the old input area, back on the output row
  writeChrome();
}

/** Clears the screen and its scrollback, prints `intro` and the input area at the bottom. */
function drawStart(intro: string) {
  const t = crlf(intro);
  if (copiedTimer) { clearTimeout(copiedTimer); copiedTimer = null; }
  sel = null;
  highlighted = new Set();
  outCol = 0;
  if (handlers.onClick) {
    screen = new Screen(rowsN(), cols());
    mouseRows = handlers.mouseRows ?? 1;
    setMouse(true);
  }
  w("\x1b[2J\x1b[3J\x1b[H" + t);
  outRow = 1;
  track(t);
  // The conversation continues right under the intro; the input area waits at the bottom of the screen
  writeChrome();
}

/** Starts over on a clean screen showing `intro` (used by /clear and /resume). */
export function restart(intro: string) {
  if (started) drawStart(intro);
}

/** Clears the screen, prints `intro`, and shows the input area at the bottom. */
export function begin(intro: string, h: Handlers) {
  handlers = h;
  started = true;
  drawStart(intro);

  process.stdin.setRawMode(true);
  emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", onKey);
  process.stdin.resume();
  process.stdout.on("resize", relayout);
}

/** Removes the input area and prints a last line. */
export function end(message = "") {
  if (!started) return;
  stopMouse();
  started = false;
  toOutput();
  w("\x1b[0J" + (message ? crlf(message) + "\r\n" : "") + "\x1b[?25h");
  try { process.stdin.setRawMode(false); } catch {}
}
