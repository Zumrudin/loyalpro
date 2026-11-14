const _stockRefs = { busy: false };
async function stockLoadRefs() {
  const el = stockEl('stockTab-suppliers');
  try {
    await stockEnsureDictionaries();
    el.innerHTML = ['suppliers', 'units', 'storages']
      .map(
        (key, i) =>
          `<h3>${['Поставщики', 'Единицы', 'Склады'][i]}</h3><button onclick="stockEditRef('${key}')">Добавить</button><table class="stock-table"><tbody>${_stock.dictionaries[key].map((r) => `<tr><td>${stockEsc(r.title)} ${r.yclients_storage_id || r.yclients_unit_id ? ' · YClients' : ''}</td><td>${(key === 'storages' && r.yclients_storage_id) || (key === 'units' && r.yclients_unit_id) ? '' : `<button onclick="stockEditRef('${key}',${Number(r.id)})">Изменить</button>`}${key === 'suppliers' ? `<button onclick="stockDeleteSupplier(${Number(r.id)})">Архивировать</button>` : ''}</td></tr>`).join('')}</tbody></table>`,
      )
      .join('');
  } catch (e) {
    el.textContent = e.message;
  }
}
function stockEditRef(key, id) {
  const r = _stock.dictionaries[key].find((r) => Number(r.id) === id) || {};
  _stockRefs.key = key;
  _stockRefs.id = id;
  stockEl('stockRefBody').innerHTML =
    stockInput('stockRefTitle', 'Название', r.title, 'text', 'required maxlength="100"') +
    (key === 'units'
      ? stockInput('stockRefShort', 'Сокращение', r.short_title, 'text', 'required maxlength="50"')
      : key === 'storages'
        ? `<label class="stock-check"><input id="stockRefSale" type="checkbox" ${r.for_sale ? 'checked' : ''}>Для продаж</label><label class="stock-check"><input id="stockRefService" type="checkbox" ${r.for_service ? 'checked' : ''}>Для услуг</label>`
        : ['inn', 'phone', 'email', 'contact', 'comment']
            .map((k, i) =>
              stockInput('stockRef-' + k, ['ИНН', 'Телефон', 'Email', 'Контакт', 'Комментарий'][i], r[k], 'text'),
            )
            .join(''));
  stockEl('stockRefError').textContent = '';
  stockEl('stockRefModal').showModal();
}
function stockCloseRef() {
  if (!_stockRefs.busy) stockEl('stockRefModal').close();
}
async function stockSaveRef(e) {
  e.preventDefault();
  if (_stockRefs.busy) return;
  _stockRefs.busy = true;
  stockEl('stockRefSave').disabled = true;
  try {
    const key = _stockRefs.key,
      b = { title: stockEl('stockRefTitle').value };
    if (key === 'units') b.shortTitle = stockEl('stockRefShort').value;
    else if (key === 'storages') {
      b.forSale = stockEl('stockRefSale').checked;
      b.forService = stockEl('stockRefService').checked;
    } else for (const k of ['inn', 'phone', 'email', 'contact', 'comment']) b[k] = stockEl('stockRef-' + k).value;
    await stockApi('/' + key + (_stockRefs.id ? '/' + _stockRefs.id : ''), b, _stockRefs.id ? 'PUT' : 'POST');
    stockEl('stockRefModal').close();
    await stockLoadRefs();
  } catch (e) {
    stockEl('stockRefError').textContent = e.message;
  } finally {
    _stockRefs.busy = false;
    stockEl('stockRefSave').disabled = false;
  }
}
async function stockDeleteSupplier(id) {
  if (!confirm('Архивировать поставщика?')) return;
  try {
    await stockApi('/suppliers/' + id, undefined, 'DELETE');
    await stockLoadRefs();
  } catch (e) {
    stockEl('stockStatus').textContent = e.message;
  }
}
async function stockLoadSettings() {
  const el = stockEl('stockTab-settings');
  if (ME?.role !== 'owner') {
    el.textContent = 'Настройки доступны владельцу';
    return;
  }
  try {
    const s = await stockApi('/settings');
    el.innerHTML = `<form onsubmit="stockSaveSettings(event)">${stockSelect('stockSettingSale', 'Склад продаж', _stock.dictionaries.storages, s.default_sale_storage_id)}${stockSelect('stockSettingService', 'Склад расходников', _stock.dictionaries.storages, s.default_service_storage_id)}<button id="stockSettingsSave">Сохранить</button><p id="stockSettingsStatus"></p></form>`;
  } catch (e) {
    el.textContent = e.message;
  }
}
async function stockSaveSettings(e) {
  e.preventDefault();
  const btn = stockEl('stockSettingsSave');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await stockApi(
      '/settings',
      {
        defaultSaleStorageId: Number(stockEl('stockSettingSale').value) || null,
        defaultServiceStorageId: Number(stockEl('stockSettingService').value) || null,
      },
      'PUT',
    );
    stockEl('stockSettingsStatus').textContent = 'Сохранено';
  } catch (e) {
    stockEl('stockSettingsStatus').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}
stockEl('stockRefModal').addEventListener('cancel', (e) => {
  e.preventDefault();
  stockCloseRef();
});
