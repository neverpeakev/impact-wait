"""
title: Other embed (test only)
"""
from typing import Any, Awaitable, Callable, Optional


class Filter:
    def __init__(self):
        pass

    async def inlet(self, body: dict, __event_emitter__: Optional[Callable[[Any], Awaitable[None]]] = None) -> dict:
        if __event_emitter__:
            await __event_emitter__({"type": "embeds", "data": {"embeds": ["<!doctype html><p>OTHER-EMBED-KEEP</p>"]}})
        return body
