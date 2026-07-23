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


# Localized default templates: kind -> lang -> (subject, body).
# Admins can override any of them from the admin panel (stored in AppSetting
# "mail_templates" as {kind: {lang: {subject, body}}}).
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
    "code": {
        "ru": ("[HelpDesk] Код подтверждения: {code}",
               "Ваш код подтверждения регистрации: {code}\n\nВведите его на странице регистрации. Код действует 15 минут."),
        "en": ("[HelpDesk] Verification code: {code}",
               "Your registration verification code: {code}\n\nEnter it on the registration page. The code is valid for 15 minutes."),
        "zh": ("[HelpDesk] 验证码：{code}",
               "您的注册验证码：{code}\n\n请在注册页面输入。验证码 15 分钟内有效。"),
    },
    "registration_request": {
        "ru": ("[HelpDesk] Новая заявка на регистрацию",
               "{name} ({email}) просит доступ к системе.\n\nСообщение: {message}\n\nОдобрите или отклоните в разделе «Заявки на регистрацию»: {url}"),
        "en": ("[HelpDesk] New registration request",
               "{name} ({email}) requested access.\n\nMessage: {message}\n\nApprove or reject in the registration requests section: {url}"),
        "zh": ("[HelpDesk] 新的注册申请",
               "{name}（{email}）申请访问系统。\n\n留言：{message}\n\n请在“注册申请”中批准或拒绝：{url}"),
    },
    "approved": {
        "ru": ("[HelpDesk] Ваш аккаунт подтверждён",
               "Ваша заявка на доступ одобрена.\n\nВойти: {url}"),
        "en": ("[HelpDesk] Your account has been approved",
               "Your access request has been approved.\n\nSign in: {url}"),
        "zh": ("[HelpDesk] 您的账号已获批准",
               "您的访问申请已获批准。\n\n登录：{url}"),
    },
    "rejected": {
        "ru": ("[HelpDesk] Заявка отклонена",
               "К сожалению, ваша заявка на доступ отклонена."),
        "en": ("[HelpDesk] Registration request declined",
               "Unfortunately your access request has been declined."),
        "zh": ("[HelpDesk] 注册申请被拒绝",
               "很抱歉，您的访问申请已被拒绝。"),
    },
    "comment": {
        "ru": ("[HelpDesk] Новый комментарий к {key}: {title}",
               "{author} написал(а):\n\n{text}\n\nОткрыть сайт: {url}"),
        "en": ("[HelpDesk] New comment on {key}: {title}",
               "{author} wrote:\n\n{text}\n\nOpen: {url}"),
        "zh": ("[HelpDesk] {key} 有新评论：{title}",
               "{author} 写道：\n\n{text}\n\n打开：{url}"),
    },
}

# Placeholders each kind supports (shown in the admin template editor).
MAIL_VARS = {
    "new_task": ["key", "title", "dep", "url"],
    "assigned": ["key", "title", "url"],
    "due": ["key", "title", "due", "url"],
    "code": ["code"],
    "registration_request": ["name", "email", "message", "url"],
    "approved": ["url"],
    "rejected": [],
    "comment": ["key", "title", "author", "text", "url"],
}


class _SafeDict(dict):
    """Leave unknown {placeholders} intact instead of crashing on admin typos."""
    def __missing__(self, key):
        return "{" + key + "}"


def get_template_overrides(db=None) -> dict:
    import json
    from .mailcfg import _get
    from .database import SessionLocal
    own = False
    if db is None:
        db = SessionLocal()
        own = True
    try:
        raw = _get(db, "mail_templates", "")
        if not raw:
            return {}
        try:
            data = json.loads(raw)
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}
    finally:
        if own:
            db.close()


def mail_text(kind: str, lang: str, _db=None, **kw) -> tuple[str, str]:
    lang = lang if lang in ("ru", "en", "zh") else "ru"
    subject, body = MAIL_T[kind].get(lang, MAIL_T[kind]["ru"])
    ov = get_template_overrides(_db).get(kind, {}).get(lang) or {}
    if (ov.get("subject") or "").strip():
        subject = ov["subject"]
    if (ov.get("body") or "").strip():
        body = ov["body"]
    safe = _SafeDict(**kw)
    return subject.format_map(safe), body.format_map(safe)


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
