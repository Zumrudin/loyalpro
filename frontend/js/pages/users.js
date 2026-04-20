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
      <td><span style="font-size:11.5px;font-weight:600;color:${ROLE_COLOR[u.role]||'#333'};background:${ROLE_BG[u.role]||'#f3f4f6'};padding:2px 8px;border-radius:4px">${ROLE_LABEL[u.role]||u.role}</span></td>
      <td>${u.is_active ? '<span style="color:#059669">Активен</span>' : '<span style="color:var(--t3)">Отключён</span>'}</td>
      <td style="color:var(--t3);font-size:12px">${u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('ru') : '—'}</td>
      <td style="text-align:right">
        <button class="btn btn-sec btn-sm" onclick="usersOpenEdit(${u.id})">Изменить</button>
        ${u.is_active && u.role!=='owner' ? `<button class="btn btn-sm" style="color:var(--danger);border:1px solid var(--bd);margin-left:4px" onclick="usersDeactivate(${u.id},'${esc(u.name)}')">Отключить</button>` : ''}
      </td>
    </tr>
  `).join('');
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

  try {
    if (isNew) {
      await api('POST', '/api/users', { name, email, role, position, password: pw });
      notify('Пользователь создан', 'ok');
    } else {
      const body = { name, role, position };
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
