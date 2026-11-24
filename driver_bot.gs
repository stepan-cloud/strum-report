/**
 * Бот для водителей. Этап 1: хранилище, опрос Telegram раз в минуту, журнал событий.
 * Этап 2: регистрация водителей (/start в личке → заявка в группу с кнопками), /водители — список и удаление.
 * Этап 3: копия отчёта водителю (botAfterReport_ зовёт telegram_report.gs), /водитель ответом на отчёт.
 * Этап 4: «маршрут завершён» с итогом водителю — его присылает окно сверки в CRM через веб-приложение (doPost).
 * Файл лежит в том же проекте Apps Script, что и telegram_report.gs. Токен берётся оттуда же (secret_).
 * Все имена здесь начинаются с bot / BOT_, чтобы не совпасть с другими файлами проекта.
 *
 * Порядок установки:
 *   1) botSetup()        — один раз: создаёт Google Таблицу-хранилище на вашем Диске (ссылка — в журнале выполнения).
 *   2) botPoll()         — можно запускать вручную: забирает новые события Telegram в лист «Журнал».
 *   3) botShowChats()    — показывает, из каких чатов приходили события, с их ID (так узнаём ID группы).
 *   4) botStartPolling() — включает опрос: botPoll раз в минуту. botStopPolling() — выключает.
 *   5) Веб-приложение (для «маршрут завершён»): Развернуть → Новое развертывание → Веб-приложение,
 *      запуск от моего имени, доступ «Все». Адрес …/exec — в свойство скрипта BOT_WEBAPP_URL.
 *      После каждой правки кода: Управление развертываниями → ✎ → Версия «Новая» (иначе работает старый код).
 */

// Свойства скрипта, в которых бот хранит своё состояние.
const BOT_P = {
  sheet: 'BOT_SHEET_ID',   // ID таблицы-хранилища
  offset: 'BOT_OFFSET',    // с какого события продолжать опрос getUpdates
  due: 'BOT_NEXT_DUE',     // время (мс) ближайшего отложенного дела: удаление старых сообщений (этап 6)
  webApp: 'BOT_WEBAPP_URL', // адрес веб-приложения …/exec — его вписывает пользователь после развёртывания
  linkKey: 'BOT_LINK_KEY',  // секрет для подписи рейса в ссылке на CRM (создаётся сам, никому не нужен)
};

// Какие события просим у Telegram. Реакции не нужны (решено на этапе 4) — их не просим.
const BOT_UPDATES = ['message', 'callback_query'];

// Листы таблицы-хранилища. Заголовки пишутся, только если лист пустой.
const BOT_SHEETS = {
  drivers: { name: 'Водители', head: ['Telegram ID', 'Фамилия', 'Имя', 'Username', 'Статус', 'Дата'] },
  messages: {
    name: 'Сообщения', head: ['chat_id', 'message_id', 'Маршрут', 'Отчёт', 'Водитель', 'Дата', 'Удалено', 'Что'],
  },
  log: {
    name: 'Журнал',
    head: ['Время', 'update_id', 'Тип', 'Чат ID', 'Чат', 'Кто', 'Сообщение ID', 'Ответ на ID', 'Что', 'JSON'],
  },
};


// ===== ЗАПУСК ВРУЧНУЮ =====

/** Один раз: создаёт таблицу-хранилище (или достраивает недостающие листы). */
function botSetup() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  const id = props.getProperty(BOT_P.sheet);
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Бот водителей — данные');
    props.setProperty(BOT_P.sheet, ss.getId());
  }
  const names = Object.keys(BOT_SHEETS).map(k => BOT_SHEETS[k].name);
  Object.keys(BOT_SHEETS).forEach(k => botSheet_(ss, k));
  // Пустой «Лист1», который Google создаёт сам, — убрать.
  ss.getSheets()
    .filter(sh => names.indexOf(sh.getName()) < 0 && sh.getLastRow() === 0)
    .forEach(sh => ss.deleteSheet(sh));
  console.log('Таблица-хранилище: ' + ss.getUrl());
}

/** Включает опрос Telegram раз в минуту (триггер на botPoll). */
function botStartPolling() {
  const info = botApi_('getWebhookInfo', {});
  if (info.url) {
    throw new Error('У бота включён webhook (' + info.url + '). При нём опрос не работает — ' +
      'напишите об этом, решим, что делать.');
  }
  botStopPolling();
  ScriptApp.newTrigger('botPoll').timeBased().everyMinutes(1).create();
  console.log('Опрос включён: botPoll раз в минуту.');
}

/** Выключает опрос. */
function botStopPolling() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'botPoll')
    .forEach(t => ScriptApp.deleteTrigger(t));
  console.log('Опрос выключен.');
}

/** Показывает все чаты из журнала с их ID — так узнаём ID группы. */
function botShowChats() {
  const sh = botBook_().getSheetByName(BOT_SHEETS.log.name);
  const rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues() : [];
  const chats = {};
  const moves = [];
  rows.forEach(r => {
    const chatId = String(r[3]);
    if (!chatId) return;
    if (!chats[chatId]) chats[chatId] = { name: r[4], count: 0 };
    chats[chatId].name = r[4];
    chats[chatId].count++;
    if (/ID группы стал|прежний ID/.test(String(r[8]))) moves.push(chatId + ': ' + r[8]);
  });
  const ids = Object.keys(chats);
  if (!ids.length) {
    console.log('В журнале пока нет событий. Напишите что-нибудь в группу и запустите botPoll.');
    return;
  }
  console.log('Чаты в журнале:\n' + ids.map(id =>
    '  ' + id + '   ' + chats[id].name + ' — событий: ' + chats[id].count).join('\n'));
  if (moves.length) {
    console.log('Группа становилась супергруппой (брать ID, который начинается с -100):\n  ' + moves.join('\n  '));
  }
}


// ===== ОПРОС =====

