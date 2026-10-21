// Markdown for answers in the terminal, rendered while the text streams in.
//
// Lines are styled by how they start (headings, lists, quotes, rules), code blocks and tables a whole
// line at a time. Inside a line, text is written as soon as it arrives, except from an opening marker
// (`code`, **bold**, *italic*, [link](url)) until it is closed, so a style is never cut in half.
import { bold, dim, mint, rgb, italic, strike, underline } from "./style";

const code = rgb(232, 190, 150);
const RULE = "─".repeat(32);

/** Inline styles of one piece of text whose markers are all closed. */
export function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part, i) => {
      if (i % 2) return code(part.slice(1, -1));
      return part
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => underline(label) + dim(` (${url})`))
        .replace(/\*\*(?!\s)(.+?)\*\*/g, (_, t) => bold(t))
        .replace(/__(?!\s)(.+?)__/g, (_, t) => bold(t))
        .replace(/~~(?!\s)(.+?)~~/g, (_, t) => strike(t))
        .replace(/(^|[^\w*])\*(?![\s*])(.+?)\*(?!\*)/g, (_, pre, t) => pre + italic(t))
        .replace(/(^|[^\w_])_(?![\s_])(.+?)_(?![\w_])/g, (_, pre, t) => pre + italic(t));
    })
    .join("");
}

/** How much of `text` can be written now: everything before the first marker that is not closed yet. */
function stableEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const pair = text.slice(i, i + 2);
    const close = (marker: string, from: number) => text.indexOf(marker, from);
    if (c === "`") {
      const j = close("`", i + 1);
      if (j < 0) return i;
      i = j;
    } else if (pair === "**" || pair === "__" || pair === "~~") {
      const j = close(pair, i + 2);
      if (j < 0) return i;
      i = j + 1;
    } else if ((c === "*" || c === "_") && /\S/.test(text[i + 1] ?? "") && !/\w/.test(c === "_" ? text[i - 1] ?? "" : "")) {
      const j = close(c, i + 1);
      if (j < 0) return text[i + 1] === undefined ? i : i; // wait for the closing marker
      i = j;
    } else if ((c === "*" || c === "_" || c === "~") && i === text.length - 1) {
      return i; // could still become "**", "__" or "~~"
    } else if (c === "[") {
      const j = text.indexOf("]", i + 1);
      if (j < 0) return i;
      if (text[j + 1] === undefined) return i; // a "(" may follow
      if (text[j + 1] === "(") {
        const k = text.indexOf(")", j + 2);
        if (k < 0) return i;
        i = k;
      }
    }
  }
  return text.length;
}

type Kind = { prefix: string; start: number; style: (s: string) => string };

