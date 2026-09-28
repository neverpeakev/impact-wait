# ImpactWait for Open WebUI

While the model is thinking, your users see one clearly labeled sponsored line. Part of the revenue funds a good cause, and every wait adds to a public live counter. It disappears the moment the reply is done and is never saved in chat history.

Tested on Open WebUI 0.11.4.

## Install (2 minutes)

1. Admin Panel > Functions > **+** (Import) and paste [`impact_wait_filter.py`](impact_wait_filter.py).
2. Open the function's **Valves** and set `site` to your key, e.g. `lincoln-high` (2-41 chars: a-z, 0-9, dash). It registers on first use and shows on the leaderboard.
3. Turn the function **on**, then either make it **Global** (three-dot menu) or attach it to specific models.

That's it. No API keys on your server.

## How it works

- **Before the model is called** the filter attaches a small sandboxed embed to the reply that's about to be generated. The embed runs the ImpactWait web component in the user's own browser.
- **While the model thinks** the embed asks ImpactWait for one sponsored line that matches the user's latest message, and shows it.
- **A view counts** only after the line has been at least 50% on screen, in a visible tab, for 1 full second.
- **When the reply is done** the filter removes its embed (other tools' embeds on the same reply are left alone).
- If a reply never finishes (tab closed mid-answer) and the chat is reopened later, the leftover embed stays inactive: no ad and no request.

## Privacy

- Sent to ImpactWait: the user's latest message (to pick a relevant sponsor) and your site key. That's all.
- Not sent: user names, emails, IDs, chat history, or anything from your server. No cookies.
- The embed runs sandboxed (no access to Open WebUI's page, cookies or storage).
- Users can switch it off for themselves: Settings > Functions > ImpactWait > `show_sponsored_line`.

## Valves

| Valve | Default | What it does |
| --- | --- | --- |
| `site` | (empty) | Your site key. Nothing shows until it's set. |
| `enabled` | `true` | Master switch for everyone. |
| `theme` | `auto` | `auto`, `light` or `dark`. |
| `endpoint` | ImpactWait API | Leave as is. |
| `priority` | `0` | Filter order. |

## Tests

- `test/test_filter_unit.py` - unit tests (no network).
- `test/e2e.mjs` - real Chromium against a real Open WebUI with a mock model that "thinks" for 4 seconds: the line shows while thinking, the view counts once after 1s, the embed is removed after the reply, nothing is saved in history, reopening the chat shows nothing, other embeds survive, the per-user opt-out works, and stale embeds never activate.
