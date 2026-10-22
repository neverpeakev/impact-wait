# Vibedough for Claude Code

Get paid while Claude Code thinks.

While your agent works, this mod shows one labeled sponsored line above the prompt. Every view you're actually there for earns you **half the ad revenue**. You can cash it out to PayPal, donate it to charity: water, and it counts as entries in prize draws.

The full source is here so you can check exactly what it does. It never reads your files, your code or anything the agent writes.

> Inside Claude Code the mod still calls itself Goodwait (`/goodwait`, the pane title) until the rename ships.

## Install

```bash
git clone https://github.com/neverpeakev/vibedough-claude-code
claude --plugin-dir ./vibedough-claude-code
```

To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.

If a friend gave you an invite code, set it in `/config` (**Invite code**) before your first run.

## How it works

1. **A turn starts.** One sponsored line appears above the prompt.
2. **It counts only when you're there.** A view counts after the line has been on screen for a full second. On long turns a new ad rotates in every 15 seconds, at most 16 times a turn, and only within 2 minutes of your last keystroke or prompt. Walk away and nothing more is counted.
3. **The reply lands.** The line clears a few seconds later.

Subagents running in the background never trigger an ad.

## Earning

On first run the mod signs this install up as an earner. There's no account or email; it keeps a private token in the plugin store on this machine.

- **Your share:** 50% of what advertisers actually paid for your views, settled monthly. Nothing is owed from estimates.
- **`/earn`** shows your balance, paid views today, what's been paid out or donated, draw entries and your invite code.
- **`/earn paypal you@example.com`** sets where cash goes. Cash goes out once you have $10. Your first cash-out is held 30 days after you join, to stop fraud.
- **`/earn donate`** gives your balance to charity: water; `/earn donate 2.50` gives part of it. Donations go out monthly.
- **`/earn exit donate`** sends all future earnings straight to charity: water. `/earn exit cash` switches back.
- **`/earn refer`** shows your invite code. When a friend joins with it, you get 10% of what they earn, for life. That comes out of our half, never theirs.

Limits: at most 200 credited views a day and one every 15 seconds. Scripted or fake views get the earner banned and forfeit the balance.

Keep your token private, because it holds your balance. Reinstalling on a new machine starts a new earner.

## What leaves your machine

The mod makes these requests and no others.

**To Velocity** (`gw.vlcapi.net`), the ad network, directly from your machine:
- The first 500 characters of your prompt, so the ad matches what you're working on.
- A random per-session id, your earner id, the ad unit and your timezone.
- The ad's impression URL, after the ad has been on screen for a second.

**To the Vibedough API** (`mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait`):
- `/earner`: a one-time sign-up, plus the invite code if you set one.
- `/ad`: used only when Velocity has no ad. It sends the first 500 characters of your prompt, the site key, the session id and your earner token.
- `/event`, `/impression/external`: that a view happened, so it counts and is credited.
- `/earner/me`, `/earner/payout`, `/earner/donate`, `/earner/exit`: your balance and your choices.
- `/stats`: the public counter.

**Never sent:** your files, your code, terminal or tool output, anything the agent writes, and anything from subagents.

Like any web request, both servers see your IP address. Your PayPal email is stored only for payouts and is shown back to you masked.

## Settings

In `/config` under **goodwait**:

| Setting | Default | What it does |
| --- | --- | --- |
| Invite code | empty | A friend's code, used once at sign-up |
| Rotate every (seconds) | 15 | 0 turns rotation off; never below 15 |
| Presence window (seconds) | 120 | How long after your last activity ads keep rotating |
| Velocity ad unit ID | Vibedough's unit | Clear it to use only the Vibedough API's ads |
| Site key | `claude-code` | `sandbox` shows a test ad and counts nothing |

Turn the line off any time with `/goodwait off`, or press `h` on the band. `/goodwait on` brings it back.

## Development

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
