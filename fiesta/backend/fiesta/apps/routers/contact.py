"""The "Having trouble? Email Us" form (node-less: POST /v2/contact).

Anyone, signed in or not, can send the EarthRef webmaster (settings.
contact_email) a message with an optional screenshot of the page they were on.
The message only ever goes to that one address, with the sender as Reply-To,
so the form cannot relay mail elsewhere; a honeypot field and a per-sender and
per-process throttle keep it from flooding the inbox.
"""

import base64
import binascii
import logging
import re
import time
from collections import deque
from email.message import EmailMessage

import aiosmtplib
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field

from fiesta.apps.deps import OptionalUser
from fiesta.settings import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/contact", tags=["contact"])

MAX_SCREENSHOT_BYTES = 6 * 1024 * 1024
PER_SENDER = 5  # messages per sender per WINDOW
PER_PROCESS = 60  # messages per API process per WINDOW
WINDOW = 3600.0
_DATA_URL = re.compile(r"data:image/(png|jpeg|webp);base64,(.+)", re.DOTALL)

_sent: deque[tuple[float, str]] = deque()


class ContactIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr
    subject: str = Field("", max_length=200)
    message: str = Field(min_length=1, max_length=20_000)
    page: str = Field("", max_length=2000)  # the URL the form was opened on
    repository: str = Field("", max_length=40)  # the node key, or FIESTA on the portal
    # A data: URL (PNG, JPEG or WebP); base64 makes it ~4/3 the image's size.
    screenshot: str | None = Field(None, max_length=MAX_SCREENSHOT_BYTES * 4 // 3 + 100)
    website: str = ""  # honeypot: hidden in the form, so only bots fill it


def _throttled(sender: str) -> bool:
    now = time.monotonic()
    while _sent and now - _sent[0][0] > WINDOW:
        _sent.popleft()
    return len(_sent) >= PER_PROCESS or sum(s == sender for _, s in _sent) >= PER_SENDER


def _screenshot(data_url: str) -> tuple[str, bytes]:
    match = _DATA_URL.fullmatch(data_url.strip())
    if not match:
        raise HTTPException(422, "the screenshot must be a PNG, JPEG or WebP data URL")
    try:
        content = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(422, "the screenshot is not valid base64") from error
    if len(content) > MAX_SCREENSHOT_BYTES:
        raise HTTPException(413, "the screenshot is too large")
    return match.group(1), content


async def deliver(message: EmailMessage) -> None:
    settings = get_settings()
    await aiosmtplib.send(message, hostname=settings.smtp_host, port=settings.smtp_port, timeout=30)


@router.post("", status_code=202)
async def contact(payload: ContactIn, request: Request, user: OptionalUser) -> dict:
    """Email the message (and screenshot) to the EarthRef webmaster."""
    if payload.website:  # a bot: answer as if sent
        logger.info("contact form honeypot filled; dropped")
        return {"sent": True}
    sender = str(payload.email).strip().lower()
    if _throttled(sender):
        raise HTTPException(429, "too many messages; please try again later or email us directly")
    image = _screenshot(payload.screenshot) if payload.screenshot else None

    settings = get_settings()
    repository = payload.repository.strip() or "FIESTA"
    subject = " ".join(payload.subject.split()) or "Help"
    name = " ".join(payload.name.split())
    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = settings.contact_email
    message["Reply-To"] = f"{name} <{sender}>" if name else sender
    message["Subject"] = f"[{repository} Help] {subject}"
    account = (
        f"{user.name or user.handle or user.email} (id {user.id}, {user.email})"
        if user
        else "not signed in"
    )
    message.set_content(
        f"{payload.message.strip()}\n\n"
        "--\n"
        f"From: {name} <{sender}>\n"
        f"Account: {account}\n"
        f"Repository: {repository}\n"
        f"Page: {payload.page or 'unknown'}\n"
        f"Browser: {request.headers.get('user-agent', 'unknown')}\n"
        f"Screenshot: {'attached' if image else 'none'}\n"
    )
    if image:
        kind, content = image
        extension = "jpg" if kind == "jpeg" else kind
        message.add_attachment(
            content, maintype="image", subtype=kind, filename=f"screenshot.{extension}"
        )
    try:
        await deliver(message)
    except Exception as error:  # SMTP down: say so rather than pretend it was sent
        logger.exception("contact email from %s failed", sender)
        detail = "the message could not be sent; please email us directly"
        raise HTTPException(503, detail) from error
    _sent.append((time.monotonic(), sender))
    return {"sent": True}
