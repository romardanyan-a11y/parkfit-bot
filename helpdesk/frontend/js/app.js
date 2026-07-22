// ===========================================================================
// HelpDesk SPA
// ===========================================================================
const state = {
  me: null,
  settings: { palette: {}, app_name: "HelpDesk" },
  view: "catalog",
  authMode: "login", // login | register
  currentDept: null,
  currentTask: null,
  notifCount: 0,
  aliases: {},   // { targetUserId: {alias, display} } — personal, private nicknames
  activity: { total: 0, departments: {}, tasks: {} },  // unread-activity counters
  chatUnread: 0,
  currentConvId: null,
  navTabs: { catalog: true, archive: true, chat: true, directory: true },
};

const STATUSES = ["open", "in_progress", "need_info", "resolved", "closed"];
const PRIORITIES = ["trivial", "minor", "normal", "major", "critical", "blocker"];
const TYPES = ["task", "bug", "incident", "request"];
const PALETTE_KEYS = ["primary", "primary_hover", "accent", "bg", "surface", "text", "muted", "border", "sidebar", "sidebar_text"];

const $ = (sel) => document.querySelector(sel);
const app = () => document.getElementById("app");
const t = (k) => I18N.t(k);

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function localeCode() {
  return I18N.lang === "zh" ? "zh-CN" : I18N.lang === "en" ? "en-US" : "ru-RU";
}

// The server stores naive UTC timestamps (no timezone suffix). A browser would
// otherwise read them as local time — the cause of the -3h shift. Force UTC.
function parseServerDate(s) {
  if (!s) return null;
  let iso = String(s);
  if (!/([zZ]|[+-]\d\d:?\d\d)$/.test(iso)) iso += "Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function tzParts(d, tz) {
  const loc = localeCode();
  return {
    date: d.toLocaleDateString(loc, { timeZone: tz, day: "2-digit", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString(loc, { timeZone: tz, hour: "2-digit", minute: "2-digit" }),
  };
}

// Show every timestamp in BOTH Moscow and Beijing time, each clearly labelled.
function fmtDate(s) {
  const d = parseServerDate(s);
  if (!d) return "—";
  const m = tzParts(d, "Europe/Moscow");
  const c = tzParts(d, "Asia/Shanghai");
  const MSK = `<span class="tzc">${t("tz.msk")}</span>`;
  const CN = `<span class="tzc cn">${t("tz.cn")}</span>`;
  if (m.date === c.date) {
    // Same calendar day in both zones — show the date once.
    return `<span class="dt"><span class="dt-part">${m.date} · <b>${m.time}</b> ${MSK}</span> <span class="dt-part">· <b>${c.time}</b> ${CN}</span></span>`;
  }
  // Crosses midnight between zones — show each zone's own date to avoid confusion.
  return `<span class="dt"><span class="dt-part">${m.date}, <b>${m.time}</b> ${MSK}</span> <span class="dt-part">· ${c.date}, <b>${c.time}</b> ${CN}</span></span>`;
}

// Date-only (e.g. a due date) — a deadline is a day, shown in Moscow time.
function fmtDay(s) {
  const d = parseServerDate(s);
  if (!d) return "—";
  return d.toLocaleDateString(localeCode(), { timeZone: "Europe/Moscow", day: "2-digit", month: "short", year: "numeric" });
}

// Resolve the name to show for a user: a personal alias (if set + enabled)
// overrides the real name, but only for the person who created that alias.
function displayName(u) {
  if (!u) return "";
  const a = state.aliases[u.id];
  if (a && a.display && a.alias) return a.alias;
  return u.full_name || u.email;
}

// Round avatar: the user's photo, or their initial on a colored circle.
function avaHtml(u, size) {
  size = size || 22;
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px`;
  if (u && u.avatar_name) {
    return `<img class="ava" style="${style}" alt=""
      src="/api/users/${u.id}/avatar?token=${encodeURIComponent(API.token)}&v=${encodeURIComponent(u.avatar_name)}" />`;
  }
  const ch = ((u && (displayName(u) || "?")) || "?").trim().charAt(0).toUpperCase() || "?";
  const hue = u ? (u.id * 57) % 360 : 0;
  return `<span class="ava ava-init" style="${style};background:hsl(${hue},45%,48%)">${esc(ch)}</span>`;
}

// Group avatar (photo or 👥 circle).
function groupAvaHtml(conv, size) {
  size = size || 34;
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px`;
  if (conv.avatar_name) {
    return `<img class="ava" style="${style}" alt=""
      src="/api/chat/conversations/${conv.id}/avatar?token=${encodeURIComponent(API.token)}&v=${encodeURIComponent(conv.avatar_name)}" />`;
  }
  const hue = (conv.id * 83) % 360;
  return `<span class="ava ava-init" style="${style};background:hsl(${hue},40%,45%)">${conv.type === "group" ? "👥" : "?"}</span>`;
}

// Render a user's name with a round avatar miniature on the left;
// observers stay highlighted everywhere they appear.
function userLabel(u) {
  if (!u) return "—";
  const name = esc(displayName(u));
  const inner = u.role === "observer"
    ? `<span class="observer-label" title="${t("admin.role_observer")}">👁 ${name}</span>`
    : name;
  return `<span class="ulab">${avaHtml(u, 20)}${inner}</span>`;
}

// Plain-text variant for <option> labels (no HTML rendering there).
function userOptionText(u) {
  return (u.role === "observer" ? "👁 " : "") + displayName(u);
}

async function loadAliases() {
  try {
    const list = await API.get("/api/aliases");
    state.aliases = {};
    list.forEach((a) => { state.aliases[a.target_id] = a; });
  } catch (e) {
    state.aliases = {};
  }
}

// Localized job-title name for the current interface language, with fallback.
function posName(p) {
  if (!p) return "";
  return p["name_" + I18N.lang] || p.name_ru || p.name_en || p.name_zh || "";
}

// ---------- Activity / unread counters ----------
let activityTimer = null;

async function fetchActivity() {
  try {
    state.activity = await API.get("/api/activity");
  } catch (e) { /* keep previous */ }
  setNavDot("catalog", state.activity.total > 0);
}

// A simple red dot in a sidebar nav item (no number).
function setNavDot(view, on) {
  const item = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (!item) return;
  let dot = item.querySelector(".act-dot");
  if (on) {
    if (!dot) {
      dot = document.createElement("span");
      dot.className = "act-dot";
      item.appendChild(dot);
    }
  } else if (dot) {
    dot.remove();
  }
}

// Toggle the inline dots (department cards, task rows) from state, no re-render.
function refreshActivityUI() {
  setNavDot("catalog", state.activity.total > 0);
  document.querySelectorAll("[id^='depdot-']").forEach((el) => {
    el.hidden = !(state.activity.departments[el.id.replace("depdot-", "")] || 0);
  });
  document.querySelectorAll("[id^='taskdot-']").forEach((el) => {
    el.hidden = !(state.activity.tasks[el.id.replace("taskdot-", "")] || 0);
  });
}

function actDot(count, id) {
  return `<span class="act-dot" id="${id}"${count ? "" : " hidden"}></span>`;
}

// Mark a task read: clear its dot immediately (optimistic) AND persist, so the
// dot never lingers due to a slow request / navigation race.
async function markTaskSeen(task) {
  const c = state.activity.tasks[task.id] || 0;
  if (c) {
    delete state.activity.tasks[task.id];
    const dep = task.department_id;
    const left = (state.activity.departments[dep] || 0) - c;
    if (left > 0) state.activity.departments[dep] = left;
    else delete state.activity.departments[dep];
    state.activity.total = Math.max(0, state.activity.total - c);
    refreshActivityUI();
  }
  try { await API.post(`/api/tasks/${task.id}/seen`); } catch (e) { /* ignore */ }
}

async function fetchChatUnread() {
  try {
    const r = await API.get("/api/chat/unread");
    state.chatUnread = r.total || 0;
  } catch (e) { /* keep previous */ }
  setNavDot("chat", state.chatUnread > 0);
}

// Which sidebar tabs this user may see (admin can hide tabs from regulars).
async function fetchNavTabs() {
  try {
    const r = await API.get("/api/settings/nav");
    state.navTabs = r.tabs || state.navTabs;
  } catch (e) { /* keep previous */ }
}

function startActivityPolling() {
  if (activityTimer) return;
  activityTimer = setInterval(async () => {
    if (!state.me) return;
    await fetchActivity();
    refreshActivityUI();
    await fetchChatUnread();
    await fetchNavTabs();  // pick up admin toggles without re-login
  }, 30000);
}

function applyPalette(p) {
  const r = document.documentElement.style;
  const map = {
    primary: "--primary", primary_hover: "--primary-hover", accent: "--accent",
    bg: "--bg", surface: "--surface", text: "--text", muted: "--muted",
    border: "--border", sidebar: "--sidebar", sidebar_text: "--sidebar-text",
  };
  for (const k in map) if (p[k]) r.setProperty(map[k], p[k]);
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------
async function setLang(lang) {
  await I18N.load(lang);
  if (state.me) {
    try {
      const u = await API.put("/api/auth/me/language", { language: lang });
      state.me = u;
    } catch (e) { /* ignore */ }
  }
  render();
}

function langSwitcher(cls) {
  return `<div class="${cls}">` + I18N.supported.map((l) =>
    `<button class="lang-btn ${I18N.lang === l ? "active" : ""}" data-lang="${l}">${esc(I18N.langName(l))}</button>`
  ).join("") + `</div>`;
}

function wireLangSwitcher() {
  document.querySelectorAll("[data-lang]").forEach((b) =>
    b.addEventListener("click", () => setLang(b.dataset.lang)));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  await preloadLanguages();
  try {
    const s = await API.get("/api/settings");
    state.settings = s;
    applyPalette(s.palette);
  } catch (e) { /* ignore */ }

  if (API.token) {
    try {
      state.me = await API.get("/api/auth/me");
      if (state.me.preferred_language && state.me.preferred_language !== I18N.lang) {
        await I18N.load(state.me.preferred_language);
      }
      await loadAliases();
      await fetchNavTabs();
      await fetchActivity();
      await fetchChatUnread();
      startActivityPolling();
    } catch (e) {
      API.setToken(null);
      state.me = null;
    }
  }
  render();
}

// ---------------------------------------------------------------------------
// Router / render
// ---------------------------------------------------------------------------
function render() {
  if (!state.me) return renderAuth();
  // A user with a temporary password is trapped on this screen until they set
  // a permanent one — every render routes here, so it cannot be skipped.
  if (state.me.must_change_password) return renderForcePassword();
  renderShell();
}

// ---------- Forced password change (temporary password) ----------
function renderForcePassword() {
  app().innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <h1>${esc(state.settings.app_name || "HelpDesk")}</h1>
        <div class="sub">${t("password.force_title")}</div>
        <div class="msg info">${t("password.force_message")}</div>
        <div id="fp-msg"></div>
        <div class="field"><label>${t("password.new")}</label><input id="fp-new" type="password" autocomplete="new-password" /></div>
        <div class="field"><label>${t("password.confirm")}</label><input id="fp-confirm" type="password" autocomplete="new-password" /></div>
        <button class="btn" id="fp-save" style="width:100%;justify-content:center">${t("password.save")}</button>
        ${langSwitcher("auth-lang")}
      </div>
    </div>`;
  wireLangSwitcher();
  const submit = async () => {
    const p1 = $("#fp-new").value, p2 = $("#fp-confirm").value;
    const err = (msg) => { $("#fp-msg").innerHTML = `<div class="msg error">${esc(msg)}</div>`; };
    if (p1.length < 6) return err(t("password.too_short"));
    if (p1 !== p2) return err(t("password.mismatch"));
    try {
      state.me = await API.put("/api/auth/me/password", { new_password: p1 });
      state.view = "catalog";
      render();
    } catch (e) {
      err(e.message || t("common.error"));
    }
  };
  $("#fp-save").onclick = submit;
  $("#fp-confirm").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

// ---------- Auth ----------
function renderAuth() {
  const isLogin = state.authMode === "login";
  app().innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <h1>${esc(state.settings.app_name || "HelpDesk")}</h1>
        <div class="sub">${t("login.subtitle")}</div>
        <div id="auth-msg"></div>
        ${isLogin ? loginForm() : registerForm()}
        ${langSwitcher("auth-lang")}
      </div>
    </div>`;
  wireLangSwitcher();
  if (isLogin) wireLogin(); else wireRegister();
}

function loginForm() {
  return `
    <div class="field"><label>${t("login.email")}</label><input id="l-email" type="email" autocomplete="username" /></div>
    <div class="field"><label>${t("login.password")}</label><input id="l-pass" type="password" autocomplete="current-password" /></div>
    <button class="btn" id="l-submit" style="width:100%;justify-content:center">${t("login.sign_in")}</button>
    <div style="text-align:center;margin-top:14px">
      <button class="link-btn" id="to-register">${t("login.to_register")}</button>
    </div>`;
}

function registerForm() {
  return `
    <div class="field"><label>${t("login.full_name")}</label><input id="r-name" type="text" /></div>
    <div class="field"><label>${t("login.email")}</label><input id="r-email" type="email" /></div>
    <div class="field"><label>${t("login.password")}</label><input id="r-pass" type="password" /></div>
    <div class="field"><label>${t("login.description")}</label><textarea id="r-desc"></textarea></div>
    <button class="btn" id="r-submit" style="width:100%;justify-content:center">${t("login.submit_register")}</button>
    <div style="text-align:center;margin-top:14px">
      <button class="link-btn" id="to-login">${t("login.back_to_login")}</button>
    </div>`;
}

function authMsg(text, type) {
  $("#auth-msg").innerHTML = `<div class="msg ${type}">${esc(text)}</div>`;
}

function wireLogin() {
  $("#to-register").onclick = () => { state.authMode = "register"; renderAuth(); };
  $("#l-submit").onclick = async () => {
    const email = $("#l-email").value.trim();
    const pass = $("#l-pass").value;
    try {
      const data = await API.login(email, pass);
      API.setToken(data.access_token);
      state.me = await API.get("/api/auth/me");
      if (state.me.preferred_language) await I18N.load(state.me.preferred_language);
      await loadAliases();
      await fetchNavTabs();
      await fetchActivity();
      await fetchChatUnread();
      startActivityPolling();
      state.view = "catalog";
      render();
    } catch (e) {
      const m = /pending/i.test(e.message) ? t("login.pending_login") : t("login.invalid");
      authMsg(m, "error");
    }
  };
}

function wireRegister() {
  $("#to-login").onclick = () => { state.authMode = "login"; renderAuth(); };
  $("#r-submit").onclick = async () => {
    try {
      await API.post("/api/auth/register", {
        full_name: $("#r-name").value.trim(),
        email: $("#r-email").value.trim(),
        password: $("#r-pass").value,
        description: $("#r-desc").value.trim(),
        preferred_language: I18N.lang,
      });
      state.authMode = "login";
      renderAuth();
      authMsg(t("login.pending_message"), "info");
    } catch (e) {
      authMsg(e.message || t("common.error"), "error");
    }
  };
}

// ---------- Shell (logged in) ----------
async function refreshNotifCount() {
  if (state.me.role !== "admin") { state.notifCount = 0; return; }
  try {
    const list = await API.get("/api/notifications?unread=true");
    state.notifCount = list.length;
  } catch (e) { state.notifCount = 0; }
}

function renderShell() {
  const isAdmin = state.me.role === "admin";
  let nav = [
    { key: "catalog", label: t("nav.catalog"), dot: state.activity.total > 0 },
    { key: "archive", label: t("nav.archive") },
    { key: "chat", label: t("nav.chat"), dot: state.chatUnread > 0 },
    { key: "directory", label: t("nav.users") },  // public staff directory, everyone
  ];
  // Admin-hidden tabs (admins/exempt users get all-true from the server).
  if (!isAdmin) {
    nav = nav.filter((n) => state.navTabs[n.key] !== false);
    if (!nav.some((n) => n.key === state.view) && ["catalog", "archive", "chat", "directory"].includes(state.view)) {
      state.view = nav.length ? nav[0].key : "catalog";
    }
  }
  if (isAdmin) {
    nav.push({ key: "requests", label: t("nav.requests"), badge: state.notifCount });
    nav.push({ key: "users", label: t("nav.manage_users") });
    nav.push({ key: "settings", label: t("nav.settings") });
  }

  const appName = esc(state.settings.app_name || "HelpDesk");
  app().innerHTML = `
    <div class="layout" id="layout">
      <div class="nav-backdrop" id="nav-backdrop"></div>
      <aside class="sidebar">
        <div class="brand">${appName}</div>
        <nav>
          ${nav.map((n) => `
            <a class="nav-item ${state.view === n.key ? "active" : ""}" data-view="${n.key}">
              <span class="label">${esc(n.label)}</span>
              ${n.badge ? `<span class="nav-badge">${n.badge}</span>` : ""}
              ${n.dot ? `<span class="act-dot"></span>` : ""}
            </a>`).join("")}
        </nav>
        <div class="sidebar-footer">
          ${langSwitcher("sidebar-lang")}
          <a class="nav-item" data-logout><span class="label">${t("nav.logout")}</span></a>
          <div style="padding:8px 12px;font-size:12px;opacity:0.7">${esc(state.me.email)}</div>
        </div>
      </aside>
      <div class="content">
        <header class="mobile-topbar">
          <button class="hamburger" id="nav-toggle" aria-label="menu">☰</button>
          <span class="mtb-title">${appName}</span>
        </header>
        <main class="main" id="main"></main>
      </div>
    </div>`;

  const layout = document.getElementById("layout");
  const closeDrawer = () => layout.classList.remove("nav-open");
  $("#nav-toggle").addEventListener("click", () => layout.classList.toggle("nav-open"));
  $("#nav-backdrop").addEventListener("click", closeDrawer);

  document.querySelectorAll("[data-view]").forEach((el) =>
    el.addEventListener("click", () => { closeDrawer(); state.view = el.dataset.view; state.currentDept = null; state.currentTask = null; renderMain(); }));
  $("[data-logout]").addEventListener("click", logout);
  wireLangSwitcher();
  renderMain();
}

function logout() {
  API.setToken(null);
  state.me = null;
  state.authMode = "login";
  state.activity = { total: 0, departments: {}, tasks: {} };
  state.chatUnread = 0;
  state.currentConvId = null;
  if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
  render();
}

async function renderMain() {
  // Leaving the chat view stops its message polling.
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }

  // Update sidebar active state
  document.querySelectorAll(".nav-item[data-view]").forEach((el) =>
    el.classList.toggle("active", el.dataset.view === state.view && !state.currentDept && !state.currentTask));

  const main = $("#main");
  main.innerHTML = `<div class="empty-state">${t("common.loading")}</div>`;

  try {
    if (state.currentTask) return await viewTaskDetail(main);
    if (state.currentDept) return await viewDepartment(main);
    switch (state.view) {
      case "catalog": return await viewCatalog(main);
      case "archive": return await viewArchive(main);
      case "chat": return await viewChat(main);
      case "directory": return await viewDirectory(main);
      case "requests": return await viewRequests(main);
      case "users": return await viewUsers(main);
      case "settings": return await viewSettings(main);
      default: return await viewCatalog(main);
    }
  } catch (e) {
    main.innerHTML = `<div class="msg error">${esc(e.message || t("common.error"))}</div>`;
  }
}

// ---------- Catalog ----------
async function viewCatalog(main) {
  const isAdmin = state.me.role === "admin";
  const deps = await API.get("/api/departments");
  main.innerHTML = `
    <div class="topbar">
      <h2>${t("catalog.title")}</h2>
      ${isAdmin ? `<button class="btn" id="new-dept">+ ${t("catalog.new_department")}</button>` : ""}
    </div>
    ${deps.length === 0
      ? `<div class="empty-state">${isAdmin ? t("catalog.empty") : t("catalog.empty_agent")}</div>`
      : `<div class="grid">${deps.map(depCard).join("")}</div>`}`;

  if (isAdmin) $("#new-dept").onclick = () => openDeptModal();
  deps.forEach((d) => {
    $(`#dep-${d.id}`).onclick = () => { state.currentDept = d; renderMain(); };
    if (isAdmin) {
      $(`#dep-edit-${d.id}`).onclick = (e) => { e.stopPropagation(); openDeptModal(d); };
      $(`#dep-del-${d.id}`).onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(t("common.confirm_delete"))) return;
        await API.del(`/api/departments/${d.id}`);
        renderMain();
      };
    }
  });
}

