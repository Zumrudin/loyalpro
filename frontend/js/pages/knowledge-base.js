// ── База знаний администратора ─────────────────────────────────
'use strict';

let _kbCats = [];
let _kbActiveCat = null;       // id выбранной папки или null (все)
let _kbSearchTimer = null;
let _kbSuggestSeq = 0;         // токен «последнего запроса» — защита от гонки ответов
let _kbSuggestItems = [];      // текущие статьи в popup
let _kbSuggestActive = -1;     // индекс подсвеченной строки (-1 = нет)

const _kbCanEdit = () => ME && (ME.role === 'owner' || ME.role === 'admin');
// kbSnippet — из kb-markdown.js (глобальная); экранирует сниппет и возвращает
// подсветку <b> из сентинел-маркеров. Защита от XSS в поисковой выдаче.

async function loadKnowledgeBase() {
  document.body.classList.toggle('kb-editor', _kbCanEdit());
  try {
    const data = await api('GET', '/api/kb/categories');
    _kbCats = data.categories || [];
    renderKbFolders();
    await kbRunSearch();
    kbBindOnce();
  } catch (e) {
    document.getElementById('kb-content').innerHTML =
      `<div class="kb-empty">Ошибка загрузки: ${kbEsc(e.message)}</div>`;
  }
}

let _kbBound = false;
function kbBindOnce() {
  if (_kbBound) return; _kbBound = true;

  const input = document.getElementById('kb-search');
  input.addEventListener('input', () => {
    clearTimeout(_kbSearchTimer);
    _kbSearchTimer = setTimeout(kbTypeahead, 180);
  });
  input.addEventListener('keydown', (ev) => {
    const box = document.getElementById('kb-suggest');
    if (box.hidden) return;
    if (ev.key === 'ArrowDown')      { ev.preventDefault(); kbMoveActive(1); }
    else if (ev.key === 'ArrowUp')   { ev.preventDefault(); kbMoveActive(-1); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      const pick = _kbSuggestActive >= 0 ? _kbSuggestActive : 0;
      const art = _kbSuggestItems[pick];
      if (art) { kbHideSuggest(); kbOpenArticle(art.id); }
    } else if (ev.key === 'Escape') { kbHideSuggest(); }
  });
  // клик вне строки поиска — закрыть popup
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.kb-search-wrap')) kbHideSuggest();
  });

  document.getElementById('kb-add-article').addEventListener('click', () => kbOpenArticleModal(null));

  const askToggle = document.getElementById('kb-ask-toggle');
  const askPanel  = document.getElementById('kb-ask-panel');
  const askInput  = document.getElementById('kb-ask-input');
  const askSend   = document.getElementById('kb-ask-send');
  if (askToggle && askPanel) {
    askToggle.addEventListener('click', () => {
      askPanel.hidden = !askPanel.hidden;
      askToggle.classList.toggle('active', !askPanel.hidden);
      if (!askPanel.hidden) {
        askInput.focus();
      } else {
        // закрыли вкладку ассистента — затираем последний ответ
        kbClearAskResult();
      }
    });
    askSend.addEventListener('click', kbAskSend);
    askInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); kbAskSend(); }
    });
  }

  // делегирование: клики по кнопкам копирования внутри статьи
  document.getElementById('kb-content').addEventListener('click', (ev) => {
    const copy = ev.target.closest('.kb-copy');
    if (copy) {
      const code = copy.parentElement.querySelector('code');
      if (code) navigator.clipboard.writeText(code.innerText).then(() => {
        copy.textContent = '✓'; setTimeout(() => (copy.textContent = '⧉'), 1200);
      });
    }
  });
}

// затирает последний ответ ИИ-ассистента (при закрытии панели / переходе в статью)
function kbClearAskResult() {
  const result = document.getElementById('kb-ask-result');
  if (result) { result.hidden = true; result.innerHTML = ''; }
}

function kbHideSuggest() {
  const box = document.getElementById('kb-suggest');
  box.hidden = true; box.innerHTML = '';
  _kbSuggestItems = []; _kbSuggestActive = -1;
}

