// Start screen: Peri, a little cut peridot with two eyes, next to the app name, model/plan and folder.
import { bold, dim, rgb } from "./style";

// Three rows, lighter at the crown and darker at the point, like light through the stone
const crown = rgb(168, 235, 207);
const girdle = rgb(111, 211, 183);
const point = rgb(58, 150, 122);
const sparkle = rgb(245, 222, 140);

const PERI = [
  crown(" ▗▟██████▙▖") + " " + sparkle("˖"),
  girdle(" ▝██ ██ ██▘") + "  ",
  point("   ▝▜██▛▘  ") + "  ",
];

/** Peri on the left, three lines of text on the right (like Claude Code's start screen). */
export function startScreen(lines: [string, string, string]): string {
  const gap = "   ";
  return PERI.map((art, i) => art + gap + lines[i]).join("\n");
}

export function startLines(o: { version: string; model: string; plan: string; folder: string }): [string, string, string] {
  return [`${bold("Peridot")} ${dim("v" + o.version)}`, `${o.model} ${dim("·")} ${o.plan}`, dim(o.folder)];
}
