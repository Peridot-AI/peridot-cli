# Peridot CLI

[Peridot AI](https://peridot.ai) in your terminal. Start it and chat; everything else is a slash command.

```
$ peridot
◆ Peridot v0.2.0
not signed in · /login
model: default model · /help for commands

› hello
```

| Command | |
|---|---|
| `/model [name\|number]` | Show or change the model |
| `/usage` | Token usage and plan limits |
| `/login` · `/logout` · `/whoami` | Account |
| `/clear` | Start a new conversation |
| `/help` | List commands |
| `/exit` | Quit |

`Ctrl+C` stops a response, `Tab` completes commands. The token and the selected model are stored in `~/.config/peridot/config.json` (mode 0600).

Environment: `PERIDOT_TOKEN` (use instead of the stored token), `PERIDOT_API_URL` (default `https://peridot.ai/api`).

## Develop

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev        # watch mode
bun start          # run once
bun run build      # single binary in dist/peridot (then just run `peridot`)
bun run build:linux   # also :macos, :windows
```
