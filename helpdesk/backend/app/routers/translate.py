"""Smart translator: server-side proxy to a free translation endpoint with a
permanent database cache. The frontend sends batches of user-generated texts
(task titles, comments, chat messages) and gets them back in the viewer's
interface language. Each unique (text, target) pair hits the external service
exactly once — afterwards it is a cheap indexed SELECT.
"""
import hashlib
import json
import logging
import urllib.parse
import urllib.request

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import TranslationCache, User

log = logging.getLogger("helpdesk.translate")

router = APIRouter(prefix="/api", tags=["translate"])

SUPPORTED = {"ru": "ru", "en": "en", "zh": "zh-CN"}
MAX_ITEMS = 50
MAX_LEN = 4000


class TrItem(BaseModel):
    id: str
    text: str = ""


class TranslateIn(BaseModel):
    target: str
    items: list[TrItem]


def _google_translate(text: str, target: str):
    """Returns (translated, detected_lang). Raises on network errors."""
    q = urllib.parse.quote(text)
    url = (f"https://translate.googleapis.com/translate_a/single"
           f"?client=gtx&sl=auto&tl={urllib.parse.quote(target)}&dt=t&q={q}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read().decode("utf8"))
    translated = "".join(seg[0] for seg in data[0] if seg and seg[0])
    detected = data[2] if len(data) > 2 else None
    return translated, detected


def _key(target: str, text: str) -> str:
    return hashlib.sha256(f"{target}:{text}".encode("utf8")).hexdigest()


@router.post("/translate")
def translate(data: TranslateIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if data.target not in SUPPORTED:
        raise HTTPException(status_code=400, detail="Unsupported target language")
    g_target = SUPPORTED[data.target]

    out = {}
    pending = []  # (item_id, text, hash) not in cache yet
    seen_hashes = {}
    for item in data.items[:MAX_ITEMS]:
        text = (item.text or "")[:MAX_LEN]
        if not text.strip():
            out[item.id] = text
            continue
        h = _key(data.target, text)
        row = db.query(TranslationCache).filter(TranslationCache.key_hash == h).first()
        if row:
            out[item.id] = row.translated
            continue
        pending.append((item.id, text, h))

    if pending:
        from concurrent.futures import ThreadPoolExecutor

        def work(entry):
            item_id, text, h = entry
            try:
                translated, detected = _google_translate(text, g_target)
                # Text already in the target language — keep the original wording.
                if detected and detected.split("-")[0].lower() == data.target:
                    translated = text
                return item_id, text, h, translated, detected, None
            except Exception as exc:  # noqa: BLE001
                return item_id, text, h, text, None, exc

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(work, pending))

        dirty = False
        for item_id, text, h, translated, detected, err in results:
            out[item_id] = translated
            if err is not None:
                log.warning("Translate failed: %s", err)
                continue
            if h not in seen_hashes:  # same text may repeat in one batch
                seen_hashes[h] = True
                db.add(TranslationCache(key_hash=h, target_lang=data.target,
                                        detected_lang=detected, translated=translated))
                dirty = True
        if dirty:
            db.commit()
    return {"translations": out}
