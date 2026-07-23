"""Best-effort SMTP email notifications.

SMTP settings come from the admin panel (AppSetting) with env defaults —
see mailcfg.get_mail_config(). Sending happens on a background thread so API
requests never block on the mail server, and failures are swallowed with a
log line: email problems must never break the core helpdesk flow.
"""
import logging
import smtplib
import threading
from email.message import EmailMessage
from email.utils import formataddr

log = logging.getLogger("helpdesk.mailer")


# Localized templates: kind -> lang -> (subject, body)
MAIL_T = {
    "new_task": {
        "ru": ("[HelpDesk] Новая задача {key}: {title}",
               "В подразделении «{dep}» создана новая задача {key}: {title}.\n\nОткрыть сайт: {url}"),
        "en": ("[HelpDesk] New task {key}: {title}",
               "A new task {key}: {title} was created in department \"{dep}\".\n\nOpen: {url}"),
        "zh": ("[HelpDesk] 新任务 {key}：{title}",
               "部门“{dep}”创建了新任务 {key}：{title}。\n\n打开：{url}"),
    },
    "assigned": {
        "ru": ("[HelpDesk] Вам назначена задача {key}: {title}",
               "Вы назначены исполнителем задачи {key} — {title}.\n\nОткрыть сайт: {url}"),
        "en": ("[HelpDesk] Task assigned to you — {key}: {title}",
               "You have been assigned to task {key} — {title}.\n\nOpen: {url}"),
        "zh": ("[HelpDesk] 任务已分配给您 — {key}：{title}",
               "您已被指派为任务 {key} — {title} 的负责人。\n\n打开：{url}"),
    },
    "due": {
        "ru": ("[HelpDesk] Срок задачи {key} скоро истекает",
               "Срок задачи {key} — {title} — истекает: {due}.\n\nОткрыть сайт: {url}"),
        "en": ("[HelpDesk] Task {key} is due soon",
               "Task {key} — {title} — is due: {due}.\n\nOpen: {url}"),
        "zh": ("[HelpDesk] 任务 {key} 即将到期",
               "任务 {key} — {title} — 截止时间：{due}。\n\n打开：{url}"),
    },
}


def mail_text(kind: str, lang: str, **kw) -> tuple[str, str]:
    pair = MAIL_T[kind].get(lang or "ru", MAIL_T[kind]["ru"])
    return pair[0].format(**kw), pair[1].format(**kw)


def _send_via(cfg: dict, to_addr: str, subject: str, body: str):
    """Attempt one delivery. Returns None on success or an error string."""
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("HelpDesk", cfg["mail_from"]))
    msg["To"] = to_addr
    msg.set_content(body)
    try:
        if cfg["ssl"]:
            server = smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=15)
        else:
            server = smtplib.SMTP(cfg["host"], cfg["port"], timeout=15)
            if cfg["tls"]:
                server.starttls()
        try:
            if cfg["user"]:
                server.login(cfg["user"], cfg["password"])
            server.send_message(msg)
        finally:
            server.quit()
        log.info("Sent email to %s: %s", to_addr, subject)
        return None
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to send email to %s: %s", to_addr, exc)
        return str(exc)


def _send_sync(to_addr: str, subject: str, body: str):
    from .mailcfg import get_mail_config
    cfg = get_mail_config()
    if not cfg["enabled"] or not to_addr:
        return
    _send_via(cfg, to_addr, subject, body)


def send_email(to_addr: str, subject: str, body: str):
    """Fire-and-forget email; returns immediately."""
    if not to_addr:
        return
    threading.Thread(target=_send_sync, args=(to_addr, subject, body), daemon=True).start()


def send_email_many(addrs, subject: str, body: str):
    for a in set(filter(None, addrs)):
        send_email(a, subject, body)


def send_test(to_addr: str):
    """Synchronous test delivery for the admin panel. None == success."""
    from .mailcfg import get_mail_config
    cfg = get_mail_config()
    if not cfg["enabled"]:
        return "SMTP host is not configured"
    return _send_via(cfg, to_addr, "[HelpDesk] Test email",
                     "SMTP settings are working. / Настройки почты работают.")
