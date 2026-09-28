"""
title: ImpactWait
author: Never Peak
author_url: https://impact-wait.vercel.app
version: 0.1.0
license: MIT
description: While the model is thinking, show one clearly labeled sponsored line. Part of the revenue funds a good cause, and every wait adds to a public live counter. No ad keys on your server, no cookies, no user IDs sent anywhere.
"""

# How it works
# - inlet (runs before the model is called): attaches a small embed to the
#   assistant message that is about to be generated. The embed runs the
#   ImpactWait web component in the user's own browser, so the ad request,
#   the 1-second on-screen view check and any click all come from the user,
#   exactly like on a normal website.
# - outlet (runs when the reply is finished): removes the embed, so nothing
#   sponsored stays in the chat history.
# The only thing sent to ImpactWait is the user's latest message (to pick a
# relevant sponsor) and your site key. Nothing is sent from this server.

import html
import re
import time
from typing import Any, Awaitable, Callable, Optional

from pydantic import BaseModel, Field

SITE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
DEFAULT_ENDPOINT = "https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/impact-wait"


def last_user_text(messages: list) -> str:
    for m in reversed(messages or []):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            return c.strip()
        if isinstance(c, list):  # multimodal: [{type:"text", text:...}, {type:"image_url"...}]
            return " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text").strip()
        return ""
    return ""


MARK = "data-impact-wait-embed"
# If a reply never finishes (tab closed mid-answer), the embed can stay in the chat.
# It only activates within this window, so reopening an old chat never shows or counts an ad.
ACTIVE_WINDOW_S = 600


def embed_html(site: str, query: str, endpoint: str, theme: str, now: Optional[float] = None) -> str:
    q = html.escape(query[:500], quote=True)
    theme_attr = f' theme="{theme}"' if theme in ("light", "dark") else ""
    src = html.escape(endpoint.rstrip("/") + "/embed.js", quote=True)
    ep = html.escape(endpoint.rstrip("/"), quote=True)
    ts = int((now if now is not None else time.time()) * 1000)
    return (
        f"<!doctype html><html {MARK}><head><meta charset=\"utf-8\">"
        "<style>html,body{margin:0;background:transparent;overflow:hidden}body{padding:2px 1px}</style></head><body>"
        f"<impact-wait site=\"{html.escape(site, quote=True)}\" endpoint=\"{ep}\" query=\"{q}\" linger=\"0\"{theme_attr}></impact-wait>"
        f"<script>if(Math.abs(Date.now()-{ts})<{ACTIVE_WINDOW_S * 1000})document.querySelector('impact-wait').setAttribute('active','');</script>"
        f"<script src=\"{src}\"></script>"
        # Open WebUI sizes embeds from this message; 0 while nothing is showing.
        "<script>(function(){var el=document.querySelector('impact-wait');"
        "function h(){var v=el&&!el.hidden?Math.ceil(document.body.getBoundingClientRect().height):0;"
        "parent.postMessage({type:'iframe:height',height:v},'*');}"
        "h();if(window.ResizeObserver)new ResizeObserver(h).observe(document.body);"
        "if(window.MutationObserver)new MutationObserver(h).observe(el,{attributes:true});})();</script>"
        "</body></html>"
    )


class Filter:
    class Valves(BaseModel):
        priority: int = Field(default=0, description="Filter order (lower runs first).")
        site: str = Field(
            default="",
            description="Your ImpactWait site key, e.g. lincoln-high or my-ai-club (2-41 chars: a-z, 0-9, dash). Shown on the public leaderboard. Required.",
        )
        endpoint: str = Field(default=DEFAULT_ENDPOINT, description="ImpactWait API. Leave as is.")
        theme: str = Field(default="auto", description="auto, light or dark.")
        enabled: bool = Field(default=True, description="Turn the sponsored line on or off for everyone.")

    class UserValves(BaseModel):
        show_sponsored_line: bool = Field(default=True, description="Show the sponsored line while the model is thinking.")

    def __init__(self):
        self.valves = self.Valves()

    def _site(self) -> str:
        s = (self.valves.site or "").strip().lower()
        return s if SITE_RE.match(s) else ""

    def _on_for(self, user: Optional[dict]) -> bool:
        if not self.valves.enabled or not self._site():
            return False
        uv = (user or {}).get("valves")
        if uv is not None and getattr(uv, "show_sponsored_line", True) is False:
            return False
        return True

    async def inlet(
        self,
        body: dict,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[Callable[[Any], Awaitable[None]]] = None,
    ) -> dict:
        try:
            if __event_emitter__ is None or not self._on_for(__user__):
                return body
            query = last_user_text(body.get("messages", []))
            if not query:
                return body
            await __event_emitter__(
                {
                    "type": "embeds",
                    "data": {"embeds": [embed_html(self._site(), query, self.valves.endpoint, self.valves.theme)]},
                }
            )
        except Exception as e:  # never block the user's chat because of the sponsored line
            print(f"[impact-wait] inlet skipped: {e}")
        return body

    async def outlet(
        self,
        body: dict,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[Callable[[Any], Awaitable[None]]] = None,
        __metadata__: Optional[dict] = None,
    ) -> dict:
        # Remove only our embed; keep any embeds other tools added to the same reply.
        try:
            if __event_emitter__ is None or not self._site():
                return body
            meta = __metadata__ or {}
            chat_id = meta.get("chat_id") or body.get("chat_id")
            message_id = meta.get("message_id") or body.get("id")
            keep = None
            if chat_id and message_id:
                try:
                    from open_webui.models.chats import Chats

                    existing = await Chats.get_message_metadata(chat_id, message_id, "embeds")
                    if isinstance(existing, list):
                        keep = [e for e in existing if not (isinstance(e, str) and MARK in e)]
                        if len(keep) == len(existing):
                            return body  # nothing of ours to remove
                except Exception as e:
                    print(f"[impact-wait] could not read embeds, clearing: {e}")
            await __event_emitter__({"type": "embeds", "data": {"embeds": keep or [], "replace": True}})
        except Exception as e:
            print(f"[impact-wait] outlet cleanup skipped: {e}")
        return body
