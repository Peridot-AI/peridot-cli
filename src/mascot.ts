// Start screen: Peri, a little frog, next to the app name, model/plan and folder.
import { bold, dim, mint } from "./style";

const PERI = [
  " ▟█▙   ▟█▙ ",
  "▐█▘▝███▘▝█▌",
  " ▜███████▛ ",
  "  ▀▘   ▝▀  ",
];

/** Peri on the left, three lines of text beside it (like Claude Code's start screen). */
export function startScreen(lines: [string, string, string]): string {
  return PERI.map((art, i) => `${mint(art)}   ${lines[i] ?? ""}`.trimEnd()).join("\n");
}

export function startLines(o: { version: string; model: string; plan: string; folder: string }): [string, string, string] {
  return [`${bold("Peridot")} ${dim("v" + o.version)}`, `${o.model} ${dim("·")} ${o.plan}`, dim(o.folder)];
}
