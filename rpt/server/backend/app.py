"""
RPT server — веб-панель и API (FastAPI).

Разделы API:
  * /api/login, /api/logout            — вход администратора;
  * /api/robots ...                     — управление роботами (нужна авторизация);
  * /api/pairing ...                    — окно сопряжения (кнопка "Синхронизация");
  * /api/enroll ...                     — вызывается роботом при сопряжении;
  * WS /api/robots/{id}/ssh             — веб-терминал (xterm.js);
  * /api/robots/{id}/sftp/...           — файловый менеджер (SFTP).
"""

import asyncio
import io
import os
import secrets
import time

import asyncssh
from fastapi import (FastAPI, WebSocket, WebSocketDisconnect, Request, Response,
                     UploadFile, File, Form, HTTPException, Depends)
from fastapi.responses import (JSONResponse, StreamingResponse, FileResponse,
                               RedirectResponse)
from fastapi.staticfiles import StaticFiles

import database as db
import keymgr
import ssh_client

ADMIN_PASSWORD = os.environ.get("RPT_ADMIN_PASSWORD", "changeme")
HUB_PUBLIC_HOST = os.environ.get("RPT_HUB_PUBLIC_HOST", "")   # адрес/IP сервера
HUB_PUBLIC_PORT = int(os.environ.get("RPT_HUB_PORT", "2222"))
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

app = FastAPI(title="RPT Server")

# Активные админ-сессии: token -> expiry
_sessions = {}
SESSION_TTL = 12 * 3600


# --------------------------------------------------------------------------
# авторизация администратора
# --------------------------------------------------------------------------
def _new_session():
    tok = secrets.token_urlsafe(32)
    _sessions[tok] = time.time() + SESSION_TTL
    return tok


def _valid_session(tok):
    exp = _sessions.get(tok)
    if not exp:
        return False
    if exp < time.time():
        _sessions.pop(tok, None)
        return False
    return True


def require_admin(request: Request):
    tok = request.cookies.get("rpt_session")
    if not tok or not _valid_session(tok):
        raise HTTPException(status_code=401, detail="Требуется вход")
    return True


@app.post("/api/login")
async def login(request: Request):
    data = await request.json()
    if data.get("password") != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Неверный пароль")
    tok = _new_session()
    resp = JSONResponse({"ok": True})
    resp.set_cookie("rpt_session", tok, httponly=True, samesite="lax", max_age=SESSION_TTL)
    return resp


@app.post("/api/logout")
async def logout(request: Request):
    tok = request.cookies.get("rpt_session")
    _sessions.pop(tok, None)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("rpt_session")
    return resp


@app.get("/api/whoami")
async def whoami(request: Request):
    tok = request.cookies.get("rpt_session")
    return {"authenticated": bool(tok and _valid_session(tok))}


# --------------------------------------------------------------------------
# сопряжение (pairing) — кнопка "Синхронизация" на сервере
# --------------------------------------------------------------------------
@app.post("/api/pairing/enable")
async def pairing_enable(request: Request, _=Depends(require_admin)):
    code, expires = db.enable_pairing(ttl_seconds=600)
    return {
        "code": code,
        "expires": expires,
        "hub_host": HUB_PUBLIC_HOST,
        "hub_port": HUB_PUBLIC_PORT,
    }


@app.post("/api/pairing/disable")
async def pairing_disable(request: Request, _=Depends(require_admin)):
    db.clear_pairing()
    return {"ok": True}


@app.get("/api/pairing")
async def pairing_status(request: Request, _=Depends(require_admin)):
    p = db.get_pairing()
    p["hub_host"] = HUB_PUBLIC_HOST
    p["hub_port"] = HUB_PUBLIC_PORT
    return p


# --------------------------------------------------------------------------
# роботы (админ)
# --------------------------------------------------------------------------
def _robot_public(r):
    return {
        "id": r["id"],
        "serial": r["serial"],
        "name": r["name"],
        "status": r["status"],
        "assigned_port": r["assigned_port"],
        "notes": r["notes"],
        "ssh_user": r["ssh_user"],
        "online": bool(r["online"]),
        "last_seen": r["last_seen"],
        "created_at": r["created_at"],
    }


@app.get("/api/robots")
async def robots_list(request: Request, _=Depends(require_admin)):
    active = [_robot_public(r) for r in db.list_robots("active")]
    pending = [_robot_public(r) for r in db.list_robots("pending")]
    return {"robots": active, "pending": pending}


@app.post("/api/robots/{robot_id}/approve")
async def robot_approve(robot_id: int, request: Request, _=Depends(require_admin)):
    r = db.approve_robot(robot_id)
    if not r:
        raise HTTPException(404, "Робот не найден")
    keymgr.rebuild_authorized_keys(db.active_robots())
    return {"ok": True, "robot": _robot_public(r)}


