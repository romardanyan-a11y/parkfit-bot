"""Best-effort SMTP email notifications.

Sending happens on a background thread so API requests never block on the
mail server, and any failure is swallowed with a log line — email problems
must never break the core helpdesk flow. If SMTP_HOST is not configured the
functions are silent no-ops.
"""
import logging
import smtplib
import threading
from email.message import EmailMessage
from email.utils import formataddr

from .config import settings

log = logging.getLogger("helpdesk.mailer")


def _send_sync(to_addr: str, subject: str, body: str):
    if not settings.email_enabled or not to_addr:
        return
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("HelpDesk", settings.MAIL_FROM))
    msg["To"] = to_addr
    msg.set_content(body)
    try:
        if settings.SMTP_SSL:
            server = smtplib.SMTP_SSL(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15)
        else:
            server = smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15)
            if settings.SMTP_TLS:
                server.starttls()
        try:
            if settings.SMTP_USER:
                server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            server.send_message(msg)
        finally:
            server.quit()
        log.info("Sent email to %s: %s", to_addr, subject)
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to send email to %s: %s", to_addr, exc)


def send_email(to_addr: str, subject: str, body: str):
    """Fire-and-forget email; returns immediately."""
    if not settings.email_enabled or not to_addr:
        return
    threading.Thread(target=_send_sync, args=(to_addr, subject, body), daemon=True).start()


def send_email_many(addrs, subject: str, body: str):
    for a in set(filter(None, addrs)):
        send_email(a, subject, body)
