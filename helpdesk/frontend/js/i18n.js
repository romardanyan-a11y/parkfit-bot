// Lightweight i18n: loads ru/en/zh JSON files and resolves dotted keys.
const I18N = {
  lang: localStorage.getItem("lang") || "ru",
  supported: ["ru", "en", "zh"],
  dicts: {},

  async load(lang) {
    if (!this.supported.includes(lang)) lang = "ru";
    if (!this.dicts[lang]) {
      const res = await fetch(`/static/i18n/${lang}.json`);
      this.dicts[lang] = await res.json();
    }
    this.lang = lang;
    localStorage.setItem("lang", lang);
    document.documentElement.lang = lang;
  },

  // t("tasks.new_task") -> localized string, falls back to the key.
  t(key) {
    const parts = key.split(".");
    let node = this.dicts[this.lang];
    for (const p of parts) {
      if (node && typeof node === "object" && p in node) node = node[p];
      else return key;
    }
    return typeof node === "string" ? node : key;
  },

  langName(lang) {
    return (this.dicts[lang] && this.dicts[lang].lang_name) || lang;
  },
};

// Preload all languages so switching is instant.
async function preloadLanguages() {
  await Promise.all(I18N.supported.map((l) => I18N.load(l)));
  // load() sets I18N.lang to the last language loaded; restore the intended one.
  await I18N.load(localStorage.getItem("lang") || "ru");
}
