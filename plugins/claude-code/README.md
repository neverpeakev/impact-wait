# Goodwait for Claude Code

A Claude Code mod (plugin of function hooks). While Claude works, one labeled sponsored line sits above the prompt:

```
Sponsored · Wispr Flow: Talk instead of type  Try free  hide
50% of net ad revenue goes to Khan Academy · 1,234 waits so far
```

It appears when a turn starts, counts a view only after it has been on screen for a full second, and clears a few seconds after the reply lands. When the terminal is wide the ad's one-line body shows too.

Around it:

- **Status line**: `Goodwait · 1,234 waits · 50% to Khan Academy`, always visible while the mod is on, refreshed every 5 minutes and after each counted wait.
- **Band controls** (focus the band with ctrl+x tab, then a key): `1` opens the ad in your browser through the server's click redirect, so clicks count like web clicks; `2` opens the counter pane; `h` hides the line.
- **Counter pane**: `/goodwait` opens a pane with the public total, the amount donated, your waits this session, the leaderboard and this site's numbers. Keys: `r` refresh, `t` turn the line off or on, `o` open the counter page.
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
- **API endpoint**: leave as is unless you self-host the API.

Commands: `/goodwait` opens the counter pane, `/goodwait off` and `/goodwait on` toggle the line. The `hide` button does the same and remembers your choice across sessions.

## What leaves your machine

The first 500 characters of your prompt, the site key and a random per-session id, sent to the Goodwait API to pick one matching line. No files, no tool output, no account details.

## Development

```bash
claude plugin validate plugins/claude-code
claude plugin test plugins/claude-code
```
