/**
 * Этап 7: отчёт водителя через WebApp (Mini App) в Telegram — для ВСЕХ подключённых водителей.
 * Кнопка «Создать отчёт» (Reply-клавиатура) приходит водителю при подключении (✅) и на /start;
 * отправку формы принимает только подключённый водитель (по Telegram ID из формы).
 * С 26.11.2026 тест у водителя 444604645 (Буров Степан) сочтён успешным, ограничение снято.
 *
 * Что здесь:
 *   doGet()                — отдаёт форму report_form_layout.html (тот же URL …/exec, что и у «маршрут завершён»).
 *                            Форма — шаблон: в неё подставляется webAppUrl — POST принимается ТОЛЬКО по
 *                            адресу …/exec, а location.href после редиректа Apps Script указывает на
 *                            script.googleusercontent.com — тот на POST отвечает HTML-страницей.
 *   botReportFromWeb_(q)   — принимает заполненную форму (doPost, action 'report'), собирает отчёт
 *                            и шлёт его в группу + копию водителю через sendReport_ (telegram_report.gs).
 *   botReportKeyboard_()   — Reply-клавиатура с кнопкой «Создать отчёт» (открывает форму).
 *   botGiveReportButton()  — вручную: прислать кнопку и объявление ВСЕМ подключённым водителям.
 *
 * Порядок установки:
 *   1) Файл HTML: КОНСОЛЬ СКРИПТОВ → + → HTML. Название — report_form_layout (НЕ report_form: HTML-файлу
 *      нельзя давать имя, совпадающее с файлом скрипта report_form.gs). Скопировать туда содержимое
 *      report_form_layout.html из репозитория (в репозитории файл называется так же, как в Apps Script).
 *   2) Управление развертываниями → ✎ → Версия «Новая» (без этого работает старый код без формы).
 *   3) botGiveReportButton() — прислать кнопку и объявление всем подключённым водителям.
 * Примечание: Telegram ID из формы (initDataUnsafe) не проверяется подписью — его можно подделать
 *   из консоли браузера, зная адрес …/exec. Защита от посторонних — только сама кнопка в чате с ботом.
 */

const REPORT_TYPES = ['Розница', 'ОПТ', 'Розница и ОПТ'];
const REPORT_STATUS = ['Сдан', 'Не сдан', 'Не загружен'];
const REPORT_CUR = ['BYN', 'USD', 'EUR', 'RUB'];

/** Форма отчёта: Telegram открывает её по кнопке web_app. HTML-файл назван иначе,
 *  потому что Apps Script не даёт HTML-файлу имя, совпадающее с файлом скрипта (report_form.gs).
 *  Форма — шаблон: в неё подставляется webAppUrl — POST с данными принимается ТОЛЬКО по адресу …/exec,
 *  а location.href после редиректа Apps Script указывает на script.googleusercontent.com — тот на POST
 *  отвечает HTML-страницей, и отправка падает с «Unexpected token <». */