/** Block kind of a line from its start, or null while it could still be several things. */
function lineKind(line: string, complete: boolean): Kind | null {
  // Too short to tell yet: "#" may be a heading, "-" a list item or a rule, "- [" a checkbox…
  if (!complete && /^\s*(#{0,6}|[-*+_]+|\d{1,3}[.)]?|>|[`~]{1,2}|[-*+]\s+(\[[ xX]?\]?)?)?$/.test(line)) return null;
  let m: RegExpMatchArray | null;
  if ((m = line.match(/^(#{1,6})\s+/))) {
    const h = m[1].length;
    return { prefix: "", start: m[0].length, style: (s) => (h <= 2 ? bold(mint(s)) : bold(s)) };
  }
  if ((m = line.match(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?/))) {
    const box = m[2] ? (/x/i.test(m[2]) ? mint("✓") + " " : dim("○") + " ") : "";
    return { prefix: m[1] + mint("•") + " " + box, start: m[0].length, style: (s) => s };
  }
  if ((m = line.match(/^(\s*)(\d{1,3})([.)])\s+/))) return { prefix: m[1] + mint(m[2] + m[3]) + " ", start: m[0].length, style: (s) => s };
  if ((m = line.match(/^\s*>\s?/))) return { prefix: dim("│ "), start: m[0].length, style: (s) => dim(s) };
  return { prefix: "", start: 0, style: (s) => s };
}

const isRule = (line: string) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
const isFence = (line: string) => /^\s*(```|~~~)/.test(line);
const isTable = (line: string) => /^\s*\|.*\|\s*$/.test(line);

/** A whole table, with every column as wide as its widest cell. */
function renderTable(lines: string[]): string {
  const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  const isSep = (r: string[]) => r.every((c) => /^:?-{1,}:?$/.test(c));
  const shown = (c: string) => [...inline(c).replace(/\x1b\[[0-9;]*m/g, "")].length;
  const widths: number[] = [];
  for (const r of rows) if (!isSep(r)) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, shown(c))));
  return rows
    .map((r, ri) =>
      isSep(r)
        ? dim(widths.map((w) => "─".repeat(w)).join("─┼─"))
        : widths.map((w, i) => {
            const c = r[i] ?? "";
            const text = ri === 0 ? bold(inline(c)) : inline(c);
            return text + " ".repeat(w - shown(c));
          }).join(dim(" │ ")).trimEnd(),
    )
    .join("\n");
}

export class MarkdownStream {
  private line = ""; // the line being received
  private kind: Kind | null = null;
  private sent = 0; // characters of `line` already written
  private inCode = false;
  private table: string[] = []; // rows of a table, shown together once it ends

  /** Feeds streamed text; returns what can be shown now. */
  push(text: string): string {
    let out = "";
    for (const ch of text) {
      if (ch === "\n") {
        const line = this.finishLine();
        if (line !== null) out += line + "\n";
        continue;
      }
      this.line += ch;
    }
    return out + this.partial();
  }

  /** The end of the answer: whatever is still held back. */
  end(): string {
    return ((this.line ? this.finishLine() : "") ?? "") + this.flushTable(false);
  }

  /** Writes a finished table; `more` tells whether a line follows it. */
  private flushTable(more: boolean): string {
    if (!this.table.length) return "";
    const t = renderTable(this.table);
    this.table = [];
    return t + (more ? "\n" : "");
  }

  /** Lines that are only shown once complete. */
  private wholeLineOnly() {
    return this.inCode || isFence(this.line) || /^\s*\|/.test(this.line) || isRule(this.line);
  }

  private partial(): string {
    if (!this.line || this.wholeLineOnly()) return "";
    let out = this.flushTable(true); // the table above ended where this line began
    if (!this.kind) {
      this.kind = lineKind(this.line, false);
      if (!this.kind) return "";
      out += this.kind.prefix;
      this.sent = this.kind.start;
    }
    const body = this.line.slice(this.kind.start);
    const upTo = this.kind.start + stableEnd(body);
    if (upTo > this.sent) {
      out += this.kind.style(inline(this.line.slice(this.sent, upTo)));
      this.sent = upTo;
    }
    return out;
  }

  /** Renders the line just completed, or returns null when it is held (a table row). */
  private finishLine(): string | null {
    const line = this.line;
    const kind = this.kind;
    const sent = this.sent;
    this.line = "";
    this.kind = null;
    this.sent = 0;

    if (!this.inCode && isTable(line)) {
      this.table.push(line);
      return null;
    }
    const before = this.flushTable(true);
    return before + this.renderLine(line, kind, sent);
  }

  private renderLine(line: string, kind: Kind | null, sent: number): string {
    if (this.inCode) {
      if (isFence(line)) { this.inCode = false; return dim("└"); }
      return dim("│ ") + code(line);
    }
    if (isFence(line)) {
      this.inCode = true;
      const lang = line.replace(/^\s*(```|~~~)/, "").trim();
      return dim("┌" + (lang ? " " + lang : ""));
    }
    if (kind) return kind.style(inline(line.slice(sent)));
    if (isRule(line)) return dim(RULE);
    const k = lineKind(line, true)!;
    return k.prefix + k.style(inline(line.slice(k.start)));
  }
}
