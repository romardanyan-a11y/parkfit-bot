// Хранилище сессий Telegraf в Postgres.
// Нужно на serverless (webhook): между запросами память не сохраняется,
// поэтому пошаговый диалог бронирования держим в БД.
const { pool } = require("./db");

// Сессии старше этого срока считаем брошенными и удаляем при обращении к store.
const SESSION_TTL_DAYS = 7;

let initPromise = null;
let lastCleanup = 0;

function ensureTable() {
  if (!initPromise) {
    initPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        key        TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `);
  }
  return initPromise;
}

// Раз в час чистим протухшие сессии (не чаще, чтобы не дёргать БД на каждый апдейт).
async function cleanupStale() {
  const now = Date.now();
  if (now - lastCleanup < 3600_000) return;
  lastCleanup = now;
  try {
    await pool.query(
      `DELETE FROM sessions WHERE updated_at < now() - ($1 || ' days')::interval`,
      [String(SESSION_TTL_DAYS)]
    );
  } catch (e) {
    console.error("Не удалось очистить старые сессии:", e.message);
  }
}

// Интерфейс store для telegraf v4: get/set/delete (могут быть async).
const store = {
  async get(key) {
    await ensureTable();
    const { rows } = await pool.query("SELECT data FROM sessions WHERE key = $1", [key]);
    return rows[0] ? rows[0].data : undefined;
  },
  async set(key, value) {
    await ensureTable();
    cleanupStale();
    await pool.query(
      `INSERT INTO sessions (key, data, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = now()`,
      [key, value]
    );
  },
  async delete(key) {
    await ensureTable();
    await pool.query("DELETE FROM sessions WHERE key = $1", [key]);
  },
};

module.exports = { store };
