/*
 * Струм CRM — окно сверки отчёта водителя.
 * Для расширения "User JavaScript and CSS", правило для сайта: strum-crm.onrender.com
 *
 * Данные отчёта приходят из ссылки в Telegram:
 *   https://strum-crm.onrender.com/?fio=...&pts=7&ns=3,6&nl=5&km=312&byn=1500&cm=...#route/4521
 */
(function () {
  'use strict';
  // Не запускать второй раз (например, если в расширении остался и старый код, и загрузчик)
  if (document.documentElement.dataset.strumReport) return;
  document.documentElement.dataset.strumReport = '1';

  // =====================================================================
  // 1. НАСТРОЙКА ПОД CRM
  //    Здесь код, который читает данные со страницы маршрута и меняет их.
  //    Пока это заглушки: подключу, когда будет разметка страницы CRM.
  //    Каждая функция чтения возвращает null, если данных нет.
  // =====================================================================
  // Поля страницы рейса ищем по их подсказкам (placeholder / title)
  const byName = (tag, name) =>
    document.querySelector(`${tag}[title="${name}"], ${tag}[aria-label="${name}"]`);
  const kmInput = () => document.querySelector('input[placeholder="км"]');
  const driverInput = () => document.querySelector('input[placeholder="фамилия"]');
  const STATUS_SELECT = 'select[title="Сменить статус заказа"], select[aria-label="Сменить статус заказа"]';
  const ORDER_INPUT = 'input[title="Порядок объезда"], input[aria-label="Порядок объезда"]';

  // Текст статуса в CRM → код окна
  const CRM_STATUS = { 'Сдан': 'ok', 'Не сдан': 'ns', 'Не загружен': 'nl' };
  const CRM_TEXT = { ok: 'Сдан', ns: 'Не сдан', nl: 'Не загружен' };

  /** ID заказа в строке: <td class="code"><b>003149</b>, запасной вариант — ссылка #order/3149 */
  function orderId(tr) {
    if (!tr) return null;
    const b = tr.querySelector('td.code b');
    let id = b && /^\d+$/.test(b.textContent.trim()) ? b.textContent.trim() : null;
    if (!id) {
      const a = tr.querySelector('a[href^="#order/"]');
      const m = a && a.getAttribute('href').match(/^#order\/(\d+)/);
      id = m ? m[1] : null;
    }
    return id ? id.padStart(6, '0') : null;
  }

  /** Текст «Пометки к заказу» в строке: div рядом с кнопкой ✏️; null — если ячейку не нашли */
  function rowNote(tr) {
    const pencil = tr && tr.querySelector('button[title="Поправить пометку к заказу"]');
    const div = pencil && pencil.parentElement && [...pencil.parentElement.children].find(e => e.tagName === 'DIV');
    return div ? div.textContent : null;
  }

  /** Строки таблицы «Заказы в рейсе», по порядку объезда */
  function crmRows() {
    const rows = [...document.querySelectorAll(STATUS_SELECT)].map((sel, i) => {
      const tr = sel.closest('tr');
      const ord = tr && tr.querySelector(ORDER_INPUT);
      const n = ord ? parseInt(ord.value, 10) : NaN;
      const text = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text.trim() : '';
      return { num: isNaN(n) ? i + 1 : n, id: orderId(tr), tr, note: rowNote(tr), select: sel, statusText: text, status: CRM_STATUS[text] || '' };
    });
    return rows.sort((a, b) => a.num - b.num);
  }

  /** Ждать, пока check() вернёт не пустое значение; по таймауту — ошибка с текстом msg */
  function waitFor(check, timeoutMs, msg) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        let v = null;
        try { v = check(); } catch (e) { /* страница ещё перерисовывается */ }
        if (v) { clearInterval(timer); resolve(v); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error(msg)); }
      }, 100);
    });
  }

  /** Записать значение в поле так, чтобы страница это заметила */
  function setFieldValue(input, value) {
    const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype
      : input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const CRM = {
    /** ФИО водителя (в CRM — только фамилия) */
    getDriverName() {
      const i = driverInput();
      return i && i.value.trim() ? i.value.trim() : null;
    },

    /** Заказы, в товарах которых есть «@табл опт» (ячейка td.goods: текст и подсказка) */
    getOptRows() {
      const re = /@\s*табл\.?\s*опт/i;
      return crmRows().filter(r => {
        const g = r.tr && r.tr.querySelector('td.goods');
        return g && (re.test(g.textContent) || re.test(g.getAttribute('title') || ''));
      });
    },

    /** Тип рейса: select#rt_rtype → { value: 'minsk' | 'intercity' | ... | '', text: 'Минск' } */
    getRouteType() {
      const s = document.getElementById('rt_rtype');
      if (!s) return null;
      const o = s.options[s.selectedIndex];
      return { value: s.value, text: o ? o.text.trim() : '' };
    },

    /** Статус рейса: поле «Статус» select#rt_status → { value: 'loaded' | 'done' | ..., text: 'Загружен' } */
    getRouteStatus() {
      const s = document.getElementById('rt_status');
      if (s) {
        const o = s.options[s.selectedIndex];
        return { value: s.value, text: o ? o.text.trim() : s.value };
      }
      const r = window._route;   // запасной вариант — данные рейса, которые держит сама CRM
      if (!r || !r.status) return null;
      return { value: r.status, text: typeof window.rtStName === 'function' ? window.rtStName(r.status) : r.status };
    },

    /**
     * Поменять статус рейса и сохранить. Без подтверждения (как «Статус» и «КМ»).
     * Сохраняем функцией самой CRM rtStep(id, статус) — ей пользуется кнопка «🏁 Завершить рейс»:
     * она шлёт на сервер только статус (остальное — как сейчас в рейсе на сервере), не трогая
     * несохранённые правки формы, и перерисовывает страницу — поле «Статус» покажет новый статус.
     */
    async setRouteStatus(value) {
      if (typeof window.rtStep !== 'function') throw new Error('Не нашёл в CRM функцию смены статуса рейса — ничего не менял.');
      if (String(window._routeId) !== String(ROUTE_ID))
        throw new Error(`Открыт другой рейс (${window._routeId}), а отчёт — по рейсу ${ROUTE_ID}. Ничего не менял.`);
      await window.rtStep(window._routeId, value);   // ошибки сервера CRM показывает сама и не бросает
      return waitFor(() => { const st = CRM.getRouteStatus(); return st && st.value === value ? st : null; },
        6000, 'Статус рейса не поменялся — проверьте поле «Статус».');
    },

    /** Длина маршрута, км */
    getKm() {
      const i = kmInput();
      return i && i.value.trim() !== '' ? num(i.value) : null;
    },

    /** Точки: [{ num, id: '003149', status: 'ok' | 'ns' | 'nl' | '' }] */
    getPoints() {
      const rows = crmRows();
      return rows.length ? rows.map(r => ({ num: r.num, id: r.id, note: r.note, status: r.status })) : null;
    },

    /*
     * Наличные из блока «Принято» → { BYN: 10490, USD: 50 }.
     * Блок — div.rt-cifry-prin, по строке на способ оплаты: «Наличные: <b>BYN 10 490</b>», «ЕРИП: <b>BYN 819</b>»…
     * Водитель сдаёт только наличные, поэтому берём только строки «Наличные» (ЕРИП и прочее — не касса водителя).
     * Раньше читался весь блок, и строка «ЕРИП» затирала наличные.
     * Пока ничего не сдано — в блоке «пока ничего не сдано», вернётся {}.
     */
    getMoney() {
      const box = document.querySelector('.rt-cifry-prin');
      if (!box) return null;
      const money = {};
      let anyLine = false, cashLine = false;
      [...box.children].forEach(line => {
        const m = line.textContent.replace(/\s+/g, ' ').match(/^\s*([^:]+):\s*(BYN|USD|EUR|RUB)\s*([\d .,]+)/i);
        if (!m) return;
        anyLine = true;
        if (!/^наличн/i.test(m[1].trim())) return;
        cashLine = true;
        const cur = m[2].toUpperCase();
        money[cur] = round((money[cur] || 0) + num(m[3]));
      });
      // Почему валюты может не быть: 'empty' — в «Принято» ничего не сдано,
      // 'nocash' — есть только безнал (ЕРИП и т. п.), 'ok' — наличные есть, но не в этой валюте
      money._status = !anyLine ? 'empty' : !cashLine ? 'nocash' : 'ok';
      return money;
    },

    /**
     * Какие статусы в CRM надо поменять, чтобы совпало с отчётом.
     * → { changes: [{ repNum, status, row }] } или { error: 'текст' }
     */
    planStatuses(rep) {
      const rows = crmRows();
      if (!rows.length) return { error: 'Не нашёл точки на странице.' };

      // Какой статус должен быть у каждой точки отчёта
      const want = [];
      for (let n = 1; n <= rep.total; n++)
        want.push({ repNum: n, status: rep.nl.includes(n) ? 'nl' : rep.ns.includes(n) ? 'ns' : 'ok' });

      let pairs;
      if (rows.length === want.length) {
        pairs = want.map((w, i) => ({ ...w, row: rows[i] }));
      } else if (rows.length === want.length - rep.nl.length) {
        // Незагруженные убраны из маршрута — сопоставляем оставшиеся по порядку
        const left = want.filter(w => w.status !== 'nl');
        pairs = left.map((w, i) => ({ ...w, row: rows[i] }));
      } else {
        return { error: `Количество точек не сходится (CRM ${rows.length}, отчёт ${rep.total}) — статусы не проставляю.` };
      }
      return { changes: pairs.filter(p => p.row.status !== p.status) };
    },

    /** Проставить статусы точек по отчёту (с подтверждением) */
    applyStatuses(rep) {
      // Без подтверждения (так попросил пользователь). CRM сохраняет статус сразу при смене
      // (rtSetOrdStatus → запрос на сервер → перерисовка страницы).
      const plan = CRM.planStatuses(rep);
      if (plan.error) return showToast(plan.error);
      const changes = plan.changes;
      if (!changes.length) return showToast('Статусы уже как в отчёте');

      changes.forEach(p => {
        const opt = [...p.row.select.options].find(o => o.text.trim() === CRM_TEXT[p.status]);
        if (opt) setFieldValue(p.row.select, opt.value);
      });
      showToast('Статусы: ' + changes.map(p => `${p.row.num} → ${CRM_TEXT[p.status]}`).join(', '));
    },

    /**
     * Изменить «Пометку к заказу» и сохранить: жмём ✏️ «Поправить пометку к заказу» в строке заказа,
     * ждём окно CRM и текущую пометку, ставим transform(текущая), жмём «Сохранить», ждём закрытия окна.
     * Если пометка в строке не пустая, а в окне так и не появилась — ничего не сохраняем
     * (иначе можно затереть пометку).
     * → Promise<{ changed, before, after }>
     */
    async editOrderNote(id, transform) {
      const row = crmRows().find(r => r.id && normId(r.id) === normId(id));
      if (!row) throw new Error(`Не нашёл заказ ${id} в рейсе.`);
      const pencil = row.tr.querySelector('button[title="Поправить пометку к заказу"]');
      if (!pencil) throw new Error(`Не нашёл кнопку «Поправить пометку к заказу» у заказа ${id}.`);
      const rowHasNote = !!(rowNote(row.tr) || '').trim();

      pencil.click();
      const idRe = new RegExp(`(^|\\D)0*${normId(id)}(\\D|$)`);
      const t0 = Date.now();
      const ta = await waitFor(() => {
        const dlg = document.querySelector('#modal.on');
        const t = dlg && dlg.querySelector('#rt_note_txt');
        const ttl = dlg && dlg.querySelector('#dlg-ttl');
        if (!t || (ttl && !idRe.test(ttl.textContent))) return null;
        // ждём, пока CRM подставит текущую пометку
        if (rowHasNote ? !t.value.trim() : Date.now() - t0 < 300) return null;
        return t;
      }, 5000, 'Окно «Пометка к заказу» не открылось или пометка не подгрузилась — ничего не сохранял.');

      const dlg = ta.closest('#modal') || document.querySelector('#modal.on');
      const btn = name => [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === name);
      const before = ta.value;
      const after = transform(before);
      if (after === before) {
        const cancel = btn('Отмена');
        if (cancel) cancel.click();
        return { changed: false, before, after };
      }
      const save = btn('Сохранить');
      if (!save) throw new Error('Не нашёл кнопку «Сохранить» в окне пометки — ничего не сохранял.');
      setFieldValue(ta, after);
      save.click();
      await waitFor(() => !document.querySelector('#modal.on'), 8000,
        'После «Сохранить» окно пометки не закрылось — проверьте пометку вручную.');
      return { changed: true, before, after };
    },

    /** Вписать километраж из отчёта (с подтверждением) */
    applyKm(km) {
      const i = kmInput();
      // Без подтверждения. CRM сохраняет км сразу при изменении поля (rtNavKm → запрос на сервер).
      if (!i) return showToast('Не нашёл поле «Длина маршрута»');
      if (km === null) return showToast('В отчёте нет километража');
      if (num(i.value) === km) return showToast('Километраж уже как в отчёте');
      showToast(`Длина маршрута: ${i.value || '—'} → ${km}`);
      i.focus();
      setFieldValue(i, String(km));
      i.blur();
      i.scrollIntoView({ block: 'center' });
      i.style.outline = '3px solid #f5b400';
      setTimeout(() => { i.style.outline = ''; }, 4000);
    },
  };

  // =====================================================================
  // 2. НАСТРОЙКИ ОКНА
  // =====================================================================
  const CURRENCIES = ['BYN', 'USD', 'EUR', 'RUB'];
  // Допуск по километражу по типу рейса (select#rt_rtype): pct% от км в CRM + km
  const KM_TOLERANCE = {
    intercity: { pct: 5, km: 0 },   // Межгород — 5%
    minsk:     { pct: 5, km: 20 },  // Минск — 5% + 20 км
  };
  // Других типов быть не должно: для них (и для «не задан») результат красный
  const REFRESH_MS = 1500;         // как часто перечитывать CRM
  const STORE = 'strumReport:';    // ключ для правок отчёта

  // =====================================================================
  // 3. ДАННЫЕ ОТЧЁТА ИЗ ССЫЛКИ
  // =====================================================================
  const params = new URLSearchParams(location.search);
  if (!params.has('pts') && !params.has('fio') && !params.has('km')) return; // ссылка не из отчёта

  const routeIdFromHash = () => {
    const m = location.hash.match(/route\/([^/?&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const ROUTE_ID = routeIdFromHash();

  const nums = s => (s || '').split(',').map(x => parseInt(x, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
  const num = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  };

  const originalReport = {
    fio: (params.get('fio') || '').trim().split(/\s+/)[0], // только фамилия
    km: params.get('km') || '',
    pts: params.get('pts') || '',
    ns: params.get('ns') || '',
    nl: params.get('nl') || '',
    cm: params.get('cm') || '',
  };
  CURRENCIES.forEach(c => { originalReport[c] = params.get(c.toLowerCase()) || ''; });

  // Правки хранятся только для этой конкретной ссылки: новый отчёт — чистые данные
  const STORE_KEY = STORE + ROUTE_ID + ':' + location.search;
  let report = loadReport() || { ...originalReport };

  function loadReport() {
    try { const s = localStorage.getItem(STORE_KEY); return s ? JSON.parse(s) : null; }
    catch (e) { return null; }
  }
  function saveReport() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(report)); } catch (e) {}
  }
  function resetReport() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    report = { ...originalReport };
  }

  // =====================================================================
  // 4. СРАВНЕНИЕ
  //    Результат: { level: 'ok' | 'warn' | 'bad' | 'none', text: '...' }
  // =====================================================================
  const OK = t => ({ level: 'ok', text: t });
  const WARN = t => ({ level: 'warn', text: t });
  const BAD = t => ({ level: 'bad', text: t });
  const NONE = t => ({ level: 'none', text: t || 'Нет данных' });

  const normName = s => (s || '').trim().split(/\s+/)[0].toLowerCase().replace(/ё/g, 'е');

  function levenshtein(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
          d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  function compareName(crm, rep) {
    if (!crm) return NONE('Нет ФИО в CRM');
    if (!rep) return WARN('В отчёте нет ФИО');
    const a = normName(crm), b = normName(rep);
    if (a === b) return OK('Совпадает');
    const dist = levenshtein(a, b);
    const allowed = Math.max(a.length, b.length) >= 7 ? 2 : 1;
    if (dist <= allowed) return WARN(`Возможна опечатка (${dist} симв.)`);
    return BAD('Разные водители');
  }

  /** Допуск по типу рейса: ровно — зелёный, в пределах — жёлтый, больше — красный */
  function compareKm(crm, rep, type) {
    const c = num(crm), r = num(rep);
    if (c === null) return NONE('Нет км в CRM');
    if (r === null) return WARN('В отчёте нет км');
    const diff = r - c;
    const pct = c !== 0 ? Math.abs(diff) / c * 100 : 100;
    const d = `${diff > 0 ? '+' : ''}${round(diff)} км (${round(pct)}%)`;

    // Допуск есть только у Минска и Межгорода; любой другой тип — ошибка в CRM
    const t = type && KM_TOLERANCE[type.value];
    if (!t) {
      const what = !type ? 'Не нашёл тип рейса на странице'
        : type.value ? `Тип рейса «${type.text}» — должен быть Минск или Межгород`
        : 'Тип рейса не задан — должен быть Минск или Межгород';
      return BAD(c === r ? `${what}; км совпадают` : `${what}; разница ${d}`);
    }
    if (c === r) return OK('Совпадает');

    const tol = round(c * t.pct / 100 + t.km);
    const rule = `${type.text}: ${t.pct}%${t.km ? ` + ${t.km} км` : ''} = ${tol} км`;
    return Math.abs(diff) <= tol
      ? WARN(`В допуске: ${d} — допуск ${rule}`)
      : BAD(`Допуск превышен на ${round(Math.abs(diff) - tol)} км — расхождение ${d}, допуск ${rule}`);
  }

  /** Точки, не сданные и не загруженные — одна связанная проверка */
  function comparePoints(crmPoints, rep) {
    if (!crmPoints) return NONE('Нет точек в CRM');
    const r = { total: num(rep.pts) || 0, ns: nums(rep.ns), nl: nums(rep.nl) };
    const c = {
      total: crmPoints.length,
      ns: crmPoints.filter(p => p.status === 'ns').map(p => p.num).sort((a, b) => a - b),
      nl: crmPoints.filter(p => p.status === 'nl').map(p => p.num).sort((a, b) => a - b),
    };
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const noStatuses = c.ns.length === 0 && c.nl.length === 0;

    // Количество точек совпадает — сверяем номера
    if (c.total === r.total) {
      if (same(c.ns, r.ns) && same(c.nl, r.nl)) return OK('Совпадает');
      if (noStatuses) return WARN('Статусы не проставлены — нажмите «Статус»');
      const msgs = [];
      if (!same(c.ns, r.ns)) msgs.push(`Не сданы: CRM ${listT(c.ns)}, отчёт ${listT(r.ns)}`);
      if (!same(c.nl, r.nl)) msgs.push(`Не загружены: CRM ${listT(c.nl)}, отчёт ${listT(r.nl)}`);
      return WARN(msgs.join('; '));   // статусы не совпадают — жёлтый (так решил пользователь)
    }

    // В CRM меньше точек ровно на число незагруженных — их убрали из маршрута
    if (r.nl.length && c.total === r.total - r.nl.length && c.nl.length === 0) {
      const removed = `Незагруженные (${listT(r.nl)}) убраны из маршрута`;
      if (c.ns.length === r.ns.length) return OK(`${removed} — сходится`);
      if (c.ns.length === 0) return WARN(`${removed}; «не сдан» не проставлены — нажмите «Статус»`);
      return WARN(`${removed}; несданных: CRM ${c.ns.length}, отчёт ${r.ns.length}`);
    }

    return BAD(`Количество точек: CRM ${c.total}, отчёт ${r.total}`);
  }

  function compareMoney(cur, crmMoney, rep) {
    const c = crmMoney ? num(crmMoney[cur]) : null;
    const r = num(rep);
    if (crmMoney === null) return NONE('Не нашёл блок «Принято» в CRM');
    if (c === null) return WARN(
      crmMoney._status === 'empty' ? 'В «Принято» пока ничего не сдано'
      : crmMoney._status === 'nocash' ? 'В «Принято» нет наличных — только безнал'
      : `В «Принято» нет наличных ${cur}`);
    if (r === null) return WARN('В отчёте не указано');
    if (Math.abs(c - r) < 0.005) return OK('Совпадает');
    const diff = r - c;
    // find — что искать на странице по клику (без знака)
    return { ...BAD(`Расхождение ${diff > 0 ? '+' : ''}${round(diff)} ${cur}`), find: Math.abs(round(diff)) };
  }

  // =====================================================================
  // ПОИСК ЧИСЛА НА СТРАНИЦЕ (как Ctrl+F)
  //   Подсвечивает все места, где на странице стоит это число (со знаком или без),
  //   каждое следующее нажатие — к следующему. Esc — снять подсветку.
  //   CRM пишет тысячи отдельным span: «1<span>015</span>» — склеиваем текст внутри
  //   одного блока, а между блоками и через <br> ставим разделитель.
  // =====================================================================
  const NUM_RE = /\d{1,3}(?:[    ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;
  const numVal = s => parseFloat(s.replace(/[    ]/g, '').replace(',', '.'));
  const findState = { value: null, idx: -1 };

  /** Видимый текст страницы (без окна сверки) + где какой текстовый узел */
  function pageText() {
    const blockCache = new Map();
    const isBlock = e => {
      if (!blockCache.has(e)) blockCache.set(e, !/^inline/.test(getComputedStyle(e).display));
      return blockCache.get(e);
    };
    const blockOf = n => { let e = n.parentElement; while (e && e !== document.body && !isBlock(e)) e = e.parentElement; return e; };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === 1) return n.matches('#srp, script, style, noscript, textarea, select, template')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        const p = n.parentElement;
        return p && n.nodeValue.trim() && p.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let text = '', segs = [], prevBlock = null, brSeen = false, n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) { if (n.tagName === 'BR') brSeen = true; continue; }
      const b = blockOf(n);
      if (segs.length && (b !== prevBlock || brSeen)) text += '\n';
      segs.push({ node: n, start: text.length });
      text += n.nodeValue;
      prevBlock = b; brSeen = false;
    }
    return { text, segs };
  }

  /** Позиция в склеенном тексте → Range */
  function makeRange(segs, from, to) {
    const at = (pos, end) => {
      let i = segs.length - 1;
      while (i > 0 && (end ? segs[i].start >= pos : segs[i].start > pos)) i--;
      return { node: segs[i].node, offset: pos - segs[i].start };
    };
    const a = at(from, false), b = at(to, true);
    const r = document.createRange();
    r.setStart(a.node, Math.min(a.offset, a.node.length));
    r.setEnd(b.node, Math.min(b.offset, b.node.length));
    return r;
  }

  function findRanges(value) {
    const { text, segs } = pageText();
    const same = s => Math.abs(numVal(s) - value) < 0.005;
    const out = [];
    let m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(text))) {
      if (same(m[0])) { out.push(makeRange(segs, m.index, m.index + m[0].length)); continue; }
      // «100 200» могло оказаться двумя числами — проверяем части
      if (/[    ]/.test(m[0])) {
        const re = /\d+(?:[.,]\d+)?/g;
        let p;
        while ((p = re.exec(m[0]))) {
          if (!/^0\d/.test(p[0]) && same(p[0]))
            out.push(makeRange(segs, m.index + p.index, m.index + p.index + p[0].length));
        }
      }
    }
    return out;
  }

  function findOnPage(value, label) {
    const ranges = findRanges(value);
    if (!ranges.length) { clearFind(); return showToast(`${label}: на странице не найдено`); }
    findState.idx = findState.value === value ? (findState.idx + 1) % ranges.length : 0;
    findState.value = value;
    const cur = ranges[findState.idx];
    if (window.CSS && CSS.highlights && window.Highlight) {
      CSS.highlights.set('srp-find', new Highlight(...ranges));
      CSS.highlights.set('srp-find-cur', new Highlight(cur));
    }
    const e = cur.startContainer.parentElement;
    if (e) {
      e.scrollIntoView({ block: 'center' });  // сразу, как Ctrl+F (плавная прокрутка сбивается при частых кликах)
      if (!(window.CSS && CSS.highlights)) {  // старый браузер — хотя бы рамка
        e.style.outline = '3px solid #f97316';
        setTimeout(() => { e.style.outline = ''; }, 2000);
      }
    }
    showToast(`${label}: ${findState.idx + 1} из ${ranges.length}`);
  }

  function clearFind() {
    findState.value = null; findState.idx = -1;
    if (window.CSS && CSS.highlights) { CSS.highlights.delete('srp-find'); CSS.highlights.delete('srp-find-cur'); }
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && findState.value !== null) clearFind(); });

  const round = n => Math.round(n * 100) / 100;
  const listT = arr => arr.length ? arr.map(n => n + 'т').join(', ') : '—';

  // =====================================================================
  // РАЗБОР КОММЕНТАРИЯ ВОДИТЕЛЯ
  //   Текст до первого обозначения точки — общий комментарий к маршруту.
  //   Дальше каждый кусок относится к точке, обозначенной перед ним:
  //   «1.», «1)», «1 -», «1т», «1 точка», «На 1 точке», «1-я точка», «1я»,
  //   «Точка 1», «Адрес № 7», «№7», «ID 004376», «004376» (6 цифр = ID точки),
  //   «1 точка (004376)». Номер точки — от 1 до 30.
  //   «1т, 3т - закрыто» — один комментарий на обе точки.
  // =====================================================================
  //   Слово «точка» узнаём и с опечатками: «точяка», «тчка», «точька», «тчк» (см. isPointWord).
  //   «ID» — и как «I'd», «Id:», «айди».
  const N = String.raw`(?<!\d)(?<n>[1-9]|[12]\d|30)(?!\d)`;
  const COMMENT_MARKERS = [
    // «1т», «1 т.», «1 точка», «1-я точка», «на 1 точке», «1я точка маршрута», «3 точяка»
    { re: String.raw`(?:(?<!\p{L})(?:на|в)\s+)?${N}\s*(?:-?\s*(?:я|ая|ой|й)\s*)?(?:(?<w>\p{L}{3,9})|т\.?)(?!\p{L})(?:\s+маршрута)?`,
      ok: g => !g.w || isPointWord(g.w) },
    // «Точка 1», «Адрес № 7», «т.1», «№7», «Тчк 2»
    { re: String.raw`(?:(?<!\p{L})(?:(?<w>\p{L}{3,9})|т\.)\s*(?:№\s*)?|№\s*)${N}`,
      ok: g => !g.w || isPointWord(g.w) || /^адрес/i.test(g.w) },
    // «1я», «1-я», «2-ой»
    { re: String.raw`${N}-?(?:я|ая|ой)(?!\p{L})` },
    // в начале строки или после конца предложения: «1.», «1)», «1 -», «1:»
    { re: String.raw`(?<=(?:^|[\n.;!?])\s*)${N}(?:\s*[.)](?!\d)|\s*[-–—:])` },
    // «ID 004376», «I'd 004376», «004376»
    { re: String.raw`(?:(?<!\p{L})(?:i['’\x60]?d|ид|айди)\s*[:№]?\s*)?(?<!\d)(?<id>\d{6})(?!\d)` },
  ].map(m => ({ ...m, re: new RegExp(m.re, 'giu') }));

  // Слова, похожие на «точка», но ей не являющиеся
  const NOT_POINT = new Set(['точно', 'точнее', 'тоже', 'только', 'тогда', 'тонна', 'тонны', 'тонн', 'того', 'тому',
    'тот', 'тут', 'там', 'так', 'тем', 'тех', 'тачка', 'тачки', 'течка', 'тучка', 'точёк']);
  const POINT_FORMS = ['точка', 'точке', 'точки', 'точку', 'точкой', 'точек'];
  /** «точка» в любой форме и с опечаткой (1 ошибка, для слов от 6 букв — 2) */
  function isPointWord(w) {
    w = w.toLowerCase().replace(/ё/g, 'е');
    if (w === 'тчк' || /^точк/.test(w)) return true;
    if (w[0] !== 'т' || NOT_POINT.has(w)) return false;
    const allowed = w.length >= 6 ? 2 : 1;
    return POINT_FORMS.some(f => levenshtein(w, f) <= allowed);
  }

  const SEP_ONLY = /^[\s\-–—:.,;()]*$/;

  /** → { general: '...', points: [{ num, id, text }] } */
  function parseComment(text) {
    text = (text || '').replace(/\r/g, '');
    // Все обозначения точек с их позициями
    const found = [];
    COMMENT_MARKERS.forEach(m => {
      m.re.lastIndex = 0;
      let x;
      while ((x = m.re.exec(text))) {
        const g = x.groups || {};
        if (m.ok && !m.ok(g)) { m.re.lastIndex = x.index + 1; continue; } // похоже, но не «точка»
        found.push({
          start: x.index, end: x.index + x[0].length,
          num: g.n ? parseInt(g.n, 10) : null,
          id: g.id || null,
        });
      }
    });
    // Пересекающиеся: оставляем то, что начинается раньше, при равенстве — длиннее
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const marks = [];
    found.forEach(f => { if (!marks.length || f.start >= marks[marks.length - 1].end) marks.push(f); });

    // Обозначения подряд (между ними только знаки) — одна группа:
    // «1 точка (004376)» → номер + ID одной точки; «1т, 3т» → две точки с общим текстом
    const groups = [];
    marks.forEach(m => {
      const g = groups[groups.length - 1];
      if (g && SEP_ONLY.test(text.slice(g.end, m.start))) {
        const p = g.points[g.points.length - 1];
        if (m.num !== null && p.num === null && m.id === null) p.num = m.num;
        else if (m.id !== null && p.id === null && m.num === null) p.id = m.id;
        else g.points.push({ num: m.num, id: m.id });
        g.end = m.end;
      } else {
        groups.push({ start: m.start, end: m.end, points: [{ num: m.num, id: m.id }] });
      }
    });

    const clean = s => s.replace(/^[\s\-–—:.,;)]+/, '').replace(/[\s\-–—,;(]+$/, '').trim();
    const general = clean(text.slice(0, groups.length ? groups[0].start : text.length));
    const points = [];
    groups.forEach((g, i) => {
      const t = clean(text.slice(g.end, i + 1 < groups.length ? groups[i + 1].start : text.length));
      g.points.forEach(p => points.push({ num: p.num, id: p.id, text: t }));
    });
    return { general, points };
  }

  const normId = id => String(parseInt(id, 10));

  /**
   * Номер точки в отчёте ↔ ID заказа в CRM.
   * Пары — как у кнопки «Статус»: если точек поровну — по порядку; если в CRM меньше
   * ровно на незагруженные — оставшиеся точки отчёта по порядку; иначе — по «Порядку объезда».
   */
  function pointIdMap(crmPoints, rep) {
    const idByNum = new Map(), numById = new Map(), noteById = new Map();
    if (!crmPoints) return { idByNum, numById, noteById };
    const total = num(rep.pts) || 0, nl = nums(rep.nl);
    let repNums;
    if (crmPoints.length === total) repNums = crmPoints.map((_, i) => i + 1);
    else if (nl.length && crmPoints.length === total - nl.length)
      repNums = Array.from({ length: total }, (_, i) => i + 1).filter(n => !nl.includes(n));
    else repNums = crmPoints.map(p => p.num);
    crmPoints.forEach((p, i) => {
      if (!p.id) return;
      idByNum.set(repNums[i], p.id);
      numById.set(normId(p.id), repNums[i]);
      noteById.set(normId(p.id), p.note);
    });
    return { idByNum, numById, noteById };
  }

  /**
   * Строка таблицы комментариев: недостающий номер / ID берём из CRM,
   * если водитель указал оба и они не сходятся с CRM — предупреждение.
   */
  function commentPointRow(p, map) {
    const fromCrm = v => el('span', { class: 'srp-sub', title: 'Взято из CRM' }, v);
    const crmNum = p.id !== null ? map.numById.get(normId(p.id)) : undefined;
    const crmId = p.num !== null ? map.idByNum.get(p.num) : undefined;

    let numCell = p.num !== null ? p.num + 'т' : crmNum !== undefined ? fromCrm(crmNum + 'т') : '—';
    let idCell = p.id !== null ? p.id : crmId ? fromCrm(crmId) : '—';
    let warn = '';
    if (p.id !== null && map.numById.size && crmNum === undefined) warn = `Заказа ${p.id} нет в рейсе`;
    else if (p.num !== null && crmNum !== undefined && crmNum !== p.num) warn = `В CRM ${p.id} — это ${crmNum}т`;

    // Заказ для кнопки «в пометку»: ID водителя, иначе ID из CRM по номеру
    const targetId = p.id !== null ? p.id : crmId || null;
    const canWrite = !!(targetId && p.text && map.numById.has(normId(targetId)));
    const key = canWrite ? noteKey(targetId, p.text) : null;
    // Комментарий уже в пометке → кнопка «убрать». Смотрим на саму пометку в CRM
    // (её мог вписать и человек вручную); если пометку прочитать не удалось — на свою запись.
    const crmNote = canWrite ? map.noteById.get(normId(targetId)) : null;
    const done = !canWrite ? false
      : typeof crmNote === 'string' ? noteHas(crmNote, p.text) : !!loadJson(key);
    const busy = key && noteBusy.has(key);
    const btnNote = el('button', {
      class: 'srp-icon srp-note' + (done ? ' srp-active' : ''),
      title: !canWrite ? 'Не знаю, к какому заказу CRM относится комментарий'
        : done ? `Комментарий есть в пометке заказа ${targetId} — убрать его и сохранить`
        : `Вписать комментарий в пометку заказа ${targetId} и сохранить`,
      onclick: () => (done ? undoNote : insertNote)(targetId, p.text, key),
    }, busy ? '⏳' : done ? '↩️' : '📝');
    if (!canWrite || busy) btnNote.disabled = true;

    // Клик по номеру / ID — прокрутка к строке заказа в CRM с подсветкой.
    // Номер → заказ CRM под этим номером (или ID водителя, если номера нет); ID → этот заказ.
    const numTarget = p.num !== null ? crmId || p.id : p.id;
    const idTarget = p.id !== null ? p.id : crmId || null;
    const gotoCell = (content, id, label) => el('td', {
      class: (warn ? 'warn ' : '') + (id ? 'srp-goto' : ''),
      title: (warn ? warn + '\n' : '') + (id ? `Показать ${label} в списке заказов` : 'Не знаю, какой это заказ в CRM'),
      onclick: () => gotoOrder(id),
    }, content);

    return el('tr', null,
      gotoCell(numCell, numTarget, numTarget ? `заказ ${numTarget}` : ''),
      gotoCell(idCell, idTarget, idTarget ? `заказ ${idTarget}` : ''),
      el('td', { class: 'srp-cm-text srp-copy', title: 'Нажмите, чтобы скопировать', onclick: () => copyText(p.text) },
        p.text || '—',
        warn ? el('div', { class: 'srp-sub' }, '⚠ ' + warn) : null),
      el('td', { class: 'srp-cm-btn' }, btnNote));
  }

  /** Прокрутить к строке заказа в CRM и подсветить её на несколько секунд */
  function flashRow(tr, color) {
    tr.scrollIntoView({ block: 'center' });
    clearTimeout(tr._srpFlash);
    if (!tr._srpFlash) tr._srpWas = { o: tr.style.outline, b: tr.style.backgroundColor };
    tr.style.outline = `3px solid ${color.line}`;
    tr.style.backgroundColor = color.bg;
    tr._srpFlash = setTimeout(() => {
      tr.style.outline = tr._srpWas.o;
      tr.style.backgroundColor = tr._srpWas.b;
      tr._srpFlash = null;
    }, 2500);
  }
  const FLASH_POINT = { line: '#2563eb', bg: '#dbeafe' };
  const FLASH_OPT = { line: '#dc2626', bg: '' };

  function gotoOrder(id) {
    if (!id) return showToast('Не знаю, какой это заказ в CRM');
    const row = (safe(() => crmRows()) || []).find(r => r.id && normId(r.id) === normId(id));
    if (!row) return showToast(`Заказа ${id} нет в списке рейса`);
    flashRow(row.tr, FLASH_POINT);
    showToast(`${row.num}т · заказ ${row.id}`);
  }

  // ---- Комментарий → «Пометка к заказу» и обратно ----
  // Что вписали, хранится в localStorage для этой ссылки отчёта: { before, after }
  const noteKey = (id, text) => `${STORE_KEY}|note|${normId(id)}|${text}`;
  const noteBusy = new Set();
  const loadJson = k => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } };
  const saveJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const dropJson = k => { try { localStorage.removeItem(k); } catch (e) {} };

  async function runNoteOp(key, op) {
    noteBusy.add(key); render();
    try { await op(); }
    catch (e) { alert(e.message); }
    finally { noteBusy.delete(key); render(); }
  }

  // Сравниваем без учёта лишних пробелов и переносов строк
  const squash = s => String(s || '').replace(/\s+/g, ' ').trim();
  const noteHas = (note, text) => !!squash(text) && squash(note).includes(squash(text));
  /** Вырезать text из пометки (пробелы/переносы внутри текста — любые) */
  function cutText(note, text) {
    const esc = squash(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    return note.replace(new RegExp('\\n?[ \\t]*' + esc), '').replace(/^\s+|\s+$/g, '');
  }

  function insertNote(id, text, key) {
    return runNoteOp(key, async () => {
      const r = await CRM.editOrderNote(id, cur =>
        noteHas(cur, text) ? cur : cur.trim() ? cur.replace(/\s+$/, '') + '\n' + text : text);
      if (!r.changed) return showToast('Этот текст уже есть в пометке');
      saveJson(key, { before: r.before, after: r.after });
      showToast(`Вписано в пометку ${id}`);
    });
  }

  function undoNote(id, text, key) {
    const rec = loadJson(key) || {};
    return runNoteOp(key, async () => {
      const r = await CRM.editOrderNote(id, cur => {
        if (rec.after !== undefined && cur === rec.after) return rec.before; // вписывали мы и пометку не трогали
        if (noteHas(cur, text)) return cutText(cur, text);                   // вырезаем только этот комментарий
        return cur;                                                          // его там уже нет
      });
      dropJson(key);
      showToast(r.changed ? `Пометка ${id} возвращена` : 'В пометке этого текста уже нет');
    });
  }

  /** Копирование в буфер с подсказкой «Скопировано» */
  function copyText(text) {
    if (!text) return;
    const done = () => showToast('Скопировано');
    const fallback = () => {
      const t = el('textarea');
      t.value = text;
      t.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.append(t);
      t.select();
      try { document.execCommand('copy'); done(); } catch (e) { showToast('Не удалось скопировать'); }
      t.remove();
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), 1500);
  }

  // =====================================================================
  // 5. ОКНО
  // =====================================================================
  const css = `
  #srp{position:fixed;top:70px;right:20px;width:520px;max-width:calc(100vw - 20px);z-index:2147483000;
    background:#fff;color:#222;border:1px solid #cfd4da;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);
    font:13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  #srp *{box-sizing:border-box}
  #srp .srp-head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#f3f5f7;
    border-bottom:1px solid #e1e4e8;border-radius:10px 10px 0 0;cursor:move;user-select:none}
  #srp.srp-collapsed .srp-head{border-bottom:none;border-radius:10px}
  #srp .srp-title{flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #srp button{font:inherit;border:1px solid #c5cbd2;background:#fff;border-radius:6px;padding:4px 10px;cursor:pointer}
  #srp button:hover{background:#eef2f6}
  #srp button.srp-icon{padding:4px 8px;min-width:30px}
  #srp button.srp-active{background:#dbe9ff;border-color:#7aa7e8}
  #srp button.srp-ok{background:#dcfce7;border-color:#86efac;color:#166534}
  #srp button.srp-ok:hover{background:#bbf7d0}
  #srp button.srp-bad{background:#fde8e8;border-color:#f5a3a3;color:#9b1c1c}
  #srp button.srp-bad:hover{background:#fbd0d0}
  #srp button.srp-warn{background:#fff6d6;border-color:#f0d27a;color:#7a5a00}
  #srp button.srp-warn:hover{background:#ffedb3}
  #srp button.srp-opt{font-weight:700;letter-spacing:.5px}
  #srp button.srp-fin{display:flex;flex-direction:column;align-items:center;line-height:1.15;padding:2px 8px;white-space:nowrap}
  #srp button.srp-fin small{font-size:10px;opacity:.85}
  #srp .srp-body{padding:10px;max-height:70vh;overflow:auto}
  #srp.srp-collapsed .srp-body{display:none}
  #srp table{width:100%;border-collapse:collapse}
  #srp th,#srp td{border:1px solid #e1e4e8;padding:5px 6px;vertical-align:top;text-align:left}
  #srp th{background:#fafbfc;font-weight:600}
  #srp td.srp-param{font-weight:600;white-space:nowrap}
  #srp td.ok{background:#e7f6ea;color:#1d6b2f}
  #srp td.warn{background:#fff6d6;color:#7a5a00}
  #srp td.bad{background:#fde8e8;color:#9b1c1c}
  #srp td.none{background:#f3f4f6;color:#6b7280}
  #srp input,#srp textarea{width:100%;font:inherit;border:1px solid #9db8e0;border-radius:4px;padding:2px 4px}
  #srp .srp-sub{color:#6b7280;font-size:12px}
  #srp .srp-cm-label{margin:10px 0 4px;font-weight:600}
  #srp .srp-cm{white-space:pre-wrap;background:#fafbfc;border:1px solid #e1e4e8;border-radius:6px;padding:6px 8px;min-height:32px}
  #srp table.srp-cm-pts{margin-top:6px}
  #srp table.srp-cm-pts td:not(.srp-cm-text){white-space:nowrap;width:1%}
  #srp td.srp-cm-text{white-space:pre-wrap}
  #srp .srp-copy{cursor:copy}
  #srp .srp-copy:hover{background:#eef4ff}
  #srp td.srp-goto{cursor:pointer;color:#1d4ed8;text-decoration:underline dotted}
  #srp td.srp-goto:hover{background:#eef4ff}
  #srp td.srp-goto.warn{color:#7a5a00}
  #srp td.srp-cm-btn{padding:3px 4px;vertical-align:middle}
  #srp button.srp-note{padding:2px 6px;min-width:0}
  #srp button:disabled{opacity:.35;cursor:not-allowed;background:#fff}
  #srp .srp-toast{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);background:#1f2937;color:#fff;
    padding:4px 12px;border-radius:6px;font-size:12px;opacity:0;pointer-events:none;transition:opacity .2s}
  #srp .srp-toast.on{opacity:.92}
  #srp.srp-under-modal{visibility:hidden}
  #srp td.srp-findable{cursor:pointer}
  #srp td.srp-findable:hover{filter:brightness(.95)}
  ::highlight(srp-find){background:#fde047;color:#111}
  ::highlight(srp-find-cur){background:#f97316;color:#fff}
  #srp .srp-reset{margin-top:8px}
  `;

  const ICON = { ok: '✔', warn: '⚠', bad: '✖', none: '…' };
  let editing = false;
  let collapsed = false;
  try { collapsed = localStorage.getItem('strumReportCollapsed') === '1'; } catch (e) {}

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    children.flat().forEach(c => { if (c !== null && c !== undefined) e.append(c instanceof Node ? c : String(c)); });
    return e;
  }

  const style = el('style');
  style.textContent = css;
  document.head.append(style);

  const btnStatus = el('button', { title: 'Проставить статусы точек по отчёту', onclick: () => CRM.applyStatuses(reportForApply()) }, 'Статус');
  const btnKm = el('button', { title: 'Записать километраж из отчёта', onclick: () => CRM.applyKm(num(report.km)) }, 'КМ');
  const btnEdit = el('button', { class: 'srp-icon', title: 'Редактировать значения отчёта', onclick: toggleEdit }, '✎');
  const btnHide = el('button', { class: 'srp-icon', title: 'Скрыть / раскрыть', onclick: toggleCollapse }, '▾');
  const title = el('div', { class: 'srp-title' }, `Отчёт · ${ROUTE_ID || '?'}`);
  // «ОПТ» — красная плашка, если в товарах рейса есть «@табл опт»; клик — к следующей такой строке
  let optIdx = -1;
  const optBadge = el('button', { class: 'srp-bad srp-opt', onclick: () => {
    const rows = safe(() => CRM.getOptRows()) || [];
    if (!rows.length) return;
    optIdx = (optIdx + 1) % rows.length;
    flashRow(rows[optIdx].tr, FLASH_OPT);
    showToast(`Опт: ${rows[optIdx].num}т (${optIdx + 1} из ${rows.length})`);
  } }, 'ОПТ');
  optBadge.style.display = 'none';
  // «Завершить» — слева в меню, под надписью — текущий статус рейса.
  // Завершен → зелёная «Не завершать» (ставит «Не завершен»); Загружен → жёлтая; другой статус → красная.
  const finLabel = el('span', null, 'Завершить');
  const finStatus = el('small', null, '…');
  let finBusy = false;
  const btnFin = el('button', { class: 'srp-fin', onclick: async () => {
    if (finBusy) return;
    const st = safe(() => CRM.getRouteStatus());
    if (!st) return showToast('Не нашёл статус рейса на странице');
    const to = st.value === 'done' ? 'not_done' : 'done';
    finBusy = true; btnFin.disabled = true; finStatus.textContent = '⏳';
    try {
      const now = await CRM.setRouteStatus(to);
      showToast(`Статус рейса: ${st.text} → ${now.text}`);
    } catch (e) {
      showToast(e.message);
    } finally {
      finBusy = false; btnFin.disabled = false; render();
    }
  } }, finLabel, finStatus);
  const head = el('div', { class: 'srp-head' }, btnFin, title, optBadge, btnStatus, btnKm, btnEdit, btnHide);
  const body = el('div', { class: 'srp-body' });
  const toast = el('div', { class: 'srp-toast' });
  const panel = el('div', { id: 'srp' }, head, body, toast);
  document.body.append(panel);

  /** Кнопка меню: state 'ok' — зелёная, 'warn' — жёлтая, 'bad' — красная, '' — обычная */
  function paintBtn(btn, state, title) {
    btn.classList.toggle('srp-ok', state === 'ok');
    btn.classList.toggle('srp-warn', state === 'warn');
    btn.classList.toggle('srp-bad', state === 'bad');
    btn.title = title;
  }

  function paintFin() {
    if (finBusy) return;
    const st = safe(() => CRM.getRouteStatus());
    btnFin.disabled = !st;
    finLabel.textContent = st && st.value === 'done' ? 'Не завершать' : 'Завершить';
    finStatus.textContent = st ? st.text : 'статус ?';
    if (!st) paintBtn(btnFin, '', 'Не нашёл статус рейса на странице');
    else if (st.value === 'done') paintBtn(btnFin, 'ok', 'Рейс завершён. Нажмите — поставить «Не завершен»');
    else if (st.value === 'loaded') paintBtn(btnFin, 'warn', 'Рейс загружен. Нажмите — поставить «Завершен»');
    else paintBtn(btnFin, 'bad', `Статус «${st.text}» — обычно должен быть «Загружен» или «Завершен». Нажмите — поставить «Завершен»`);
  }

  function reportForApply() {
    return { total: num(report.pts) || 0, ns: nums(report.ns), nl: nums(report.nl) };
  }

  function toggleEdit() {
    if (editing) {
      body.querySelectorAll('[data-key]').forEach(inp => { report[inp.dataset.key] = inp.value.trim(); });
      saveReport();
    }
    editing = !editing;
    btnEdit.classList.toggle('srp-active', editing);
    btnEdit.textContent = editing ? '💾' : '✎';
    btnEdit.title = editing ? 'Сохранить правки' : 'Редактировать значения отчёта';
    if (editing && collapsed) toggleCollapse();
    render();
  }

  function toggleCollapse() {
    collapsed = !collapsed;
    panel.classList.toggle('srp-collapsed', collapsed);
    btnHide.textContent = collapsed ? '▸' : '▾';
    try { localStorage.setItem('strumReportCollapsed', collapsed ? '1' : '0'); } catch (e) {}
  }
  if (collapsed) { panel.classList.add('srp-collapsed'); btnHide.textContent = '▸'; }

  // Ячейка значения отчёта: текст или поле ввода в режиме правки
  const repCell = (key, display, hint) => editing
    ? el('td', null, el('input', { 'data-key': key, value: report[key] || '', placeholder: hint || '' }))
    : el('td', null, display === '' || display === null ? '—' : display);

  const resCell = r => r.find === undefined
    ? el('td', { class: r.level }, `${ICON[r.level]} ${r.text}`)
    : el('td', {
        class: r.level + ' srp-findable',
        title: `Нажмите — найти ${r.find} на странице (ещё раз — следующее; Esc — снять подсветку)`,
        onclick: () => findOnPage(r.find, String(r.find)),
      }, `${ICON[r.level]} ${r.text} 🔍`);

  function render() {
    const crmName = safe(() => CRM.getDriverName());
    const crmKm = safe(() => CRM.getKm());
    const routeType = safe(() => CRM.getRouteType());
    const crmPoints = safe(() => CRM.getPoints());

    // «ОПТ» — видна, только если в товарах есть «@табл опт»
    const optRows = safe(() => CRM.getOptRows()) || [];
    optBadge.style.display = optRows.length ? '' : 'none';
    optBadge.title = `В товарах есть «@табл опт»: ${optRows.map(r => r.num + 'т').join(', ')}. Нажмите — показать`;

    paintFin();

    // Цвет кнопок: зелёная — в CRM уже как в отчёте, красная — отличается
    const repKm = num(report.km);
    if (crmKm === null || repKm === null) paintBtn(btnKm, '', 'Записать километраж из отчёта');
    else if (crmKm === repKm) paintBtn(btnKm, 'ok', 'Километраж в CRM уже как в отчёте');
    else paintBtn(btnKm, 'bad', `Записать километраж из отчёта: ${crmKm} → ${repKm}`);
    const plan = crmPoints ? safe(() => CRM.planStatuses(reportForApply())) : null;
    if (!plan) paintBtn(btnStatus, '', 'Проставить статусы точек по отчёту');
    else if (plan.error) paintBtn(btnStatus, 'bad', plan.error);
    else if (plan.changes.length) paintBtn(btnStatus, 'bad',
      `Статусы отличаются от отчёта у ${plan.changes.length} т. — нажмите, чтобы проставить`);
    else paintBtn(btnStatus, 'ok', 'Статусы в CRM уже как в отчёте');
    const crmMoney = safe(() => CRM.getMoney());
    const show = v => (v === null || v === undefined || v === '') ? '—' : v;

    const rows = [];

    // ФИО
    rows.push(el('tr', null,
      el('td', { class: 'srp-param' }, 'ФИО'),
      el('td', null, show(crmName)),
      repCell('fio', report.fio),
      resCell(compareName(crmName, report.fio))));

    // Километраж: в названии строки — тип рейса («Минск», «Межгород»); если тип не задан — «Километраж»
    const withKm = v => show(v) === '—' ? '—' : `${v} км.`;
    rows.push(el('tr', null,
      el('td', { class: 'srp-param' }, routeType && routeType.value ? routeType.text : 'Километраж'),
      el('td', null, withKm(crmKm)),
      repCell('km', withKm(report.km)),
      resCell(compareKm(crmKm, report.km, routeType))));

    // Точки, не загруженные, не сданные — свои строки, общий результат (ячейка на все строки).
    // Строки «Не загружены» / «Не сданы» скрыты, если их нет ни в CRM, ни в отчёте (кроме режима правки).
    const crmByStatus = st => crmPoints ? crmPoints.filter(p => p.status === st).map(p => p.num).sort((a, b) => a - b) : [];
    const ptRows = [
      { name: 'Точки', crm: crmPoints ? `${crmPoints.length} шт.` : '—',
        key: 'pts', rep: `${num(report.pts) || 0} шт.`, hint: 'всего', always: true },
      { name: 'Не загружены', crm: crmPoints ? listT(crmByStatus('nl')) : '—',
        key: 'nl', rep: listT(nums(report.nl)), hint: '5', has: crmByStatus('nl').length || nums(report.nl).length },
      { name: 'Не сданы', crm: crmPoints ? listT(crmByStatus('ns')) : '—',
        key: 'ns', rep: listT(nums(report.ns)), hint: '3,6', has: crmByStatus('ns').length || nums(report.ns).length },
    ].filter(r => r.always || r.has || editing);
    const ptResult = resCell(comparePoints(crmPoints, report));
    ptResult.rowSpan = ptRows.length;
    ptResult.style.verticalAlign = 'middle';
    ptRows.forEach((r, i) => rows.push(el('tr', null,
      el('td', { class: 'srp-param' }, r.name),
      el('td', null, r.crm),
      repCell(r.key, r.rep, r.hint),
      i === 0 ? ptResult : null)));

    // Валюты: каждая, что есть в отчёте или в CRM (в режиме правки — все)
    CURRENCIES.forEach(cur => {
      const inRep = num(report[cur]) !== null && num(report[cur]) !== 0;
      const inCrm = crmMoney && num(crmMoney[cur]) !== null && num(crmMoney[cur]) !== 0;
      if (!editing && !inRep && !inCrm) return;
      rows.push(el('tr', null,
        el('td', { class: 'srp-param' }, cur),
        el('td', null, crmMoney ? show(crmMoney[cur]) : '—'),
        repCell(cur, report[cur]),
        resCell(compareMoney(cur, crmMoney, report[cur]))));
    });

    const table = el('table', null,
      el('thead', null, el('tr', null, el('th', null, 'Параметр'), el('th', null, 'CRM'), el('th', null, 'Отчёт'), el('th', null, 'Результат'))),
      el('tbody', null, rows));

    // Комментарий: общий — текстовым блоком, по точкам — таблицей «Точка | ID | Комментарий»
    const cmBlocks = [];
    if (editing) {
      cmBlocks.push(el('textarea', { 'data-key': 'cm', rows: '4' }, report.cm));
    } else {
      const cm = parseComment(report.cm);
      // Общий комментарий показываем только если он есть; пустое поле с прочерком не выводим
      if (cm.general) cmBlocks.push(
        el('div', { class: 'srp-cm srp-copy', title: 'Нажмите, чтобы скопировать', onclick: () => copyText(cm.general) }, cm.general));
      const idMap = pointIdMap(crmPoints, report);
      if (cm.points.length) cmBlocks.push(el('table', { class: 'srp-cm-pts' },
        el('thead', null, el('tr', null, el('th', { title: 'Точка' }, 'Т.'), el('th', null, 'ID'), el('th', null, 'Комментарий'), el('th'))),
        el('tbody', null, cm.points.map(p => commentPointRow(p, idMap)))));
    }

    const children = [table];
    // Заголовок «Комментарий водителя» нужен только когда под ним что-то есть
    if (cmBlocks.length) children.push(el('div', { class: 'srp-cm-label' }, 'Комментарий водителя'));
    children.push(...cmBlocks);
    if (editing) children.push(el('button', { class: 'srp-reset', onclick: () => { resetReport(); render(); } }, '↺ Вернуть значения из отчёта'));

    body.replaceChildren(...children);
  }

  function safe(fn) { try { const v = fn(); return v === undefined ? null : v; } catch (e) { console.warn('[Струм отчёт]', e); return null; } }

  // Перетаскивание окна за заголовок
  (function drag() {
    let sx, sy, ox, oy, moving = false;
    head.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      moving = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!moving) return;
      panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { moving = false; });
  })();

  // Окно видно только на странице того маршрута, к которому относится отчёт
  function updateVisibility() {
    panel.style.display = routeIdFromHash() === ROUTE_ID ? '' : 'none';
  }
  window.addEventListener('hashchange', updateVisibility);
  updateVisibility();

  render();
  // CRM подгружает данные не сразу — периодически перечитываем (кроме режима правки)
  setInterval(() => { if (!editing && panel.style.display !== 'none') render(); }, REFRESH_MS);
  // Пока открыто окно CRM (например, «Пометка к заказу») — прячем окно сверки, чтобы не закрывало его
  setInterval(() => panel.classList.toggle('srp-under-modal', !!document.querySelector('#modal.on')), 200);
})();