function depCard(d) {
  const isAdmin = state.me.role === "admin";
  return `
    <div class="card" id="dep-${d.id}">
      <h3>${esc(d.name)}${actDot(state.activity.departments[d.id], "depdot-" + d.id)}</h3>
      <div class="desc">${esc(d.description || "")}</div>
      <div class="stats">
        <span>${t("catalog.open_tasks")}: <b>${d.open_tasks}</b></span>
        <span>${t("catalog.total_tasks")}: <b>${d.total_tasks}</b></span>
      </div>
      ${isAdmin ? `<div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn secondary small" id="dep-edit-${d.id}">${t("common.edit")}</button>
        <button class="btn danger small" id="dep-del-${d.id}">${t("common.delete")}</button>
      </div>` : ""}
    </div>`;
}

function openDeptModal(dep) {
  const editing = !!dep;
  openModal(`
    <h3>${editing ? t("common.edit") : t("catalog.new_department")}</h3>
    <div class="field"><label>${t("catalog.dept_name")}</label>
      <input id="d-name" value="${esc(dep ? dep.name : "")}" placeholder="${t("catalog.example")}" /></div>
    <div class="field"><label>${t("catalog.dept_desc")}</label>
      <textarea id="d-desc">${esc(dep ? dep.description : "")}</textarea></div>
    <div class="modal-actions">
      <button class="btn secondary" data-close>${t("common.cancel")}</button>
      <button class="btn" id="d-save">${t("common.save")}</button>
    </div>`);
  $("#d-save").onclick = async () => {
    const body = { name: $("#d-name").value.trim(), description: $("#d-desc").value.trim() };
    if (!body.name) return;
    if (editing) await API.put(`/api/departments/${dep.id}`, body);
    else await API.post("/api/departments", body);
    closeModal();
    renderMain();
  };
}

// ---------- Department (task list) ----------
function currentFilters() {
  if (!state._filters) state._filters = { q: "", status: "", priority: "", type: "", tag: "" };
  return state._filters;
}

async function viewDepartment(main) {
  const dep = state.currentDept;
  const f = currentFilters();
  const allTags = await API.get("/api/tags");

  let url = `/api/departments/${dep.id}/tasks?archived=false`;
  if (f.status) url += `&status=${f.status}`;
  if (f.priority) url += `&priority=${f.priority}`;
  if (f.type) url += `&type=${f.type}`;
  if (f.tag) url += `&tag_id=${f.tag}`;
  if (f.q) url += `&q=${encodeURIComponent(f.q)}`;
  const tasks = await API.get(url);

  main.innerHTML = `
    <div class="topbar">
      <div>
        <a class="link-btn" id="back-cat">← ${t("nav.catalog")}</a>
        <h2 style="margin-top:6px">${esc(dep.name)}</h2>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn secondary" id="manage-tags">🏷 ${t("tasks.create_tag")}</button>
        <button class="btn" id="new-task">+ ${t("tasks.new_task")}</button>
      </div>
    </div>
    <div class="toolbar">
      <input id="f-search" placeholder="${t("common.search")}" value="${esc(f.q)}" style="min-width:180px" />
      <select id="f-status">
        <option value="">${t("tasks.filter_status")}: ${t("common.all")}</option>
        ${STATUSES.map((s) => `<option value="${s}" ${s === f.status ? "selected" : ""}>${t("status." + s)}</option>`).join("")}
      </select>
      <select id="f-priority">
        <option value="">${t("tasks.filter_priority")}: ${t("common.all")}</option>
        ${PRIORITIES.map((p) => `<option value="${p}" ${p === f.priority ? "selected" : ""}>${t("priority." + p)}</option>`).join("")}
      </select>
      <select id="f-type">
        <option value="">${t("tasks.filter_type")}: ${t("common.all")}</option>
        ${TYPES.map((x) => `<option value="${x}" ${x === f.type ? "selected" : ""}>${t("type." + x)}</option>`).join("")}
      </select>
      <select id="f-tag">
        <option value="">${t("tasks.filter_tag")}: ${t("common.all")}</option>
        ${allTags.map((tg) => `<option value="${tg.id}" ${String(tg.id) === String(f.tag) ? "selected" : ""}>${esc(tg.name)}</option>`).join("")}
      </select>
      <button class="btn secondary small" id="f-reset">${t("tasks.reset_filters")}</button>
    </div>
    ${taskTable(tasks)}`;

  $("#back-cat").onclick = () => { state.currentDept = null; state._filters = null; renderMain(); };
  $("#new-task").onclick = () => openTaskModal(dep, allTags);
  $("#manage-tags").onclick = () => openTagsModal();
  $("#f-search").addEventListener("keydown", (e) => { if (e.key === "Enter") { f.q = e.target.value; renderMain(); } });
  $("#f-status").onchange = (e) => { f.status = e.target.value; renderMain(); };
  $("#f-priority").onchange = (e) => { f.priority = e.target.value; renderMain(); };
  $("#f-type").onchange = (e) => { f.type = e.target.value; renderMain(); };
  $("#f-tag").onchange = (e) => { f.tag = e.target.value; renderMain(); };
  $("#f-reset").onclick = () => { state._filters = null; renderMain(); };
  wireTaskRows(tasks);
}

