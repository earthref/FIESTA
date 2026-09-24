"""Background tasks: contribution processing (parse/validate/summarize/index),
standalone validation, and email."""

import logging
from email.message import EmailMessage

import aiosmtplib

from fiesta.db.session import get_sessionmaker
from fiesta.jobs.app import get_job_app
from fiesta.nodeconfig import get_deployment
from fiesta.services import contributions as svc
from fiesta.services import node_config, node_publish
from fiesta.settings import get_settings

logger = logging.getLogger(__name__)
app = get_job_app()


@app.task(name="process_contribution", retry=2)
async def process_contribution(contribution_id: int, node_slug: str) -> None:
    await node_config.maybe_refresh()  # a node published in the admin UI since start
    node = get_deployment().node_for(node_slug)
    async with get_sessionmaker(node.node.slug)() as session:
        await svc.process_contribution(session, node, contribution_id)


async def defer_process_contribution(node, contribution_id: int) -> int:
    """Defer processing onto the node's own queue. One worker listens on
    every enabled node's queue plus `default` (email); the node slug travels
    with the job so it is processed with that node's config."""
    return await process_contribution.configure(queue=node.node.slug).defer_async(
        contribution_id=contribution_id, node_slug=node.node.slug
    )


@app.task(name="publish_node_config", queue="default")
async def publish_node_config(revision_id: int) -> None:
    """Write a published node revision to the repository (FIESTA_CONFIG_PUBLISH).
    Failures are recorded on the revision; the admin UI retries."""
    await node_publish.write_revision(revision_id)


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
