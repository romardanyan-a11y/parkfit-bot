const { Telegraf, Markup, session } = require("telegraf");
const { addBooking, getUserBookings, generateCode } = require("./storage");
const { pool } = require("./db");

// ─── Данные для диалога бронирования ───────────────────────────────────────

const CAPSULES = [
  { id: "rut-campus-1", name: "ParkFit Campus", location: "РУТ, корпус рядом с кампусом", price: 799 },
  { id: "coworking-1", name: "ParkFit Coworking", location: "Партнерская локация", price: 699 },
];

const SLOTS = ["08:00", "09:30", "11:00", "13:00", "15:30", "19:30", "21:00"];

const DURATIONS = [30, 60, 90];

const GOALS = [
  "Поддержать форму",
  "Силовая тренировка",
  "Снижение веса",
  "Быстрая тренировка",
];

// Генерируем даты на ближайшие 4 дня
function getNextDays() {
  const days = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const label = i === 0 ? "Сегодня" : i === 1 ? "Завтра" : d.toLocaleDateString("ru-RU", { weekday: "short" });
    const date = d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
    const value = d.toISOString().split("T")[0];
    days.push({ label, date, value });
  }
  return days;
}

// ─── Вспомогательные функции ────────────────────────────────────────────────

function capsuleKeyboard() {
  return Markup.inlineKeyboard(
    CAPSULES.map((c) => [Markup.button.callback(`${c.name} — ${c.price} ₽/ч`, `capsule_${c.id}`)])
  );
}

function dayKeyboard() {
  const days = getNextDays();
  return Markup.inlineKeyboard(
    days.map((d) => [Markup.button.callback(`${d.label}, ${d.date}`, `day_${d.value}_${d.date}`)])
  );
}

function slotKeyboard() {
  const rows = [];
  for (let i = 0; i < SLOTS.length; i += 3) {
    rows.push(SLOTS.slice(i, i + 3).map((t) => Markup.button.callback(t, `slot_${t}`)));
  }
  return Markup.inlineKeyboard(rows);
}

function durationKeyboard() {
  return Markup.inlineKeyboard([
    DURATIONS.map((d) => Markup.button.callback(`${d} мин`, `dur_${d}`)),
  ]);
}

function goalKeyboard() {
  return Markup.inlineKeyboard(GOALS.map((g, i) => [Markup.button.callback(g, `goal_${i}`)]));
}

function confirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Подтвердить и забронировать", "confirm_booking")],
    [Markup.button.callback("❌ Отменить", "cancel_booking")],
  ]);
}

function formatBookingText(b) {
  const capsule = CAPSULES.find((c) => c.id === b.capsuleId) || { name: b.capsuleId, price: 0 };
  const total = Math.round((capsule.price / 60) * b.duration);
  return (
    `📋 *Проверь бронь*\n\n` +
    `🏋️ Капсула: *${capsule.name}*\n` +
    `📍 Адрес: ${capsule.location}\n` +
    `📅 Дата: ${b.dayLabel}\n` +
    `⏰ Время: ${b.time}, ${b.duration} мин\n` +
    `🎯 Цель: ${b.goal}\n` +
    `💳 Стоимость: *${total} ₽*`
  );
}

function formatConfirmation(b) {
  const capsule = CAPSULES.find((c) => c.id === b.capsuleId) || { name: b.capsuleId };
  return (
    `✅ *Бронь создана!*\n\n` +
    `🏋️ ${capsule.name}\n` +
    `📅 ${b.dayLabel}, ${b.time} (${b.duration} мин)\n\n` +
    `🔑 *Код доступа: \`${b.accessCode}\`*\n` +
    `_Активен за 10 минут до начала_\n\n` +
    `Введи код на замке капсулы — и тренируйся!`
  );
}

// ─── Конструктор бота (без запуска) ──────────────────────────────────────────

