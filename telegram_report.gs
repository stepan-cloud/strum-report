/**
 * Отправка ответов Google Формы "Водители отчет" в Telegram.
 * Скрипт привязан к самой форме (Редактор формы → ⋮ → Редактор скриптов).
 */

// ===== НАСТРОЙКИ =====
// Токен бота и чат НЕ в этом файле (он лежит в публичном репозитории на GitHub).
// Создайте в этом же проекте Apps Script второй файл (например «Настройки.gs») и впишите туда:
//   const TELEGRAM_TOKEN = '...';   // токен бота от @BotFather
//   const CHAT_ID = '...';          // куда слать сообщения
// Можно вместо файла — в Настройки проекта ⚙ → Свойства скрипта (см. secret_).
const CRM_ROUTE_URL = 'https://strum-crm.onrender.com/#route/';
const TIMEZONE = 'Europe/Minsk';
const SEPARATOR = '--------------------';

// Начало названий вопросов в форме (ищем по началу, поэтому
// "Всего BYN (без учёта опта)" найдётся по "Всего BYN").
const Q = {
  name: 'ФИО',
  routeId: 'ID Маршрута',
  km: 'Фактическая длина маршрута',
  points: 'Точки',
  byn: 'Всего BYN',
  usd: 'Всего USD',
  eur: 'Всего EUR',
  rub: 'Всего RUB',
  comment: 'Комментарий по маршруту',
};

// Значения в сетке "Точки"
const ST_NOT_DELIVERED = 'Не сдан';
const ST_NOT_LOADED = 'Не загружен';


// ===== ТЕСТОВЫЙ ОТВЕТ =====
// Меняйте значения как нужно и запускайте функцию testFakeAnswer.
// Пустая строка '' = поле не заполнено.
const TEST_ANSWER = {
  name: 'Иванов Иван Иванович',
  routeId: '(4521) 13.11.2026',
  km: '312',
  // Точки: номер → 'Сдан' / 'Не сдан' / 'Не загружен'.
  // Не указанные номера считаются незаполненными.
  points: {
    1: 'Сдан',
    2: 'Сдан',
    3: 'Не сдан',
    4: 'Сдан',
    5: 'Не загружен',
    6: 'Не сдан',
    7: 'Сдан',
  },
  byn: '1500',
  usd: '',
  eur: '200',
  rub: '',
  comment: 'Точка 3 была закрыта, перезвонить клиенту.',
};


// ===== ЗАПУСК =====

/** Срабатывает при каждой отправке формы (через триггер). */
function onFormSubmitHandler(e) {
  sendTelegram_(buildMessage_(dataFromResponse_(e.response)));
}

/** Запустить ОДИН раз вручную: создаёт триггер на отправку формы. */
function setupTrigger() {
  const form = FormApp.getActiveForm();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onFormSubmitHandler')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onFormSubmitHandler').forForm(form).onFormSubmit().create();
}

/** Тест: отправляет сообщение по тестовому ответу TEST_ANSWER (время — текущее). */
function testFakeAnswer() {
  const t = TEST_ANSWER;
  const points = [];
  for (let i = 1; i <= 30; i++) {
    points.push({ label: String(i), value: t.points[i] || '' });
  }
  sendTelegram_(buildMessage_({
    name: t.name, routeRaw: t.routeId, km: t.km, points: points,
    byn: t.byn, usd: t.usd, eur: t.eur, rub: t.rub,
    comment: t.comment, timestamp: new Date(),
  }));
}

/** Тест: отправляет в Telegram последний настоящий ответ формы. */
function testLastResponse() {
  const responses = FormApp.getActiveForm().getResponses();
  if (!responses.length) throw new Error('В форме пока нет ответов');
  sendTelegram_(buildMessage_(dataFromResponse_(responses[responses.length - 1])));
}


// ===== ЛОГИКА =====

/** Достаёт данные из настоящего ответа формы в простой объект. */
function dataFromResponse_(response) {
  const items = response.getItemResponses();
  const find = prefix => items.find(ir =>
    ir.getItem().getTitle().trim().toLowerCase().startsWith(prefix.toLowerCase()));
  const text = prefix => {
    const ir = find(prefix);
    const v = ir ? ir.getResponse() : '';
    return (v === null || v === undefined) ? '' : String(v).trim();
  };

  const points = [];
  const pointsIr = find(Q.points);
  if (pointsIr) {
    const rows = pointsIr.getItem().asGridItem().getRows();
    const values = pointsIr.getResponse() || [];
    rows.forEach((label, i) => points.push({ label: label, value: values[i] || '' }));
  }

  return {
    name: text(Q.name), routeRaw: text(Q.routeId), km: text(Q.km), points: points,
    byn: text(Q.byn), usd: text(Q.usd), eur: text(Q.eur), rub: text(Q.rub),
    comment: text(Q.comment), timestamp: response.getTimestamp(),
  };
}

