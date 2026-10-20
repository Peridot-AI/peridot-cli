# Peridot CLI

[Peridot AI](https://peridot.ai) in your terminal.

```bash
peridot                     # interactive chat
peridot "explain this error"
cat notes.txt | peridot "summarize"   # stdin is used when no prompt is given
peridot login               # sign in; token stored in ~/.config/peridot/config.json (0600)
peridot logout
```

Options: `-m, --model <id>`. Environment: `PERIDOT_TOKEN` (use instead of the stored token), `PERIDOT_API_URL` (default `https://peridot.ai/api`).

## Develop / build

Requires [Bun](https://bun.sh).

```bash
bun run start -- "hello"
bun run build            # single binary in dist/peridot
bun run build:linux      # also :macos, :windows
```