function tagChips(tags) {
  if (!tags || !tags.length) return "";
  return `<span class="task-tags">${tags.map((tg) =>
    `<span class="tag-chip" style="background:${esc(tg.color)}">${esc(tg.name)}</span>`).join("")}</span>`;
}

function taskTable(tasks) {
  if (!tasks.length) return `<div class="empty-state">${t("tasks.empty")}</div>`;
  return `
    <div class="panel"><table>
      <thead><tr>
        <th>${t("tasks.key")}</th><th>${t("tasks.task_title")}</th><th>${t("tasks.created")}</th><th>${t("tasks.status")}</th>
        <th>${t("tasks.priority")}</th><th>${t("tasks.assignee")}</th><th>${t("tasks.due_date")}</th>
      </tr></thead>
      <tbody>${tasks.map((task) => `
        <tr data-task="${task.id}">
          <td class="mono" data-label="${t("tasks.key")}">${esc(task.key)}${actDot(state.activity.tasks[task.id], "taskdot-" + task.id)}</td>
          <td data-label="${t("tasks.task_title")}">${esc(task.title)}${tagChips(task.tags)}</td>
          <td data-label="${t("tasks.created")}">${fmtDate(task.created_at)}</td>
          <td data-label="${t("tasks.status")}"><span class="badge st-${task.status}">${t("status." + task.status)}</span></td>
          <td data-label="${t("tasks.priority")}"><span class="pr-${task.priority}">${t("priority." + task.priority)}</span></td>
          <td data-label="${t("tasks.assignee")}">${task.assignee ? userLabel(task.assignee) : `<span class="muted">${t("tasks.unassigned")}</span>`}</td>
          <td data-label="${t("tasks.due_date")}">${task.due_date ? fmtDay(task.due_date) : "—"}</td>
        </tr>`).join("")}
      </tbody>
    </table></div>`;
}

function wireTaskRows(tasks) {
  document.querySelectorAll("[data-task]").forEach((row) =>
    row.addEventListener("click", async () => {
      const task = await API.get(`/api/tasks/${row.dataset.task}`);
      state.currentTask = task;
      renderMain();
    }));
}

async function openTaskModal(dep, allTags) {
  const assignees = await API.get(`/api/admin/assignees?dep_id=${dep.id}`);
  if (!allTags) allTags = await API.get("/api/tags");
  openModal(`
    <h3>${t("tasks.new_task")}</h3>
    <div class="field"><label>${t("tasks.task_title")}</label><input id="t-title" /></div>
    <div class="field"><label>${t("tasks.task_desc")}</label><textarea id="t-desc"></textarea></div>
    <div class="field"><label>${t("tasks.attachments")}</label><input type="file" id="t-files" multiple accept="image/*,video/*,*/*" /></div>
    <div class="row">
      <div class="field"><label>${t("tasks.priority")}</label>
        <select id="t-prio">${PRIORITIES.map((p) => `<option value="${p}" ${p === "normal" ? "selected" : ""}>${t("priority." + p)}</option>`).join("")}</select></div>
      <div class="field"><label>${t("tasks.type")}</label>
        <select id="t-type">${TYPES.map((x) => `<option value="${x}">${t("type." + x)}</option>`).join("")}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>${t("tasks.assignee")}</label>
        <select id="t-assignee"><option value="">${t("tasks.unassigned")}</option>
          ${assignees.map((a) => `<option value="${a.id}">${esc(userOptionText(a))}</option>`).join("")}</select></div>
      <div class="field"><label>${t("tasks.due_date")}</label><input id="t-due" type="date" /></div>
    </div>
    <div class="field"><label>${t("tasks.tags")}</label>
      <div class="tag-row" id="t-tags">
        ${allTags.length ? allTags.map((tg) => `
          <span class="tag-toggle" data-tag="${tg.id}" data-color="${esc(tg.color)}"><span class="tag-dot" style="background:${esc(tg.color)}"></span>${esc(tg.name)}</span>`).join("")
        : `<span class="muted">${t("tasks.no_tags")}</span>`}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn secondary" data-close>${t("common.cancel")}</button>
      <button class="btn" id="t-save">${t("common.create")}</button>
    </div>`);
  wireTagToggles();
  $("#t-save").onclick = async () => {
    const title = $("#t-title").value.trim();
    if (!title) return;
    const due = $("#t-due").value;
    const tagIds = [...document.querySelectorAll("#t-tags .tag-toggle.on")].map((e) => parseInt(e.dataset.tag));
    const created = await API.post(`/api/departments/${dep.id}/tasks`, {
      title,
      description: $("#t-desc").value.trim(),
      priority: $("#t-prio").value,
      type: $("#t-type").value,
      assignee_id: $("#t-assignee").value ? parseInt($("#t-assignee").value) : null,
      due_date: due ? new Date(due).toISOString() : null,
      tag_ids: tagIds,
    });
    const files = [...$("#t-files").files];
    for (const f of files) await API.upload(`/api/tasks/${created.id}/attachments`, f);
    closeModal();
    renderMain();
  };
}

// ---------- Tags manager (create / rename / recolor / delete) ----------
async function openTagsModal() {
  const tags = await API.get("/api/tags");
  const isAdmin = state.me.role === "admin";
  openModal(`
    <h3>${t("tasks.tags")}</h3>
    <div>
      ${tags.length ? tags.map((tg) => `
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <input type="color" id="tg-c-${tg.id}" value="${esc(tg.color)}" style="width:42px;padding:2px" ${isAdmin ? "" : "disabled"} />
          <input id="tg-n-${tg.id}" value="${esc(tg.name)}" style="flex:1" ${isAdmin ? "" : "disabled"} />
          ${isAdmin ? `
            <button class="btn small" data-tgsave="${tg.id}">${t("common.save")}</button>
            <button class="ci-del" data-tgdel="${tg.id}" title="${t("common.delete")}">✕</button>` : ""}
        </div>`).join("") : `<div class="muted" style="margin-bottom:10px">${t("tasks.no_tags")}</div>`}
    </div>
    <hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />
    <label>${t("tasks.create_tag")}</label>
    <div class="add-inline">
      <input id="tg-new-name" placeholder="${t("tasks.new_tag")}" />
      <input type="color" id="tg-new-color" value="#6b7280" style="width:42px;padding:2px" />
      <button class="btn small" id="tg-add">+ ${t("common.create")}</button>
    </div>
    <div class="modal-actions">
      <button class="btn" id="tg-close">${t("common.close")}</button>
    </div>`);
  const reopen = () => { closeModal(); openTagsModal(); };
  $("#tg-close").onclick = () => { closeModal(); renderMain(); };  // refresh tag filter/chips
  $("#tg-add").onclick = async () => {
    const name = $("#tg-new-name").value.trim();
    if (!name) return;
    await API.post("/api/tags", { name, color: $("#tg-new-color").value });
    reopen();
  };
  $("#tg-new-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#tg-add").click(); });
  document.querySelectorAll("[data-tgsave]").forEach((b) =>
    b.onclick = async () => {
      const id = b.dataset.tgsave;
      const name = $(`#tg-n-${id}`).value.trim();
      if (!name) return;
      await API.put(`/api/tags/${id}`, { name, color: $(`#tg-c-${id}`).value });
      reopen();
    });
  document.querySelectorAll("[data-tgdel]").forEach((b) =>
    b.onclick = async () => {
      if (!confirm(t("common.confirm_delete"))) return;
      await API.del(`/api/tags/${b.dataset.tgdel}`);
      reopen();
    });
}

// Toggle chip on/off with its own color when active.
function wireTagToggles() {
  document.querySelectorAll(".tag-toggle[data-tag]").forEach((el) => {
    el.addEventListener("click", () => {
      const on = el.classList.toggle("on");
      el.style.background = on ? el.dataset.color : "";
    });
  });
}

