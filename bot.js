const { Telegraf, Markup, session } = require("telegraf");
const {
  addBooking,
  getUserBookings,
  cancelBooking,
  getBookedSlots,
  generateCode,
  SlotTakenError,
} = require("./storage");
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

// Слот в прошлом? (учитываем только для сегодняшней даты)
function isSlotPast(dayValue, time) {
  const [h, m] = time.split(":").map(Number);
  const slot = new Date(`${dayValue}T00:00:00`);
  slot.setHours(h, m, 0, 0);
  return slot.getTime() <= Date.now();
}

// Стоимость считаем ТОЛЬКО на сервере из прайса капсулы — клиенту не доверяем.
function calcPrice(capsuleId, duration) {
  const capsule = CAPSULES.find((c) => c.id === capsuleId);
  if (!capsule) return 0;
  return Math.round((capsule.price / 60) * Number(duration || 0));
}

// ─── Клавиатуры ──────────────────────────────────────────────────────────────

function capsuleKeyboard() {
  return Markup.inlineKeyboard(
    CAPSULES.map((c) => [Markup.button.callback(`${c.name} — ${c.price} ₽/ч`, `capsule_${c.id}`)])
  );
}

function dayKeyboard() {
  const days = getNextDays();
  return Markup.inlineKeyboard([
    ...days.map((d) => [Markup.button.callback(`${d.label}, ${d.date}`, `day_${d.value}_${d.date}`)]),
    [Markup.button.callback("⬅️ Назад", "back_capsule")],
  ]);
}

