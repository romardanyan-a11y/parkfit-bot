const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

// Если есть Postgres (pool) — пишем в БД (надёжно, переживает редеплой и работает на serverless).
// Если нет — fallback на локальный файл bookings.json (удобно для разработки).
const FILE = path.join(__dirname, "bookings.json");

let initPromise = null;

// ─── Postgres ────────────────────────────────────────────────────────────────

function ensureTable() {
  if (!initPromise) {
    initPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bookings (
          id          BIGSERIAL PRIMARY KEY,
          user_id     BIGINT NOT NULL,
          username    TEXT,
          capsule_id  TEXT,
          day         TEXT,
          day_label   TEXT,
          slot_time   TEXT,
          duration    INTEGER,
          goal        TEXT,
          access_code TEXT,
          status      TEXT NOT NULL DEFAULT 'active',
          created_at  TIMESTAMPTZ DEFAULT now()
        )
      `);
      // Для таблиц, созданных до появления колонки status.
      await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
      // Ускоряем выборку броней пользователя.
      await pool.query(`CREATE INDEX IF NOT EXISTS bookings_user_id_idx ON bookings (user_id)`);
      // Защита от двойного бронирования: один активный слот в капсуле на дату.
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS bookings_slot_uniq
           ON bookings (capsule_id, day, slot_time)
           WHERE status = 'active'`
      );
    })();
  }
  return initPromise;
}

// ─── Файловый fallback ───────────────────────────────────────────────────────

function loadFile() {
  if (!fs.existsSync(FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveFile(bookings) {
  fs.writeFileSync(FILE, JSON.stringify(bookings, null, 2), "utf8");
}

// ─── Публичный интерфейс ──────────────────────────────────────────────────────

// Ошибка, которую кидаем при попытке занять уже занятый слот.
class SlotTakenError extends Error {
  constructor() {
    super("slot_taken");
    this.code = "SLOT_TAKEN";
  }
}

async function isSlotTaken(capsuleId, day, time, { exceptId } = {}) {
  if (pool) {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT 1 FROM bookings
        WHERE capsule_id = $1 AND day = $2 AND slot_time = $3
          AND status = 'active' AND ($4::bigint IS NULL OR id <> $4)
        LIMIT 1`,
      [capsuleId, day, time, exceptId ?? null]
    );
    return rows.length > 0;
  }
  return loadFile().some(
    (b) =>
      b.status !== "cancelled" &&
      b.capsuleId === capsuleId &&
      b.day === day &&
      b.time === time &&
      b.id !== exceptId
  );
}

// Возвращает множество занятых времён для капсулы на дату (для отрисовки клавиатуры).
async function getBookedSlots(capsuleId, day) {
  if (pool) {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT slot_time FROM bookings
        WHERE capsule_id = $1 AND day = $2 AND status = 'active'`,
      [capsuleId, day]
    );
    return new Set(rows.map((r) => r.slot_time));
  }
  return new Set(
    loadFile()
      .filter((b) => b.status !== "cancelled" && b.capsuleId === capsuleId && b.day === day)
      .map((b) => b.time)
  );
}

async function addBooking(booking) {
  if (pool) {
    await ensureTable();
    try {
      const { rows } = await pool.query(
        `INSERT INTO bookings
           (user_id, username, capsule_id, day, day_label, slot_time, duration, goal, access_code, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10)
         RETURNING id`,
        [
          booking.userId,
          booking.username,
          booking.capsuleId,
          booking.day,
          booking.dayLabel,
          booking.time,
          booking.duration,
          booking.goal,
          booking.accessCode,
          booking.createdAt,
        ]
      );
      return { ...booking, id: rows[0].id };
    } catch (err) {
      // 23505 = unique_violation: слот уже занят активной бронью.
      if (err.code === "23505") throw new SlotTakenError();
      throw err;
    }
  }

  const bookings = loadFile();
  if (
    bookings.some(
      (b) =>
        b.status !== "cancelled" &&
        b.capsuleId === booking.capsuleId &&
        b.day === booking.day &&
        b.time === booking.time
    )
  ) {
    throw new SlotTakenError();
  }
  const id = (bookings.reduce((m, b) => Math.max(m, b.id || 0), 0) || 0) + 1;
  const saved = { ...booking, id, status: "active" };
  bookings.push(saved);
  saveFile(bookings);
  return saved;
}

async function getUserBookings(userId) {
  if (pool) {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT id,
              user_id     AS "userId",
              username,
              capsule_id  AS "capsuleId",
              day,
              day_label   AS "dayLabel",
              slot_time   AS "time",
              duration,
              goal,
              access_code AS "accessCode",
              status,
              created_at  AS "createdAt"
       FROM bookings
       WHERE user_id = $1 AND status = 'active'
       ORDER BY id ASC`,
      [userId]
    );
    return rows;
  }

  return loadFile().filter((b) => b.userId === userId && b.status !== "cancelled");
}

// Отменяет бронь пользователя. Возвращает true, если что-то отменили.
async function cancelBooking(userId, id) {
  if (pool) {
    await ensureTable();
    const { rowCount } = await pool.query(
      `UPDATE bookings SET status = 'cancelled'
        WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [id, userId]
    );
    return rowCount > 0;
  }
  const bookings = loadFile();
  const b = bookings.find((x) => x.id === id && x.userId === userId && x.status !== "cancelled");
  if (!b) return false;
  b.status = "cancelled";
  saveFile(bookings);
  return true;
}

// Генерирует 4-значный код, уникальный среди активных броней (несколько попыток).
async function generateCode() {
  const rnd = () => String(Math.floor(1000 + Math.random() * 9000));
  for (let i = 0; i < 10; i++) {
    const code = rnd();
    let exists = false;
    if (pool) {
      await ensureTable();
      const { rows } = await pool.query(
        `SELECT 1 FROM bookings WHERE access_code = $1 AND status = 'active' LIMIT 1`,
        [code]
      );
      exists = rows.length > 0;
    } else {
      exists = loadFile().some((b) => b.status !== "cancelled" && b.accessCode === code);
    }
    if (!exists) return code;
  }
  // Крайне маловероятно: отдаём как есть.
  return rnd();
}

module.exports = {
  addBooking,
  getUserBookings,
  cancelBooking,
  isSlotTaken,
  getBookedSlots,
  generateCode,
  SlotTakenError,
};