// ---------- Task detail ----------
async function viewTaskDetail(main) {
  const task = state.currentTask;
  const dep = state.currentDept || { id: task.department_id };
  const assignees = await API.get(`/api/admin/assignees?dep_id=${task.department_id}`);
  const allTags = await API.get("/api/tags");
  const taskTagIds = new Set((task.tags || []).map((tg) => tg.id));

  // Opening a task marks its activity as read (optimistic + persisted).
  markTaskSeen(task);
  const backLabel = state.view === "archive" ? t("nav.archive") : (state.currentDept ? esc(state.currentDept.name) : t("nav.catalog"));

  main.innerHTML = `
    <div class="topbar">
      <div>
        <a class="link-btn" id="back">← ${backLabel}</a>
        <h2 style="margin-top:6px"><span class="mono">${esc(task.key)}</span> ${esc(task.title)}</h2>
      </div>
      <div style="display:flex;gap:8px">
        ${task.assignee && task.assignee.id === state.me.id ? "" : `<button class="btn" id="take">${t("tasks.take")}</button>`}
        ${task.archived
          ? `<button class="btn secondary" id="restore">${t("tasks.restore")}</button>`
          : `<button class="btn secondary" id="archive">${t("tasks.archive")}</button>`}
      </div>
    </div>
    <div class="detail-grid">
      <div class="detail-main">
        <div class="section">
          <label>${t("tasks.task_title")}</label>
          <input id="e-title" value="${esc(task.title)}" style="margin-bottom:12px" />
          <label>${t("tasks.task_desc")}</label>
          <textarea id="e-desc" style="min-height:120px">${esc(task.description || "")}</textarea>
          <div style="margin-top:12px"><button class="btn small" id="save-desc">${t("tasks.save_changes")}</button></div>
        </div>

        <div class="section">
          <h4>${t("tasks.checklist")} <span class="muted" id="cl-count"></span></h4>
          <div class="progress-bar"><span id="cl-progress"></span></div>
          <div id="checklist">${renderChecklist(task.checklist)}</div>
          <div class="add-inline">
            <input id="ci-text" placeholder="${t("tasks.add_item")}" />
            <button class="btn small" id="ci-add">+</button>
          </div>
        </div>

        <div class="section">
          <h4>${t("tasks.comments")}</h4>
          <div id="comments">${renderComments(task.comments)}</div>
          <div style="margin-top:12px">
            <textarea id="c-body" placeholder="${t("tasks.add_comment")}"></textarea>
            <div class="add-inline" style="margin-top:8px">
              <input type="file" id="c-files" multiple accept="image/*,video/*,*/*" />
              <button class="btn small" id="c-send">${t("tasks.send")}</button>
            </div>
          </div>
        </div>

        <div class="section">
          <h4>${t("tasks.attachments")}</h4>
          <div id="attachments">${renderAttachments((task.attachments || []).filter((a) => !a.comment_id))}</div>
          <div style="margin-top:10px"><input type="file" id="a-file" multiple accept="image/*,video/*,*/*" /></div>
        </div>

        <div class="section">
          <h4>${t("tasks.history")}</h4>
          <div>${renderHistory(task.history)}</div>
        </div>
      </div>

      <div class="detail-side">
        <div class="side-block">
          <h4>${t("tasks.status")}</h4>
          <select id="s-status">${STATUSES.map((s) => `<option value="${s}" ${s === task.status ? "selected" : ""}>${t("status." + s)}</option>`).join("")}</select>
        </div>
        <div class="side-block">
          <h4>${t("tasks.priority")}</h4>
          <select id="s-prio">${PRIORITIES.map((p) => `<option value="${p}" ${p === task.priority ? "selected" : ""}>${t("priority." + p)}</option>`).join("")}</select>
        </div>
        <div class="side-block">
          <h4>${t("tasks.type")}</h4>
          <select id="s-type">${TYPES.map((x) => `<option value="${x}" ${x === task.type ? "selected" : ""}>${t("type." + x)}</option>`).join("")}</select>
        </div>
        <div class="side-block">
          <h4>${t("tasks.assignee")}</h4>
          <select id="s-assignee"><option value="">${t("tasks.unassigned")}</option>
            ${assignees.map((a) => `<option value="${a.id}" ${task.assignee && task.assignee.id === a.id ? "selected" : ""}>${esc(userOptionText(a))}</option>`).join("")}</select>
        </div>
        <div class="side-block">
          <h4>${t("tasks.due_date")}</h4>
          <input type="date" id="s-due" value="${task.due_date ? new Date(task.due_date).toISOString().slice(0, 10) : ""}" />
        </div>
        <div class="side-block">
          <h4>${t("tasks.tags")}</h4>
          <div class="tag-row" id="d-tags">
            ${allTags.length ? allTags.map((tg) => `
              <span class="tag-toggle ${taskTagIds.has(tg.id) ? "on" : ""}" data-tag="${tg.id}" data-color="${esc(tg.color)}"
                    style="${taskTagIds.has(tg.id) ? `background:${esc(tg.color)}` : ""}">
                <span class="tag-dot" style="background:${esc(tg.color)}"></span>${esc(tg.name)}</span>`).join("")
            : `<span class="muted">${t("tasks.no_tags")}</span>`}
          </div>
          <div class="add-inline">
            <input id="d-newtag" placeholder="${t("tasks.new_tag")}" />
            <input type="color" id="d-newtag-color" value="#6b7280" style="width:38px;padding:2px" />
            <button class="btn small" id="d-addtag">+</button>
          </div>
        </div>
        <div class="side-block">
          <div class="kv"><span class="k">${t("tasks.author")}</span><span>${userLabel(task.author)}</span></div>
          <div class="kv"><span class="k">${t("tasks.created")}</span><span>${fmtDate(task.created_at)}</span></div>
          <div class="kv"><span class="k">${t("tasks.updated")}</span><span>${fmtDate(task.updated_at)}</span></div>
        </div>
      </div>
    </div>`;

  $("#back").onclick = () => { state.currentTask = null; renderMain(); };

  async function reload() {
    state.currentTask = await API.get(`/api/tasks/${task.id}`);
    renderMain();
  }
  async function patch(body) {
    state.currentTask = await API.put(`/api/tasks/${task.id}`, body);
    renderMain();
  }

  const take = $("#take"); if (take) take.onclick = async () => { await API.post(`/api/tasks/${task.id}/take`); reload(); };
  const arch = $("#archive"); if (arch) arch.onclick = async () => { await API.post(`/api/tasks/${task.id}/archive`); state.currentTask = null; renderMain(); };
  const rest = $("#restore"); if (rest) rest.onclick = async () => { await API.post(`/api/tasks/${task.id}/restore`); reload(); };

  $("#save-desc").onclick = () => patch({ title: $("#e-title").value.trim(), description: $("#e-desc").value });
  $("#s-status").onchange = (e) => patch({ status: e.target.value });
  $("#s-prio").onchange = (e) => patch({ priority: e.target.value });
  $("#s-type").onchange = (e) => patch({ type: e.target.value });
  $("#s-assignee").onchange = (e) => patch({ assignee_id: e.target.value ? parseInt(e.target.value) : 0 });
  $("#s-due").onchange = (e) => patch({ due_date: e.target.value ? new Date(e.target.value).toISOString() : null });

  $("#c-send").onclick = async () => {
    const body = $("#c-body").value.trim();
    const files = [...$("#c-files").files];
    if (!body && !files.length) return;
    const btn = $("#c-send"); btn.disabled = true;
    try {
      const comment = await API.post(`/api/tasks/${task.id}/comments`, { body });
      for (const f of files) await API.upload(`/api/comments/${comment.id}/attachments`, f);
      reload();
    } catch (err) { alert(err.message); btn.disabled = false; }
  };
  $("#a-file").onchange = async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    try {
      for (const f of files) await API.upload(`/api/tasks/${task.id}/attachments`, f);
      reload();
    } catch (err) { alert(err.message); }
  };

  // ----- Comment edit / delete, attachment delete -----
  document.querySelectorAll("[data-cdel]").forEach((b) =>
    b.onclick = async () => {
      if (!confirm(t("common.confirm_delete"))) return;
      await API.del(`/api/comments/${b.dataset.cdel}`);
      reload();
    });
  document.querySelectorAll("[data-cedit]").forEach((b) =>
    b.onclick = () => {
      const id = parseInt(b.dataset.cedit);
      const c = (state.currentTask.comments || []).find((x) => x.id === id);
      const slot = document.querySelector(`#comment-${id} .c-slot`);
      if (!c || !slot) return;
      slot.innerHTML = `
        <textarea id="ce-${id}"></textarea>
        <div style="margin-top:6px;display:flex;gap:8px">
          <button class="btn small" id="ces-${id}">${t("common.save")}</button>
          <button class="btn secondary small" id="cec-${id}">${t("common.cancel")}</button>
        </div>`;
      const ta = $(`#ce-${id}`);
      ta.value = c.body || "";
      ta.focus();
      $(`#ces-${id}`).onclick = async () => {
        try {
          await API.put(`/api/comments/${id}`, { body: ta.value });
          reload();
        } catch (err) { alert(err.message); }
      };
      $(`#cec-${id}`).onclick = () => renderMain();
    });
  document.querySelectorAll("[data-attdel]").forEach((b) =>
    b.onclick = async (e) => {
      e.preventDefault();
      if (!confirm(t("common.confirm_delete"))) return;
      await API.del(`/api/attachments/${b.dataset.attdel}`);
      reload();
    });

  // ----- Checklist -----
  updateChecklistProgress(task.checklist);
  $("#ci-add").onclick = async () => {
    const text = $("#ci-text").value.trim();
    if (!text) return;
    await API.post(`/api/tasks/${task.id}/checklist`, { text });
    reload();
  };
  $("#ci-text").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#ci-add").click(); });
  document.querySelectorAll("[data-ci]").forEach((cb) =>
    cb.addEventListener("change", async () => {
      await API.put(`/api/checklist/${cb.dataset.ci}`, { is_done: cb.checked });
      reload();
    }));
  document.querySelectorAll("[data-cidel]").forEach((b) =>
    b.addEventListener("click", async () => {
      await API.del(`/api/checklist/${b.dataset.cidel}`);
      reload();
    }));

  // ----- Tags -----
  async function saveTags() {
    const ids = [...document.querySelectorAll("#d-tags .tag-toggle.on")].map((e) => parseInt(e.dataset.tag));
    await API.put(`/api/tasks/${task.id}`, { tag_ids: ids });
    reload();
  }
  document.querySelectorAll("#d-tags .tag-toggle[data-tag]").forEach((el) =>
    el.addEventListener("click", () => { el.classList.toggle("on"); saveTags(); }));
  $("#d-addtag").onclick = async () => {
    const name = $("#d-newtag").value.trim();
    if (!name) return;
    const tag = await API.post("/api/tags", { name, color: $("#d-newtag-color").value });
    // attach the new tag to this task right away
    const ids = [...document.querySelectorAll("#d-tags .tag-toggle.on")].map((e) => parseInt(e.dataset.tag));
    if (!ids.includes(tag.id)) ids.push(tag.id);
    await API.put(`/api/tasks/${task.id}`, { tag_ids: ids });
    reload();
  };
  $("#d-newtag").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#d-addtag").click(); });
}

function renderChecklist(items) {
  if (!items || !items.length) return `<div class="muted">${t("tasks.no_checklist")}</div>`;
  return items.map((it) => `
    <div class="checklist-item">
      <input type="checkbox" data-ci="${it.id}" ${it.is_done ? "checked" : ""} />
      <span class="ci-text ${it.is_done ? "done" : ""}">${esc(it.text)}</span>
      <button class="ci-del" data-cidel="${it.id}" title="${t("common.delete")}">✕</button>
    </div>`).join("");
}

function updateChecklistProgress(items) {
  const total = (items || []).length;
  const done = (items || []).filter((i) => i.is_done).length;
  const bar = document.getElementById("cl-progress");
  const cnt = document.getElementById("cl-count");
  if (bar) bar.style.width = total ? (done / total * 100) + "%" : "0%";
  if (cnt) cnt.textContent = total ? `${done}/${total}` : "";
}

function renderComments(comments) {
  if (!comments || !comments.length) return `<div class="muted">${t("tasks.no_comments")}</div>`;
  return comments.map((c) => {
    const canMod = state.me && (state.me.role === "admin" || (c.author && c.author.id === state.me.id));
    return `
    <div class="comment" id="comment-${c.id}">
      <div class="head">
        <span class="author">${userLabel(c.author)}</span>
        <span style="display:flex;align-items:center;gap:8px">
          <span class="time">${fmtDate(c.created_at)}${c.edited_at ? ` <span class="muted">(${t("tasks.edited")})</span>` : ""}</span>
          ${canMod ? `
            <button class="c-act" data-cedit="${c.id}" title="${t("common.edit")}">✎</button>
            <button class="c-act c-act-del" data-cdel="${c.id}" title="${t("common.delete")}">✕</button>` : ""}
        </span>
      </div>
      <div class="c-slot">${c.body ? `<div class="body">${esc(c.body)}</div>` : ""}</div>
      ${renderMedia(c.attachments)}
    </div>`;
  }).join("");
}

function attViewUrl(a) {
  return `/api/attachments/${a.id}/view?token=${encodeURIComponent(API.token)}`;
}
function fmtSize(b) {
  return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : (b / 1024).toFixed(0) + " KB";
}
function isImage(a) { return (a.content_type || "").startsWith("image/"); }
function isVideo(a) { return (a.content_type || "").startsWith("video/"); }

// Render attachments as messenger-style cards: a preview (image / playable
// video / document icon) plus a footer with the file name, size and a
// download button — every file stays downloadable.
function renderMedia(atts) {
  if (!atts || !atts.length) return "";
  return `<div class="att-grid">` + atts.map((a) => {
    const canDel = state.me && (state.me.role === "admin" || a.uploaded_by_id === state.me.id);
    const footer = `
      <div class="att-foot">
        <span class="att-name" title="${esc(a.filename)}">${esc(a.filename)}</span>
        <span class="att-size">${fmtSize(a.size)}</span>
        <a class="att-dl" href="#" data-att="${a.id}" title="${t("tasks.download")}">⬇</a>
        ${canDel ? `<a class="att-dl att-del" href="#" data-attdel="${a.id}" title="${t("common.delete")}">✕</a>` : ""}
      </div>`;
    if (isImage(a)) {
      return `<div class="att-card">
          <img class="att-thumb" src="${attViewUrl(a)}" alt="${esc(a.filename)}" data-lightbox="1"
               onerror="this.closest('.att-card').classList.add('broken')" />
          <div class="att-fallback">🖼 ${t("tasks.preview_unavailable")}</div>
          ${footer}</div>`;
    }
    if (isVideo(a)) {
      return `<div class="att-card">
          <video class="att-thumb" src="${attViewUrl(a)}" controls preload="metadata"
                 onerror="this.closest('.att-card').classList.add('broken')"></video>
          <div class="att-fallback">🎬 ${t("tasks.preview_unavailable")}</div>
          ${footer}</div>`;
    }
    return `<div class="att-card doc"><div class="att-docicon">📄</div>${footer}</div>`;
  }).join("") + `</div>`;
}

