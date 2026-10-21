// A copy of what is on the terminal screen, kept by reading everything ui.ts writes. Used while Peri
// is on screen: the mouse is ours then, so selecting text, highlighting it and copying it are done by
// us and need to know what each cell shows (and in which colours).
//
// It understands the sequences this app writes (cursor moves, erasing, colours, save/restore) and
// ignores the rest. Every character is taken as one column wide.

type Cell = { ch: string; sgr: string };
const blank = (): Cell => ({ ch: " ", sgr: "" });

export class Screen {
  private grid: Cell[][];
  private y = 0;
  private x = 0;
  private wrapNext = false;
  private saved: [number, number] = [0, 0];
  private sgr = ""; // colour sequences in effect since the last reset
  /** Rows that have scrolled off the top since the screen was cleared. */
  scrolled = 0;

  constructor(public rows: number, public cols: number) {
    this.grid = Array.from({ length: rows }, () => this.row());
  }

  private row() {
    return Array.from({ length: this.cols }, blank);
  }

  private newline() {
    if (this.y === this.rows - 1) {
      this.grid.shift();
      this.grid.push(this.row());
      this.scrolled++;
    } else this.y++;
  }

  private put(ch: string) {
    if (this.wrapNext) { this.x = 0; this.newline(); this.wrapNext = false; }
    this.grid[this.y][this.x] = { ch, sgr: this.sgr };
    if (this.x === this.cols - 1) this.wrapNext = true;
    else this.x++;
  }

  private csi(params: string, final: string, raw: string) {
    const nums = params.replace(/^\?/, "").split(";").map((v) => (v === "" ? 0 : Number(v)));
    const n = nums[0] || 1;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    switch (final) {
      case "A": this.y = clamp(this.y - n, this.rows - 1); this.wrapNext = false; break;
      case "B": this.y = clamp(this.y + n, this.rows - 1); this.wrapNext = false; break;
      case "G": this.x = clamp(n - 1, this.cols - 1); this.wrapNext = false; break;
      case "H": this.y = clamp((nums[0] || 1) - 1, this.rows - 1); this.x = clamp((nums[1] || 1) - 1, this.cols - 1); this.wrapNext = false; break;
      case "K":
        if (nums[0] === 2) this.grid[this.y] = this.row();
        else if (!nums[0]) for (let i = this.x; i < this.cols; i++) this.grid[this.y][i] = blank();
        break;
      case "J":
        if (nums[0] === 2) { this.grid = Array.from({ length: this.rows }, () => this.row()); this.scrolled = 0; }
        else if (!nums[0]) {
          for (let i = this.x; i < this.cols; i++) this.grid[this.y][i] = blank();
          for (let r = this.y + 1; r < this.rows; r++) this.grid[r] = this.row();
        }
        break;
      case "m":
        if (params === "" || params === "0") this.sgr = "";
        else this.sgr += raw;
        break;
    }
  }

  feed(data: string) {
    for (let i = 0; i < data.length; ) {
      const c = data[i];
      if (c === "\x1b") {
        const rest = data.slice(i, i + 40);
        let m = rest.match(/^\x1b\[([?0-9;]*)([A-Za-z])/);
        if (m) { this.csi(m[1], m[2], m[0]); i += m[0].length; continue; }
        if (rest.startsWith("\x1b7")) { this.saved = [this.y, this.x]; i += 2; continue; }
        if (rest.startsWith("\x1b8")) { [this.y, this.x] = this.saved; this.wrapNext = false; i += 2; continue; }
        if (data[i + 1] === "]") { const end = data.indexOf("\x07", i); i = end < 0 ? data.length : end + 1; continue; }
        i += 2;
        continue;
      }
      if (c === "\r") { this.x = 0; this.wrapNext = false; }
      else if (c === "\n") { this.newline(); this.wrapNext = false; }
      else if (c >= " ") {
        const ch = String.fromCodePoint(data.codePointAt(i)!);
        this.put(ch);
        i += ch.length;
        continue;
      }
      i++;
    }
  }

  /** Plain text of row y (1-based). */
  text(y: number): string {
    return (this.grid[y - 1] ?? []).map((c) => c.ch).join("");
  }

  /** Row y as it was drawn, with columns [from, to) in reverse video. */
  styled(y: number, from = 0, to = 0): string {
    let out = "";
    let prev: string | null = null;
    (this.grid[y - 1] ?? []).forEach((c, i) => {
      const sel = i >= from && i < to;
      const sgr = sel ? "\x1b[7m" : c.sgr;
      if (sgr !== prev) { out += "\x1b[0m" + sgr; prev = sgr; }
      out += c.ch;
    });
    return out + "\x1b[0m";
  }
}
