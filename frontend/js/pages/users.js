// ── USERS PAGE ────────────────────────────────────────────────
let _usersData = [];

const ROLE_LABEL = { owner: 'Владелец', admin: 'Администратор', specialist: 'Специалист' };
const ROLE_COLOR = { owner: '#6d28d9', admin: '#1d4ed8', specialist: '#065f46' };
const ROLE_BG    = { owner: '#ede9fe', admin: '#dbeafe', specialist: '#d1fae5' };

async function loadUsers() {
  try {
    const d = await api('GET', '/api/users');
    _usersData = d.users;
    document.getElementById('usersQuota').textContent =
      `Активных: ${d.active_count} из ${d.max_users} (тариф ${d.plan})`;
    renderUsers(d.users);
  } catch(e) { notify('Ошибка загрузки: '+e.message, 'err'); }
}

function renderUsers(users) {
  const tbody = document.getElementById('usersTbody');
  if (!users.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">Нет пользователей</td></tr>'; return; }
  tbody.innerHTML = users.map(u => `
    <tr style="${u.is_active ? '' : 'opacity:.5'}">
      <td><b>${esc(u.name)}</b>${u.must_change_password ? ' <span style="font-size:11px;color:#92400e;background:#fffbeb;padding:1px 6px;border-radius:4px;border:1px solid #fde68a">Не активирован</span>' : ''}</td>
      <td style="color:var(--t3)">${esc(u.email)}</td>
      <td style="color:var(--t2)">${esc(u.position || '—')}</td>
      <td>
        <span style="font-size:11.5px;font-weight:600;color:${ROLE_COLOR[u.role]||'#333'};background:${ROLE_BG[u.role]||'#f3f4f6'};padding:2px 8px;border-radius:4px">${ROLE_LABEL[u.role]||u.role}</span>
        ${u.role==='specialist' && u.staff_member_name ? `<div style="font-size:11px;color:var(--t3);margin-top:3px">→ ${esc(u.staff_member_name)}</div>` : ''}
      </td>
      <td>${u.is_active ? '<span style="color:#059669">Активен</span>' : '<span style="color:var(--t3)">Отключён</span>'}</td>
      <td style="color:var(--t3);font-size:12px">${u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('ru') : '—'}</td>
      <td style="text-align:right">
        <button class="btn btn-sec btn-sm" data-users-edit="${u.id}">Изменить</button>
        ${u.is_active && u.role!=='owner' ? `<button class="btn btn-sm" style="color:var(--danger);border:1px solid var(--bd);margin-left:4px" data-users-deactivate="${u.id}">Отключить</button>` : ''}
      </td>
    </tr>
  `).join('');
  // Event delegation: never interpolate user-controlled strings into onclick
  // handlers — HTML attribute decoding turns escaped quotes back into real
  // quotes, opening XSS via stored names. Look up the row from _usersData by id.
  if (!tbody._usersDelegated) {
    tbody.addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-users-edit]');
      if (editBtn) { usersOpenEdit(parseInt(editBtn.dataset.usersEdit, 10)); return; }
      const deactBtn = e.target.closest('[data-users-deactivate]');
      if (deactBtn) {
        const id = parseInt(deactBtn.dataset.usersDeactivate, 10);
        const u = _usersData.find(x => x.id === id);
        usersDeactivate(id, u?.name || '');
      }
    });
    tbody._usersDelegated = true;
  }
}

function usersOpenCreate() {
  const u = { id: null, name: '', email: '', role: 'admin', is_active: true };
  usersShowModal(u, true);
}

function usersOpenEdit(id) {
  const u = _usersData.find(x => x.id === id);
  if (u) usersShowModal(u, false);
}