function renderAttachments(atts) {
  if (!atts || !atts.length) return `<div class="muted">${t("tasks.no_attachments")}</div>`;
  return renderMedia(atts);
}

function renderHistory(events) {
  if (!events || !events.length) return `<div class="muted">—</div>`;
  return events.slice().reverse().map((e) => {
    let detail = e.detail || "";
    if (e.kind === "status") detail = translatePair(detail, "status");
    else if (e.kind === "priority") detail = translatePair(detail, "priority");
    else if (e.kind === "type") detail = translatePair(detail, "type");
    return `<div class="hist-item">${fmtDate(e.created_at)} — <b>${userLabel(e.actor)}</b> ${t("event." + e.kind)} ${detail ? `<span class="muted">${esc(detail)}</span>` : ""}</div>`;
  }).join("");
}

function translatePair(detail, ns) {
  // "open->in_progress" -> localized "Открыта → В работе"
  const m = detail.split("->");
  if (m.length === 2) {
    const from = m[0] ? t(ns + "." + m[0]) : "";
    const to = m[1] ? t(ns + "." + m[1]) : "";
    return `${from} → ${to}`;
  }
  return detail;
}

// Click an image preview to open it full-screen (lightbox).
document.addEventListener("click", (e) => {
  const img = e.target.closest("img[data-lightbox]");
  if (!img) return;
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${img.getAttribute("src")}" />`;
  box.addEventListener("click", () => box.remove());
  document.body.appendChild(box);
});

// Attachments need the auth header, so intercept clicks and fetch as blob.
document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-att]");
  if (!a) return;
  e.preventDefault();
  const id = a.dataset.att;
  const res = await fetch(`/api/attachments/${id}/download`, { headers: { Authorization: "Bearer " + API.token } });
  if (!res.ok) return alert(t("common.error"));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const cd = res.headers.get("Content-Disposition") || "";
  const match = cd.match(/filename="?([^"]+)"?/);
  link.download = match ? match[1] : "file";
  link.click();
  URL.revokeObjectURL(url);
});

// ---------- Archive ----------
async function viewArchive(main) {
  const deps = await API.get("/api/departments");
  let all = [];
  for (const d of deps) {
    const items = await API.get(`/api/departments/${d.id}/tasks?archived=true`);
    items.forEach((it) => (it._dep = d));
    all = all.concat(items);
  }
  all.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  main.innerHTML = `
    <div class="topbar"><h2>${t("nav.archive")}</h2></div>
    ${all.length === 0 ? `<div class="empty-state">${t("tasks.empty_archive")}</div>` : `
      <div class="panel"><table>
        <thead><tr><th>${t("tasks.key")}</th><th>${t("tasks.task_title")}</th><th>${t("catalog.title")}</th><th>${t("tasks.status")}</th><th>${t("tasks.updated")}</th></tr></thead>
        <tbody>${all.map((task) => `
          <tr data-task="${task.id}">
            <td class="mono" data-label="${t("tasks.key")}">${esc(task.key)}</td>
            <td data-label="${t("tasks.task_title")}">${esc(task.title)}</td>
            <td data-label="${t("catalog.title")}">${esc(task._dep.name)}</td>
            <td data-label="${t("tasks.status")}"><span class="badge st-${task.status}">${t("status." + task.status)}</span></td>
            <td data-label="${t("tasks.updated")}">${fmtDate(task.updated_at)}</td>
          </tr>`).join("")}</tbody>
      </table></div>`}`;
  document.querySelectorAll("[data-task]").forEach((row) =>
    row.addEventListener("click", async () => {
      state.currentTask = await API.get(`/api/tasks/${row.dataset.task}`);
      state.currentDept = null;
      renderMain();
    }));
}

// ---------- Public staff directory (all users) ----------
async function viewDirectory(main) {
  const users = await API.get("/api/users");
  main.innerHTML = `
    <div class="topbar"><h2>${t("directory.title")}</h2></div>
    ${users.length === 0
      ? `<div class="empty-state">${t("directory.empty")}</div>`
      : `<div class="grid">${users.map(dirCard).join("")}</div>`}`;
  users.forEach((u) => {
    if (u.id === state.me.id) {
      const b = $(`#prof-${u.id}`); if (b) b.onclick = () => openProfileModal();
    } else {
      const b = $(`#alias-${u.id}`); if (b) b.onclick = () => openAliasModal(u);
    }
  });
  document.querySelectorAll("[data-dm]").forEach((b) =>
    b.onclick = async () => {
      const conv = await API.post(`/api/chat/dm/${b.dataset.dm}`);
      state.view = "chat";
      state.currentConvId = conv.id;
      state._openConvNow = true;  // jump straight into the conversation, incl. phones
      renderShell();
    });
}

function dirCard(u) {
  const isMe = u.id === state.me.id;
  const alias = state.aliases[u.id];
  const aliasOn = alias && alias.display && alias.alias;
  return `
    <div class="card" style="cursor:default">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:8px">
        ${avaHtml(u, 44)}
        <div style="min-width:0">
          <h3 style="margin:0">${u.role === "observer" ? userLabel(u) : esc(displayName(u))} ${isMe ? `<span class="muted" style="font-size:12px;font-weight:400">(${t("directory.you")})</span>` : ""}</h3>
          <div class="muted" style="font-size:13px">${esc(u.email)}</div>
        </div>
      </div>
      <div style="font-size:13px;margin-bottom:6px">
        <span class="muted">${t("directory.position")}:</span>
        ${posName(u.position) ? esc(posName(u.position)) : `<span class="muted">${t("directory.no_position")}</span>`}
      </div>
      <div class="desc" style="min-height:0;margin-bottom:12px">${esc(u.description || "")}</div>
      ${isMe
        ? `<button class="btn secondary small" id="prof-${u.id}">${t("directory.edit_profile")}</button>`
        : `<div style="display:flex;gap:8px;flex-wrap:wrap">
             ${(state.me.role === "admin" || state.navTabs.chat !== false) ? `<button class="btn small" data-dm="${u.id}">✉ ${t("chat.write")}</button>` : ""}
             <button class="btn secondary small" id="alias-${u.id}">${t("directory.set_alias")}${aliasOn ? " ✓" : ""}</button>
           </div>`}
    </div>`;
}

async function openProfileModal() {
  const positions = await API.get("/api/positions");
  const me = state.me;
  openModal(`
    <h3>${t("profile.title")}</h3>
    <div class="field"><label>${t("profile.avatar")}</label>
      <div style="display:flex;align-items:center;gap:14px">
        <span id="pf-ava">${avaHtml(me, 64)}</span>
        <div>
          <input type="file" id="pf-avatar" accept="image/*" />
          <div class="muted" style="font-size:12px;margin-top:4px">${t("profile.avatar_hint")}</div>
        </div>
      </div>
    </div>
    <div class="field"><label>${t("profile.full_name")}</label><input id="pf-name" value="${esc(me.full_name || "")}" /></div>
    <div class="field"><label>${t("profile.position")}</label>
      <select id="pf-pos">
        <option value="0">${t("directory.no_position")}</option>
        ${positions.map((p) => `<option value="${p.id}" ${me.position_id === p.id ? "selected" : ""}>${esc(posName(p))}</option>`).join("")}
      </select></div>
    <div class="field"><label>${t("profile.description")}</label><textarea id="pf-desc">${esc(me.description || "")}</textarea></div>
    <div class="modal-actions">
      <button class="btn secondary" data-close>${t("common.cancel")}</button>
      <button class="btn" id="pf-save">${t("profile.save")}</button>
    </div>`);
  $("#pf-avatar").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      state.me = await API.upload("/api/users/me/avatar", f);
      $("#pf-ava").innerHTML = avaHtml(state.me, 64);
    } catch (err) { alert(err.message); }
  };
  $("#pf-save").onclick = async () => {
    state.me = await API.put("/api/users/me/profile", {
      full_name: $("#pf-name").value.trim(),
      description: $("#pf-desc").value,
      position_id: parseInt($("#pf-pos").value) || 0,
    });
    closeModal();
    renderMain();
  };
}

function openAliasModal(u) {
  const existing = state.aliases[u.id] || { alias: "", display: true };
  const realName = esc(u.full_name || u.email);
  openModal(`
    <h3>${t("alias.title")}</h3>
    <div class="muted" style="margin-bottom:12px">${realName}</div>
    <div class="field"><label>${t("alias.label")}</label>
      <input id="al-text" value="${esc(existing.alias || "")}" placeholder="${realName}" /></div>
    <div class="chip-check" style="margin-bottom:8px">
      <input type="checkbox" id="al-display" ${existing.display ? "checked" : ""} />
      <label for="al-display">${t("alias.display")}</label>
    </div>
    <div class="muted" style="font-size:12px;margin-bottom:4px">${t("alias.hint")}</div>
    <div class="modal-actions">
      <button class="btn danger secondary" id="al-clear">${t("alias.clear")}</button>
      <button class="btn secondary" data-close>${t("common.cancel")}</button>
      <button class="btn" id="al-save">${t("alias.save")}</button>
    </div>`);
  $("#al-save").onclick = async () => {
    const res = await API.put(`/api/aliases/${u.id}`, {
      alias: $("#al-text").value.trim(),
      display: $("#al-display").checked,
    });
    state.aliases[u.id] = res;
    closeModal();
    renderMain();
  };
  $("#al-clear").onclick = async () => {
    await API.del(`/api/aliases/${u.id}`);
    delete state.aliases[u.id];
    closeModal();
    renderMain();
  };
}

// ===========================================================================
// Chat (DMs + groups)
// ===========================================================================
let chatTimer = null;

function convTitle(conv) {
  if (conv.type === "group") return conv.name || "—";
  const other = (conv.members || []).find((m) => m && m.id !== state.me.id);
  return other ? displayName(other) : "—";
}

function convAvatar(conv, size) {
  if (conv.type === "group") return groupAvaHtml(conv, size);
  const other = (conv.members || []).find((m) => m && m.id !== state.me.id);
  return avaHtml(other, size);
}

function chatFileUrl(f, kind) {
  return `/api/chat/files/${f.id}/${kind}?token=${encodeURIComponent(API.token)}`;
}

function chatMedia(files) {
  if (!files || !files.length) return "";
  return `<div class="att-grid">` + files.map((f) => {
    const footer = `
      <div class="att-foot">
        <span class="att-name" title="${esc(f.filename)}">${esc(f.filename)}</span>
        <span class="att-size">${fmtSize(f.size)}</span>
        <a class="att-dl" href="${chatFileUrl(f, "download")}" download title="${t("tasks.download")}">⬇</a>
      </div>`;
    if ((f.content_type || "").startsWith("image/")) {
      return `<div class="att-card">
        <img class="att-thumb" src="${chatFileUrl(f, "view")}" data-lightbox="1"
             onerror="this.closest('.att-card').classList.add('broken')" />
        <div class="att-fallback">🖼 ${t("tasks.preview_unavailable")}</div>${footer}</div>`;
    }
    if ((f.content_type || "").startsWith("video/")) {
      return `<div class="att-card">
        <video class="att-thumb" src="${chatFileUrl(f, "view")}" controls preload="metadata"></video>${footer}</div>`;
    }
    return `<div class="att-card doc"><div class="att-docicon">📄</div>${footer}</div>`;
  }).join("") + `</div>`;
}

