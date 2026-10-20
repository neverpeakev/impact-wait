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

## Earn a share of the ad revenue

On first run the mod signs this install up as an earner (no account, no email needed) and keeps a private earner token in the plugin store. Every paid view the API credits to that token earns you a share of the ad revenue (50% by default).

- `/earn` shows your balance: paid views today and pending, what you are owed, and what has been paid out.
- `/earn paypal you@example.com` sets where payouts go.
- Views settle monthly from what the ad network **actually paid** for the period, split by credited views. Nothing is owed from estimates.
- Payouts go out once you are owed $10.
- Limits: at most 200 credited views a day and one every 20 seconds. Fake or scripted views get the earner banned and forfeit what is owed.

Keep your earner token private: it is your balance. It lives in the plugin store on this machine; reinstalling on a new machine starts a new earner.

## Install

```bash
git clone https://github.com/neverpeakev/goodwait
claude --plugin-dir ./goodwait/plugins/claude-code
```

Or add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` so it loads in every session.

## Settings

In `/config` under **goodwait**:

- **Site key** (default `claude-code`): your name on the public leaderboard. `sandbox` shows a house ad and counts nothing.
- **Estimated eCPM (USD)** (default 24.50): what you earn per 1,000 counted paid waits. The default is Idlen's published $35 network average for sponsored recommendations times the 70% publisher share. Idlen's dashboard is the exact balance, paid monthly once you pass $50.

## Actual earnings

When a network's dashboard figure is recorded in the API (`impact_wait.earnings`, one row per report), the mod shows that actual as lifetime earnings, plus an estimate for the paid waits counted after the report. With no actual recorded, lifetime is an estimate from the eCPM. To record a figure:

```sql
insert into impact_wait.earnings (network, site_key, earned_usd, paid_waits, clicks, as_of, source)
values ('idlen', 'claude-code', 0.63, 30, 1, now(), 'idlen dashboard');
```
- **API endpoint**: leave as is unless you self-host the API.

Commands: `/goodwait` opens the counter pane, `/goodwait off` and `/goodwait on` toggle the line. The `hide` button does the same and remembers your choice across sessions.

## What leaves your machine

The first 500 characters of your prompt, the site key, a random per-session id and your earner token, sent to the Goodwait API to pick one matching line and credit your view. The API passes the prompt text on to the ad network to match the ad. No files, no tool output, no code beyond what you typed in the prompt. Your PayPal email is stored only for payouts and shown back to you masked.

## Development

```bash
claude plugin validate plugins/claude-code
claude plugin test plugins/claude-code
```