@app.post("/api/robots/{robot_id}/reject")
async def robot_reject(robot_id: int, request: Request, _=Depends(require_admin)):
    db.reject_robot(robot_id)
    keymgr.rebuild_authorized_keys(db.active_robots())
    return {"ok": True}


@app.delete("/api/robots/{robot_id}")
async def robot_delete(robot_id: int, request: Request, _=Depends(require_admin)):
    db.delete_robot(robot_id)
    keymgr.rebuild_authorized_keys(db.active_robots())
    return {"ok": True}


@app.patch("/api/robots/{robot_id}")
async def robot_patch(robot_id: int, request: Request, _=Depends(require_admin)):
    data = await request.json()
    db.update_robot(robot_id, name=data.get("name"), notes=data.get("notes"))
    return {"ok": True, "robot": _robot_public(db.get_robot(robot_id))}


# --------------------------------------------------------------------------
# enrollment — вызывается роботом (кнопка "Синхронизация" на роботе)
# --------------------------------------------------------------------------
@app.post("/api/enroll")
async def enroll(request: Request):
    data = await request.json()
    code = str(data.get("code", ""))
    if not db.check_pairing_code(code):
        raise HTTPException(403, "Неверный или просроченный код сопряжения")
    serial = (data.get("serial") or "").strip()
    name = (data.get("name") or "").strip() or serial
    pub = (data.get("tunnel_pubkey") or "").strip()
    ssh_user = (data.get("ssh_user") or "RM").strip()
    if not serial or not pub:
        raise HTTPException(400, "Нужны serial и tunnel_pubkey")
    rid, token = db.create_enrollment(serial, name, pub, ssh_user)
    return {"enroll_id": rid, "token": token, "status": "pending"}


@app.get("/api/enroll/{robot_id}")
async def enroll_status(robot_id: int, token: str):
    r = db.get_robot(robot_id)
    if not r or not secrets.compare_digest(r["enroll_token"], token):
        raise HTTPException(403, "Неверный токен")
    result = {"status": r["status"]}
    if r["status"] == "active":
        result.update({
            "assigned_port": r["assigned_port"],
            "hub_host": HUB_PUBLIC_HOST,
            "hub_port": HUB_PUBLIC_PORT,
            "hub_hostkey": keymgr.hub_host_public_key(),
            "admin_pubkey": keymgr.admin_public_key(),
        })
    return result


@app.post("/api/heartbeat")
async def heartbeat(request: Request):
    data = await request.json()
    rid = data.get("enroll_id")
    token = data.get("token", "")
    r = db.get_robot(rid) if rid else None
    if not r or not secrets.compare_digest(r["enroll_token"], token):
        raise HTTPException(403, "Неверный токен")
    db.touch_heartbeat(rid)
    return {"ok": True}


# --------------------------------------------------------------------------
# веб-терминал (SSH через WebSocket)
# --------------------------------------------------------------------------
@app.websocket("/api/robots/{robot_id}/ssh")
async def ws_ssh(websocket: WebSocket, robot_id: int):
    # авторизация по cookie (WebSocket не проходит через Depends)
    tok = websocket.cookies.get("rpt_session")
    if not tok or not _valid_session(tok):
        await websocket.close(code=4401)
        return
    await websocket.accept()

    robot = db.get_robot(robot_id)
    if not robot or robot["status"] != "active":
        await websocket.send_text("\r\n[RPT] Робот не активен.\r\n")
        await websocket.close()
        return

    try:
        conn = await ssh_client.connect_robot(robot)
    except Exception as e:  # noqa
        await websocket.send_text(f"\r\n[RPT] Не удалось подключиться: {e}\r\n")
        await websocket.close()
        return

    try:
        # encoding=None -> работаем с байтами (безопасно для UTF-8 на границах чтения)
        proc = await conn.create_process(
            term_type="xterm-256color", term_size=(80, 24), encoding=None
        )
    except Exception as e:  # noqa
        await websocket.send_text(f"\r\n[RPT] Ошибка запуска shell: {e}\r\n")
        conn.close()
        await websocket.close()
        return

    async def pump_ssh_to_ws():
        try:
            while True:
                out = await proc.stdout.read(4096)
                if not out:            # b'' -> EOF (shell завершился)
                    break
                await websocket.send_bytes(out)
        except Exception:  # noqa
            pass

    async def pump_ws_to_ssh():
        try:
            while True:
                msg = await websocket.receive_text()
                if msg.startswith("\x00RESIZE"):
                    # формат: \x00RESIZE cols rows
                    try:
                        _, cols, rows = msg.split()
                        proc.change_terminal_size(int(cols), int(rows))
                    except Exception:  # noqa
                        pass
                    continue
                proc.stdin.write(msg.encode("utf-8", "ignore"))
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa
            pass

    reader = asyncio.create_task(pump_ssh_to_ws())
    writer = asyncio.create_task(pump_ws_to_ssh())
    try:
        await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        reader.cancel()
        writer.cancel()
        try:
            proc.terminate()
        except Exception:  # noqa
            pass
        conn.close()
        try:
            await websocket.close()
        except Exception:  # noqa
            pass


