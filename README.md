# Goodwait

**Every AI wait can do some good.**

While an AI chat app is "thinking", Goodwait shows one clearly labeled sponsored line under the pending reply. Half of the net ad revenue is donated to Khan Academy, and every wait adds to a public live counter at [goodwait.vercel.app](https://goodwait.vercel.app).

- One line. It shows only while the model is working and disappears when the reply is done.
- It never touches the model's answer and is never saved in chat history.
- A view counts only after the line has been at least 50% on screen, in a visible tab, for 1 full second.
- No cookies, no user IDs, no ad-network keys on your server or in the browser.
- Users can turn it off for themselves. Admins can turn it off for everyone.

## Add it to your app

| You run | Do this |
| --- | --- |
| **Open WebUI** | Admin Panel > Functions > Import [`plugins/openwebui/goodwait_filter.py`](plugins/openwebui/goodwait_filter.py), set the `site` valve, turn it on and make it Global. [Details](plugins/openwebui/README.md) |
| **LibreChat** | Use [neverpeakev/goodwait-librechat](https://github.com/neverpeakev/goodwait-librechat) and set `GOODWAIT_SITE=your-site` in `.env`. |
| **Vercel AI Chatbot** | One-click deploy [neverpeakev/goodwait-chatbot](https://github.com/neverpeakev/goodwait-chatbot), set `NEXT_PUBLIC_GOODWAIT_SITE`. |
| **Any web app** | The snippets below. |

### Plain HTML

```html
<script src="https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait/embed.js" defer></script>
<good-wait id="iw" site="your-site"></good-wait>
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
npm i github:neverpeakev/goodwait
```

```jsx
import { Goodwait } from "goodwait/react";

<Goodwait site="your-site" active={isLoading} query={lastUserMessage} />
```

Props: `site`, `active`, `query`, `response?`, `linger?` (ms, default 4000), `theme?` (`"light"` | `"dark"`), `endpoint?`, `onAd?`, `onImpression?`.

**Site key:** any name you like (2-41 chars: a-z, 0-9, dash). It registers on first use and shows on the public leaderboard. On `localhost` and other dev hosts the API runs in test mode: you see a house ad, and nothing is counted.

## How it works

1. When a user sends a message, the component asks the Goodwait API for one sponsored line that matches the message. It sends only the message text and your site key.
2. The API asks several AI-native ad networks at once (Idlen, AdMesh, AgentAds) and picks the paying ad. House ads are a last resort.
3. The line shows while the model thinks. After 1 second on screen, the view is reported and the counter goes up.
4. Clicks go through a redirect so they can be counted without cookies.

Sensitive categories (gambling, adult, cannabis and vaping, weapons, payday loans) are always blocked.

## Where the money goes

50% of net ad revenue is donated to [Khan Academy](https://www.khanacademy.org), a 501(c)(3) nonprofit offering free education. Every donation is published on [the counter page](https://goodwait.vercel.app) with its receipt, so the counter only ever shows real money.

Goodwait is an independent project by Never Peak and is not affiliated with or endorsed by Khan Academy.

## Repo layout

- `web/` - the counter page, demo, and the `<good-wait>` web component (`web/goodwait.js` is the source of truth; `npm run build` regenerates the copies)
- `supabase/functions/goodwait/` - the API (Supabase Edge Function, Deno)
- `plugins/openwebui/` - the Open WebUI filter
- `react.js`, `react.d.ts`, `goodwait.js` - the npm package
- `tests/` - API unit tests and real-browser end-to-end tests (plain HTML, React, Vercel chatbot, LibreChat, Open WebUI)

## License

MIT. Built by [Never Peak](mailto:kevin@neverpeakmarketing.com?subject=Goodwait). Want to be a launch partner or a cause partner? Email kevin@neverpeakmarketing.com.