/** Раз в минуту по триггеру (можно и вручную): забирает новые события Telegram. */
function botPoll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;  // другой запуск ещё работает — в следующую минуту
  try {
    const props = PropertiesService.getScriptProperties();
    const offset = Number(props.getProperty(BOT_P.offset) || 0);
    const updates = botApi_('getUpdates', {
      offset: offset, limit: 100, timeout: 0, allowed_updates: BOT_UPDATES,
    });
    const due = Number(props.getProperty(BOT_P.due) || 0);
    const dueNow = due > 0 && due <= Date.now();
    // Быстрый пустой запуск: нет событий и ничего не ждёт — таблицу даже не открываем.
    if (!updates.length && !dueNow) return;

    const ss = botBook_();
    if (updates.length) {
      const rows = updates.map(botLogRow_);
      // Разбор событий. Ошибка в одном событии не мешает остальным — она пишется в журнал.
      updates.forEach((u, i) => {
        try {
          botHandle_(u, ss);
        } catch (e) {
          rows[i][8] += '  ⚠️ ОШИБКА: ' + e.message;
          console.error('Событие ' + u.update_id + ': ' + (e.stack || e.message));
        }
      });
      const sh = botSheet_(ss, 'log');
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows.map(r => r.map(botCell_)));
      props.setProperty(BOT_P.offset, String(updates[updates.length - 1].update_id + 1));
      console.log('Новых событий: ' + rows.length + '\n' +
        rows.map(r => '  ' + r[2] + ' | чат ' + r[3] + ' ' + r[4] + ' | ' + r[5] + ' | ' + r[8]).join('\n'));
    }
    if (dueNow) {
      props.deleteProperty(BOT_P.due);  // отложенные дела (удаление старых сообщений) появятся на этапе 6
    }
  } finally {
    lock.releaseLock();
  }
}


// ===== РАЗБОР СОБЫТИЙ =====

/** Одно событие Telegram. */
function botHandle_(u, ss) {
  if (u.message) botOnMessage_(u.message, ss);
  else if (u.callback_query) botOnButton_(u.callback_query, ss);
}

