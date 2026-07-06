/* RPT — веб-панель. Логика: вход, список роботов, сопряжение, терминал, SFTP. */

const $ = (id) => document.getElementById(id);
let term = null, fitAddon = null, ws = null, sftpRobot = null, sftpCwd = ".";
let notesRobotId = null, pollTimer = null, pairingTimer = null;

/* -------------------- API helper -------------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  return res;
}
async function apiJson(path, opts) {
  const r = await api(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
const jsonPost = (path, body) => apiJson(path, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
});

/* -------------------- вход -------------------- */
function showLogin() {
  $("login").classList.remove("hidden");
  $("app").classList.add("hidden");
  if (pollTimer) clearInterval(pollTimer);
}
function showApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  refresh();
  pollTimer = setInterval(refresh, 5000);
}
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    await jsonPost("/api/login", { password: $("login-password").value });
    $("login-password").value = "";
    showApp();
  } catch (err) { $("login-error").textContent = "Неверный пароль"; }
});
$("logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showLogin();
});

/* -------------------- список роботов -------------------- */
async function refresh() {
  let data;
  try { data = await apiJson("/api/robots"); } catch { return; }
  renderPending(data.pending);
  renderRobots(data.robots);
}

function renderPending(pending) {
  const sec = $("pending-section"), list = $("pending-list");
  if (!pending.length) { sec.classList.add("hidden"); list.innerHTML = ""; return; }
  sec.classList.remove("hidden");
  list.innerHTML = "";
  for (const r of pending) {
    const el = document.createElement("div");
    el.className = "pending-item";
    el.innerHTML = `
      <div class="p-name">${esc(r.name)}</div>
      <div class="p-serial">SN: ${esc(r.serial)}</div>
      <div class="p-actions">
        <button class="btn-accept">✓ Принять</button>
        <button class="btn-reject">✕ Отклонить</button>
      </div>`;
    el.querySelector(".btn-accept").onclick = async () => {
      await jsonPost(`/api/robots/${r.id}/approve`); refresh();
    };
    el.querySelector(".btn-reject").onclick = async () => {
      await jsonPost(`/api/robots/${r.id}/reject`); refresh();
    };
    list.appendChild(el);
  }
}

function renderRobots(robots) {
  $("robot-count").textContent = robots.length ? `(${robots.length})` : "";
  const list = $("robot-list");
  list.innerHTML = "";
  if (!robots.length) {
    list.innerHTML = `<div class="muted" style="padding:12px 16px">Пока нет роботов.</div>`;
    return;
  }
  for (const r of robots) {
    const el = document.createElement("div");
    el.className = "robot-card";
    el.innerHTML = `
      <div class="robot-head">
        <span class="dot ${r.online ? "on" : "off"}" title="${r.online ? "онлайн" : "оффлайн"}"></span>
        <span class="robot-name">${esc(r.name)}</span>
      </div>
      <div class="robot-serial">SN: ${esc(r.serial)} · порт ${r.assigned_port ?? "—"}</div>
      ${r.notes ? `<div class="robot-notes">${esc(r.notes)}</div>` : ""}
      <div class="robot-actions">
        <button class="b-ssh"  ${r.online ? "" : "disabled"}>SSH</button>
        <button class="b-sftp" ${r.online ? "" : "disabled"}>SFTP</button>
        <button class="b-note">✎</button>
        <button class="b-del">🗑</button>
      </div>`;
    el.querySelector(".b-ssh").onclick = () => openTerminal(r);
    el.querySelector(".b-sftp").onclick = () => openSftp(r);
    el.querySelector(".b-note").onclick = () => openNotes(r);
    el.querySelector(".b-del").onclick = async () => {
      if (confirm(`Удалить робота «${r.name}»?`)) { await api(`/api/robots/${r.id}`, { method: "DELETE" }); refresh(); }
    };
    list.appendChild(el);
  }
}

/* -------------------- сопряжение -------------------- */
$("sync-btn").addEventListener("click", async () => {
  const info = await jsonPost("/api/pairing/enable");
  showPairing(info);
});
function showPairing(info) {
  const box = $("pairing-info");
  box.classList.remove("hidden");
  if (pairingTimer) clearInterval(pairingTimer);
  const render = () => {
    const left = Math.max(0, info.expires - Math.floor(Date.now() / 1000));
    if (left <= 0) { box.classList.add("hidden"); clearInterval(pairingTimer); return; }
    box.innerHTML = `
      <div class="hint">Код сопряжения (введите на роботе):</div>
      <div class="code">${info.code}</div>
      <div class="hint">Сервер: ${esc(info.hub_host || "—")} : ${info.hub_port}</div>
      <div class="timer">Действует ещё ${left} c</div>`;
  };
  render();
  pairingTimer = setInterval(render, 1000);
}

/* -------------------- терминал (SSH) -------------------- */
function hideViews() {
  $("welcome").classList.add("hidden");
  $("terminal-view").classList.add("hidden");
  $("sftp-view").classList.add("hidden");
}
function closeTerminal() {
  if (ws) { ws.close(); ws = null; }
  if (term) { term.dispose(); term = null; }
  $("terminal-view").classList.add("hidden");
  $("welcome").classList.remove("hidden");
}
$("term-close").addEventListener("click", closeTerminal);