function createBot() {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const MINI_APP_URL = process.env.MINI_APP_URL || "";

  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN не задан в переменных окружения.");
  }

  const bot = new Telegraf(BOT_TOKEN);

  // На serverless (есть Postgres) храним сессии в БД, иначе — в памяти.
  if (pool) {
    const { store } = require("./session-store");
    bot.use(session({ store }));
  } else {
    bot.use(session());
  }

  // ─── Команды ────────────────────────────────────────────────────────────

  bot.start((ctx) => {
    ctx.session = {};

    if (MINI_APP_URL) {
      ctx.reply(
        "📱 Открой Mini App для удобного бронирования:",
        Markup.keyboard([[Markup.button.webApp("📱 Открыть Mini App", MINI_APP_URL)]]).resize()
      );
    }

    return ctx.reply(
      `👋 Привет! Я бот *ParkFit* — умные фитнес-капсулы.\n\nЗдесь можно записаться на тренировку прямо в чате или через Mini App.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🏋️ Записаться на тренировку", "book_start")],
          [Markup.button.callback("📋 Мои брони", "my_bookings")],
        ]),
      }
    );
  });

  bot.command("mybookings", (ctx) => showMyBookings(ctx));
  bot.command("book", (ctx) => startBooking(ctx));

  // ─── Запись через бота ──────────────────────────────────────────────────

  function startBooking(ctx) {
    ctx.session = { step: "capsule" };
    return ctx.reply("🏋️ *Шаг 1/5* — Выбери капсулу:", {
      parse_mode: "Markdown",
      ...capsuleKeyboard(),
    });
  }

  bot.action("book_start", (ctx) => {
    ctx.answerCbQuery();
    return startBooking(ctx);
  });

  bot.action(/^capsule_(.+)$/, (ctx) => {
    const capsuleId = ctx.match[1];
    ctx.session = { ...ctx.session, capsuleId, step: "day" };
    ctx.answerCbQuery();
    return ctx.editMessageText("📅 *Шаг 2/5* — Выбери дату:", {
      parse_mode: "Markdown",
      ...dayKeyboard(),
    });
  });

  bot.action(/^day_(\d{4}-\d{2}-\d{2})_(.+)$/, (ctx) => {
    const dayValue = ctx.match[1];
    const dayLabel = ctx.match[2];
    ctx.session = { ...ctx.session, day: dayValue, dayLabel, step: "slot" };
    ctx.answerCbQuery();
    return ctx.editMessageText("⏰ *Шаг 3/5* — Выбери время:", {
      parse_mode: "Markdown",
      ...slotKeyboard(),
    });
  });

  bot.action(/^slot_(.+)$/, (ctx) => {
    const time = ctx.match[1];
    ctx.session = { ...ctx.session, time, step: "duration" };
    ctx.answerCbQuery();
    return ctx.editMessageText("⏱ *Шаг 4/5* — Длительность:", {
      parse_mode: "Markdown",
      ...durationKeyboard(),
    });
  });

  bot.action(/^dur_(\d+)$/, (ctx) => {
    const duration = Number(ctx.match[1]);
    ctx.session = { ...ctx.session, duration, step: "goal" };
    ctx.answerCbQuery();
    return ctx.editMessageText("🎯 *Шаг 5/5* — Цель тренировки:", {
      parse_mode: "Markdown",
      ...goalKeyboard(),
    });
  });

  bot.action(/^goal_(\d+)$/, (ctx) => {
    const goal = GOALS[Number(ctx.match[1])];
    ctx.session = { ...ctx.session, goal, step: "confirm" };
    ctx.answerCbQuery();
    return ctx.editMessageText(formatBookingText({ ...ctx.session, goal }), {
      parse_mode: "Markdown",
      ...confirmKeyboard(),
    });
  });

  bot.action("confirm_booking", async (ctx) => {
    const s = ctx.session || {};
    const accessCode = generateCode();
    const booking = await addBooking({
      userId: ctx.from.id,
      username: ctx.from.username || ctx.from.first_name,
      capsuleId: s.capsuleId,
      day: s.day,
      dayLabel: s.dayLabel,
      time: s.time,
      duration: s.duration,
      goal: s.goal,
      accessCode,
      createdAt: new Date().toISOString(),
    });

    ctx.session = {};
    await ctx.answerCbQuery("✅ Бронь создана!");
    return ctx.editMessageText(formatConfirmation(booking), { parse_mode: "Markdown" });
  });

  bot.action("cancel_booking", (ctx) => {
    ctx.session = {};
    ctx.answerCbQuery("Отменено");
    return ctx.editMessageText("❌ Бронирование отменено. Напиши /start чтобы начать заново.");
  });

  // ─── Мои брони ────────────────────────────────────────────────────────────

  async function showMyBookings(ctx) {
    const bookings = await getUserBookings(ctx.from.id);
    if (!bookings.length) {
      return ctx.reply("У тебя пока нет броней.\n\nНажми /book чтобы записаться.");
    }

    const list = bookings
      .slice(-5)
      .reverse()
      .map((b) => {
        const capsule = CAPSULES.find((c) => c.id === b.capsuleId);
        return `📅 *${b.dayLabel}, ${b.time}* (${b.duration} мин)\n🏋️ ${capsule?.name || b.capsuleId}\n🔑 Код: \`${b.accessCode}\``;
      })
      .join("\n\n─────────────\n\n");

    return ctx.reply(`📋 *Твои последние брони:*\n\n${list}`, { parse_mode: "Markdown" });
  }

  bot.action("my_bookings", (ctx) => {
    ctx.answerCbQuery();
    return showMyBookings(ctx);
  });

  // ─── Получение данных из Mini App ─────────────────────────────────────────

  bot.on("web_app_data", async (ctx) => {
    let payload;
    try {
      payload = JSON.parse(ctx.message.web_app_data.data);
    } catch {
      return ctx.reply("Получены данные из Mini App, но не удалось их разобрать.");
    }

    if (payload.type !== "booking_created") return;

    const accessCode = generateCode();
    const capsule = CAPSULES.find((c) => c.id === payload.capsuleId);

    await addBooking({
      userId: ctx.from.id,
      username: ctx.from.username || ctx.from.first_name,
      capsuleId: payload.capsuleId,
      day: payload.day,
      dayLabel: payload.dayLabel || payload.day,
      time: payload.time,
      duration: payload.duration,
      goal: payload.goal,
      accessCode,
      createdAt: new Date().toISOString(),
    });

    const name = ctx.from.first_name || "друг";

    return ctx.reply(
      `✅ *${name}, бронь подтверждена!*\n\n` +
      `🏋️ *${capsule?.name || payload.capsuleName || payload.capsuleId}*\n` +
      `📍 ${capsule?.location || ""}\n\n` +
      `📅 ${payload.dayLabel || payload.day}\n` +
      `⏰ ${payload.time} — ${payload.duration} мин\n` +
      `🎯 Цель: ${payload.goal}\n` +
      `💳 Сумма: ${payload.amount} ₽\n\n` +
      `━━━━━━━━━━━━━━\n` +
      `🔑 *Код доступа: \`${accessCode}\`*\n` +
      `━━━━━━━━━━━━━━\n` +
      `_Введи код на замке капсулы.\nКод активен за 10 минут до начала._`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── Обработка ошибок ─────────────────────────────────────────────────────

  bot.catch((err, ctx) => {
    console.error(`❌ Ошибка при обработке ${ctx?.updateType}:`, err);
    try {
      ctx?.reply?.("Что-то пошло не так. Попробуй ещё раз: /start");
    } catch {}
  });

  return bot;
}

module.exports = { createBot };