function kbRenderSuggest(arts) {
  const box = document.getElementById('kb-suggest');
  _kbSuggestItems = arts; _kbSuggestActive = -1;
  if (!arts.length) {
    box.innerHTML = `<div class="kb-suggest-empty">Ничего не найдено</div>`;
    box.hidden = false; return;
  }
  box.innerHTML = arts.map((a) => `
    <div class="kb-suggest-item" data-id="${a.id}">
      <div class="kb-suggest-title">${kbEsc(a.title)}</div>
      <div class="kb-suggest-snippet">${kbSnippet(a.snippet)}</div>
    </div>`).join('');
  box.hidden = false;
  box.querySelectorAll('.kb-suggest-item').forEach(el =>
    el.addEventListener('click', () => {
      const id = parseInt(el.dataset.id, 10);
      kbHideSuggest(); kbOpenArticle(id);
    }));
}

function kbMoveActive(dir) {
  const items = document.querySelectorAll('#kb-suggest .kb-suggest-item');
  if (!items.length) return;
  _kbSuggestActive = (_kbSuggestActive + dir + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('active', i === _kbSuggestActive));
  items[_kbSuggestActive].scrollIntoView({ block: 'nearest' });
}

async function kbTypeahead() {
  const q = document.getElementById('kb-search').value.trim();
  if (q.length < 2) { kbHideSuggest(); return; }
  const seq = ++_kbSuggestSeq;
  try {
    const data = await api('GET', '/api/kb/articles?q=' + encodeURIComponent(q) + '&limit=8');
    if (seq !== _kbSuggestSeq) return;          // пришёл устаревший ответ — игнор
    kbRenderSuggest(data.articles || []);
  } catch (e) {
    if (seq === _kbSuggestSeq) kbHideSuggest(); // ошибку в popup не показываем
  }
}

function renderKbFolders() {
  const el = document.getElementById('kb-folders');
  const all = `<div class="kb-folder ${_kbActiveCat === null ? 'active' : ''}" data-cat="">
      📚 Все разделы</div>`;
  const items = _kbCats.map(c => `
    <div class="kb-folder ${_kbActiveCat === c.id ? 'active' : ''}" data-cat="${c.id}">
      <span>${kbEsc(c.icon)} ${kbEsc(c.title)}</span>
      <span class="kb-count">${c.articles_count}</span>
    </div>`).join('');
  const addBtn = _kbCanEdit()
    ? `<button class="btn-sec kb-admin-only" id="kb-add-folder" type="button">+ Папка</button>` : '';
  el.innerHTML = all + items + addBtn;

  el.querySelectorAll('.kb-folder').forEach(f => f.addEventListener('click', () => {
    const v = f.dataset.cat;
    _kbActiveCat = v === '' ? null : parseInt(v, 10);
    renderKbFolders();
    kbRunSearch();
  }));
  const addFolder = document.getElementById('kb-add-folder');
  if (addFolder) addFolder.addEventListener('click', kbCreateFolder);
}

async function kbRunSearch() {
  const q = document.getElementById('kb-search').value.trim();
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (_kbActiveCat) params.set('category_id', _kbActiveCat);
  const content = document.getElementById('kb-content');
  try {
    const data = await api('GET', '/api/kb/articles?' + params.toString());
    const arts = data.articles || [];
    if (!arts.length) {
      content.innerHTML = `<div class="kb-empty">Ничего не найдено.
        ${_kbCanEdit() ? 'Добавьте статью кнопкой «+ Статья».' : ''}</div>`;
      return;
    }
    content.innerHTML = arts.map(a => `
      <div class="kb-card" data-id="${a.id}">
        <div class="kb-card-title">${a.internal_only ? '🔒 ' : ''}${kbEsc(a.title)}</div>
        <div class="kb-card-snippet">${kbSnippet(a.snippet)}</div>
        <div class="kb-card-tags">${(a.tags || []).map(t => `<span class="kb-tag">${kbEsc(t)}</span>`).join('')}</div>
      </div>`).join('');
    content.querySelectorAll('.kb-card').forEach(card =>
      card.addEventListener('click', () => kbOpenArticle(parseInt(card.dataset.id, 10))));
  } catch (e) {
    content.innerHTML = `<div class="kb-empty">Ошибка поиска: ${kbEsc(e.message)}</div>`;
  }
}