/** Собирает текст сообщения (HTML-разметка Telegram). Пустые строки не выводятся. */
function buildMessage_(d) {
  const clean = v => (v === null || v === undefined) ? '' : String(v).trim();
  const name = clean(d.name) || 'Без имени';
  const routeId = extractRouteId_(clean(d.routeRaw));
  const km = clean(d.km);
  const comment = clean(d.comment);
  const money = { BYN: clean(d.byn), USD: clean(d.usd), EUR: clean(d.eur), RUB: clean(d.rub) };

  // --- Точки
  let totalPoints = 0;
  const notDelivered = [];
  const notLoaded = [];
  d.points.forEach(p => {
    if (!p.value) return;
    totalPoints++;
    if (p.value === ST_NOT_DELIVERED) notDelivered.push(p.label);
    if (p.value === ST_NOT_LOADED) notLoaded.push(p.label);
  });

  // --- Дата и время отправки
  const date = Utilities.formatDate(d.timestamp, TIMEZONE, 'dd.MM.yyyy');
  const time = Utilities.formatDate(d.timestamp, TIMEZONE, 'HH.mm.ss');

  // --- Ссылка на CRM с дополнительными данными
  const link = buildCrmLink_(routeId, {
    fio: clean(d.name),
    pts: totalPoints || '',
    ns: notDelivered.join(','),
    nl: notLoaded.join(','),
    km: km,
    byn: money.BYN,
    usd: money.USD,
    eur: money.EUR,
    rub: money.RUB,
    cm: comment,
  });

  const withT = arr => arr.map(n => n + 'т').join(', ');

  const lines = [
    `<b><a href="${esc_(link)}">${esc_(name)}</a></b>`,
    `Дата: ${date}.`,
    `Время: ${time}.`,
    `ID: <b><code>${esc_(routeId)}</code></b>`,
    SEPARATOR,
  ];
  if (km) lines.push(`КМ: <b><code>${esc_(km)}</code></b>`);
  lines.push(`📍 Всего точек: <b>${totalPoints}</b>`);
  if (notDelivered.length) lines.push(`⚠️ Не сдан: <b>${esc_(withT(notDelivered))}</b>`);
  if (notLoaded.length) lines.push(`❌ Не загружен: <b>${esc_(withT(notLoaded))}</b>`);
  Object.keys(money).forEach(cur => {
    if (money[cur]) lines.push(`${cur}: <b>${esc_(money[cur])}</b>`);
  });
  if (comment) {
    lines.push(SEPARATOR);
    lines.push(`<code>${esc_(comment)}</code>`);
  }
  return lines.join('\n');
}

/**
 * Ссылка вида:
 * https://strum-crm.onrender.com/?pts=7&ns=3,6&nl=5&km=312&byn=1500#route/4521
 * Доп. данные идут ДО знака #, чтобы не мешать CRM открывать маршрут.
 * Пустые параметры не добавляются.
 *   fio — ФИО, pts — всего точек, ns — не сданы, nl — не загружены,
 *   km — км, byn/usd/eur/rub — суммы, cm — комментарий.
 */
function buildCrmLink_(routeId, data) {
  const base = CRM_ROUTE_URL.split('#')[0];       // https://strum-crm.onrender.com/
  const hash = CRM_ROUTE_URL.split('#')[1] || '';  // route/
  const query = Object.keys(data)
    .filter(k => data[k] !== '' && data[k] !== null && data[k] !== undefined)
    .map(k => k + '=' + encodeURIComponent(String(data[k])).replace(/%2C/g, ','))
    .join('&');
  return base + (query ? '?' + query : '') + '#' + hash + encodeURIComponent(routeId);
}

/**
 * ID маршрута в CRM — целое число (ссылка #route/186). Как его пишут:
 *   "(12345) 13.11.2026" → "12345"  — ID в скобках, как в списке формы;
 *   "186.13"             → "186"    — ID и через точку число месяца;
 *   "186 13.11", "№186"  → "186".
 * Берём первое число (внутри скобок, если они есть); если цифр нет — текст как есть.
 */
function extractRouteId_(raw) {
  const m = raw.match(/\(([^)]+)\)/);
  const s = (m ? m[1] : raw).trim();
  const n = s.match(/\d+/);
  return n ? n[0] : s;
}

/** Экранирование для HTML-режима Telegram. */
function esc_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Токен и чат. Откуда берутся (по порядку):
 *   1) из другого файла этого же проекта Apps Script, например «Настройки.gs»:
 *        const TELEGRAM_TOKEN = '123:ABC...';
 *        const CHAT_ID = '123456789';
 *      (можно и без const). Этот файл есть только в Apps Script — в репозиторий его не класть;
 *   2) иначе — из свойств скрипта (Настройки проекта ⚙ → Свойства скрипта).
 */
function secret_(name) {
  const fromFile = {
    TELEGRAM_TOKEN: typeof TELEGRAM_TOKEN !== 'undefined' ? TELEGRAM_TOKEN : null,
    CHAT_ID: typeof CHAT_ID !== 'undefined' ? CHAT_ID : null,
  }[name];
  const v = fromFile !== null && fromFile !== undefined && String(fromFile).trim() !== ''
    ? fromFile
    : PropertiesService.getScriptProperties().getProperty(name);
  if (v === null || v === undefined || String(v).trim() === '') {
    throw new Error('Не задан ' + name + ': впишите его в отдельный файл проекта (const ' + name +
      " = '...';) или в Настройки проекта ⚙ → Свойства скрипта.");
  }
  return String(v).trim();
}

/** Отправляет сообщение в CHAT_ID. Возвращает message_id отправленного сообщения (нужен боту). */
function sendTelegram_(html) {
  const url = `https://api.telegram.org/bot${secret_('TELEGRAM_TOKEN')}/sendMessage`;
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: secret_('CHAT_ID'),
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Telegram ответил ошибкой: ' + res.getContentText());
  }
  return JSON.parse(res.getContentText()).result.message_id;
}