# --------------------------------------------------------------------------
# SFTP файловый менеджер
# --------------------------------------------------------------------------
async def _with_sftp(robot_id, fn):
    robot = db.get_robot(robot_id)
    if not robot or robot["status"] != "active":
        raise HTTPException(400, "Робот не активен")
    conn = await ssh_client.connect_robot(robot)
    try:
        async with conn.start_sftp_client() as sftp:
            return await fn(sftp)
    finally:
        conn.close()


@app.get("/api/robots/{robot_id}/sftp/list")
async def sftp_list(robot_id: int, request: Request, path: str = ".", _=Depends(require_admin)):
    async def _do(sftp):
        if path in (".", ""):
            base = await sftp.realpath(".")
        else:
            base = path
        entries = []
        for name in await sftp.listdir(base):
            if name in (".", ".."):
                continue
            full = base.rstrip("/") + "/" + name
            try:
                st = await sftp.stat(full)
                import stat as _stat
                is_dir = _stat.S_ISDIR(st.permissions or 0)
                entries.append({
                    "name": name,
                    "path": full,
                    "is_dir": is_dir,
                    "size": st.size or 0,
                    "mtime": st.mtime or 0,
                })
            except Exception:  # noqa
                entries.append({"name": name, "path": full, "is_dir": False,
                                "size": 0, "mtime": 0})
        entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
        return {"cwd": base, "entries": entries}
    try:
        return await _with_sftp(robot_id, _do)
    except HTTPException:
        raise
    except Exception as e:  # noqa
        raise HTTPException(500, f"SFTP: {e}")


@app.get("/api/robots/{robot_id}/sftp/download")
async def sftp_download(robot_id: int, request: Request, path: str, _=Depends(require_admin)):
    async def _do(sftp):
        f = await sftp.open(path, "rb")
        try:
            return await f.read()
        finally:
            await f.close()
    try:
        content = await _with_sftp(robot_id, _do)
    except HTTPException:
        raise
    except Exception as e:  # noqa
        raise HTTPException(500, f"SFTP: {e}")
    filename = os.path.basename(path) or "download"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/robots/{robot_id}/sftp/upload")
async def sftp_upload(robot_id: int, request: Request, path: str = Form(...),
                      file: UploadFile = File(...), _=Depends(require_admin)):
    content = await file.read()
    target = path.rstrip("/") + "/" + file.filename

    async def _do(sftp):
        f = await sftp.open(target, "wb")
        await f.write(content)
        await f.close()
        return {"ok": True, "path": target}
    try:
        return await _with_sftp(robot_id, _do)
    except HTTPException:
        raise
    except Exception as e:  # noqa
        raise HTTPException(500, f"SFTP: {e}")


@app.post("/api/robots/{robot_id}/sftp/mkdir")
async def sftp_mkdir(robot_id: int, request: Request, _=Depends(require_admin)):
    data = await request.json()
    path = data["path"]

    async def _do(sftp):
        await sftp.mkdir(path)
        return {"ok": True}
    try:
        return await _with_sftp(robot_id, _do)
    except HTTPException:
        raise
    except Exception as e:  # noqa
        raise HTTPException(500, f"SFTP: {e}")


@app.post("/api/robots/{robot_id}/sftp/delete")
async def sftp_delete(robot_id: int, request: Request, _=Depends(require_admin)):
    data = await request.json()
    path = data["path"]
    is_dir = data.get("is_dir", False)

    async def _do(sftp):
        if is_dir:
            await sftp.rmdir(path)
        else:
            await sftp.remove(path)
        return {"ok": True}
    try:
        return await _with_sftp(robot_id, _do)
    except HTTPException:
        raise
    except Exception as e:  # noqa
        raise HTTPException(500, f"SFTP: {e}")


# --------------------------------------------------------------------------
# фоновая проверка онлайн-статуса
# --------------------------------------------------------------------------
async def _status_loop():
    while True:
        try:
            for r in db.active_robots():
                online = await asyncio.get_event_loop().run_in_executor(
                    None, ssh_client.robot_tunnel_online, r)
                db.set_online(r["id"], online)
        except Exception:  # noqa
            pass
        await asyncio.sleep(15)


@app.on_event("startup")
async def _startup():
    db.init_db()
    keymgr.ensure_keys()
    keymgr.rebuild_authorized_keys(db.active_robots())
    asyncio.create_task(_status_loop())


# --------------------------------------------------------------------------
# статика (веб-панель)
# --------------------------------------------------------------------------
@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