async function viewChat(main) {
  const convs = await API.get("/api/chat/conversations");
  state._convs = convs;
  main.innerHTML = `
    <div class="topbar">
      <h2>${t("chat.title")}</h2>
      <button class="btn" id="new-group">👥 + ${t("chat.new_group")}</button>
    </div>
    <div class="chat-wrap" id="chat-wrap">
      <div class="chat-list" id="conv-list">
        ${convs.length ? convs.map((c) => `
          <div class="conv-item ${state.currentConvId === c.id ? "active" : ""}" data-conv="${c.id}">
            ${convAvatar(c, 38)}
            <div class="conv-info">
              <div class="conv-name">${esc(convTitle(c))}</div>
              <div class="conv-preview">${c.last_message ? esc((c.last_message.body || (c.last_message.has_files ? "📎" : ""))) : ""}</div>
            </div>
            ${c.unread ? `<span class="unread-dot"></span>` : ""}
          </div>`).join("") : `<div class="empty-state" style="padding:20px">${t("chat.no_convs")}</div>`}
      </div>
      <div class="chat-main" id="chat-main">
        <div class="empty-state" style="margin:auto">${t("chat.pick")}</div>
      </div>
      <div class="chat-side" id="chat-side"></div>
    </div>`;

  $("#new-group").onclick = openGroupModal;
  document.querySelectorAll("[data-conv]").forEach((el) =>
    el.addEventListener("click", () => {
      state.currentConvId = parseInt(el.dataset.conv);
      document.querySelectorAll(".conv-item").forEach((x) => x.classList.toggle("active", x === el));
      el.querySelector(".unread-dot")?.remove();
      openConversation(state.currentConvId);
    }));

  // Desktop: auto-open the last conversation (list stays visible beside it).
  // Phone: land on the full-screen chat list, except when explicitly asked
  // to jump into a conversation (the "Write" button / a fresh group).
  const isPhone = window.matchMedia("(max-width: 860px)").matches;
  if (state.currentConvId && convs.some((c) => c.id === state.currentConvId)
      && (!isPhone || state._openConvNow)) {
    openConversation(state.currentConvId);
  }
  state._openConvNow = false;
}

async function openConversation(convId) {
  const conv = (state._convs || []).find((c) => c.id === convId);
  if (!conv) return;
  const mainEl = $("#chat-main");
  const msgs = await API.get(`/api/chat/conversations/${convId}/messages`);
  fetchChatUnread();

  const wrap = $("#chat-wrap");
  if (wrap) { wrap.classList.add("conv-open"); wrap.classList.remove("side-open"); }

  mainEl.innerHTML = `
    <div class="chat-header">
      <button class="chat-back" id="chat-back" aria-label="back">←</button>
      ${convAvatar(conv, 34)}
      <span class="ch-name">${esc(convTitle(conv))}</span>
      ${conv.type === "group" ? `
        <button class="c-act" id="grp-leave" title="${t("chat.leave")}">🚪</button>
        ${(conv.created_by_id === state.me.id || state.me.role === "admin")
          ? `<button class="c-act c-act-del" id="grp-del" title="${t("chat.delete_group")}">🗑</button>` : ""}` : ""}
      <button class="chat-info" id="chat-info" title="${t("chat.search")} / ${t("chat.files")}">ⓘ</button>
    </div>
    <div class="chat-msgs" id="chat-msgs">${renderChatMessages(msgs)}</div>
    <div class="chat-composer">
      <label class="attach-btn" id="cm-attach" title="${t("tasks.upload")}">📎
        <span class="attach-count" id="cm-count" hidden></span>
        <input type="file" id="cm-files" multiple accept="image/*,video/*,*/*" hidden />
      </label>
      <textarea id="cm-body" rows="1" placeholder="${t("chat.message")}"></textarea>
      <button class="send-btn" id="cm-send" title="${t("chat.send")}">➤</button>
    </div>`;
  scrollChatDown();
  renderChatSide(conv);

  const resetAttach = () => {
    $("#cm-files").value = "";
    $("#cm-attach").classList.remove("has-files");
    $("#cm-count").hidden = true;
  };
  const send = async () => {
    const body = $("#cm-body").value.trim();
    const files = [...$("#cm-files").files];
    if (!body && !files.length) return;
    $("#cm-send").disabled = true;
    try {
      const msg = await API.post(`/api/chat/conversations/${convId}/messages`, { body });
      for (const f of files) await API.upload(`/api/chat/messages/${msg.id}/files`, f);
      $("#cm-body").value = "";
      $("#cm-body").style.height = "";
      resetAttach();
      await refreshMessages(convId, true);
    } catch (e) { alert(e.message); }
    $("#cm-send").disabled = false;
  };
  $("#cm-send").onclick = send;
  const bodyTa = $("#cm-body");
  bodyTa.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  // Auto-grow the input like messengers do (up to the CSS max-height).
  bodyTa.addEventListener("input", () => {
    bodyTa.style.height = "auto";
    bodyTa.style.height = Math.min(bodyTa.scrollHeight, 120) + "px";
  });
  // Keep the latest messages in view when the phone keyboard opens.
  bodyTa.addEventListener("focus", () => setTimeout(scrollChatDown, 250));
  // Paperclip badge shows how many files are picked.
  $("#cm-files").onchange = (e) => {
    const n = e.target.files.length;
    $("#cm-attach").classList.toggle("has-files", n > 0);
    const c = $("#cm-count");
    c.hidden = !n;
    c.textContent = n;
  };

  // Phone: back arrow returns to the full-screen conversations list.
  $("#chat-back").onclick = () => {
    state.currentConvId = null;
    if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
    renderMain();
  };
  // Narrow screens: ⓘ toggles the search/attachments panel.
  $("#chat-info").onclick = () => { if (wrap) wrap.classList.toggle("side-open"); };

  const leave = $("#grp-leave");
  if (leave) leave.onclick = async () => {
    if (!confirm(t("chat.leave") + "?")) return;
    await API.del(`/api/chat/groups/${convId}/members/${state.me.id}`);
    state.currentConvId = null;
    renderMain();
  };
  const gdel = $("#grp-del");
  if (gdel) gdel.onclick = async () => {
    if (!confirm(t("common.confirm_delete"))) return;
    await API.del(`/api/chat/groups/${convId}`);
    state.currentConvId = null;
    renderMain();
  };

  // Poll for new messages every 5s while the conversation is open.
  if (chatTimer) clearInterval(chatTimer);
  chatTimer = setInterval(() => refreshMessages(convId, false), 5000);
}

let _lastMsgKey = "";
function _msgKey(msgs) {
  return msgs.length + ":" + (msgs.length ? msgs[msgs.length - 1].id : 0)
    + ":" + msgs.reduce((n, m) => n + (m.files ? m.files.length : 0), 0);
}

async function refreshMessages(convId, force) {
  if (state.view !== "chat" || state.currentConvId !== convId) return;
  try {
    const msgs = await API.get(`/api/chat/conversations/${convId}/messages`);
    const key = _msgKey(msgs);
    if (!force && key === _lastMsgKey) return;
    _lastMsgKey = key;
    const box = $("#chat-msgs");
    if (box) { box.innerHTML = renderChatMessages(msgs); scrollChatDown(); }
    fetchChatUnread();
  } catch (e) { /* transient */ }
}

function renderChatMessages(msgs) {
  if (!msgs.length) return `<div class="empty-state">${t("chat.no_messages")}</div>`;
  return msgs.map((m) => `
    <div class="chat-msg ${m.author && m.author.id === state.me.id ? "own" : ""}">
      ${avaHtml(m.author, 30)}
      <div class="bubble">
        <div class="m-head">
          <span class="m-author">${esc(m.author ? displayName(m.author) : "—")}</span>
          <span class="m-time">${fmtDate(m.created_at)}</span>
        </div>
        ${m.body ? `<div class="m-body">${esc(m.body)}</div>` : ""}
        ${chatMedia(m.files)}
      </div>
    </div>`).join("");
}

function scrollChatDown() {
  const box = $("#chat-msgs");
  if (box) box.scrollTop = box.scrollHeight;
}

// ---------- Right side panel: search / files / members / tasks ----------
function renderChatSide(conv) {
  const side = $("#chat-side");
  if (!side) return;
  const isGroup = conv.type === "group";
  const tabs = [
    { k: "search", label: t("chat.search") },
    { k: "files", label: t("chat.files") },
  ];
  if (isGroup) {
    tabs.push({ k: "members", label: t("chat.members") });
    tabs.push({ k: "tasks", label: t("chat.tasks") });
  }
  side.innerHTML = `
    <div class="tabs">${tabs.map((x, i) => `<div class="tab ${i === 0 ? "active" : ""}" data-cstab="${x.k}">${x.label}</div>`).join("")}</div>
    <div id="cs-body"></div>`;
  const show = (k) => {
    document.querySelectorAll("[data-cstab]").forEach((el) => el.classList.toggle("active", el.dataset.cstab === k));
    if (k === "search") renderSideSearch(conv);
    else if (k === "files") renderSideFiles(conv);
    else if (k === "members") renderSideMembers(conv);
    else renderSideTasks(conv);
  };
  document.querySelectorAll("[data-cstab]").forEach((el) => el.addEventListener("click", () => show(el.dataset.cstab)));
  show("search");
}

function renderSideSearch(conv) {
  const box = $("#cs-body");
  box.innerHTML = `
    <input id="cs-q" placeholder="${t("chat.search_ph")}" />
    <div id="cs-results" style="margin-top:10px"></div>`;
  const run = async () => {
    const q = $("#cs-q").value.trim();
    if (!q) { $("#cs-results").innerHTML = ""; return; }
    const res = await API.get(`/api/chat/conversations/${conv.id}/messages?q=${encodeURIComponent(q)}`);
    $("#cs-results").innerHTML = res.length ? res.map((m) => `
      <div class="sr-item">
        <b>${esc(m.author ? displayName(m.author) : "—")}</b>
        <span class="m-time">${fmtDate(m.created_at)}</span>
        <div>${esc(m.body)}</div>
      </div>`).join("") : `<div class="muted">${t("chat.nothing_found")}</div>`;
  };
  $("#cs-q").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  $("#cs-q").addEventListener("input", () => { clearTimeout(box._t); box._t = setTimeout(run, 400); });
}

async function renderSideFiles(conv) {
  const files = await API.get(`/api/chat/conversations/${conv.id}/files`);
  $("#cs-body").innerHTML = files.length
    ? chatMedia(files)
    : `<div class="muted">${t("chat.no_files")}</div>`;
}

function renderSideMembers(conv) {
  const box = $("#cs-body");
  const canKick = conv.created_by_id === state.me.id || state.me.role === "admin";
  box.innerHTML = `
    ${(conv.members || []).map((m) => `
      <div class="cs-item">
        ${avaHtml(m, 26)}
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(displayName(m))}</span>
        ${canKick && m.id !== state.me.id ? `<button class="ci-del" data-kick="${m.id}">✕</button>` : ""}
      </div>`).join("")}
    <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
      <button class="btn secondary small" id="cs-add">+ ${t("chat.add_members")}</button>
      <label class="btn secondary small" style="cursor:pointer;text-align:center">
        ${t("chat.group_avatar")}
        <input type="file" id="cs-gava" accept="image/*" style="display:none" />
      </label>
    </div>`;
  document.querySelectorAll("[data-kick]").forEach((b) =>
    b.onclick = async () => {
      if (!confirm(t("common.confirm_delete"))) return;
      await API.del(`/api/chat/groups/${conv.id}/members/${b.dataset.kick}`);
      renderMain();
    });
  $("#cs-add").onclick = async () => {
    const users = await API.get("/api/users");
    const inGroup = new Set((conv.members || []).map((m) => m.id));
    const candidates = users.filter((u) => !inGroup.has(u.id));
    openModal(`
      <h3>${t("chat.add_members")}</h3>
      <div class="chip-list">${candidates.map((u) => `
        <div class="chip-check"><input type="checkbox" id="am-${u.id}" /><label for="am-${u.id}">${esc(displayName(u))}</label></div>`).join("") || `<span class="muted">—</span>`}</div>
      <div class="modal-actions">
        <button class="btn secondary" data-close>${t("common.cancel")}</button>
        <button class="btn" id="am-save">${t("common.save")}</button>
      </div>`);
    $("#am-save").onclick = async () => {
      const ids = candidates.filter((u) => $(`#am-${u.id}`).checked).map((u) => u.id);
      if (ids.length) await API.post(`/api/chat/groups/${conv.id}/members`, { user_ids: ids });
      closeModal();
      renderMain();
    };
  };
  $("#cs-gava").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { await API.upload(`/api/chat/groups/${conv.id}/avatar`, f); renderMain(); }
    catch (err) { alert(err.message); }
  };
}

