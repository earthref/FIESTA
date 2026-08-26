"""Background tasks: contribution processing (parse/validate/summarize/index),
standalone validation, and email."""

import logging
from email.message import EmailMessage

import aiosmtplib

from fiesta.db.session import get_sessionmaker
from fiesta.jobs.app import get_job_app
from fiesta.nodeconfig import get_node
from fiesta.services import contributions as svc
from fiesta.settings import get_settings

logger = logging.getLogger(__name__)
app = get_job_app()


@app.task(name="process_contribution", retry=2)
async def process_contribution(contribution_id: int) -> None:
    node = get_node()
    async with get_sessionmaker()() as session:
        await svc.process_contribution(session, node, contribution_id)


async def defer_process_contribution(node, contribution_id: int) -> int:
    """Defer processing onto the node's own queue. Multiple nodes share one
    Postgres (and thus one procrastinate schema); each node's worker only
    consumes its own queue, so jobs are always processed with the right node
    config."""
    return await process_contribution.configure(queue=node.node.slug).defer_async(
        contribution_id=contribution_id
    )


@app.task(name="send_email", retry=3)
async def send_email(to: str, subject: str, body: str) -> None:
    settings = get_settings()
    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)
    await aiosmtplib.send(message, hostname=settings.smtp_host, port=settings.smtp_port)
    logger.info("sent email %r to %s", subject, to)
