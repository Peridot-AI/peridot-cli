// Mouse reporting on/off, shared by the input area (ui.ts) and full-screen windows (card.ts), which
// pause it so clicks never reach them as stray keys.
const ON = "\x1b[?1002h\x1b[?1006h"; // 1002: presses, releases and drags; 1006: readable coordinates
const OFF = "\x1b[?1002l\x1b[?1006l";
const write = (s: string) => process.stdout.write(s);

let on = false;
let paused = 0;

export function setMouse(value: boolean) {
  if (value === on) return;
  on = value;
  if (!paused) write(value ? ON : OFF);
}

export const mouseIsOn = () => on;

export function pauseMouse() {
  if (paused++ === 0 && on) write(OFF);
}

export function resumeMouse() {
  if (--paused === 0 && on) write(ON);
}
