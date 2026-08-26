"""Smart translator: server-side proxy to free translation endpoints with a
permanent database cache. The frontend sends batches of user-generated texts
(task titles, comments, chat messages) and gets them back in the viewer's
interface language. Each unique (text, target) pair hits an external service
exactly once — afterwards it is a cheap indexed SELECT.

Several providers are tried in turn: the free endpoints are unofficial and any
one of them can start answering 429 at any time, so a single dead provider must
not take the whole feature down. Texts are sent in batches, which keeps the
number of outbound requests (and the odds of being rate-limited) low.
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
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"

# One outbound request carries at most this many texts / characters.
BATCH_ITEMS = 10
BATCH_CHARS = 1500


class TrItem(BaseModel):
    id: str
    text: str = ""


class TranslateIn(BaseModel):
    target: str
    items: list[TrItem]


def _q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def _http_json(url: str, timeout: int = 12):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf8"))


def _guess_lang(text: str) -> str:
    """Rough source-language guess for providers that cannot auto-detect."""
    for ch in text:
        o = ord(ch)
        if 0x0400 <= o <= 0x04FF:
            return "ru"
        if 0x3400 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF:
            return "zh-CN"
    return "en"


def _google_chrome(texts: list[str], target: str):
    """Batch endpoint: one request for the whole chunk. -> [(translated, detected)]"""
    qs = "&".join("q=" + _q(t) for t in texts)
    url = (f"https://translate.googleapis.com/translate_a/t"
           f"?client=dict-chrome-ex&sl=auto&tl={_q(target)}&{qs}")
    data = _http_json(url)
    if data and isinstance(data[0], str):  # a lone text may come back unwrapped
        data = [data]
    out = []
    for row in data:
        if isinstance(row, str):
            out.append((row, None))
        else:
            out.append((row[0], row[1] if len(row) > 1 else None))
    if len(out) != len(texts):
        raise ValueError(f"expected {len(texts)} results, got {len(out)}")
    return out


def _google_gtx(texts: list[str], target: str):
    """Older single-text endpoint, kept as a fallback."""
    out = []
    for text in texts:
        url = (f"https://translate.googleapis.com/translate_a/single"
               f"?client=gtx&sl=auto&tl={_q(target)}&dt=t&q={_q(text)}")
        data = _http_json(url)
        translated = "".join(seg[0] for seg in data[0] if seg and seg[0])
        out.append((translated, data[2] if len(data) > 2 else None))
    return out


def _mymemory(texts: list[str], target: str):
    """Independent provider (not Google), used when both endpoints above fail."""
    out = []
    for text in texts:
        src = _guess_lang(text)
        if src == target:
            out.append((text, src))
            continue
        url = (f"https://api.mymemory.translated.net/get"
               f"?q={_q(text[:500])}&langpair={_q(src)}|{_q(target)}")
        data = _http_json(url)
        translated = ((data or {}).get("responseData") or {}).get("translatedText")
        if not translated:
            raise ValueError("empty response")
        out.append((translated, src))
    return out


PROVIDERS = [("google-chrome", _google_chrome), ("google-gtx", _google_gtx), ("mymemory", _mymemory)]


def _translate_batch(texts: list[str], target: str):
    """Try providers in order; the first one that answers wins. None if all fail."""
    for name, fn in PROVIDERS:
        try:
            results = fn(texts, target)
            if name != PROVIDERS[0][0]:
                log.info("Translate: served by fallback provider %s", name)
            return results
        except Exception as exc:  # noqa: BLE001
            log.warning("Translate provider %s failed: %s", name, exc)
    return None


def _slices(pending):
    """Split pending work into outbound requests of a sane size."""
    batch, chars = [], 0
    for entry in pending:
        size = len(entry[1])
        if batch and (len(batch) >= BATCH_ITEMS or chars + size > BATCH_CHARS):
            yield batch
            batch, chars = [], 0
        batch.append(entry)
        chars += size
    if batch:
        yield batch


def _key(target: str, text: str) -> str:
    return hashlib.sha256(f"{target}:{text}".encode("utf8")).hexdigest()


@router.post("/translate")
def translate(data: TranslateIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if data.target not in SUPPORTED:
        raise HTTPException(status_code=400, detail="Unsupported target language")
    g_target = SUPPORTED[data.target]

    out = {}
    failed = []
    pending = []  # (item_id, text, hash) not in cache yet
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

    stored = set()
    dirty = False
    for batch in _slices(pending):
        results = _translate_batch([b[1] for b in batch], g_target)
        if results is None:  # every provider is down — say so instead of pretending
            for item_id, text, _h in batch:
                out[item_id] = text
                failed.append(item_id)
            continue
        for (item_id, text, h), (translated, detected) in zip(batch, results):
            # Text already in the target language — keep the original wording.
            if detected and detected.split("-")[0].lower() == data.target:
                translated = text
            out[item_id] = translated
            if h not in stored:  # the same text may repeat within one batch
                stored.add(h)
                db.add(TranslationCache(key_hash=h, target_lang=data.target,
                                        detected_lang=detected, translated=translated))
                dirty = True
    if dirty:
        db.commit()
    return {"translations": out, "failed": failed}