async function renderSideTasks(conv) {
  const tasks = await API.get(`/api/chat/conversations/${conv.id}/tasks`);
  const box = $("#cs-body");
  box.innerHTML = `
    ${tasks.length ? tasks.map((task) => `
      <div class="cs-item">
        <span class="mono" style="flex-shrink:0">${esc(task.key)}</span>
        <a href="#" data-opentask="${task.id}" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(task.title)}</a>
        <span class="badge st-${task.status}" style="flex-shrink:0">${t("status." + task.status)}</span>
        <button class="ci-del" data-untask="${task.id}" title="${t("chat.detach")}">✕</button>
      </div>`).join("") : `<div class="muted">—</div>`}
    <button class="btn secondary small" id="cs-attach" style="margin-top:10px">+ ${t("chat.attach_task")}</button>`;
  document.querySelectorAll("[data-opentask]").forEach((a) =>
    a.onclick = async (e) => {
      e.preventDefault();
      state.currentTask = await API.get(`/api/tasks/${a.dataset.opentask}`);
      state.currentDept = null;
      state.view = "catalog";
      renderMain();
    });
  document.querySelectorAll("[data-untask]").forEach((b) =>
    b.onclick = async () => {
      await API.del(`/api/chat/conversations/${conv.id}/tasks/${b.dataset.untask}`);
      renderSideTasks(conv);
    });
  $("#cs-attach").onclick = async () => {
    const deps = await API.get("/api/departments");
    openModal(`
      <h3>${t("chat.attach_task")}</h3>
      <div class="field"><select id="at-dep">
        <option value="">${t("chat.select_department")}</option>
        ${deps.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}
      </select></div>
      <div class="field"><select id="at-task" disabled><option value="">${t("chat.select_task")}</option></select></div>
      <div class="modal-actions">
        <button class="btn secondary" data-close>${t("common.cancel")}</button>
        <button class="btn" id="at-save" disabled>${t("chat.attach_task")}</button>
      </div>`);
    $("#at-dep").onchange = async (e) => {
      const depId = e.target.value;
      const sel = $("#at-task");
      sel.innerHTML = `<option value="">${t("chat.select_task")}</option>`;
      sel.disabled = !depId;
      if (!depId) return;
      const tasks2 = await API.get(`/api/departments/${depId}/tasks?archived=false`);
      sel.innerHTML += tasks2.map((x) => `<option value="${x.id}">${esc(x.key)} — ${esc(x.title)}</option>`).join("");
      sel.onchange = () => { $("#at-save").disabled = !sel.value; };
    };
    $("#at-save").onclick = async () => {
      const tid = parseInt($("#at-task").value);
      if (!tid) return;
      await API.post(`/api/chat/conversations/${conv.id}/tasks`, { task_id: tid });
      closeModal();
      renderSideTasks(conv);
    };
  };
}

function openGroupModal() {
  API.get("/api/users").then((users) => {
    const others = users.filter((u) => u.id !== state.me.id);
    openModal(`
      <h3>${t("chat.new_group")}</h3>
      <div class="field"><label>${t("chat.group_name")}</label><input id="gr-name" /></div>
      <div class="field"><label>${t("chat.group_members_pick")}</label>
        <div class="chip-list">${others.map((u) => `
          <div class="chip-check"><input type="checkbox" id="gm-${u.id}" /><label for="gm-${u.id}">${esc(displayName(u))}</label></div>`).join("") || `<span class="muted">—</span>`}</div></div>
      <div class="modal-actions">
        <button class="btn secondary" data-close>${t("common.cancel")}</button>
        <button class="btn" id="gr-save">${t("common.create")}</button>
      </div>`);
    $("#gr-save").onclick = async () => {
      const name = $("#gr-name").value.trim();
      if (!name) return;
      const ids = others.filter((u) => $(`#gm-${u.id}`).checked).map((u) => u.id);
      const conv = await API.post("/api/chat/groups", { name, member_ids: ids });
      closeModal();
      state.currentConvId = conv.id;
      state._openConvNow = true;
      renderMain();
    };
  });
}

// ---------- Admin: registration requests / notifications ----------
async function viewRequests(main) {
  const pending = await API.get("/api/admin/users?status=pending");
  const deps = await API.get("/api/departments");
  await API.post("/api/notifications/read-all").catch(() => {});
  await refreshNotifCount();
  document.querySelectorAll(".nav-badge").forEach((b) => b.remove());

  main.innerHTML = `
    <div class="topbar"><h2>${t("admin.requests_title")}</h2></div>
    ${pending.length === 0 ? `<div class="empty-state">${t("admin.no_requests")}</div>` : `
      <div class="grid">${pending.map((u) => `
        <div class="card" style="cursor:default">
          <h3>${esc(u.full_name || u.email)}</h3>
          <div class="desc">${esc(u.email)}</div>
          <div style="font-size:13px;margin-bottom:12px">${esc(u.description || "")}</div>
          <div style="display:flex;gap:8px">
            <button class="btn small" data-approve="${u.id}">${t("admin.approve")}</button>
            <button class="btn danger small" data-reject="${u.id}">${t("admin.reject")}</button>
          </div>
        </div>`).join("")}</div>`}`;

  document.querySelectorAll("[data-approve]").forEach((b) =>
    b.onclick = () => openApproveModal(pending.find((u) => u.id == b.dataset.approve), deps));
  document.querySelectorAll("[data-reject]").forEach((b) =>
    b.onclick = async () => { await API.post(`/api/admin/users/${b.dataset.reject}/reject`); renderMain(); });
}

function openApproveModal(user, deps) {
  openModal(`
    <h3>${t("admin.approve")}: ${esc(user.email)}</h3>
    <div class="field"><label>${t("admin.role")}</label>
      <select id="ap-role">
        <option value="agent">${t("admin.role_agent")}</option>
        <option value="observer">${t("admin.role_observer")}</option>
        <option value="admin">${t("admin.role_admin")}</option>
      </select></div>
    <div class="field"><label>${t("admin.select_departments")}</label>
      <div class="chip-list">${deps.map((d) => `
        <div class="chip-check"><input type="checkbox" id="ap-d-${d.id}" value="${d.id}" /><label for="ap-d-${d.id}">${esc(d.name)}</label></div>`).join("") || `<span class="muted">${t("catalog.empty")}</span>`}</div></div>
    <div class="modal-actions">
      <button class="btn secondary" data-close>${t("common.cancel")}</button>
      <button class="btn" id="ap-save">${t("admin.approve")}</button>
    </div>`);
  $("#ap-save").onclick = async () => {
    const ids = deps.filter((d) => $(`#ap-d-${d.id}`).checked).map((d) => d.id);
    await API.post(`/api/admin/users/${user.id}/approve`, { role: $("#ap-role").value, department_ids: ids });
    closeModal();
    renderMain();
  };
}

// ---------- Admin: users ----------
async function viewUsers(main) {
  const users = await API.get("/api/admin/users");
  const deps = await API.get("/api/departments");
  const depName = (id) => (deps.find((d) => d.id === id) || {}).name || id;

  main.innerHTML = `
    <div class="topbar">
      <h2>${t("admin.users_title")}</h2>
      <button class="btn secondary" id="manage-pos">${t("admin.manage_positions")}</button>
    </div>
    <div class="panel"><table>
      <thead><tr><th>${t("login.email")}</th><th>${t("login.full_name")}</th><th>${t("admin.role")}</th><th>${t("admin.position")}</th><th>${t("tasks.status")}</th><th>${t("admin.access")}</th><th></th></tr></thead>
      <tbody>${users.map((u) => `
        <tr style="cursor:default" class="${u.role === "observer" ? "observer-row" : ""}">
          <td data-label="${t("login.email")}">${u.role === "observer" ? userLabel(u) : esc(u.email)}</td>
          <td data-label="${t("login.full_name")}">${esc(u.full_name || "")}</td>
          <td data-label="${t("admin.role")}">${t("admin.role_" + u.role)}</td>
          <td data-label="${t("admin.position")}">${posName(u.position) ? esc(posName(u.position)) : "—"}</td>
          <td data-label="${t("tasks.status")}"><span class="badge st-${u.status === "approved" ? "resolved" : u.status === "pending" ? "need_info" : "closed"}">${t("admin.status_" + u.status)}</span></td>
          <td class="muted" data-label="${t("admin.access")}">${u.department_ids.map(depName).map(esc).join(", ") || "—"}</td>
          <td data-label="" style="white-space:nowrap;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn secondary small" data-access="${u.id}">${t("admin.access")}</button>
            <button class="btn secondary small" data-resetpw="${u.id}">${t("admin.reset_password")}</button>
            ${u.id !== state.me.id ? `<button class="btn danger small" data-deluser="${u.id}">${t("common.delete")}</button>` : ""}
          </td>
        </tr>`).join("")}</tbody>
    </table></div>`;

  $("#manage-pos").onclick = openPositionsModal;
  document.querySelectorAll("[data-access]").forEach((b) =>
    b.onclick = () => openAccessModal(users.find((u) => u.id == b.dataset.access), deps));
  document.querySelectorAll("[data-resetpw]").forEach((b) =>
    b.onclick = () => openResetPasswordModal(users.find((u) => u.id == b.dataset.resetpw)));
  document.querySelectorAll("[data-deluser]").forEach((b) =>
    b.onclick = async () => { if (confirm(t("common.confirm_delete"))) { await API.del(`/api/admin/users/${b.dataset.deluser}`); renderMain(); } });
}

function openResetPasswordModal(user) {
  openModal(`
    <h3>${t("admin.reset_password_title")}: ${esc(user.email)}</h3>
    <div class="field">
      <label>${t("admin.temp_password_hint")}</label>
      <input id="rp-pass" placeholder="${t("admin.temp_password_hint")}" autocomplete="off" />
    </div>
    <div id="rp-result"></div>
    <div class="modal-actions">
      <button class="btn secondary" data-close>${t("common.cancel")}</button>
      <button class="btn" id="rp-save">${t("admin.reset_password")}</button>
    </div>`);
  $("#rp-save").onclick = async () => {
    const val = $("#rp-pass").value.trim();
    const res = await API.post(`/api/admin/users/${user.id}/reset-password`, { password: val || null });
    $("#rp-result").innerHTML = `
      <div class="msg info">${t("admin.temp_password_generated")}
        <div style="margin-top:8px;display:flex;align-items:center;gap:10px">
          <b style="font-size:18px;font-family:ui-monospace,monospace">${esc(res.temp_password)}</b>
          <button class="btn secondary small" id="rp-copy">${t("admin.copy")}</button>
        </div>
      </div>`;
    $("#rp-copy").onclick = () => {
      if (navigator.clipboard) navigator.clipboard.writeText(res.temp_password);
      $("#rp-copy").textContent = t("admin.copied");
    };
    // Turn the primary button into a "done" action.
    const save = $("#rp-save");
    save.textContent = t("common.close");
    save.onclick = () => closeModal();
  };
}

async function openAccessModal(user, deps) {
  const positions = await API.get("/api/positions");
  openModal(`
    <h3>${t("admin.access")}: ${esc(user.email)}</h3>
    <div class="field"><label>${t("admin.role")}</label>
      <select id="ac-role">
        <option value="agent" ${user.role === "agent" ? "selected" : ""}>${t("admin.role_agent")}</option>
        <option value="observer" ${user.role === "observer" ? "selected" : ""}>${t("admin.role_observer")}</option>
        <option value="admin" ${user.role === "admin" ? "selected" : ""}>${t("admin.role_admin")}</option>
      </select></div>
    <div class="field"><label>${t("admin.position")}</label>
      <select id="ac-pos">
        <option value="0">${t("admin.position_none")}</option>
        ${positions.map((p) => `<option value="${p.id}" ${user.position_id === p.id ? "selected" : ""}>${esc(posName(p))}</option>`).join("")}
      </select></div>
    <div class="field"><label>${t("admin.select_departments")}</label>
      <div class="chip-list">${deps.map((d) => `
        <div class="chip-check"><input type="checkbox" id="ac-d-${d.id}" value="${d.id}" ${user.department_ids.includes(d.id) ? "checked" : ""} /><label for="ac-d-${d.id}">${esc(d.name)}</label></div>`).join("") || `<span class="muted">${t("catalog.empty")}</span>`}</div></div>
    <div class="modal-actions">
      <button class="btn secondary" data-close>${t("common.cancel")}</button>
      <button class="btn" id="ac-save">${t("admin.save_access")}</button>
    </div>`);
  $("#ac-save").onclick = async () => {
    const ids = deps.filter((d) => $(`#ac-d-${d.id}`).checked).map((d) => d.id);
    await API.put(`/api/admin/users/${user.id}/role`, { role: $("#ac-role").value });
    await API.put(`/api/admin/users/${user.id}/access`, { department_ids: ids });
    await API.put(`/api/admin/users/${user.id}/position`, { position_id: parseInt($("#ac-pos").value) || null });
    closeModal();
    renderMain();
  };
}

