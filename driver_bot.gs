/**
 * Бот для водителей — этап 1: хранилище, опрос Telegram раз в минуту, журнал событий.
 * Файл лежит в том же проекте Apps Script, что и telegram_report.gs. Токен берётся оттуда же (secret_).
 * Все имена здесь начинаются с bot / BOT_, чтобы не совпасть с другими файлами проекта.
 *
 * Порядок установки:
 *   1) botSetup()        — один раз: создаёт Google Таблицу-хранилище на вашем Диске (ссылка — в журнале выполнения).
 *   2) botPoll()         — можно запускать вручную: забирает новые события Telegram в лист «Журнал».
 *   3) botShowChats()    — показывает, из каких чатов приходили события, с их ID (так узнаём ID группы).
 *   4) botStartPolling() — включает опрос: botPoll раз в минуту. botStopPolling() — выключает.
 */

// Свойства скрипта, в которых бот хранит своё состояние.
const BOT_P = {
  sheet: 'BOT_SHEET_ID',   // ID таблицы-хранилища
  offset: 'BOT_OFFSET',    // с какого события продолжать опрос getUpdates
  due: 'BOT_NEXT_DUE',     // время (мс) ближайшего отложенного дела: реакции, удаления (этапы 4 и 6)
};

// Какие события просим у Telegram. message_reaction приходит, только если он указан здесь явно.
const BOT_UPDATES = ['message', 'message_reaction', 'callback_query'];

// Листы таблицы-хранилища. Заголовки пишутся, только если лист пустой.
const BOT_SHEETS = {
  drivers: { name: 'Водители', head: ['Telegram ID', 'Фамилия', 'Имя', 'Username', 'Статус', 'Дата'] },
  messages: { name: 'Сообщения', head: ['chat_id', 'message_id', 'Маршрут', 'Отчёт', 'Водитель', 'Дата', 'Удалено'] },
  reactions: { name: 'Реакции', head: ['chat_id', 'message_id', 'Кто', 'Реакция', 'Время'] },
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
      const sh = botSheet_(ss, 'log');
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows.map(r => r.map(botCell_)));
      // Здесь на следующих этапах будет разбор событий (регистрация, реакции, переписка).
      props.setProperty(BOT_P.offset, String(updates[updates.length - 1].update_id + 1));
      console.log('Новых событий: ' + rows.length + '\n' +
        rows.map(r => '  ' + r[2] + ' | чат ' + r[3] + ' ' + r[4] + ' | ' + r[5] + ' | ' + r[8]).join('\n'));
    }
    if (dueNow) {
      props.deleteProperty(BOT_P.due);  // отложенные дела появятся на этапах 4 и 6
    }
  } finally {
    lock.releaseLock();
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
  } else if (u.message_reaction) {
    const r = u.message_reaction;
    chat = r.chat;
    who = botWho_(r.user, r.actor_chat);
    msgId = r.message_id;
    what = botEmojis_(r.old_reaction) + ' → ' + botEmojis_(r.new_reaction);
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
  type = type === 'message_reaction' ? 'реакция' : type === 'callback_query' ? 'кнопка' :
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

function botEmojis_(list) {
  const s = (list || []).map(r =>
    r.type === 'emoji' ? r.emoji : r.type === 'custom_emoji' ? '[свой эмодзи]' : '[платная ⭐]').join(' ');
  return s || 'нет';
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
  }
  return sh;
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
