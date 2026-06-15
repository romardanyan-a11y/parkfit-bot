// Единый пул подключений к Postgres, общий для броней и сессий.
// Если DATABASE_URL не задан — pool === null (локальная разработка на файле/памяти).
const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;

if (DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Облачный Postgres (Neon/Supabase) требует SSL; локальный — нет.
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: 3, // serverless: держим мало соединений
  });
}

module.exports = { pool };