// ---------- Admin: manage the job-title (position) catalog ----------
async function openPositionsModal() {
  const positions = await API.get("/api/positions");
  const langCols = (idPrefix, p) => `
    <div class="row" style="gap:8px">
      <input placeholder="Русский" value="${esc(p ? p.name_ru : "")}" id="${idPrefix}-ru" />
      <input placeholder="English" value="${esc(p ? p.name_en : "")}" id="${idPrefix}-en" />
      <input placeholder="中文" value="${esc(p ? p.name_zh : "")}" id="${idPrefix}-zh" />
    </div>`;
  openModal(`
    <h3>${t("admin.positions_title")}</h3>
    <div id="pos-list">
      ${positions.length ? positions.map((p) => `
        <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px">
          <div style="flex:1">${langCols("pe-" + p.id, p)}</div>
          <button class="btn small" data-possave="${p.id}">${t("common.save")}</button>
          <button class="ci-del" data-posdel="${p.id}" title="${t("common.delete")}" style="margin-top:8px">✕</button>
        </div>`).join("") : `<div class="muted" style="margin-bottom:10px">${t("admin.no_positions")}</div>`}
    </div>
    <hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />
    <label>${t("admin.new_position")}</label>
    ${langCols("pos-new", null)}
    <div style="margin-top:8px"><button class="btn small" id="pos-add">+ ${t("common.create")}</button></div>
    <div class="modal-actions">
      <button class="btn" data-close>${t("common.close")}</button>
    </div>`);
  const reopen = () => { closeModal(); openPositionsModal(); };
  const readVals = (prefix) => ({
    name_ru: $(`#${prefix}-ru`).value.trim(),
    name_en: $(`#${prefix}-en`).value.trim(),
    name_zh: $(`#${prefix}-zh`).value.trim(),
  });
  $("#pos-add").onclick = async () => {
    const v = readVals("pos-new");
    if (!v.name_ru) return alert(t("admin.position") + ": Русский");
    await API.post("/api/positions", v);
    reopen();
  };
  document.querySelectorAll("[data-possave]").forEach((b) =>
    b.onclick = async () => {
      const v = readVals("pe-" + b.dataset.possave);
      if (!v.name_ru) return;
      await API.put(`/api/positions/${b.dataset.possave}`, v);
      reopen();
    });
  document.querySelectorAll("[data-posdel]").forEach((b) =>
    b.onclick = async () => { await API.del(`/api/positions/${b.dataset.posdel}`); reopen(); });
}

// ---------- Admin: appearance / palette ----------
async function viewSettings(main) {
  const s = await API.get("/api/settings");
  state.settings = s;
  main.innerHTML = `
    <div class="topbar"><h2>${t("admin.settings_title")}</h2></div>
    <div class="section" style="max-width:760px">
      <div class="field"><label>${t("admin.app_name")}</label><input id="set-name" value="${esc(s.app_name)}" /></div>
      <h4 style="margin:18px 0 12px">${t("admin.palette")}</h4>
      <div class="palette-grid">
        ${PALETTE_KEYS.map((k) => `
          <div class="color-field">
            <input type="color" id="col-${k}" value="${esc(s.palette[k] || "#000000")}" />
            <span class="cf-label">${t("admin.color." + k)}</span>
          </div>`).join("")}
      </div>
      <div style="margin-top:20px;display:flex;gap:10px">
        <button class="btn" id="pal-save">${t("admin.save_palette")}</button>
        <button class="btn secondary" id="pal-reset">${t("admin.reset_palette")}</button>
      </div>
    </div>`;

  // Live preview as the admin picks colors.
  PALETTE_KEYS.forEach((k) => {
    $(`#col-${k}`).oninput = (e) => applyPalette({ [k]: e.target.value });
  });

  $("#pal-save").onclick = async () => {
    const palette = {};
    PALETTE_KEYS.forEach((k) => (palette[k] = $(`#col-${k}`).value));
    const updated = await API.put("/api/settings", { palette, app_name: $("#set-name").value.trim() });
    state.settings = updated;
    applyPalette(updated.palette);
    renderShell();
    state.view = "settings";
    renderMain();
  };
  $("#pal-reset").onclick = async () => {
    const updated = await API.post("/api/settings/reset");
    state.settings = updated;
    applyPalette(updated.palette);
    renderShell();
    state.view = "settings";
    renderMain();
  };

  await renderBackupSection(main);
  await renderNavSection(main);
}

// ---------- Admin: sidebar tab visibility (feature toggles) ----------
async function renderNavSection(main) {
  const cfg = await API.get("/api/settings/nav/admin");
  const users = (await API.get("/api/admin/users?status=approved")).filter((u) => u.role !== "admin");
  const exempt = new Set(cfg.exempt_user_ids || []);
  const TAB_LABELS = {
    catalog: t("nav.catalog"), archive: t("nav.archive"),
    chat: t("nav.chat"), directory: t("nav.users"),
  };

  const html = `
    <div class="section" style="max-width:760px;margin-top:20px">
      <h2 style="margin:0 0 6px;font-size:18px">${t("admin.nav_title")}</h2>
      <div class="muted" style="font-size:13px;margin-bottom:14px">${t("admin.nav_hint")}</div>
      ${Object.keys(TAB_LABELS).map((k) => `
        <div class="nav-toggle-row">
          <span>${esc(TAB_LABELS[k])}</span>
          <label class="switch">
            <input type="checkbox" id="nt-${k}" ${cfg.tabs[k] !== false ? "checked" : ""} />
            <span class="sl"></span>
          </label>
        </div>`).join("")}
      <h4 style="margin:18px 0 8px">${t("admin.nav_exempt")}</h4>
      <div class="chip-list">${users.length ? users.map((u) => `
        <div class="chip-check">
          <input type="checkbox" id="ne-${u.id}" ${exempt.has(u.id) ? "checked" : ""} />
          <label for="ne-${u.id}">${esc(u.full_name || u.email)}</label>
        </div>`).join("") : `<span class="muted">${t("admin.no_users")}</span>`}</div>
      <div style="margin-top:14px"><button class="btn" id="nt-save">${t("common.save")}</button></div>
    </div>`;
  main.insertAdjacentHTML("beforeend", html);

  $("#nt-save").onclick = async () => {
    const tabs = {};
    Object.keys(TAB_LABELS).forEach((k) => (tabs[k] = $(`#nt-${k}`).checked));
    const ids = users.filter((u) => $(`#ne-${u.id}`).checked).map((u) => u.id);
    await API.put("/api/settings/nav/admin", { tabs, exempt_user_ids: ids });
    await fetchNavTabs();
    state.view = "settings";
    renderShell();
  };
}

// ---------- Admin: backups / export / import ----------
async function renderBackupSection(main) {
  const cfg = await API.get("/api/admin/backup/config");
  const files = cfg.backups || [];

  const html = `
    <div class="section" style="max-width:760px;margin-top:20px">
      <h2 style="margin:0 0 16px;font-size:18px">${t("admin.backup_title")}</h2>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
        <button class="btn" id="bk-export">⬇ ${t("admin.backup_export")}</button>
        <button class="btn secondary" id="bk-run">${t("admin.backup_now")}</button>
        <label class="btn secondary" style="cursor:pointer;margin:0">
          ⬆ ${t("admin.backup_import")}
          <input type="file" id="bk-import" accept=".zip,.json,application/zip,application/json" style="display:none" />
        </label>
      </div>

      <h4 style="margin:0 0 12px">${t("admin.backup_auto")}</h4>
      <div class="chip-check" style="margin-bottom:12px">
        <input type="checkbox" id="bk-enabled" ${cfg.enabled ? "checked" : ""} />
        <label for="bk-enabled">${t("admin.backup_enabled")}</label>
      </div>
      <div class="row">
        <div class="field"><label>${t("admin.backup_interval")}</label>
          <input type="number" id="bk-interval" min="1" value="${cfg.interval_hours}" /></div>
        <div class="field"><label>${t("admin.backup_keep")}</label>
          <input type="number" id="bk-keep" min="1" value="${cfg.keep}" /></div>
      </div>
      <div style="margin-bottom:8px" class="muted">${t("admin.backup_last")}: ${cfg.last_backup_at ? fmtDate(cfg.last_backup_at) : t("admin.backup_never")}</div>
      <button class="btn" id="bk-save">${t("admin.backup_save")}</button>

      <h4 style="margin:22px 0 10px">${t("admin.backup_list")}</h4>
      <div id="bk-list">${renderBackupList(files)}</div>
    </div>`;
  main.insertAdjacentHTML("beforeend", html);

  $("#bk-export").onclick = () => downloadWithAuth("/api/admin/backup/export", "helpdesk-export.zip");
  $("#bk-run").onclick = async () => { await API.post("/api/admin/backup/run"); state.view = "settings"; renderMain(); };
  $("#bk-save").onclick = async () => {
    await API.put("/api/admin/backup/config", {
      enabled: $("#bk-enabled").checked,
      interval_hours: parseInt($("#bk-interval").value) || 24,
      keep: parseInt($("#bk-keep").value) || 14,
    });
    state.view = "settings";
    renderMain();
  };
  $("#bk-import").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!confirm(t("admin.backup_import_confirm"))) { e.target.value = ""; return; }
    try {
      const res = await API.upload("/api/admin/backup/import", f);
      alert(`${t("admin.backup_import_done")}: ${JSON.stringify(res.restored)}`);
      logout(); // data (incl. users) replaced — force a fresh login
    } catch (err) {
      alert(err.message);
    }
  };
  document.querySelectorAll("[data-bkfile]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const name = a.dataset.bkfile;
      downloadWithAuth(`/api/admin/backup/download/${encodeURIComponent(name)}`, name);
    }));
}

function renderBackupList(files) {
  if (!files.length) return `<div class="muted">${t("admin.backup_none")}</div>`;
  return `<div class="panel"><table>
    <tbody>${files.map((f) => `
      <tr style="cursor:default">
        <td class="mono" data-label="">${esc(f.name)}</td>
        <td class="muted" data-label="">${(f.size / 1024).toFixed(0)} KB</td>
        <td data-label="">${fmtDate(f.created_at)}</td>
        <td data-label=""><a class="btn secondary small" href="#" data-bkfile="${esc(f.name)}">${t("admin.backup_download")}</a></td>
      </tr>`).join("")}</tbody>
  </table></div>`;
}

// Download a protected endpoint by fetching with the auth header as a blob.
async function downloadWithAuth(url, fallbackName) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + API.token } });
  if (!res.ok) return alert(t("common.error"));
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  const m = cd.match(/filename="?([^"]+)"?/);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = m ? m[1] : fallbackName;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------
function openModal(html, wide) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "modal-overlay";
  overlay.innerHTML = `<div class="modal ${wide ? "wide" : ""}">${html}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
}
function closeModal() {
  const ex = document.getElementById("modal-overlay");
  if (ex) ex.remove();
}

// ---------------------------------------------------------------------------
// Keep the admin badge fresh on shell renders.
// ---------------------------------------------------------------------------
const _origRenderShell = renderShell;
renderShell = function () {
  _origRenderShell();
  if (state.me && state.me.role === "admin") {
    refreshNotifCount().then(() => {
      const req = document.querySelector('.nav-item[data-view="requests"]');
      if (req && state.notifCount > 0 && !req.querySelector(".nav-badge")) {
        const b = document.createElement("span");
        b.className = "nav-badge";
        b.textContent = state.notifCount;
        req.appendChild(b);
      }
    });
  }
};

// Go!
boot();
