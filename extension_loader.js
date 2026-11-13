/*
 * Струм CRM — загрузчик окна сверки отчёта водителя.
 * Вставляется в расширение «User JavaScript and CSS», правило для сайта strum-crm.onrender.com.
 *
 * Сам код окна (crm_report_panel.js) лежит на GitHub и подгружается при каждом открытии страницы,
 * поэтому правка на GitHub сразу доходит до всех устройств (GitHub может отдавать старую версию до ~5 минут).
 * Этот загрузчик менять не нужно.
 */
(function () {
  'use strict';
  // Грузим только на страницах, открытых по ссылке из отчёта
  const q = new URLSearchParams(location.search);
  if (!q.has('pts') && !q.has('fio') && !q.has('km')) return;

  const SRC = 'https://raw.githubusercontent.com/stepan-cloud/strum-report/main/crm_report_panel.js';

  fetch(SRC, { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('GitHub ответил ' + r.status); return r.text(); })
    .then(code => {
      const s = document.createElement('script');
      s.textContent = code + '\n//# sourceURL=strum-report/crm_report_panel.js';
      (document.head || document.documentElement).append(s);
      s.remove();
    })
    .catch(e => {
      console.error('[Струм отчёт] не удалось загрузить окно сверки с GitHub:', e);
      const n = document.createElement('div');
      n.textContent = 'Окно сверки отчёта не загрузилось с GitHub: ' + e.message;
      n.style.cssText = 'position:fixed;top:70px;right:20px;z-index:2147483000;background:#fde8e8;color:#9b1c1c;' +
        'border:1px solid #f5b5b5;border-radius:8px;padding:8px 12px;font:13px system-ui,sans-serif';
      document.body.append(n);
      setTimeout(() => n.remove(), 10000);
    });
})();
