# Peridot CLI

[Peridot AI](https://tryperidot.io) in your terminal. Start it and chat; everything else is a slash command.

The conversation scrolls above; the input sits at the bottom between two rules, with your account and the current model on the status line. Messages you send are shown on a slightly lighter background.

```
∷ Peridot v0.4.0
Type a message, or / for commands.

 › hello

∷ Hi! How can I help?

────────────────────────────────────────────
› Try "/help" or just ask something
────────────────────────────────────────────
 you@example.com                 Model · /help
```

| Command | |
|---|---|
| `/model [name\|number]` | Show or change the model |
| `/usage` | A window with plan limits, a token heatmap of the last year and usage per model (Tab switches between larger cells and the whole year) |
| `/login` | Sign in with **Email** (on the Peridot website) or **Google**, both in your browser |
| `/logout` · `/whoami` | Account |
| `/clear` | Start a new conversation |
| `/cowork [on\|off]` | **Cowork**: switch on, then describe the outcome and the agent plans the work, does it and shows its progress (the status line says `◆ cowork`) |
| `/team [add\|list\|graph\|show\|set\|access\|link\|unlink\|remove]` | **Your AI team**: bots the agent can hand work to (see below). Just `/team` opens windows to build and edit the team |
| `/plugin [list\|search\|install\|uninstall\|installed]` | Browse plugins approved on tryperidot.io and install them from GitHub into `~/.config/peridot/plugins` (shared with the desktop app). Their commands appear as `/name`, their tools are offered to the agent |
| `/help` | List commands |
| `/exit` | Quit |

`Ctrl+C` stops a response, Type `/` and the rest of the command appears in grey: `Tab` (or `→`) accepts it. `↑`/`↓` recall earlier messages. The token and the selected model are stored in `~/.config/peridot/config.json` (mode 0600).

## Working in your project

The folder you start `peridot` in is the **workspace**. When you are signed in, Peridot can list, read and search files there, create and edit them, and run shell commands, all confined to that folder (paths outside it, also through symlinks, are refused).

- **Manual approval** (default): before it writes a file, edits one or runs a command, a window shows exactly what it is about to do and asks. "Yes, and don't ask again" switches to auto approval.
- **Auto approval**: it does everything without asking. `Shift+Tab` cycles between the two modes (shown under the input).
- `!command` runs a shell command in the folder yourself, e.g. `!git status`.
- `Ctrl+C` stops the response and any command that is still running.

Without signing in, Peridot is chat only.

## Your AI team

Create bots for the project and the agent can hand self-contained parts of a job to them. Each bot works in parallel with its own context, prompt, model and tools (reading is always allowed; editing files and running commands are switched on per bot), and sends back a report. Edits and commands by a bot ask for approval like the agent's own, one window at a time, with the bot's name in the title.

```
/team                    windows: the lead, the bots, add a bot, the graph
/team add researcher     templates: researcher, reviewer, tester, writer (or any name for a blank bot)
/team access tester run on
/team link tester researcher
/team graph              who may hand work to whom, as a tree
```

The team is saved in `.peridot/team.json` of the project and shared with the desktop app. During a run the hand-offs show up in the conversation (`◆ Lead → Researcher: …`, the bot's tool calls with its name, and its report), and the status line says who is working. Hand-offs go at most two deep, a bot has 25 steps, and its report is cut at 8000 characters.

Environment: `PERIDOT_TOKEN` (use instead of the stored token), `PERIDOT_WEB_URL` (default `https://tryperidot.io`).

The API is always `https://api.tryperidot.io/api`. Only an argument changes it, for example to try a local server: `peridot --api http://localhost:3001/api`. (An environment variable can't, so one left in your shell never sends the CLI somewhere else.)

Sign-in opens your browser and listens on `127.0.0.1` for the result (Google uses port 53682). Nothing is sent anywhere else, and `Ctrl+C` cancels.

## Develop

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev        # watch mode
bun start          # run once
bun run build      # single binary in dist/peridot (then just run `peridot`)
bun run build:linux   # also :macos, :windows
```
