/**
 * Бот для водителей. Этап 1: хранилище, опрос Telegram раз в минуту, журнал событий.
 * Этап 2: регистрация водителей (/start в личке → заявка в группу с кнопками), /водители — список и удаление.
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
      props.deleteProperty(BOT_P.due);  // отложенные дела появятся на этапах 4 и 6
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
  // message_reaction — этап 4.
}

/** Сообщение: из админ-чата — команды, из личного чата — водитель. Прочие чаты не слушаем. */
function botOnMessage_(m, ss) {
  if (!m.from || m.from.is_bot) return;
  const text = String(m.text || '').trim();
  if (String(m.chat.id) === botAdminChat_()) {
    if (/^\/(водители|drivers)(@\w+)?$/i.test(text)) {
      const list = botListView_(botDrivers_(ss), '');
      botSend_(botAdminChat_(), list.text, list.markup);
    }
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
