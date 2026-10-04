# Goodwait for Claude Code

A Claude Code mod (plugin of function hooks). While Claude works, one labeled sponsored line sits above the prompt:

```
Sponsored · Wispr Flow: Talk instead of type  Try free  hide
50% of net ad revenue goes to Khan Academy · 1,234 waits so far
```

It appears when a turn starts, counts a view only after it has been on screen for a full second, and clears a few seconds after the reply lands.

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

Commands: `/goodwait` shows the counter, `/goodwait off` and `/goodwait on` toggle the line. The `hide` button does the same and remembers your choice across sessions.

## What leaves your machine

The first 500 characters of your prompt, the site key and a random per-session id, sent to the Goodwait API to pick one matching line. No files, no tool output, no account details.

## Development

```bash
claude plugin validate plugins/claude-code
claude plugin test plugins/claude-code
```