function openTerminal(robot) {
  hideViews();
  $("terminal-view").classList.remove("hidden");
  $("term-title").textContent = `SSH · ${robot.name} (${robot.ssh_user}@${robot.serial})`;
  if (term) term.dispose();
  term = new Terminal({ cursorBlink: true, fontSize: 14, theme: { background: "#000000" } });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($("terminal"));
  fitAddon.fit();

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/api/robots/${robot.id}/ssh`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    term.writeln("\x1b[36m[RPT] Подключение к роботу...\x1b[0m");
    sendResize();
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
    else term.write(ev.data);          // текстовые служебные сообщения от сервера
  };
  ws.onclose = () => term && term.writeln("\r\n\x1b[31m[RPT] Соединение закрыто.\x1b[0m");
  term.onData((d) => ws && ws.readyState === 1 && ws.send(d));
  const sendResize = () => {
    if (ws && ws.readyState === 1) ws.send(`\x00RESIZE ${term.cols} ${term.rows}`);
  };
  term.onResize(sendResize);
  window.onresize = () => { if (fitAddon) { fitAddon.fit(); sendResize(); } };
  setTimeout(() => { fitAddon.fit(); sendResize(); }, 100);
}

/* -------------------- SFTP -------------------- */
$("sftp-close").addEventListener("click", () => {
  $("sftp-view").classList.add("hidden");
  $("welcome").classList.remove("hidden");
});
function openSftp(robot) {
  hideViews();
  $("sftp-view").classList.remove("hidden");
  sftpRobot = robot;
  $("sftp-title").textContent = `SFTP · ${robot.name}`;
  loadSftp(".");
}
async function loadSftp(path) {
  try {
    const data = await apiJson(`/api/robots/${sftpRobot.id}/sftp/list?path=${encodeURIComponent(path)}`);
    sftpCwd = data.cwd;
    $("sftp-path").textContent = data.cwd;
    const body = $("sftp-body");
    body.innerHTML = "";
    for (const e of data.entries) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="sftp-name ${e.is_dir ? "dir" : ""}">${e.is_dir ? "📁 " : "📄 "}${esc(e.name)}</span></td>
        <td>${e.is_dir ? "" : humanSize(e.size)}</td>
        <td>${e.mtime ? new Date(e.mtime * 1000).toLocaleString() : ""}</td>
        <td style="text-align:right">
          ${e.is_dir ? "" : `<span class="sftp-dl">⬇</span>`}
          <span class="sftp-rm">🗑</span>
        </td>`;
      tr.querySelector(".sftp-name").onclick = () => { if (e.is_dir) loadSftp(e.path); };
      const dl = tr.querySelector(".sftp-dl");
      if (dl) dl.onclick = () => window.open(
        `/api/robots/${sftpRobot.id}/sftp/download?path=${encodeURIComponent(e.path)}`, "_blank");
      tr.querySelector(".sftp-rm").onclick = async () => {
        if (confirm(`Удалить ${e.name}?`)) {
          await jsonPost(`/api/robots/${sftpRobot.id}/sftp/delete`, { path: e.path, is_dir: e.is_dir });
          loadSftp(sftpCwd);
        }
      };
      body.appendChild(tr);
    }
  } catch (err) { alert("SFTP: " + err.message); }
}
$("sftp-up").addEventListener("click", () => {
  const parent = sftpCwd.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
  loadSftp(parent);
});
$("sftp-mkdir").addEventListener("click", async () => {
  const name = prompt("Имя новой папки:");
  if (!name) return;
  await jsonPost(`/api/robots/${sftpRobot.id}/sftp/mkdir`, { path: sftpCwd.replace(/\/+$/, "") + "/" + name });
  loadSftp(sftpCwd);
});
$("sftp-upload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("path", sftpCwd);
  fd.append("file", file);
  await api(`/api/robots/${sftpRobot.id}/sftp/upload`, { method: "POST", body: fd });
  e.target.value = "";
  loadSftp(sftpCwd);
});

/* -------------------- заметки -------------------- */
function openNotes(robot) {
  notesRobotId = robot.id;
  $("notes-title").textContent = `Заметки · ${robot.name}`;
  $("notes-name").value = robot.name;
  $("notes-text").value = robot.notes || "";
  $("notes-modal").classList.remove("hidden");
}
$("notes-cancel").addEventListener("click", () => $("notes-modal").classList.add("hidden"));
$("notes-save").addEventListener("click", async () => {
  await api(`/api/robots/${notesRobotId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: $("notes-name").value, notes: $("notes-text").value }),
  });
  $("notes-modal").classList.add("hidden");
  refresh();
});

/* -------------------- утилиты -------------------- */
function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
function humanSize(n) {
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/* -------------------- старт -------------------- */
(async () => {
  try {
    const w = await apiJson("/api/whoami");
    if (w.authenticated) showApp(); else showLogin();
  } catch { showLogin(); }
})();
