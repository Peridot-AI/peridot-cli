// Builds the standalone binary with the version baked in (see src/version.ts).
// Usage: bun scripts/build.ts [linux|macos|windows]
import { fileURLToPath } from "node:url";
import { countCommits, formatVersion } from "../src/version";

const TARGETS: Record<string, { target: string; out: string }> = {
  linux: { target: "bun-linux-x64", out: "dist/peridot-linux" },
  macos: { target: "bun-darwin-arm64", out: "dist/peridot-macos" },
  windows: { target: "bun-windows-x64", out: "dist/peridot-windows.exe" },
};

const root = fileURLToPath(new URL("..", import.meta.url));
// scripts/release.ts in the main repo passes the count it published (it adds one for uncommitted changes)
const commits = Number(process.env.PERIDOT_VERSION_COMMITS) || countCommits(root);
if (!commits) {
  console.error("Could not count commits with git (is this a full clone?)");
  process.exit(1);
}

const which = process.argv[2];
const t = which ? TARGETS[which] : { target: "", out: "dist/peridot" };
if (!t) {
  console.error(`Unknown target "${which}". Use one of: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

const args = ["build", "--compile", ...(t.target ? [`--target=${t.target}`] : []), "--define", `PERIDOT_COMMITS=${commits}`, "src/index.ts", "--outfile", t.out];
console.log(`Peridot CLI ${formatVersion(commits)} (${commits} commits) -> ${t.out}`);
const res = Bun.spawnSync(["bun", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
process.exit(res.exitCode ?? 1);
