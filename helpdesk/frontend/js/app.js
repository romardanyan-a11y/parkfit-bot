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

function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d)) return "—";
  return d.toLocaleString(I18N.lang === "zh" ? "zh-CN" : I18N.lang === "en" ? "en-US" : "ru-RU",
    { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDay(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(I18N.lang === "zh" ? "zh-CN" : I18N.lang === "en" ? "en-US" : "ru-RU");
}

// Render a user's name; observers are highlighted everywhere they appear.
function userLabel(u) {
  if (!u) return "—";
  const name = esc(u.full_name || u.email);
  if (u.role === "observer") {
    return `<span class="observer-label" title="${t("admin.role_observer")}">👁 ${name}</span>`;
  }
  return name;
}

// Plain-text variant for <option> labels (no HTML rendering there).
function userOptionText(u) {
  return (u.role === "observer" ? "👁 " : "") + (u.full_name || u.email);
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
  const nav = [
    { key: "catalog", label: t("nav.catalog") },
    { key: "archive", label: t("nav.archive") },
  ];
  if (isAdmin) {
    nav.push({ key: "requests", label: t("nav.requests"), badge: state.notifCount });
    nav.push({ key: "users", label: t("nav.users") });
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
  render();
}

async function renderMain() {
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
      <h3>${esc(d.name)}</h3>
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
      <button class="btn" id="new-task">+ ${t("tasks.new_task")}</button>
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
        <th>${t("tasks.key")}</th><th>${t("tasks.task_title")}</th><th>${t("tasks.status")}</th>
        <th>${t("tasks.priority")}</th><th>${t("tasks.assignee")}</th><th>${t("tasks.due_date")}</th>
      </tr></thead>
      <tbody>${tasks.map((task) => `
        <tr data-task="${task.id}">
          <td class="mono" data-label="${t("tasks.key")}">${esc(task.key)}</td>
          <td data-label="${t("tasks.task_title")}">${esc(task.title)}${tagChips(task.tags)}</td>
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
    await API.post(`/api/departments/${dep.id}/tasks`, {
      title,
      description: $("#t-desc").value.trim(),
      priority: $("#t-prio").value,
      type: $("#t-type").value,
      assignee_id: $("#t-assignee").value ? parseInt($("#t-assignee").value) : null,
      due_date: due ? new Date(due).toISOString() : null,
      tag_ids: tagIds,
    });
    closeModal();
    renderMain();
  };
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
            <div style="margin-top:8px"><button class="btn small" id="c-send">${t("tasks.send")}</button></div>
          </div>
        </div>

        <div class="section">
          <h4>${t("tasks.attachments")}</h4>
          <div id="attachments">${renderAttachments(task.attachments)}</div>
          <div style="margin-top:10px"><input type="file" id="a-file" /></div>
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
    if (!body) return;
    await API.post(`/api/tasks/${task.id}/comments`, { body });
    reload();
  };
  $("#a-file").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { await API.upload(`/api/tasks/${task.id}/attachments`, f); reload(); }
    catch (err) { alert(err.message); }
  };

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
  return comments.map((c) => `
    <div class="comment">
      <div class="head">
        <span class="author">${userLabel(c.author)}</span>
        <span class="time">${fmtDate(c.created_at)}</span>
      </div>
      <div class="body">${esc(c.body)}</div>
    </div>`).join("");
}

function renderAttachments(atts) {
  if (!atts || !atts.length) return `<div class="muted">${t("tasks.no_attachments")}</div>`;
  return atts.map((a) => `
    <div class="attach-item">
      <span>📎 ${esc(a.filename)} <span class="muted">(${(a.size / 1024).toFixed(1)} KB)</span></span>
      <a class="btn secondary small" href="/api/attachments/${a.id}/download?token=" data-att="${a.id}">${t("tasks.download")}</a>
    </div>`).join("");
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
    <div class="topbar"><h2>${t("admin.users_title")}</h2></div>
    <div class="panel"><table>
      <thead><tr><th>${t("login.email")}</th><th>${t("login.full_name")}</th><th>${t("admin.role")}</th><th>${t("tasks.status")}</th><th>${t("admin.access")}</th><th></th></tr></thead>
      <tbody>${users.map((u) => `
        <tr style="cursor:default" class="${u.role === "observer" ? "observer-row" : ""}">
          <td data-label="${t("login.email")}">${u.role === "observer" ? userLabel(u) : esc(u.email)}</td>
          <td data-label="${t("login.full_name")}">${esc(u.full_name || "")}</td>
          <td data-label="${t("admin.role")}">${t("admin.role_" + u.role)}</td>
          <td data-label="${t("tasks.status")}"><span class="badge st-${u.status === "approved" ? "resolved" : u.status === "pending" ? "need_info" : "closed"}">${t("admin.status_" + u.status)}</span></td>
          <td class="muted" data-label="${t("admin.access")}">${u.department_ids.map(depName).map(esc).join(", ") || "—"}</td>
          <td data-label="" style="white-space:nowrap;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn secondary small" data-access="${u.id}">${t("admin.access")}</button>
            <button class="btn secondary small" data-resetpw="${u.id}">${t("admin.reset_password")}</button>
            ${u.id !== state.me.id ? `<button class="btn danger small" data-deluser="${u.id}">${t("common.delete")}</button>` : ""}
          </td>
        </tr>`).join("")}</tbody>
    </table></div>`;

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

function openAccessModal(user, deps) {
  openModal(`
    <h3>${t("admin.access")}: ${esc(user.email)}</h3>
    <div class="field"><label>${t("admin.role")}</label>
      <select id="ac-role">
        <option value="agent" ${user.role === "agent" ? "selected" : ""}>${t("admin.role_agent")}</option>
        <option value="observer" ${user.role === "observer" ? "selected" : ""}>${t("admin.role_observer")}</option>
        <option value="admin" ${user.role === "admin" ? "selected" : ""}>${t("admin.role_admin")}</option>
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
    closeModal();
    renderMain();
  };
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
          <input type="file" id="bk-import" accept="application/json,.json" style="display:none" />
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

  $("#bk-export").onclick = () => downloadWithAuth("/api/admin/backup/export", "helpdesk-export.json");
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
