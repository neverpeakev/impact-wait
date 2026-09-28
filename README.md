# ImpactWait

**Every AI wait can do some good.**

While an AI chat app is "thinking", ImpactWait shows one clearly labeled sponsored line under the pending reply. A share of the revenue goes to a good cause, and every wait adds to a public live counter at [impact-wait.vercel.app](https://impact-wait.vercel.app).

- One line. It shows only while the model is working and disappears when the reply is done.
- It never touches the model's answer and is never saved in chat history.
- A view counts only after the line has been at least 50% on screen, in a visible tab, for 1 full second.
- No cookies, no user IDs, no ad-network keys on your server or in the browser.
- Users can turn it off for themselves. Admins can turn it off for everyone.

## Add it to your app

| You run | Do this |
| --- | --- |
| **Open WebUI** | Admin Panel > Functions > Import [`plugins/openwebui/impact_wait_filter.py`](plugins/openwebui/impact_wait_filter.py), set the `site` valve, turn it on and make it Global. [Details](plugins/openwebui/README.md) |
| **LibreChat** | Use [neverpeakev/impact-librechat](https://github.com/neverpeakev/impact-librechat) and set `IMPACT_WAIT_SITE=your-site` in `.env`. |
| **Vercel AI Chatbot** | One-click deploy [neverpeakev/impact-chatbot](https://github.com/neverpeakev/impact-chatbot), set `NEXT_PUBLIC_IMPACT_WAIT_SITE`. |
| **Any web app** | The snippets below. |

### Plain HTML

```html
<script src="https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/impact-wait/embed.js" defer></script>
<impact-wait id="iw" site="your-site"></impact-wait>
<script>
  const iw = document.getElementById("iw");
  // when the user sends a message:
  iw.query = userMessage; iw.active = true;
  // when the reply finishes:
  iw.active = false;
</script>
```

### React / Next.js

```bash
npm i github:neverpeakev/impact-wait
```

```jsx
import { ImpactWait } from "impact-wait/react";

<ImpactWait site="your-site" active={isLoading} query={lastUserMessage} />
```

Props: `site`, `active`, `query`, `response?`, `linger?` (ms, default 4000), `theme?` (`"light"` | `"dark"`), `endpoint?`, `onAd?`, `onImpression?`.

**Site key:** any name you like (2-41 chars: a-z, 0-9, dash). It registers on first use and shows on the public leaderboard. On `localhost` and other dev hosts the API runs in test mode: you see a house ad, and nothing is counted.

## How it works

1. When a user sends a message, the component asks the ImpactWait API for one sponsored line that matches the message. It sends only the message text and your site key.
2. The API asks several AI-native ad networks at once (Idlen, AdMesh, AgentAds) and picks the paying ad. House ads are a last resort.
3. The line shows while the model thinks. After 1 second on screen, the view is reported and the counter goes up.
4. Clicks go through a redirect so they can be counted without cookies.

Sensitive categories (gambling, adult, cannabis and vaping, weapons, payday loans) are always blocked.

## Where the money goes

Sponsored revenue funds a cause partner, and every donation is published on [the counter page](https://impact-wait.vercel.app) with its receipt. The first cause partner is being announced soon. Until then the counter shows $0 donated, because it only ever shows real money.

## Repo layout

- `web/` - the counter page, demo, and the `<impact-wait>` web component (`web/impact-wait.js` is the source of truth; `npm run build` regenerates the copies)
- `supabase/functions/impact-wait/` - the API (Supabase Edge Function, Deno)
- `plugins/openwebui/` - the Open WebUI filter
- `react.js`, `react.d.ts`, `impact-wait.js` - the npm package
- `tests/` - API unit tests and real-browser end-to-end tests (plain HTML, React, Vercel chatbot, LibreChat, Open WebUI)

## License

MIT. Built by [Never Peak](mailto:kevin@neverpeakmarketing.com?subject=ImpactWait). Want to be a launch partner or a cause partner? Email kevin@neverpeakmarketing.com.
