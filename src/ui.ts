// Terminal layout: the conversation scrolls normally above, and a fixed input area sits at the
// bottom of the output:
//
//   <output row>       where text is appended (this is also where the thinking animation lives)
//   ──────────────     rule
//   › your message     input row — the cursor lives here while you type
//   ──────────────     rule
//   status             account on the left, model on the right
//
// Output is written by erasing the input area, printing, and drawing it again below the new text,
// so everything still ends up in the terminal's own scrollback.
import { emitKeypressEvents } from "node:readline";
import { dim, mint, bubbleLine } from "./style";
import { fit, vis } from "./card";

const w = (s: string) => process.stdout.write(s);
const cols = () => Math.max(20, process.stdout.columns || 80);
const rowsN = () => process.stdout.rows || 24;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

let outCol = 0; // characters already on the output row
let buf = "";
let cur = 0;
let busy = false;
let started = false;
let hint = "";
let chromeW = 0; // terminal width the input area was last drawn for
const lines: string[] = [];
let histIdx = -1;
let draft = "";
let status = { left: "", right: "" };

type Handlers = {
  onSubmit: (line: string) => void | Promise<void>;
  /** Commands that start with the typed text (for Tab and the hint under the input) */
  complete: (text: string) => string[];
  /** Ctrl+C. `hasInput` tells whether there is text in the input */
  onInterrupt: (hasInput: boolean) => void;
  /** Shift+Tab */
  onCycle: () => void;
  /** A left click on the start screen (1-based column and row). Only while nothing else was printed. */
  onClick?: (x: number, y: number) => void;
  /** The start screen scrolled away (first output); anything drawn on it must stop. */
  onStartGone?: () => void;
};
let handlers: Handlers;

// ── Mouse (start screen only) ──
// Mouse reporting takes over the wheel and plain text selection, so it is on only while the start
// screen is untouched; the first output turns it off for good.
let mouse = false;
let mouseSeq: string | null = null; // the rest of an "ESC [ <" report while it arrives key by key