async function kbOpenArticle(id) {
  try {
    const { article } = await api('GET', '/api/kb/articles/' + id);
    kbClearAskResult();   // перешли в статью — затираем последний ответ ассистента
    const content = document.getElementById('kb-content');
    const editBtns = _kbCanEdit()
      ? `<button class="btn-sec" id="kb-edit-art" type="button">Редактировать</button>
         <button class="btn-sec" id="kb-del-art" type="button">Удалить</button>` : '';
    content.innerHTML = `
      <div class="kb-article">
        <button class="btn-sec" id="kb-back" type="button">← Назад</button>
        <h2 class="kb-article-title">${article.internal_only ? '🔒 ' : ''}${kbEsc(article.title)}</h2>
        ${article.internal_only ? '<div class="kb-empty">Внутренняя статья: видна сотрудникам, Мила не использует её в ответах пациентам.</div>' : ''}
        <div class="kb-article-body">${kbMarkdown(article.body)}</div>
        <div class="kb-article-actions">${editBtns}</div>
      </div>`;
    // восстановить состояние чекбоксов из localStorage
    const key = 'kbcheck_' + id;
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    content.querySelectorAll('input[data-kb-check]').forEach(inp => {
      const idx = inp.dataset.kbCheck;
      if (saved[idx]) inp.checked = true;
      inp.addEventListener('change', () => {
        saved[idx] = inp.checked;
        localStorage.setItem(key, JSON.stringify(saved));
      });
    });
    document.getElementById('kb-back').addEventListener('click', kbRunSearch);
    const eb = document.getElementById('kb-edit-art');
    if (eb) eb.addEventListener('click', () => kbOpenArticleModal(article));
    const delBtn = document.getElementById('kb-del-art');
    if (delBtn) delBtn.addEventListener('click', () => kbDeleteArticle(id));
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
}

async function kbCreateFolder() {
  const title = prompt('Название папки:');
  if (!title || !title.trim()) return;
  const icon = prompt('Иконка (эмодзи, можно пусто):', '📄') || '';
  try {
    await api('POST', '/api/kb/categories', { title: title.trim(), icon: icon.trim() });
    await loadKnowledgeBase();
  } catch (e) { alert('Ошибка: ' + e.message); }
}

function kbOpenArticleModal(article) {
  const isEdit = !!article;
  const opts = _kbCats.map(c =>
    `<option value="${c.id}" ${article && article.category_id === c.id ? 'selected' : ''}>${kbEsc(c.title)}</option>`).join('');
  const wrap = document.createElement('div');
  wrap.className = 'kb-modal-ov';
  wrap.innerHTML = `
    <div class="kb-modal">
      <h3>${isEdit ? 'Редактировать статью' : 'Новая статья'}</h3>
      <div class="fg"><label class="fl">Заголовок</label>
        <input id="kbm-title" type="text" value="${isEdit ? kbEsc(article.title) : ''}"></div>
      <div class="fg"><label class="fl">Папка</label>
        <select id="kbm-cat">${opts}</select></div>
      <div class="fg"><label class="fl">Теги (через запятую)</label>
        <input id="kbm-tags" type="text" value="${isEdit ? kbEsc((article.tags || []).join(', ')) : ''}"></div>
      <div class="fg"><label class="fl" style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input id="kbm-internal" type="checkbox" ${isEdit && article.internal_only ? 'checked' : ''}>
        🔒 Внутренняя статья — только для сотрудников (Мила не использует её в ответах пациентам)</label></div>
      <div class="fg"><label class="fl">Текст (markdown: # заголовок, **жирный**, - список, - [ ] чекбокс, \`\`\` код, ![](фото); размер фото — {small}/{medium} после ссылки)</label>
        <textarea id="kbm-body" rows="12">${isEdit ? kbEsc(article.body) : ''}</textarea>
        <div class="kbm-toolbar">
          <button class="btn-sec" id="kbm-img-btn" type="button">🖼 Вставить фото</button>
          <select id="kbm-img-size" class="kbm-img-size" title="Размер картинки">
            <option value="small">Маленькая</option>
            <option value="medium" selected>Средняя</option>
            <option value="full">Полная</option>
          </select>
          <input id="kbm-img-file" type="file" accept="image/*" hidden>
          <span id="kbm-img-status" class="kbm-img-status"></span>
        </div></div>
      <div class="kb-modal-actions">
        <button class="btn-sec" id="kbm-cancel" type="button">Отмена</button>
        <button class="btn-pri" id="kbm-save" type="button">Сохранить</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('#kbm-cancel').addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  // загрузка фото → вставка ![](url) на позицию курсора в textarea
  const imgBtn    = wrap.querySelector('#kbm-img-btn');
  const imgFile   = wrap.querySelector('#kbm-img-file');
  const imgStatus = wrap.querySelector('#kbm-img-status');
  const bodyEl    = wrap.querySelector('#kbm-body');
  imgBtn.addEventListener('click', () => imgFile.click());
  imgFile.addEventListener('change', async () => {
    const file = imgFile.files && imgFile.files[0];
    if (!file) return;
    imgBtn.disabled = true;
    imgStatus.textContent = 'Загрузка…';
    try {
      const url = await kbUploadImage(file);
      const size = wrap.querySelector('#kbm-img-size').value;
      const tok = (size === 'small' || size === 'medium') ? `{${size}}` : '';  // full → без токена
      kbInsertAtCursor(bodyEl, `\n![](${url})${tok}\n`);
      imgStatus.textContent = 'Готово ✓';
      setTimeout(() => (imgStatus.textContent = ''), 1500);
    } catch (e) {
      imgStatus.textContent = 'Ошибка: ' + e.message;
    } finally {
      imgBtn.disabled = false;
      imgFile.value = '';   // позволяет выбрать тот же файл повторно
    }
  });
  wrap.querySelector('#kbm-save').addEventListener('click', async () => {
    const payload = {
      title: wrap.querySelector('#kbm-title').value.trim(),
      category_id: parseInt(wrap.querySelector('#kbm-cat').value, 10),
      tags: wrap.querySelector('#kbm-tags').value,
      body: wrap.querySelector('#kbm-body').value,
      // Контракт PUT полный: отсутствие поля = false, поэтому шлём всегда.
      internal_only: wrap.querySelector('#kbm-internal').checked,
    };
    if (!payload.title) { alert('Введите заголовок'); return; }
    try {
      if (isEdit) await api('PUT', '/api/kb/articles/' + article.id, payload);
      else        await api('POST', '/api/kb/articles', payload);
      close();
      await loadKnowledgeBase();
    } catch (e) { alert('Ошибка: ' + e.message); }
  });
}

// Загрузка картинки multipart (api() умеет только JSON, поэтому свой fetch).
// TOKEN — глобальный из core/api.js.
async function kbUploadImage(file) {
  const fd = new FormData();
  fd.append('image', file);
  const headers = {};
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  const r = await fetch('/api/kb/upload', { method: 'POST', headers, body: fd });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j.url;
}

// Вставляет текст на позицию курсора в textarea (или в конец, если нет фокуса).
function kbInsertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end   = textarea.selectionEnd   ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const pos = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = pos;
  textarea.focus();
}

async function kbDeleteArticle(id) {
  if (!confirm('Удалить статью?')) return;
  try {
    await api('DELETE', '/api/kb/articles/' + id);
    await loadKnowledgeBase();
  } catch (e) { alert('Ошибка: ' + e.message); }
}

let kbAsking = false;   // защита от двойной отправки (клик + Enter / быстрые клики)
async function kbAskSend() {
  if (kbAsking) return;
  const input  = document.getElementById('kb-ask-input');
  const result = document.getElementById('kb-ask-result');
  const sendBtn = document.getElementById('kb-ask-send');
  const q = (input.value || '').trim();
  if (q.length < 2) return;
  kbAsking = true;
  if (sendBtn) sendBtn.disabled = true;
  result.hidden = false;
  result.innerHTML = `<div class="kb-ask-loading">Думаю…</div>`;
  try {
    const data = await api('POST', '/api/kb/ask', { question: q });
    const answer = kbMarkdown(data.answer || '');
    const sources = (data.sources || []).map(s =>
      `<button class="kb-ask-src" type="button" data-id="${s.id}">${kbEsc(s.title)}</button>`
    ).join('');
    result.innerHTML = `
      <div class="kb-ask-answer">${answer}</div>
      ${sources ? `<div class="kb-ask-sources"><span>Источники:</span> ${sources}</div>` : ''}`;
    result.querySelectorAll('.kb-ask-src').forEach(btn =>
      btn.addEventListener('click', () => kbOpenArticle(parseInt(btn.dataset.id, 10))));
  } catch (e) {
    result.innerHTML = `<div class="kb-ask-error">Ошибка: ${kbEsc(e.message)}</div>`;
  } finally {
    kbAsking = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}