function usersShowModal(u, isNew) {
  const isOwner = ME.role === 'owner';
  const title = isNew ? 'Новый пользователь' : 'Редактировать пользователя';
  const html = `
    <div class="seg-drawer-ov open" id="usersMod" onclick="if(event.target===this)usersCloseModal()">
      <div class="seg-drawer" style="width:420px;padding:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <b style="font-size:15px">${title}</b>
          <button class="btn btn-sec btn-sm" onclick="usersCloseModal()">✕</button>
        </div>
        <div class="err" id="usersModErr"></div>
        <div class="fg"><label class="fl">Имя</label><input type="text" id="umName" value="${esc(u.name)}" placeholder="Иван Иванов"></div>
        <div class="fg"><label class="fl">Email</label><input type="email" id="umEmail" value="${esc(u.email)}" placeholder="user@salon.ru" ${isNew ? '' : 'disabled'}></div>
        <div class="fg"><label class="fl">Должность <span class="fh">необязательно</span></label><input type="text" id="umPosition" value="${esc(u.position||'')}" placeholder="Косметолог, Трихолог…"></div>
        <div class="fg">
          <label class="fl">Роль</label>
          <select id="umRole" ${!isOwner ? 'disabled' : ''}>
            ${isOwner ? '<option value="admin">Администратор</option>' : ''}
            <option value="specialist">Специалист</option>
          </select>
        </div>
        <div class="fg" id="umStaffRow" hidden>
          <label class="fl">Сотрудник YClients <span class="fh">для личного дашборда специалиста</span></label>
          <select id="umStaffSelect">
            <option value="">— не привязан —</option>
          </select>
          <div class="fh" id="umStaffHint" style="margin-top:4px"></div>
        </div>
        <div class="fg">
          <label class="fl">${isNew ? 'Временный пароль' : 'Новый пароль'} <span class="fh">${isNew ? 'обязательно' : 'оставьте пустым чтобы не менять'}</span></label>
          <input type="password" id="umPw" placeholder="••••••••">
        </div>
        ${!isNew ? `<div class="fg" style="display:flex;align-items:center;gap:10px">
          <input type="checkbox" id="umActive" ${u.is_active ? 'checked' : ''} style="width:16px;height:16px">
          <label for="umActive" class="fl" style="margin:0;cursor:pointer">Пользователь активен</label>
        </div>` : ''}
        <div style="display:flex;gap:8px;margin-top:20px">
          <button class="btn btn-pri" style="flex:1" onclick="usersSave(${u.id || 'null'},${isNew})">${isNew ? 'Создать' : 'Сохранить'}</button>
          <button class="btn btn-sec" onclick="usersCloseModal()">Отмена</button>
        </div>
      </div>
    </div>
  `;
  const el = document.createElement('div');
  el.id = 'usersModWrap';
  el.innerHTML = html;
  document.body.appendChild(el);
  // Set role value after render
  const sel = document.getElementById('umRole');
  if (sel && !isNew) sel.value = u.role;

  // Загрузить список YClients-сотрудников и подключить логику показа/скрытия.
  usersHydrateStaffSelect(u);
  if (sel) sel.addEventListener('change', () => usersToggleStaffRow(sel.value));
  usersToggleStaffRow(sel?.value);
}

function usersToggleStaffRow(role) {
  const row = document.getElementById('umStaffRow');
  if (row) row.hidden = (role !== 'specialist');
}

async function usersHydrateStaffSelect(u) {
  const sel = document.getElementById('umStaffSelect');
  const hint = document.getElementById('umStaffHint');
  if (!sel) return;
  try {
    const d = await api('GET', '/api/staff-profiles');
    const staff = d.staff || [];
    const myId = u.id;
    const opts = ['<option value="">— не привязан —</option>'].concat(
      staff.map(s => {
        const takenByOther = s.linked_to_user_id && s.linked_to_user_id !== myId;
        const label = esc(s.name) + (takenByOther ? ` (привязан к: ${esc(s.linked_to_user_name || '?')})` : '');
        const selected = (u.staff_member_id === s.id) ? ' selected' : '';
        return `<option value="${s.id}" data-taken="${takenByOther ? '1' : '0'}"${selected}>${label}</option>`;
      })
    );
    sel.innerHTML = opts.join('');
    const showHint = () => {
      const o = sel.options[sel.selectedIndex];
      hint.textContent = (o && o.dataset.taken === '1')
        ? '⚠ Этот сотрудник уже привязан к другому логину — сохранение перезапишет привязку.'
        : '';
      hint.style.color = '#92400e';
    };
    sel.addEventListener('change', showHint);
    showHint();
  } catch (e) {
    hint.textContent = 'Не удалось загрузить список сотрудников: ' + e.message;
    hint.style.color = 'var(--danger)';
  }
}

function usersCloseModal() {
  document.getElementById('usersModWrap')?.remove();
}

async function usersSave(id, isNew) {
  const err = document.getElementById('usersModErr');
  err.style.display = 'none';
  const name  = document.getElementById('umName')?.value.trim();
  const email = document.getElementById('umEmail')?.value.trim();
  const role  = document.getElementById('umRole')?.value;
  const position = document.getElementById('umPosition')?.value.trim() || null;
  const pw    = document.getElementById('umPw')?.value;
  const active = document.getElementById('umActive');
  // staff_member_id передаём только для specialist; иначе null (бэк сам сбросит).
  const staffSel = document.getElementById('umStaffSelect');
  const staff_member_id = (role === 'specialist' && staffSel && staffSel.value)
    ? parseInt(staffSel.value, 10) : null;

  try {
    if (isNew) {
      await api('POST', '/api/users', { name, email, role, position, password: pw, staff_member_id });
      notify('Пользователь создан', 'ok');
    } else {
      const body = { name, role, position, staff_member_id };
      if (pw) body.password = pw;
      if (active) body.is_active = active.checked;
      await api('PATCH', `/api/users/${id}`, body);
      notify('Изменения сохранены', 'ok');
    }
    usersCloseModal();
    loadUsers();
  } catch(e) {
    err.textContent = e.message; err.style.display = 'block';
  }
}

async function usersDeactivate(id, name) {
  if (!confirm(`Отключить пользователя "${name}"? Он не сможет войти в систему.`)) return;
  try {
    await api('DELETE', `/api/users/${id}`);
    notify('Пользователь отключён', 'ok');
    loadUsers();
  } catch(e) { notify(e.message, 'err'); }
}