// Клавиатура слотов: занятые помечаем 🔒, прошедшие — скрываем.
function slotKeyboard(bookedSet, dayValue) {
  const available = SLOTS.filter((t) => !isSlotPast(dayValue, t));
  const buttons = available.map((t) =>
    bookedSet.has(t)
      ? Markup.button.callback(`🔒 ${t}`, "slot_taken")
      : Markup.button.callback(t, `slot_${t}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  rows.push([Markup.button.callback("⬅️ Назад", "back_day")]);
  return { keyboard: Markup.inlineKeyboard(rows), available };
}

function durationKeyboard() {
  return Markup.inlineKeyboard([
    DURATIONS.map((d) => Markup.button.callback(`${d} мин`, `dur_${d}`)),
    [Markup.button.callback("⬅️ Назад", "back_slot")],
  ]);
}

function goalKeyboard() {
  return Markup.inlineKeyboard([
    ...GOALS.map((g, i) => [Markup.button.callback(g, `goal_${i}`)]),
    [Markup.button.callback("⬅️ Назад", "back_duration")],
  ]);
}

function confirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Подтвердить и забронировать", "confirm_booking")],
    [Markup.button.callback("⬅️ Назад", "back_goal")],
    [Markup.button.callback("❌ Отменить", "cancel_booking")],
  ]);
}

function formatBookingText(b) {
  const capsule = CAPSULES.find((c) => c.id === b.capsuleId) || { name: b.capsuleId, location: "" };
  const total = calcPrice(b.capsuleId, b.duration);
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
  const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";

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

  // Уведомление владельцу о событии (если задан ADMIN_CHAT_ID).
  async function notifyAdmin(text) {
    if (!ADMIN_CHAT_ID) return;
    try {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Не удалось уведомить админа:", e.message);
    }
  }

  // Меню команд в интерфейсе Telegram.
  bot.telegram
    .setMyCommands([
      { command: "start", description: "Главное меню" },
      { command: "book", description: "Записаться на тренировку" },
      { command: "mybookings", description: "Мои брони" },
      { command: "cancel", description: "Сбросить текущую запись" },
      { command: "help", description: "Помощь" },
    ])
    .catch(() => {});

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

  bot.command("cancel", (ctx) => {
    ctx.session = {};
    return ctx.reply("Текущая запись сброшена. Напиши /book чтобы начать заново.");
  });

  bot.help((ctx) =>
    ctx.reply(
      `*ParkFit — помощь*\n\n` +
        `/book — записаться на тренировку\n` +
        `/mybookings — список твоих броней и отмена\n` +
        `/cancel — сбросить незаконченную запись\n` +
        `/start — главное меню\n\n` +
        `После брони ты получаешь 4-значный код — введи его на замке капсулы.`,
      { parse_mode: "Markdown" }
    )
  );

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

  // Шаг 1 → выбрана капсула, показываем даты.
  bot.action(/^capsule_(.+)$/, (ctx) => {
    const capsuleId = ctx.match[1];
    ctx.session = { ...ctx.session, capsuleId, step: "day" };
    ctx.answerCbQuery();
    return ctx.editMessageText("📅 *Шаг 2/5* — Выбери дату:", {
      parse_mode: "Markdown",
      ...dayKeyboard(),
    });
  });

  // Назад к выбору капсулы.
  bot.action("back_capsule", (ctx) => {
    ctx.session = { step: "capsule" };
    ctx.answerCbQuery();
    return ctx.editMessageText("🏋️ *Шаг 1/5* — Выбери капсулу:", {
      parse_mode: "Markdown",
      ...capsuleKeyboard(),
    });
  });

  // Шаг 2 → выбрана дата, показываем доступные слоты.
  async function renderSlotStep(ctx) {
    const s = ctx.session || {};
    const booked = await getBookedSlots(s.capsuleId, s.day);
    const { keyboard, available } = slotKeyboard(booked, s.day);
    if (!available.length) {
      return ctx.editMessageText("😔 На эту дату свободных слотов не осталось.", {
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "back_capsule")]]),
      });
    }
    return ctx.editMessageText("⏰ *Шаг 3/5* — Выбери время:", {
      parse_mode: "Markdown",
      ...keyboard,
    });
  }

  bot.action(/^day_(\d{4}-\d{2}-\d{2})_(.+)$/, (ctx) => {
    const dayValue = ctx.match[1];
    const dayLabel = ctx.match[2];
    ctx.session = { ...ctx.session, day: dayValue, dayLabel, step: "slot" };
    ctx.answerCbQuery();
    return renderSlotStep(ctx);
  });

  // Назад к выбору даты.
  bot.action("back_day", (ctx) => {
    ctx.session = { ...ctx.session, step: "day" };
    ctx.answerCbQuery();
    return ctx.editMessageText("📅 *Шаг 2/5* — Выбери дату:", {
      parse_mode: "Markdown",
      ...dayKeyboard(),
    });
  });

  // Клик по занятому слоту.
  bot.action("slot_taken", (ctx) => ctx.answerCbQuery("Это время уже занято 🔒", { show_alert: false }));

  bot.action(/^slot_(.+)$/, (ctx) => {
    const time = ctx.match[1];
    ctx.session = { ...ctx.session, time, step: "duration" };
    ctx.answerCbQuery();
    return ctx.editMessageText("⏱ *Шаг 4/5* — Длительность:", {
      parse_mode: "Markdown",
      ...durationKeyboard(),
    });
  });

  // Назад к выбору времени.
  bot.action("back_slot", (ctx) => {
    ctx.session = { ...ctx.session, step: "slot" };
    ctx.answerCbQuery();
    return renderSlotStep(ctx);
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

  // Назад к выбору длительности.
  bot.action("back_duration", (ctx) => {
    ctx.session = { ...ctx.session, step: "duration" };
    ctx.answerCbQuery();
    return ctx.editMessageText("⏱ *Шаг 4/5* — Длительность:", {
      parse_mode: "Markdown",
      ...durationKeyboard(),
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

  // Назад к выбору цели.
  bot.action("back_goal", (ctx) => {
    ctx.session = { ...ctx.session, step: "goal" };
    ctx.answerCbQuery();
    return ctx.editMessageText("🎯 *Шаг 5/5* — Цель тренировки:", {
      parse_mode: "Markdown",
      ...goalKeyboard(),
    });
  });

  bot.action("confirm_booking", async (ctx) => {
    const s = ctx.session || {};
    if (!s.capsuleId || !s.day || !s.time || !s.duration || !s.goal) {
      await ctx.answerCbQuery();
      return ctx.editMessageText("Сессия истекла. Начни заново: /book");
    }

    const accessCode = await generateCode();
    let booking;
    try {
      booking = await addBooking({
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
    } catch (err) {
      if (err instanceof SlotTakenError) {
        ctx.session = { ...s, step: "slot" };
        await ctx.answerCbQuery("Увы, это время только что заняли");
        return renderSlotStep(ctx);
      }
      throw err;
    }

    ctx.session = {};
    await ctx.answerCbQuery("✅ Бронь создана!");
    await ctx.editMessageText(formatConfirmation(booking), { parse_mode: "Markdown" });

    const capsule = CAPSULES.find((c) => c.id === booking.capsuleId);
    await notifyAdmin(
      `🆕 *Новая бронь*\n` +
        `👤 ${ctx.from.username ? "@" + ctx.from.username : ctx.from.first_name} (id ${ctx.from.id})\n` +
        `🏋️ ${capsule?.name || booking.capsuleId}\n` +
        `📅 ${booking.dayLabel}, ${booking.time} (${booking.duration} мин)\n` +
        `🎯 ${booking.goal}\n` +
        `💳 ${calcPrice(booking.capsuleId, booking.duration)} ₽`
    );
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
      return ctx.reply("У тебя пока нет активных броней.\n\nНажми /book чтобы записаться.");
    }

    await ctx.reply("📋 *Твои активные брони:*", { parse_mode: "Markdown" });

    // Каждую бронь отдельным сообщением — со своей кнопкой отмены.
    for (const b of bookings.slice(-5).reverse()) {
      const capsule = CAPSULES.find((c) => c.id === b.capsuleId);
      const text =
        `📅 *${b.dayLabel}, ${b.time}* (${b.duration} мин)\n` +
        `🏋️ ${capsule?.name || b.capsuleId}\n` +
        `🔑 Код: \`${b.accessCode}\``;
      await ctx.reply(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отменить бронь", `cancelbk_${b.id}`)]]),
      });
    }
  }

  bot.action("my_bookings", (ctx) => {
    ctx.answerCbQuery();
    return showMyBookings(ctx);
  });

  bot.action(/^cancelbk_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ok = await cancelBooking(ctx.from.id, id);
    await ctx.answerCbQuery(ok ? "Бронь отменена" : "Бронь не найдена");
    if (ok) {
      await ctx.editMessageText("❌ Бронь отменена.");
      await notifyAdmin(
        `🚫 *Отмена брони* (id ${id})\n` +
          `👤 ${ctx.from.username ? "@" + ctx.from.username : ctx.from.first_name} (id ${ctx.from.id})`
      );
    }
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

    const capsule = CAPSULES.find((c) => c.id === payload.capsuleId);
    if (!capsule) {
      return ctx.reply("Не удалось распознать капсулу. Попробуй ещё раз.");
    }

    // Цену считаем на сервере — сумму из Mini App игнорируем.
    const amount = calcPrice(payload.capsuleId, payload.duration);
    const accessCode = await generateCode();

    let booking;
    try {
      booking = await addBooking({
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
    } catch (err) {
      if (err instanceof SlotTakenError) {
        return ctx.reply("😔 Это время только что заняли. Выбери другой слот в Mini App.");
      }
      throw err;
    }

    const name = ctx.from.first_name || "друг";

    await ctx.reply(
      `✅ *${name}, бронь подтверждена!*\n\n` +
        `🏋️ *${capsule.name}*\n` +
        `📍 ${capsule.location}\n\n` +
        `📅 ${booking.dayLabel}\n` +
        `⏰ ${booking.time} — ${booking.duration} мин\n` +
        `🎯 Цель: ${booking.goal}\n` +
        `💳 Сумма: ${amount} ₽\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `🔑 *Код доступа: \`${accessCode}\`*\n` +
        `━━━━━━━━━━━━━━\n` +
        `_Введи код на замке капсулы.\nКод активен за 10 минут до начала._`,
      { parse_mode: "Markdown" }
    );

    await notifyAdmin(
      `🆕 *Новая бронь (Mini App)*\n` +
        `👤 ${ctx.from.username ? "@" + ctx.from.username : name} (id ${ctx.from.id})\n` +
        `🏋️ ${capsule.name}\n` +
        `📅 ${booking.dayLabel}, ${booking.time} (${booking.duration} мин)\n` +
        `🎯 ${booking.goal}\n` +
        `💳 ${amount} ₽`
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