/** Сообщение: из админ-чата — команды, из личного чата — водитель. Прочие чаты не слушаем. */
function botOnMessage_(m, ss) {
  if (!m.from || m.from.is_bot) return;
  const text = String(m.text || '').trim();
  if (String(m.chat.id) === botAdminChat_()) {
    if (/^\/(водители|drivers)(@\w+)?$/i.test(text)) {
      const list = botListView_(botDrivers_(ss), '');
      botSend_(botAdminChat_(), list.text, list.markup);
      return;
    }
    const cmd = text.match(/^\/(водитель|driver)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    if (cmd) botOnDriverCmd_(m, String(cmd[2] || '').trim(), ss);
    return;  // регистрация из админ-чата не принимается; ответы водителям — этап 5
  }
  if (m.chat.type === 'private') botOnDriverMessage_(m, text, ss);
}


// ===== РЕГИСТРАЦИЯ ВОДИТЕЛЕЙ =====

// Статусы в листе «Водители». Отчёты получает только «подключён».
const BOT_ST = {
  askName: 'ввод имени',  // нажал «Старт», ждём фамилию и имя
  pending: 'ожидает',     // заявка в админ-чате
  active: 'подключён',
  rejected: 'отклонён',
  deleted: 'удалён',      // удалили через /водители
  replaced: 'заменён',    // вместо него подключили новый аккаунт с теми же фамилией и именем
};

const BOT_TXT = {
  askName: 'Здравствуйте! Напишите, пожалуйста, фамилию и имя, например: Иванов Иван',
  badName: 'Напишите фамилию и имя через пробел, например: Иванов Иван',
  sent: 'Заявка отправлена, ждите подтверждения.',
  accepted: '✅ Вы подключены. Сюда будут приходить копии ваших отчётов.',
  rejected: '❌ Заявка отклонена.',
  start: 'Чтобы подключиться к боту, нажмите /start',
  hint: 'Чтобы написать по маршруту, нажмите «Ответить» на отчёт.',
};

/** Сообщение в личном чате с ботом. */
function botOnDriverMessage_(m, text, ss) {
  const drivers = botDrivers_(ss);
  const id = String(m.from.id);
  let me = drivers.find(d => d.id === id);
  const uname = m.from.username || '';
  if (me && me.username !== uname) {  // username в Telegram сменили — обновим
    me.username = uname;
    botSaveDriver_(ss, me);
  }

  if (/^\/start(\s|$)/.test(text)) {
    if (me && me.status === BOT_ST.active) {
      botSend_(id, 'Вы уже подключены: <b>' + esc_(botFullName_(me)) + '</b>.');
    } else if (me && me.status === BOT_ST.pending) {
      botSend_(id, BOT_TXT.sent);
    } else {
      if (!me) me = { id: id, last: '', first: '', username: uname };
      me.status = BOT_ST.askName;
      me.date = new Date();
      botSaveDriver_(ss, me);
      botSend_(id, BOT_TXT.askName);
    }
    return;
  }

  if (me && me.status === BOT_ST.askName) {
    const name = botParseName_(text);
    if (!name) {
      botSend_(id, BOT_TXT.badName);
      return;
    }
    me.last = name.last;
    me.first = name.first;
    me.status = BOT_ST.pending;
    me.date = new Date();
    botSaveDriver_(ss, me);
    botSend_(id, BOT_TXT.sent);
    botSendRequest_(me, drivers, m.from);
    return;
  }

  if (me && me.status === BOT_ST.pending) botSend_(id, BOT_TXT.sent);
  else if (me && me.status === BOT_ST.active) botSend_(id, BOT_TXT.hint);  // переписка — этап 5
  else botSend_(id, BOT_TXT.start);
}

/**
 * «иванов  иван иванович» → { last: 'Иванов', first: 'Иван' } (отчество не храним).
 * Нужно 2–3 слова из букв (можно с дефисом или апострофом), иначе null.
 */
function botParseName_(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 3) return null;
  const ok = words.every(w => /^[A-Za-zА-Яа-яЁёІіЎў]+([-'’][A-Za-zА-Яа-яЁёІіЎў]+)*$/.test(w) &&
    w.replace(/[-'’]/g, '').length >= 2);
  if (!ok) return null;
  const nice = w => w.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-');
  return { last: nice(words[0]), first: nice(words[1]) };
}

/** Заявка в админ-чат с кнопками. Учитывает уже подключённых с такими же фамилией (и именем). */
function botSendRequest_(d, drivers, from) {
  const others = drivers.filter(o => o.status === BOT_ST.active && o.id !== d.id);
  const sameLast = others.filter(o => botNorm_(o.last) === botNorm_(d.last));
  const same = sameLast.filter(o => botNorm_(o.first) === botNorm_(d.first));
  const namesakes = sameLast.filter(o => same.indexOf(o) < 0);

  const tgName = [from.first_name, from.last_name].filter(Boolean).join(' ');
  const lines = [(same.length ? '⚠️ Заявка: ' : '🆕 Новый водитель: ') + botDriverHtml_(d)];
  if (tgName) lines.push('Имя в Telegram: ' + esc_(tgName));
  same.forEach(o => lines.push('Уже есть: ' + botDriverHtml_(o) + ' — с ' + botDate_(o.date)));
  if (namesakes.length) {
    lines.push('👥 однофамил' + (namesakes.length > 1 ? 'ьцы' : 'ец') + ': ' +
      namesakes.map(o => esc_(botFullName_(o))).join(', '));
  }

  let kb;
  if (same.length) {
    kb = same.map(o => [{
      text: same.length > 1 ? '🔄 Заменить ' + botShort_(o) : '🔄 Заменить старого',
      callback_data: 'reg:rep:' + d.id + ':' + o.id,
    }]);
    kb.push([{ text: '➕ Это другой человек', callback_data: 'reg:ok:' + d.id }]);
    kb.push([{ text: '❌ Отклонить', callback_data: 'reg:no:' + d.id }]);
  } else {
    kb = [[
      { text: '✅ Принять', callback_data: 'reg:ok:' + d.id },
      { text: '❌ Отклонить', callback_data: 'reg:no:' + d.id },
    ]];
  }
  botSend_(botAdminChat_(), lines.join('\n'), { inline_keyboard: kb });
}

/**
 * Нажатие кнопки. Кнопки работают только в админ-чате.
 *   reg:ok:ID  reg:no:ID  reg:rep:НОВЫЙ:СТАРЫЙ — заявка;
 *   del:ask:ID  del:yes:ID  del:list           — список /водители.
 * Ответ приходит с задержкой до минуты (опрос раз в минуту), поэтому answerCallbackQuery может опоздать — не страшно.
 */
function botOnButton_(q, ss) {
  const answer = text => {
    try { botApi_('answerCallbackQuery', { callback_query_id: q.id, text: text || '' }); } catch (e) { /* опоздали */ }
  };
  if (!q.message || String(q.message.chat.id) !== botAdminChat_()) {
    answer('Недоступно');
    return;
  }
  const p = String(q.data || '').split(':');
  const by = [q.from.first_name, q.from.last_name].filter(Boolean).join(' ');
  const drivers = botDrivers_(ss);
  const find = id => drivers.find(d => d.id === id);

  if (p[0] === 'reg') {
    const d = find(p[2]);
    if (!d || d.status !== BOT_ST.pending) {
      answer('Эта заявка уже обработана');
      botCloseRequest_(q, '⏹ Заявка уже обработана' + (d ? ' — сейчас: ' + d.status : ''));
      return;
    }
    let note;
    if (p[1] === 'no') {
      d.status = BOT_ST.rejected;
      note = '❌ Отклонена';
    } else {
      d.status = BOT_ST.active;
      note = '✅ Принят';
      if (p[1] === 'rep') {
        const old = find(p[3]);
        if (old && old.status === BOT_ST.active) {
          old.status = BOT_ST.replaced;
          old.date = new Date();
          botSaveDriver_(ss, old);
          note = '🔄 Принят вместо прежнего аккаунта (' + botShort_(old) + ')';
        }
      }
    }
    d.date = new Date();
    botSaveDriver_(ss, d);
    try {
      botSend_(d.id, d.status === BOT_ST.active ? BOT_TXT.accepted : BOT_TXT.rejected);
    } catch (e) {
      note += ' (водителю не доставлено: ' + e.message + ')';
    }
    answer(note);
    botCloseRequest_(q, note + (by ? ' — ' + by : ''));
    return;
  }

  if (p[0] === 'del') {
    const d = p[2] ? find(p[2]) : null;
    let view;
    if (p[1] === 'ask' && d && d.status === BOT_ST.active) {
      view = {
        text: 'Удалить водителя <b>' + esc_(botFullName_(d)) + '</b>' +
          (d.username ? ' (@' + esc_(d.username) + ')' : '') + '?\nОн перестанет получать отчёты.',
        markup: { inline_keyboard: [[
          { text: '🗑 Да, удалить', callback_data: 'del:yes:' + d.id },
          { text: 'Нет', callback_data: 'del:list' },
        ]] },
      };
    } else if (p[1] === 'yes' && d && d.status === BOT_ST.active) {
      d.status = BOT_ST.deleted;
      d.date = new Date();
      botSaveDriver_(ss, d);
      view = botListView_(drivers, '🗑 Удалён: <b>' + esc_(botFullName_(d)) + '</b>' + (by ? ' — ' + esc_(by) : ''));
    } else {
      view = botListView_(drivers, d && p[1] !== 'list' ? 'Водитель уже не подключён.' : '');
    }
    answer('');
    botEdit_(q.message, view.text, view.markup);
    return;
  }
  answer('');
}

/** Текст и кнопки списка /водители. */
function botListView_(drivers, top) {
  const byName = (a, b) => botFullName_(a).localeCompare(botFullName_(b), 'ru');
  const active = drivers.filter(d => d.status === BOT_ST.active).sort(byName);
  const pending = drivers.filter(d => d.status === BOT_ST.pending).sort(byName);
  const lines = top ? [top, ''] : [];
  if (active.length) {
    lines.push('👥 Подключённые водители (' + active.length + '):');
    active.forEach((d, i) => lines.push((i + 1) + '. ' + esc_(botFullName_(d)) +
      (d.username ? ' (@' + esc_(d.username) + ')' : '') + ' — с ' + botDate_(d.date)));
  } else {
    lines.push('Подключённых водителей пока нет.');
  }
  if (pending.length) {
    lines.push('', '⏳ Ждут подтверждения: ' + pending.map(d => esc_(botFullName_(d))).join(', '));
  }
  if (active.length) lines.push('', 'Чтобы удалить водителя, нажмите кнопку с его именем.');
  return {
    text: lines.join('\n'),
    markup: { inline_keyboard: active.map(d => [{ text: '🗑 ' + botShort_(d), callback_data: 'del:ask:' + d.id }]) },
  };
}

/** Заявка обработана: дописать итог под текстом и убрать кнопки (форматирование сохраняется). */
function botCloseRequest_(q, note) {
  const m = q.message;
  const payload = {
    chat_id: m.chat.id, message_id: m.message_id,
    text: (m.text || '') + '\n\n' + note,
    link_preview_options: { is_disabled: true },
  };
  if (m.entities) payload.entities = m.entities;
  try { botApi_('editMessageText', payload); } catch (e) { /* текст не изменился — не страшно */ }
}

/** Водитель для подписи в админ-чате: «<b>Иванов Иван</b> (@ivan)» или ссылка на профиль, если нет username. */
function botDriverHtml_(d) {
  const name = '<b>' + esc_(botFullName_(d)) + '</b>';
  return d.username
    ? name + ' (@' + esc_(d.username) + ')'
    : name + ' (<a href="tg://user?id=' + esc_(d.id) + '">профиль</a>, без username)';
}

function botFullName_(d) { return [d.last, d.first].filter(Boolean).join(' '); }
function botShort_(d) { return botFullName_(d) + (d.username ? ' @' + d.username : ''); }

/** Для сравнения имён: без регистра, ё = е. */
function botNorm_(s) { return String(s || '').trim().toLowerCase().replace(/ё/g, 'е'); }

function botDate_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TIMEZONE, 'dd.MM.yyyy') : String(v || '');
}


// ===== КОПИЯ ОТЧЁТА ВОДИТЕЛЮ =====

/**
 * Зовёт telegram_report.gs сразу после отправки отчёта в группу.
 *   d — данные отчёта (как для buildMessage_), reportId — message_id отчёта в группе.
 * Ищет водителя по ФИО, шлёт ему копию без ссылки на CRM и записывает связи в лист «Сообщения».
 * Не нашёл ровно одного — пишет в группу ответом на отчёт, как назначить водителя командой /водитель.
 * Никогда не бросает ошибку: отчёт в группе уже отправлен, бот ему не мешает.
 */
function botAfterReport_(d, reportId) {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(20000);  // botPoll мог как раз писать в таблицу — подождём
  try {
    const ss = botBook_();
    const route = extractRouteId_(String(d.routeRaw || '').trim());
    const msgs = botMessages_(ss);
    botLinkReport_(ss, msgs, reportId, route, '');
    const match = botMatchDrivers_(botDrivers_(ss), d.name);
    const sample = botSampleName_(d.name);
    if (!botMatchOne_(match)) {
      botReply_(botAdminChat_(), reportId, botMatchHint_(match, sample, 'Ответьте на отчёт:'));
      return;
    }
    const driver = match.list[0];
    try {
      botSendCopy_(ss, msgs, driver, { text: buildMessage_(d, true), parse_mode: 'HTML' }, route, reportId);
    } catch (e) {
      botReply_(botAdminChat_(), reportId, '⚠️ Копия не доставлена: <b>' + esc_(botFullName_(driver)) + '</b> — ' +
        esc_(e.message) + '\nПовторить — ответьте на отчёт: <code>/водитель ' + esc_(botFullName_(driver)) + '</code>');
    }
  } catch (e) {
    console.error('Бот: копия отчёта не отправлена: ' + (e.stack || e.message));
    try {
      botReply_(botAdminChat_(), reportId, '⚠️ Бот: копия водителю не отправлена — ' + esc_(e.message));
    } catch (e2) { /* ничего не поделать — ошибка уже в журнале выполнения */ }
  } finally {
    if (locked) lock.releaseLock();
  }
}

/**
 * Ответ в группе на отчёт: «/водитель Фамилия [Имя]» → копия этому водителю.
 * Текст копии берётся из самого отчёта (без ссылки на CRM), поэтому годятся и отчёты, отправленные до этапа 3.
 */
function botOnDriverCmd_(m, arg, ss) {
  const admin = botAdminChat_();
  const reply = html => botReply_(admin, m.message_id, html);
  const rep = m.reply_to_message ? botReportOf_(m.reply_to_message) : null;
  if (!rep) {
    reply('Ответьте этой командой на сам отчёт (сообщение с ФИО и ID маршрута): <code>/водитель Иванов</code>');
    return;
  }
  if (!arg) {
    reply('Напишите фамилию водителя: <code>/водитель Иванов</code> (можно с именем: <code>/водитель Иванов Иван</code>)');
    return;
  }
  const match = botMatchDrivers_(botDrivers_(ss), arg);
  if (!botMatchOne_(match)) {
    reply(botMatchHint_(match, botSampleName_(arg), 'Уточните:', arg));
    return;
  }
  const driver = match.list[0];
  const name = '<b>' + esc_(botFullName_(driver)) + '</b>';
  const msgs = botMessages_(ss);
  // Копия = строка в чате водителя с этим отчётом (номера сообщений у каждого чата свои — сравниваем и чат).
  const had = msgs.some(x => x.chat === driver.id && x.report === rep.id && !x.deleted);
  if (had) {
    reply('ℹ️ Копия этого отчёта уже отправлена: ' + name);
    return;
  }
  try {
    botSendCopy_(ss, msgs, driver, rep.content, rep.route, rep.id);
  } catch (e) {
    reply('⚠️ Копия не доставлена: ' + name + ' — ' + esc_(e.message));
    return;
  }
  reply('✅ Копия отправлена: ' + name);
}

/**
 * Сообщение, на которое ответили, — это отчёт? Отчёт = сообщение бота со ссылкой на рейс в CRM (…#route/ID).
 * Возвращает { id, route, content } (content — текст для копии: те же жирный/моноширинный, но без ссылки) или null.
 */
function botReportOf_(r) {
  if (!r.from || !r.from.is_bot || !r.text) return null;
  const ents = r.entities || [];
  const link = ents.find(e => e.type === 'text_link' && /#route\//.test(e.url || ''));
  if (!link) return null;
  let route = link.url.split('#route/')[1] || '';
  try { route = decodeURIComponent(route); } catch (e) { /* оставим как есть */ }
  const content = { text: r.text };
  const keep = ents.filter(e => e.type !== 'text_link');
  if (keep.length) content.entities = keep;
  return { id: String(r.message_id), route: route, content: content };
}

/** Шлёт копию водителю и записывает связи: копия → отчёт, отчёт → водитель. Ошибка Telegram — бросает. */
function botSendCopy_(ss, msgs, driver, content, route, reportId) {
  const sent = botApi_('sendMessage', Object.assign({
    chat_id: driver.id, link_preview_options: { is_disabled: true },
  }, content));
  const row = { chat: driver.id, id: String(sent.message_id), route: route, report: String(reportId),
    driver: driver.id, date: new Date(), deleted: '', kind: BOT_KIND.copy };
  botSaveMessage_(ss, row);
  msgs.push(row);
  botLinkReport_(ss, msgs, reportId, route, driver.id);
}

/** Строка отчёта в «Сообщения» (chat = группа, message_id = Отчёт). Есть — обновляет водителя, нет — добавляет. */
function botLinkReport_(ss, msgs, reportId, route, driverId) {
  const admin = botAdminChat_();
  const id = String(reportId);
  let row = msgs.find(x => x.chat === admin && x.id === id);
  if (!row) {
    row = { chat: admin, id: id, route: route, report: id, driver: driverId, date: new Date(), deleted: '',
      kind: BOT_KIND.report };
    msgs.push(row);
  } else {
    if (row.driver === driverId && row.route) return;
    if (driverId) row.driver = driverId;
    if (!row.route) row.route = route;
  }
  botSaveMessage_(ss, row);
}


// ===== МАРШРУТ ЗАВЕРШЁН =====
// В окне сверки в CRM нажали «Завершить» → окно шлёт сюда (веб-приложение, doPost) номер рейса, подпись
// из ссылки и «Итого водителю» из CRM → бот пишет водителю ответом на его копию отчёта, в группу — отметку.
// Подпись k = HMAC(рейс, BOT_LINK_KEY) стоит в ссылке на CRM в отчёте: без ссылки из группы сообщение
// водителю не отправить, а ключей в публичном коде окна сверки нет.

// Что за сообщение — столбец «Что» листа «Сообщения».
const BOT_KIND = { report: 'отчёт', copy: 'копия', done: 'итог' };

/**
 * Параметры для ссылки на CRM в отчёте: { k: подпись рейса, bot: путь веб-приложения «macros/s/…» }.
 * Веб-приложение не развёрнуто (нет BOT_WEBAPP_URL) — {}: ссылка как раньше, окно сверки просто не сможет
 * написать водителю. Никогда не бросает ошибку — отчёт важнее.
 */
function botLinkParams_(route) {
  try {
    const url = String(PropertiesService.getScriptProperties().getProperty(BOT_P.webApp) || '').trim();
    const m = url.match(/^https:\/\/script\.google\.com\/((?:a\/macros\/[\w.-]+|macros)\/s\/[\w-]+)\/exec\b/);
    if (!m || !route) return {};
    return { k: botLinkKey_(route), bot: m[1] };
  } catch (e) {
    console.error('Бот: подпись для ссылки не получилась: ' + (e.stack || e.message));
    return {};
  }
}

/** Подпись рейса: первые 22 знака HMAC-SHA256(рейс, BOT_LINK_KEY). Ключ создаётся сам при первом вызове. */
function botLinkKey_(route) {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty(BOT_P.linkKey);
  if (!key) {
    key = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty(BOT_P.linkKey, key);
  }
  const sig = Utilities.computeHmacSha256Signature(String(route), key);
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '').slice(0, 22);
}

/**
 * Веб-приложение: запрос из окна сверки. Тело — JSON { action, route, k, pay }:
 *   action 'done'  — написать водителю «маршрут завершён»;
 *   action 'check' — пробный прогон: всё то же, но ничего не отправляет (для диагностики).
 * Ответ — JSON { ok, driver, sum, already, check } или { ok: false, error }.
 * Каждый запрос записывается строкой в лист «Журнал» (тип «окно сверки»): до какого шага дошёл и чем кончился.
 */
function doPost(e) {
  let res, q = {};
  const trace = [];
  const step = s => { trace.push(s); console.log('doPost: ' + s); };
  try {
    step('начало');
    q = JSON.parse((e && e.postData && e.postData.contents) || '{}') || {};
    if (q.action !== 'done' && q.action !== 'check') throw new Error('Неизвестный запрос');
    res = botRouteDone_(q, step);
  } catch (err) {
    console.error('Бот, веб-приложение: ' + (err && (err.stack || err.message) || err));
    res = { ok: false, error: String(err && err.message || err) + ' (шаг: ' + trace[trace.length - 1] + ')' };
  }
  botWebLog_(q, res, trace);
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

/** Строка в «Журнал» о запросе окна сверки. Свою ошибку не бросает. */
function botWebLog_(q, res, trace) {
  try {
    const what = (q.action || '?') + ' рейс ' + (q.route || '?') + (q.pay !== undefined ? ', итого ' + q.pay : '') +
      ' → ' + (res && res.ok ? (res.check ? 'проверка ок' : res.already ? 'уже сообщено' : 'отправлено') +
      (res.driver ? ': ' + res.driver : '') : 'ошибка: ' + (res && res.error)) + ' | шаги: ' + trace.join(' → ');
    const sh = botSheet_(botBook_(), 'log');
    const row = [Utilities.formatDate(new Date(), TIMEZONE, 'dd.MM.yyyy HH:mm:ss'), '', 'окно сверки', '', '', '', '', '',
      what, JSON.stringify(res || {}).slice(0, 45000)];
    sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row.map(botCell_)]);
  } catch (e) {
    console.error('Бот, журнал веб-приложения: ' + (e.stack || e.message));
  }
}

/**
 * «Маршрут завершён» водителю. Водитель — тот, кому ушла копия последнего отчёта по этому рейсу.
 * То же «Итого» этому водителю уже отправляли — повторно не шлёт (already: true).
 */
function botRouteDone_(q, step) {
  step = step || function () {};
  const route = String(q.route || '').trim();
  step('подпись');
  if (!route || String(q.k || '') !== botLinkKey_(route)) {
    return { ok: false, error: 'Ссылка не подходит к этому рейсу — откройте рейс по ссылке из отчёта в группе.' };
  }
  const pay = Number(q.pay);
  if (q.pay === null || q.pay === undefined || q.pay === '' || !isFinite(pay)) {
    return { ok: false, error: 'Нет суммы «Итого водителю» — водителю не отправлено.' };
  }
  step('блокировка');
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(20000);  // botPoll мог как раз писать в таблицу — подождём
  try {
    step('таблица' + (locked ? '' : ' (без блокировки)'));
    const ss = botBook_();
    step('CHAT_ID');
    const admin = botAdminChat_();
    step('лист «Сообщения»');
    const msgs = botMessages_(ss);
    const reports = msgs.filter(x => x.chat === admin && x.id === x.report && x.route === route);
    const report = reports.filter(x => x.driver).pop();  // строки идут по времени — последний отчёт с водителем
    if (!report) {
      return { ok: false, error: reports.length
        ? 'Копия отчёта никому не отправлена — сначала ответьте на отчёт в группе: /водитель Фамилия.'
        : 'Отчёта по рейсу №' + route + ' нет в боте — водителю не отправлено.' };
    }
    step('лист «Водители»');
    const driver = botDrivers_(ss).find(d => d.id === report.driver);
    if (!driver || driver.status !== BOT_ST.active) {
      return { ok: false, error: 'Водитель ' + (driver ? botFullName_(driver) + ' ' : '') +
        'больше не подключён к боту — не отправлено.' };
    }
    const name = botFullName_(driver);
    const sum = 'BYN ' + botMoney_(pay);
    const kind = BOT_KIND.done + ' ' + sum;
    const mine = msgs.filter(x => x.chat === driver.id && x.route === route && !x.deleted);
    const last = mine.filter(x => x.kind.indexOf(BOT_KIND.done) === 0).pop();
    if (last && last.kind === kind) return { ok: true, already: true, driver: name, sum: sum };

    // Ответом на копию этого отчёта (строки до этапа 4 — без «Что», это тоже копии).
    const copy = mine.filter(x => x.report === report.id && (x.kind === BOT_KIND.copy || !x.kind)).pop();
    if (q.action === 'check') return { ok: true, check: true, driver: name, sum: sum, copy: copy ? copy.id : '' };
    step('отправка водителю');
    const html = '🏁 Маршрут <b>№' + esc_(route) + '</b> завершён.\nИтого водителю: <b>' + esc_(sum) + '</b>';
    const sentId = copy ? botReply_(driver.id, copy.id, html) : botSend_(driver.id, html);
    step('запись в «Сообщения»');
    botSaveMessage_(ss, { chat: driver.id, id: String(sentId), route: route, report: report.id,
      driver: driver.id, date: new Date(), deleted: '', kind: kind });
    step('отметка в группе');
    try {
      botReply_(admin, report.id, '🏁 Водителю отправлено «маршрут завершён», итого водителю <b>' + esc_(sum) +
        '</b> — <b>' + esc_(name) + '</b>');
    } catch (e) { /* водителю уже ушло — отметка в группе не главное */ }
    return { ok: true, driver: name, sum: sum };
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** 1234.5 → «1 234,50», 1500 → «1 500». */
function botMoney_(n) {
  const v = Math.round(Number(n) * 100) / 100;
  const parts = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '−' : '') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (parts[1] === '00' ? '' : ',' + parts[1]);
}


// ===== ПОИСК ВОДИТЕЛЯ ПО ФИО =====

/**
 * Подключённые водители, подходящие под ФИО «Фамилия Имя [Отчество]» (как в форме или в /водитель).
 * Без учёта регистра, ё = е; опечатки как в окне сверки: расстояние Левенштейна ≤1, для слов от 7 букв ≤2.
 * Точное совпадение фамилии важнее неточного. Если в ФИО есть имя, оно тоже проверяется (с опечатками;
 * «И.» — инициал). Возвращает { list, nameDiff }: nameDiff — по фамилии кто-то подходит, но имя другое
 * (тогда list — подошедшие по фамилии). Копия уходит, только если list ровно один и nameDiff = false.
 */
function botMatchDrivers_(drivers, fio) {
  const words = botWords_(fio);
  if (!words.length) return { list: [], nameDiff: false };
  const active = drivers.filter(d => d.status === BOT_ST.active);
  const byLast = botClosest_(active, d => d.last, words[0]);
  if (!byLast.length || !words[1]) return { list: byLast, nameDiff: false };
  const byFirst = botClosest_(byLast, d => d.first, words[1]);
  return byFirst.length ? { list: byFirst, nameDiff: false } : { list: byLast, nameDiff: true };
}

function botMatchOne_(match) { return match.list.length === 1 && !match.nameDiff; }

/** Из list — те, чьё поле похоже на word. Если есть точные совпадения — только они. */
function botClosest_(list, field, word) {
  const initial = /\./.test(word) && botClean_(word).length <= 2;  // «И.» или «И.И.»
  const w = botClean_(word);
  if (!w) return [];
  const scored = list.map(d => {
    const v = botClean_(botNorm_(field(d)));
    let dist;
    if (initial) dist = v.charAt(0) === w.charAt(0) ? 0 : 99;
    else dist = botLev_(v, w) <= (Math.max(v.length, w.length) >= 7 ? 2 : 1) ? botLev_(v, w) : 99;
    return { d: d, dist: dist };
  }).filter(x => x.dist < 99);
  const exact = scored.filter(x => x.dist === 0);
  return (exact.length ? exact : scored).map(x => x.d);
}

/** Слова ФИО для сравнения: без регистра, ё = е, без лишних знаков (точки в инициалах остаются). */
function botWords_(s) {
  return botNorm_(s).split(/\s+/).map(w => w.replace(/[^a-zа-яіў.'’-]/g, '')).filter(w => /[a-zа-яіў]/.test(w));
}

function botClean_(w) { return String(w).replace(/[^a-zа-яіў'’-]/g, ''); }

/** Расстояние Левенштейна (сколько букв вставить/удалить/заменить). */
function botLev_(a, b) {
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** «иванов иван иванович» → «Иванов Иван» — образец для подсказки /водитель. */
function botSampleName_(fio) {
  const name = botParseName_(String(fio || '').trim().split(/\s+/).slice(0, 2).join(' '));
  if (name) return name.last + ' ' + name.first;
  const w = String(fio || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-zА-Яа-яЁёІіЎў'’-]{2,}$/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : 'Иванов';
}

/**
 * Подсказка в группу, когда водитель не определился однозначно.
 *   how — «Ответьте на отчёт:» (после отчёта) или «Уточните:» (после /водитель); asked — что написали в /водитель.
 */
function botMatchHint_(match, sample, how, asked) {
  const names = match.list.map(d => esc_(botFullName_(d))).join(', ');
  const cmd = name => '<code>/водитель ' + esc_(name) + '</code>';
  const first = match.list[0];
  if (!match.list.length) {
    return asked
      ? '⚠️ Водитель «' + esc_(asked) + '» не найден среди подключённых. Список — /водители'
      : '⚠️ Водитель не найден в боте. ' + how + ' ' + cmd(sample.split(' ')[0]);
  }
  if (match.nameDiff) {
    return '⚠️ Имя не совпадает' + (asked ? ' («' + esc_(asked) + '»)' : '') + ' — по фамилии подход' +
      (match.list.length > 1 ? 'ят' : 'ит') + ': ' + names + '. Если это он, ' +
      (asked ? 'напишите' : how.charAt(0).toLowerCase() + how.slice(1)) + ' ' + cmd(botFullName_(first));
  }
  return '⚠️ Подходят: ' + names + '. ' + how + ' ' + cmd(botFullName_(first));
}


// ===== ХРАНИЛИЩЕ: ВОДИТЕЛИ =====

/** Все строки листа «Водители» (по одной на Telegram-аккаунт). row — номер строки в листе. */
function botDrivers_(ss) {
  const sh = botSheet_(ss, 'drivers');
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 6).getValues()
    .map((r, i) => ({
      row: i + 2, id: String(r[0]).trim(), last: String(r[1]), first: String(r[2]),
      username: String(r[3]).replace(/^@/, ''), status: String(r[4]), date: r[5],
    }))
    .filter(d => d.id);
}

/** Записывает водителя в его строку (или новой строкой). */
function botSaveDriver_(ss, d) {
  const sh = botSheet_(ss, 'drivers');
  const row = [d.id, d.last, d.first, d.username, d.status, d.date || new Date()].map(botCell_);
  if (d.row) {
    sh.getRange(d.row, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
    d.row = sh.getLastRow();
  }
}


// ===== ХРАНИЛИЩЕ: СООБЩЕНИЯ =====
// Лист «Сообщения» — связи сообщений с отчётами. Строка отчёта: chat_id = группа, message_id = Отчёт,
// «Водитель» — кому ушла копия. Строка копии: chat_id = водитель, «Отчёт» — message_id отчёта в группе.
// «Что» (BOT_KIND): отчёт / копия / «итог BYN 1 234» — сообщение «маршрут завершён». Строки до этапа 4 — пусто.

/** Все строки листа «Сообщения». row — номер строки в листе. */
function botMessages_(ss) {
  const sh = botSheet_(ss, 'messages');
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 8).getValues()
    .map((r, i) => ({
      row: i + 2, chat: String(r[0]).trim(), id: String(r[1]).trim(), route: String(r[2]).trim(),
      report: String(r[3]).trim(), driver: String(r[4]).trim(), date: r[5], deleted: r[6], kind: String(r[7]).trim(),
    }))
    .filter(x => x.chat && x.id);
}

/** Записывает связь в её строку (или новой строкой). */
function botSaveMessage_(ss, x) {
  const sh = botSheet_(ss, 'messages');
  const row = [x.chat, x.id, x.route, x.report, x.driver, x.date || new Date(), x.deleted || '', x.kind || '']
    .map(botCell_);
  if (x.row) {
    sh.getRange(x.row, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
    x.row = sh.getLastRow();
  }
}


// ===== ЖУРНАЛ =====

/** Одна строка журнала по событию Telegram. */
function botLogRow_(u) {
  const time = Utilities.formatDate(new Date(), TIMEZONE, 'dd.MM.yyyy HH:mm:ss');
  let type = Object.keys(u).filter(k => k !== 'update_id')[0] || '?';
  let chat = {}, who = '', msgId = '', replyTo = '', what = '';
  if (u.message) {
    const m = u.message;
    chat = m.chat;
    who = botWho_(m.from, m.sender_chat);
    msgId = m.message_id;
    replyTo = m.reply_to_message ? m.reply_to_message.message_id : '';
    what = botWhat_(m);
  } else if (u.callback_query) {
    const q = u.callback_query;
    chat = q.message ? q.message.chat : {};
    who = botWho_(q.from);
    msgId = q.message ? q.message.message_id : '';
    what = 'кнопка: ' + (q.data || '');
  } else if (u[type] && typeof u[type] === 'object') {
    // Прочие события (например my_chat_member — бота добавили, сделали админом).
    const o = u[type];
    chat = o.chat || {};
    who = botWho_(o.from);
    if (o.old_chat_member && o.new_chat_member) {
      what = botWho_(o.new_chat_member.user) + ': ' + o.old_chat_member.status + ' → ' + o.new_chat_member.status;
    }
  }
  type = type === 'callback_query' ? 'кнопка' :
    type === 'message' ? 'сообщение' : type;
  return [time, u.update_id, type, chat.id || '', botChatName_(chat), who, msgId, replyTo, what,
    JSON.stringify(u).slice(0, 45000)];
}

function botChatName_(chat) {
  if (!chat || !chat.id) return '';
  if (chat.type === 'private') {
    return 'личный: ' + [chat.first_name, chat.last_name].filter(Boolean).join(' ') +
      (chat.username ? ' @' + chat.username : '');
  }
  const kind = { group: 'группа', supergroup: 'супергруппа', channel: 'канал' }[chat.type] || chat.type;
  return kind + ' «' + (chat.title || '') + '»';
}

function botWho_(user, actorChat) {
  if (user) {
    return [user.first_name, user.last_name].filter(Boolean).join(' ') +
      (user.username ? ' @' + user.username : '') + ' (' + user.id + ')' + (user.is_bot ? ' [бот]' : '');
  }
  if (actorChat) return 'от имени чата «' + (actorChat.title || actorChat.id) + '»';
  return '';
}

/** Коротко, что в сообщении: текст или вид содержимого, служебные события группы. */
function botWhat_(m) {
  const names = users => (users || []).map(x => botWho_(x)).join(', ');
  const parts = [];
  if (m.group_chat_created) parts.push('[группа создана]');
  if (m.supergroup_chat_created) parts.push('[супергруппа создана]');
  if (m.migrate_to_chat_id) parts.push('[группа стала супергруппой, ID группы стал ' + m.migrate_to_chat_id + ']');
  if (m.migrate_from_chat_id) parts.push('[супергруппа, прежний ID ' + m.migrate_from_chat_id + ']');
  if (m.new_chat_members) parts.push('[добавлены: ' + names(m.new_chat_members) + ']');
  if (m.left_chat_member) parts.push('[вышел: ' + botWho_(m.left_chat_member) + ']');
  if (m.new_chat_title) parts.push('[новое название: ' + m.new_chat_title + ']');
  if (m.photo) parts.push('[фото]');
  if (m.voice) parts.push('[голосовое]');
  if (m.video) parts.push('[видео]');
  if (m.video_note) parts.push('[кружок]');
  if (m.document) parts.push('[файл ' + (m.document.file_name || '') + ']');
  if (m.sticker) parts.push('[стикер ' + (m.sticker.emoji || '') + ']');
  if (m.location) parts.push('[место]');
  if (m.contact) parts.push('[контакт]');
  const text = m.text || m.caption || '';
  if (text) parts.push(text);
  return parts.join(' ') || '[другое]';
}

/** Текст, начинающийся с = + - @, таблица приняла бы за формулу — экранируем апострофом. */
function botCell_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}


// ===== ОБЩЕЕ =====

/** Таблица-хранилище. */
function botBook_() {
  const id = PropertiesService.getScriptProperties().getProperty(BOT_P.sheet);
  if (!id) throw new Error('Нет таблицы-хранилища: сначала запустите botSetup().');
  return SpreadsheetApp.openById(id);
}

/** Лист хранилища по ключу из BOT_SHEETS; если его нет — создаёт с заголовком. */
function botSheet_(ss, key) {
  const def = BOT_SHEETS[key];
  let sh = ss.getSheetByName(def.name);
  if (!sh) sh = ss.insertSheet(def.name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, def.head.length).setValues([def.head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < def.head.length) {  // в листе ещё нет новых столбцов — дописать заголовок
    sh.getRange(1, 1, 1, def.head.length).setValues([def.head]).setFontWeight('bold');
  }
  return sh;
}

/** ID админ-чата (группы) — CHAT_ID из файла настроек. */
function botAdminChat_() { return String(secret_('CHAT_ID')); }

/** Сообщение в чат (HTML). markup — кнопки { inline_keyboard: [...] }. Возвращает message_id. */
function botSend_(chatId, html, markup, extra) {
  const payload = Object.assign({
    chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
  }, extra || {});
  if (markup && markup.inline_keyboard && markup.inline_keyboard.length) payload.reply_markup = markup;
  return botApi_('sendMessage', payload).message_id;
}

/** Сообщение ответом на replyTo (если его уже удалили — просто сообщение). */
function botReply_(chatId, replyTo, html) {
  return botSend_(chatId, html, null, {
    reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true },
  });
}

/** Заменяет текст и кнопки сообщения бота. */
function botEdit_(msg, html, markup) {
  const payload = {
    chat_id: msg.chat.id, message_id: msg.message_id,
    text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
  };
  if (markup && markup.inline_keyboard && markup.inline_keyboard.length) payload.reply_markup = markup;
  try { botApi_('editMessageText', payload); } catch (e) {
    if (!/not modified/.test(e.message)) throw e;
  }
}

/** Вызов Telegram Bot API. Возвращает result или бросает ошибку с описанием. */
function botApi_(method, payload) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + secret_('TELEGRAM_TOKEN') + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
  });
  let body = null;
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = null; }
  if (!body || !body.ok) {
    throw new Error('Telegram (' + method + '): ' + res.getResponseCode() + ' ' +
      (body && body.description ? body.description : res.getContentText().slice(0, 300)));
  }
  return body.result;
}
