// The "thinking" indicator, the terminal version of the one on the website and in the desktop app:
// four mint dots that squeeze in a few times, and a random word whose grey text has a light
// highlight sweeping over it.

const WORDS = [
  "Boinging", "Splonking", "Zibbering", "Flibbering", "Wobbling", "Scrungling", "Plonking", "Bamboozling",
  "Zorpifying", "Glonking", "Blooping", "Schmooving", "Blorping", "Kerfuffling", "Doinking", "Sploinking",
  "Wiggling", "Goblinating", "Frolicking", "Gronking", "Blungling", "Snorfing", "Quibbling", "Doodling",
  "Honkling", "Burbulating", "Jibbering", "Splurgling", "Zonkifying", "Grumbling", "Flumping", "Schlorping",
  "Goobering", "Crinkling", "Yapping", "Shlorping", "Binglebonging", "Wombling", "Skrunkling", "Glorping",
  "Plimbling", "Boondoggling", "Scrimbloing", "Flonking", "Zoodleing", "Mleming", "Greebling", "Flooping",
  "Blibbering", "Crungulating", "Shmeegling", "Gobbling", "Zibzabbling", "Froobling", "Dinglebopping",
  "Borking", "Grimbloing", "Wunking", "Schmoobling", "Tromboning", "Glupulating", "Bananifying",
  "Crabalating", "Skedaddling", "Boingus-ing", "Flibberjabbering",
];

const TICK = 80; // ms per frame
const SWEEP = 2200; // ms for the highlight to cross the word, like on the website
const WORD_EVERY = 4000; // a new word only if the wait drags on

// Spread out, pulled in, spread out again: one quarter turn of the website animation
const DOTS = ["∷", "∷", "∷", "⠶", "⠶", "∷", "∷", "∷"];
const GREY = [111, 109, 102]; // #6f6d66
const LIGHT = [214, 212, 205]; // #d6d4cd
const MINT = "\x1b[38;2;111;211;183m";
const MINT_BRIGHT = "\x1b[38;2;212;243;234m";

const pick = (not?: string) => {
  let w = WORDS[Math.floor(Math.random() * WORDS.length)];
  while (w === not) w = WORDS[Math.floor(Math.random() * WORDS.length)];
  return w;
};

const rgb = (c: number[]) => `\x1b[38;2;${c.map(Math.round).join(";")}m`;

export function startThinking(out: NodeJS.WriteStream = process.stdout) {
  let word = pick();
  let wordSince = Date.now();
  const began = Date.now();
  let frame = 0;
  let stopped = false;

  const render = () => {
    const now = Date.now();
    if (now - wordSince > WORD_EVERY) { word = pick(word); wordSince = now; }

    const dot = DOTS[frame++ % DOTS.length];
    const text = `${word}...`;
    // The band moves left to right and starts and ends off the text, so the loop has no jump
    const p = -0.25 + (((now - began) % SWEEP) / SWEEP) * 1.5;
    let line = "";
    for (let i = 0; i < text.length; i++) {
      const near = Math.max(0, 1 - Math.abs(i / text.length - p) / 0.22);
      const k = near * near * (3 - 2 * near);
      line += rgb(GREY.map((g, j) => g + (LIGHT[j] - g) * k)) + text[i];
    }
    out.write(`\r\x1b[2K${dot === "⠶" ? MINT_BRIGHT : MINT}${dot}\x1b[0m \x1b[3m${line}\x1b[0m`);
  };

  out.write("\x1b[?25l");
  render();
  const timer = setInterval(render, TICK);

  return {
    /** Removes the indicator and brings the cursor back. Safe to call more than once. */
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      out.write("\r\x1b[2K\x1b[?25h");
    },
  };
}
