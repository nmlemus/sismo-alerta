"""Telegram Bot API: send a message to a channel, and edit it when IGC revises the quake."""

from __future__ import annotations

import logging

import aiohttp

log = logging.getLogger("sismo.telegram")
API = "https://api.telegram.org/bot{token}/{method}"


class Telegram:
    def __init__(self, session: aiohttp.ClientSession, token: str, chat_id: str):
        self.session, self.token, self.chat_id = session, token, chat_id

    async def _call(self, method: str, payload: dict) -> dict:
        async with self.session.post(API.format(token=self.token, method=method), json=payload,
                                     timeout=aiohttp.ClientTimeout(total=15)) as r:
            body = await r.json(content_type=None)
            if not body.get("ok"):
                # "message is not modified" is harmless when an edit changes nothing visible
                if "not modified" not in str(body.get("description", "")):
                    raise RuntimeError(f"Telegram {method}: {body.get('description')}")
            return body.get("result") or {}

    async def send(self, text: str, silent: bool = False) -> int | None:
        res = await self._call("sendMessage", {
            "chat_id": self.chat_id, "text": text, "parse_mode": "HTML",
            "disable_web_page_preview": True, "disable_notification": silent,
        })
        return res.get("message_id")

    async def edit(self, message_id: int, text: str) -> None:
        await self._call("editMessageText", {
            "chat_id": self.chat_id, "message_id": message_id, "text": text,
            "parse_mode": "HTML", "disable_web_page_preview": True,
        })

    async def delete(self, message_id: int) -> None:
        await self._call("deleteMessage", {"chat_id": self.chat_id, "message_id": message_id})


class LogOnly:
    """Stand-in when no bot is configured: logs what it would have sent."""

    async def send(self, text: str, silent: bool = False) -> int | None:
        log.info("[telegram off] %s%s", "(silent) " if silent else "", text.replace("\n", " | "))
        return None

    async def edit(self, message_id: int, text: str) -> None:
        log.info("[telegram off] edit %s: %s", message_id, text.replace("\n", " | "))

    async def delete(self, message_id: int) -> None:
        log.info("[telegram off] delete %s", message_id)
