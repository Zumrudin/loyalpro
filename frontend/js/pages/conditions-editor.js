// ── Конструктор условий «мастер / категория / услуга» ─────────────
// Общий для «Заботы» и «Напоминаний о повторном визите»: обе вкладки отбирают
// визиты одним и тем же форматом conditions ({logic, items}), который на
// бэкенде разбирает общий evaluateRule. Второй копии этого кода быть не должно —
// правка фильтра или лимита опций разъехалась бы между вкладками.
//
// Экземпляр адресуется префиксом ns. Требуемая разметка на странице:
//   #<ns>Conds       — контейнер списка условий
//   #<ns>LogicWrap   — обёртка переключателя И/ИЛИ (прячется при одном условии)
//   #<ns>Logic-and, #<ns>Logic-or — кнопки переключателя
//
// Зависимости страницы: esc(), escAttr() из core/utils.js.

const COND_LABELS = { staff: 'Специалист', category: 'Категория', service: 'Услуга' };
const _condEditors = {};                 // ns → { conds, logic, dicts }

/** Создать (или пересоздать) редактор. dicts — ответ /api/notification-rules/dictionaries. */
function condInit(ns, dicts) {
  _condEditors[ns] = { conds: [], logic: 'and', dicts: dicts || null };
}

/** Загрузить условия в редактор ({logic, items} с бэкенда). */
function condSet(ns, conditions) {
  const st = _condEditors[ns];
  if (!st) return;
  const c = conditions || {};
  st.logic = c.logic === 'or' ? 'or' : 'and';
  st.conds = (Array.isArray(c.items) ? c.items : []).map(it => ({
    type: ['staff', 'category', 'service'].includes(it.type) ? it.type : 'service',
    ids: new Set((it.ids || []).map(String)),
    filter: '',
  }));
  condRender(ns);
  condSetLogic(ns, st.logic);
}

/** Выгрузить условия для отправки на бэкенд. Пустые условия отбрасываются. */
function condGet(ns) {
  const st = _condEditors[ns];
  if (!st) return { logic: 'and', items: [] };
  return {
    logic: st.logic,
    items: st.conds.filter(c => c.ids.size)
      .map(c => ({ type: c.type, ids: [...c.ids].map(Number).filter(n => !isNaN(n)) })),
  };
}

function condSetLogic(ns, logic) {
  const st = _condEditors[ns];
  if (!st) return;
  st.logic = logic === 'or' ? 'or' : 'and';
  const and = document.getElementById(`${ns}Logic-and`);
  const or = document.getElementById(`${ns}Logic-or`);
  if (and) and.classList.toggle('on', st.logic === 'and');
  if (or) or.classList.toggle('on', st.logic === 'or');
}

function condAdd(ns) {
  _condEditors[ns].conds.push({ type: 'service', ids: new Set(), filter: '' });
  condRender(ns);
}

function condRemove(ns, i) {
  _condEditors[ns].conds.splice(i, 1);
  condRender(ns);
}

function condType(ns, i, type) {
  const c = _condEditors[ns].conds[i];
  c.type = type; c.ids = new Set(); c.filter = '';
  condRender(ns);
}

function condFilter(ns, i, value) {
  _condEditors[ns].conds[i].filter = value;
  condRenderList(ns, i);
}

function condToggleId(ns, i, id, checked) {
  const c = _condEditors[ns].conds[i];
  if (checked) c.ids.add(String(id)); else c.ids.delete(String(id));
  const cnt = document.getElementById(`${ns}CondCount-${i}`);
  if (cnt) cnt.textContent = `выбрано: ${c.ids.size}`;
}

function condOptions(ns, type) {
  const d = _condEditors[ns] && _condEditors[ns].dicts;
  if (!d) return [];
  if (type === 'staff') {
    return (d.staff || []).map(s => ({
      id: s.id, label: s.name + (s.specialization ? ` — ${s.specialization}` : ''),
    }));
  }
  if (type === 'category') return (d.categories || []).map(c => ({ id: c.id, label: c.title }));
  const catById = {};
  (d.categories || []).forEach(c => { catById[String(c.id)] = c.title; });
  return (d.services || []).map(s => ({
    id: s.id,
    label: s.title + (catById[String(s.category_id)] ? ` · ${catById[String(s.category_id)]}` : ''),
  }));
}

function condRender(ns) {
  const st = _condEditors[ns];
  const wrap = document.getElementById(`${ns}Conds`);
  if (!st || !wrap) return;
  wrap.innerHTML = st.conds.map((c, i) => `
    <div class="nr-cond">
      <div class="nr-cond-head">
        <select onchange="condType('${ns}', ${i}, this.value)">
          ${Object.entries(COND_LABELS).map(([k, v]) =>
            `<option value="${k}" ${c.type === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <span class="nr-cond-count" id="${ns}CondCount-${i}">выбрано: ${c.ids.size}</span>
        <button class="mc" onclick="condRemove('${ns}', ${i})" title="Убрать условие">✕</button>
      </div>
      <input type="search" autocomplete="off" placeholder="🔎 Поиск…" value="${escAttr(esc(c.filter))}"
             oninput="condFilter('${ns}', ${i}, this.value)">
      <div class="nr-cond-list" id="${ns}CondList-${i}"></div>
    </div>`).join('');
  const lw = document.getElementById(`${ns}LogicWrap`);
  if (lw) lw.style.display = st.conds.length > 1 ? 'flex' : 'none';
  st.conds.forEach((_, i) => condRenderList(ns, i));
}

function condRenderList(ns, i) {
  const st = _condEditors[ns];
  const box = document.getElementById(`${ns}CondList-${i}`);
  if (!st || !box) return;
  const c = st.conds[i];
  const q = (c.filter || '').trim().toLowerCase();
  let opts = condOptions(ns, c.type);
  if (q) opts = opts.filter(o => o.label.toLowerCase().includes(q));
  const total = opts.length;
  // Выбранные — всегда сверху, чтобы не терялись за фильтром и лимитом.
  opts.sort((a, b) => (c.ids.has(String(b.id)) ? 1 : 0) - (c.ids.has(String(a.id)) ? 1 : 0));
  opts = opts.slice(0, 150);
  box.innerHTML = opts.map(o => `
    <label class="nr-cond-opt">
      <input type="checkbox" ${c.ids.has(String(o.id)) ? 'checked' : ''}
             onchange="condToggleId('${ns}', ${i}, '${o.id}', this.checked)">
      <span>${esc(o.label)}</span>
    </label>`).join('') || '<div class="empty" style="padding:12px 0">Ничего не найдено</div>';
  if (total > 150) {
    box.innerHTML += `<div style="font-size:11px;color:var(--t3);padding:6px 2px">Показаны первые 150 из ${total} — уточните поиск</div>`;
  }
}

/** Есть ли хоть одно непустое условие — обе страницы это проверяют перед сохранением. */
function condHasAny(ns) {
  const st = _condEditors[ns];
  return !!(st && st.conds.some(c => c.ids.size));
}

/** Есть ли условие БЕЗ выбранных значений — condGet() такие тихо отбрасывает,
 *  и без этой проверки строка пропадала бы при сохранении без предупреждения. */
function condHasEmpty(ns) {
  const st = _condEditors[ns];
  return !!(st && st.conds.some(c => !c.ids.size));
}
