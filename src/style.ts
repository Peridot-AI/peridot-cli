const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

export const mint = sgr("38;2;111;211;183");
export const dim = sgr("2");
export const bold = sgr("1");
export const red = sgr("38;2;248;113;113");
export const amber = sgr("38;2;245;158;107");

/** One full-width line of a message you sent: "› text" on a slightly lighter background. */
export function bubbleLine(text: string, width: number): string {
  const plain = ` › ${text}`.padEnd(width);
  if (!color) return plain;
  return `\x1b[48;2;40;39;37m \x1b[38;2;111;211;183m›\x1b[39m${plain.slice(2)}\x1b[0m`;
}
