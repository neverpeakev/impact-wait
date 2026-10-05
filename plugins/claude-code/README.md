# Goodwait for Claude Code

A Claude Code mod (plugin of function hooks). While Claude works, one labeled sponsored line sits above the prompt:

```
Sponsored · Fuel Path Pro: Plan every road trip in one tap.  1: Explore  2: counter  h: hide
est. earned $0.05 this session · $0.98 lifetime · 1,234 waits so far
```

It appears when a turn starts, counts a view only after it has been on screen for a full second, and clears a few seconds after the reply lands. When the terminal is wide the ad's one-line body shows too.

Around it:

- **Status line**: `goodwait: 1,234 waits · est. $0.98 earned`, always visible while the mod is on, refreshed every 5 minutes and after each counted wait.
- **Band controls** (focus the band with ctrl+x tab, then a key): `1` (the ad's call to action) opens it in your browser through the server's click redirect, so clicks count like web clicks; `2` opens the counter pane; `h` hides the line.
- **Earnings pane**: `/goodwait` opens a pane with your estimated lifetime and session earnings, paid waits, the public total, the leaderboard and this site's waits and clicks. Keys: `r` refresh, `t` turn the line off or on, `o` open the counter page.
- **Milestones**: a toast at your 10th, 50th, 100th, 250th, 500th and 1,000th wait of a session.

## Install

```bash
git clone https://github.com/neverpeakev/goodwait
claude --plugin-dir ./goodwait/plugins/claude-code
```

Or add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` so it loads in every session.

## Settings

In `/config` under **goodwait**:

- **Site key** (default `claude-code`): your name on the public leaderboard. `sandbox` shows a house ad and counts nothing.
- **Estimated eCPM (USD)** (default 24.50): what you earn per 1,000 counted paid waits. The default is Idlen's published $35 network average for sponsored recommendations times the 70% publisher share. All earnings in the mod are estimates from this number; Idlen's dashboard is the exact balance, paid monthly once you pass $50.
- **API endpoint**: leave as is unless you self-host the API.

Commands: `/goodwait` opens the counter pane, `/goodwait off` and `/goodwait on` toggle the line. The `hide` button does the same and remembers your choice across sessions.

## What leaves your machine

The first 500 characters of your prompt, the site key and a random per-session id, sent to the Goodwait API to pick one matching line. No files, no tool output, no account details.

## Development

```bash
claude plugin validate plugins/claude-code
claude plugin test plugins/claude-code
```