function doGet() {
  const t = HtmlService.createTemplateFromFile('report_form_layout');
  t.webAppUrl = ScriptApp.getService().getUrl();  // адрес …/exec текущего развёртывания
  return t.evaluate()
    .setTitle('Отчёт по маршруту')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Reply-клавиатура с кнопкой «Создать отчёт» для тестовых водителей. */
function botReportKeyboard_() {
  const url = String(PropertiesService.getScriptProperties().getProperty(BOT_P.webApp) || '').trim();
  if (!url) {
    throw new Error('Не задано свойство скрипта BOT_WEBAPP_URL — разверните веб-приложение (см. driver_bot.gs) ' +
      'и впишите адрес …/exec.');
  }
  return { keyboard: [[{ text: 'Создать отчёт', web_app: { url: url } }]], resize_keyboard: true };
}

/** Вручную: прислать кнопку «Создать отчёт» и объявление ВСЕМ подключённым водителям. */
function botGiveReportButton() {
  const kb = botReportKeyboard_();
  const drivers = botDrivers_(botBook_()).filter(d => d.status === BOT_ST.active);
  if (!drivers.length) throw new Error('Подключённых водителей нет.');
  drivers.forEach(d => {
    try {
      botSend_(d.id, 'Теперь через этот чат можно создать новый отчёт.', kb);
      console.log('Отправлено: ' + botFullName_(d) + ' (' + d.id + ')');
    } catch (e) {
      console.error('Не отправлено, ' + botFullName_(d) + ' (' + d.id + '): ' + (e.stack || e.message));
    }
  });
}

/**
 * Отчёт из формы (doPost, action 'report'). Проверяет, собирает данные как для buildMessage_
 * и шлёт в группу + копию водителю через sendReport_. Возвращает { ok, driver } или { ok: false, error }.
 */
function botReportFromWeb_(q, step) {
  step = step || function () {};
  step('водитель');
  const uid = String(q.uid || '').trim();
  const ss = botBook_();
  const drivers = botDrivers_(ss);
  // Отправить отчёт может только подключённый водитель, открывший форму кнопкой из чата с ботом.
  // Пустой uid — только отладка формы в браузере вне Telegram: отчёт уйдёт, но без ФИО
  // (копию назначит админ командой /водитель ответом на отчёт).
  let driver = null;
  if (uid) {
    driver = drivers.find(d => d.id === uid);
    if (!driver || driver.status !== BOT_ST.active) {
      return { ok: false, error: 'Вы не подключены к боту — напишите ему /start.' };
    }
  }

  // --- Тип
  const type = String(q.type || 'Розница');
  if (REPORT_TYPES.indexOf(type) < 0) return { ok: false, error: 'Неизвестный тип рейса: ' + type };
  const withRoute = type !== 'ОПТ';      // маршрут и км — не у ОПТ
  const withPoints = type !== 'ОПТ';
  const withRetailCash = type !== 'ОПТ'; // касса розница — у розницы (и у «розница и ОПТ»)
  const withOptCash = type !== 'Розница'; // касса ОПТ — у ОПТ (и у «розница и ОПТ»), в отчёт — строкой в комментарий

  // --- Номер маршрута и километраж
  step('маршрут');
  let route = '';
  let km = '';
  if (withRoute) {
    route = String(q.route || '').trim();
    if (!/^\d+$/.test(route)) return { ok: false, error: 'Номер маршрута — целое число больше нуля.' };
    const tracker = q.tracker === true || q.tracker === 'true';
    km = tracker ? '' : String(q.km || '').trim();
    if (!tracker && !/^\d+$/.test(km)) {
      return { ok: false, error: 'Километраж — целое число, либо поставьте галочку «По трекеру».' };
    }
  }

  // --- Точки
  step('точки');
  const points = [];
  if (withPoints) {
    const list = Array.isArray(q.points) ? q.points : [];
    if (!list.length) return { ok: false, error: 'Добавьте хотя бы одну точку.' };
    for (let i = 0; i < list.length; i++) {
      const st = String(list[i].status || '');
      if (REPORT_STATUS.indexOf(st) < 0) return { ok: false, error: 'Точка ' + (i + 1) + ': неизвестный статус.' };
      points.push({ label: String(i + 1), value: st, comment: String(list[i].comment || '').trim() });
    }
  }

  // --- Кассы
  step('касса');
  const money = {};   // касса розница → валюты отчёта
  const optCash = []; // касса ОПТ → строкой в комментарий
  const cashCheck = list => {
    if (list.length > REPORT_CUR.length) return 'В кассе не больше ' + REPORT_CUR.length + ' валют.';
    for (let i = 0; i < list.length; i++) {
      const cur = String(list[i].cur || '').toUpperCase();
      const amount = String(list[i].amount || '').trim();
      if (REPORT_CUR.indexOf(cur) < 0) return 'Неизвестная валюта: ' + cur;
      if (list.some((x, j) => j !== i && String(x.cur || '').toUpperCase() === cur)) {
        return 'Валюта ' + cur + ' указана дважды.';
      }
      if (!/^\d+([.]\d+)?$/.test(amount)) {
        return 'Сумма для ' + cur + ' — число, например 1500 или 120.50.';
      }
    }
    return '';
  };
  if (withRetailCash) {
    const list = Array.isArray(q.cash) ? q.cash : [];
    const err = cashCheck(list);
    if (err) return { ok: false, error: err };
    list.forEach(c => { money[String(c.cur).toUpperCase()] = String(c.amount).trim(); });
  }
  if (withOptCash) {
    const list = Array.isArray(q.optCash) ? q.optCash : [];
    const err = cashCheck(list);
    if (err) return { ok: false, error: 'Касса ОПТ: ' + err };
    list.forEach(c => optCash.push({ cur: String(c.cur).toUpperCase(), amount: String(c.amount).trim() }));
  }

  // --- Комментарий: касса ОПТ, комментарии к точкам, общий комментарий
  const commentParts = [];
  if (optCash.length) {
    commentParts.push('Касса ОПТ: ' + optCash.map(c => c.cur + ' ' + c.amount).join(', '));
  }
  points.forEach(p => { if (p.comment) commentParts.push('Точка ' + p.label + ': ' + p.comment); });
  const general = String(q.comment || '').trim();
  if (general) commentParts.push(general);
  const comment = commentParts.join('\n');

  // --- ФИО водителя (driver найден выше по uid; при отладке формы вне Telegram — пусто,
  //     копию назначит админ командой /водитель ответом на отчёт)
  step('имя');
  const name = driver ? botFullName_(driver) : '';

  step('отправка');
  sendReport_({
    name: name,
    type: type,
    routeRaw: route,
    km: km,
    points: points,
    byn: money.BYN || '', usd: money.USD || '', eur: money.EUR || '', rub: money.RUB || '',
    comment: comment,
    timestamp: new Date(),
  });
  return { ok: true, driver: name };
}