function setMouse(on: boolean) {
  if (on === mouse) return;
  mouse = on;
  w(on ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");
}
/** Also used on exit, so a crash never leaves the terminal reporting the mouse. */
export const mouseOff = () => setMouse(false);

function leaveStartScreen() {
  if (!mouse) return;
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
  if (ch === "M" && button === 0) handlers.onClick?.(x, y);
  return true;
}

/** Draws rows at a fixed place on screen (1-based) and puts the cursor back. */
export function drawAt(row: number, col: number, rows: string[]) {
  if (!started) return;
  w("\x1b7" + rows.map((r, i) => `\x1b[${row + i};${col}H${r}`).join("") + "\x1b8");
}

function trackCol(text: string) {
  const W = cols();
  for (const ch of text.replace(ANSI, "")) {
    if (ch === "\n" || ch === "\r") outCol = 0;
    else {
      if (outCol >= W) outCol = 0;
      outCol++;
    }
  }
}

function view() {
  const avail = cols() - 4;
  const start = Math.max(0, cur - (avail - 1));
  return { text: buf.slice(start, start + avail), start };
}
const inputCol = () => 3 + cur - view().start;

/** `status.left` may carry its own colors; the typed-command hint replaces it while you type. */
function statusRow() {
  const W = cols();
  const right = status.right;
  const left = fit(hint ? dim(hint) : status.left, Math.max(0, W - right.length - 3));
  const gap = Math.max(1, W - vis(left) - right.length - 1);
  return " " + left + " ".repeat(gap) + dim(right);
}

/** The rest of the command you are typing, e.g. "age" for "/us" (shown in grey, Tab accepts it). */
function suggestion() {
  if (!buf.startsWith("/") || buf.includes(" ") || cur !== buf.length) return "";
  const hit = handlers.complete(buf).find((c) => c.length > buf.length);
  return hit ? hit.slice(buf.length) : "";
}

function inputRow() {
  const { text } = view();
  if (!text) return `${mint("›")} ${dim('Try "/help" or just ask something')}`;
  const room = cols() - 4 - text.length;
  return `${mint("›")} ${text}${room > 0 ? dim(suggestion().slice(0, room)) : ""}`;
}

/** Draws the input area below the output row. The cursor must be on the output row. */
function writeChrome() {
  chromeW = cols();
  const rule = dim("─".repeat(cols()));
  w(`\r\n${rule}\r\n\x1b[2K${inputRow()}\r\n${rule}\r\n\x1b[2K${statusRow()}\x1b[2A\x1b[${inputCol()}G`);
}

const toOutput = () => w(`\x1b[2A\x1b[${outCol + 1}G`);

/** Appends text to the conversation. */
export function out(text: string) {
  if (!started) return void w(crlf(text));
  leaveStartScreen();
  const t = crlf(text);
  toOutput();
  w("\x1b[0J" + t);
  trackCol(t);
  if (outCol >= cols()) { w("\r\n"); outCol = 0; }
  writeChrome();
}

export const print = (...parts: unknown[]) => out(parts.join(" ") + "\n");

/** Replaces the content of the output row (used by the thinking animation). */
export function setLine(line: string) {
  if (!started) return;
  w(`\x1b[2A\r\x1b[2K${line}\x1b[2B\x1b[${inputCol()}G`);
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

function updateHint() {
  const next =
    buf.startsWith("/") && !buf.includes(" ") ? handlers.complete(buf).join("  ") : "";
  if (next === hint) return;
  hint = next;
  w(`\x1b[2B\r\x1b[2K${statusRow()}\x1b[2A\x1b[${inputCol()}G`);
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
  redrawInput();
  updateHint();
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
  redrawInput();
  updateHint();
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
  redrawInput();
  updateHint();
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
  redrawInput();
  updateHint();
  if (line) await handlers.onSubmit(line);
}

function onKey(str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string; code?: string } | undefined) {
  if (!key) return;
  if (mouseKey(str, key)) return;
  if (key.ctrl && key.name === "c") return handlers.onInterrupt(buf.length > 0);
  if (busy) return;
  const word = key.ctrl || key.meta;

  switch (key.name) {
    case "return": return void submit();
    case "tab": return key.shift ? handlers.onCycle() : tab();
    case "backspace": return cur > 0 ? edit(buf.slice(0, cur - 1) + buf.slice(cur), cur - 1) : undefined;
    case "delete": return edit(buf.slice(0, cur) + buf.slice(cur + 1), cur);
    case "left": return void ((cur = word ? wordLeft() : Math.max(0, cur - 1)), redrawInput());
    case "right":
      if (cur === buf.length && acceptSuggestion()) return;
      return void ((cur = word ? wordRight() : Math.min(buf.length, cur + 1)), redrawInput());
    case "home": return void ((cur = 0), redrawInput());
    case "end": return void ((cur = buf.length), redrawInput());
    case "up": return recall(-1);
    case "down": return recall(1);
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
  const W = cols();
  // The terminal re-wrapped what was on screen: the old full-width rule now takes several rows
  const ruleRows = Math.max(1, Math.ceil(chromeW / W));
  outCol = Math.min(outCol, W - 1);
  w(`\x1b[${ruleRows + 1}A\x1b[${outCol + 1}G\x1b[0J`); // erase the old input area
  w(`\x1b[${Math.max(1, rowsN() - 4)};${outCol + 1}H`); // output row, right above the bottom of the screen
  writeChrome();
}

/** Clears the screen, prints `intro`, and shows the input area at the bottom. */
export function begin(intro: string, h: Handlers) {
  handlers = h;
  started = true;
  const t = crlf(intro);
  w("\x1b[2J\x1b[H" + t);
  trackCol(t);
  const used = intro.replace(ANSI, "").split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cols())), 0) - 1;
  const pad = rowsN() - 5 - used;
  if (pad > 0) w("\r\n".repeat(pad));
  writeChrome();
  // When the intro did not fit, it scrolled and its rows are no longer where we would draw
  if (h.onClick && pad >= 0) setMouse(true);

  process.stdin.setRawMode(true);
  emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", onKey);
  process.stdin.resume();
  process.stdout.on("resize", relayout);
}

/** Removes the input area and prints a last line. */
export function end(message = "") {
  if (!started) return;
  setMouse(false);
  started = false;
  toOutput();
  w("\x1b[0J" + (message ? crlf(message) + "\r\n" : "") + "\x1b[?25h");
  try { process.stdin.setRawMode(false); } catch {}
}
