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
    initPromise = pool.query(`
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
        created_at  TIMESTAMPTZ DEFAULT now()
      )
    `);
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

async function addBooking(booking) {
  if (pool) {
    await ensureTable();
    await pool.query(
      `INSERT INTO bookings
         (user_id, username, capsule_id, day, day_label, slot_time, duration, goal, access_code, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
    return booking;
  }

  const bookings = loadFile();
  bookings.push(booking);
  saveFile(bookings);
  return booking;
}

async function getUserBookings(userId) {
  if (pool) {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT user_id     AS "userId",
              username,
              capsule_id  AS "capsuleId",
              day,
              day_label   AS "dayLabel",
              slot_time   AS "time",
              duration,
              goal,
              access_code AS "accessCode",
              created_at  AS "createdAt"
       FROM bookings
       WHERE user_id = $1
       ORDER BY id ASC`,
      [userId]
    );
    return rows;
  }

  return loadFile().filter((b) => b.userId === userId);
}

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

module.exports = { addBooking, getUserBookings, generateCode };
