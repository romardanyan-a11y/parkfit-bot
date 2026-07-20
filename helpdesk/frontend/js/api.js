// Thin REST client. Attaches the bearer token and centralises error handling.
const API = {
  token: localStorage.getItem("token") || null,

  setToken(t) {
    this.token = t;
    if (t) localStorage.setItem("token", t);
    else localStorage.removeItem("token");
  },

  async request(method, path, body, isForm) {
    const headers = {};
    if (this.token) headers["Authorization"] = "Bearer " + this.token;
    let payload = body;
    if (body && !isForm) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(path, { method, headers, body: payload });
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const detail = (data && data.detail) ? data.detail : ("HTTP " + res.status);
      const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      err.status = res.status;
      throw err;
    }
    return data;
  },

  get(p) { return this.request("GET", p); },
  post(p, b) { return this.request("POST", p, b); },
  put(p, b) { return this.request("PUT", p, b); },
  del(p) { return this.request("DELETE", p); },

  // OAuth2 password login expects form-encoded body.
  async login(email, password) {
    const form = new URLSearchParams();
    form.append("username", email);
    form.append("password", password);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "login failed");
    return data;
  },

  async upload(path, file) {
    const fd = new FormData();
    fd.append("file", file);
    return this.request("POST", path, fd, true);
  },
};
