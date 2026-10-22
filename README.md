# Peridot CLI

[Peridot AI](https://peridot.ai) in your terminal. Start it and chat; everything else is a slash command.

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
| `/plugin [list\|search\|install\|uninstall\|installed]` | Browse plugins approved on peridot.ai and install them from GitHub into `~/.config/peridot/plugins` (shared with the desktop app). Their commands appear as `/name`, their tools are offered to the agent |
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

Environment: `PERIDOT_TOKEN` (use instead of the stored token), `PERIDOT_API_URL` (default `https://peridot.ai/api`), `PERIDOT_WEB_URL` (default `https://peridot.ai`).

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
