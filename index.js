// Локальный запуск бота через long-polling (для разработки на компе).
// Прод работает через webhook на Vercel — см. api/bot.js.
require("dotenv").config();
const { createBot } = require("./bot");

const bot = createBot();

bot.launch({ dropPendingUpdates: true });
console.log(
  `🤖 ParkFit бот запущен (polling). Хранилище: ${process.env.DATABASE_URL ? "Postgres" : "файл bookings.json"}`
);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
