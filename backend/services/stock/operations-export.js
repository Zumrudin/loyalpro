'use strict';

const ExcelJS = require('exceljs');
const { pool } = require('../../db');
const { StockError } = require('./model');

const KINDS = { receipt: 'Приход товара', writeoff: 'Списание товара', move: 'Перемещение',
  sale: 'Продажа товара', inventory: 'Инвентаризация', consumable: 'Списание расходников', opening: 'Начальные остатки' };
const PAYMENTS = { paid: 'Оплачено', unpaid: 'Не оплачено', partial: 'Частично оплачено',
  pending: 'Ожидает оплаты', failed: 'Ошибка оплаты', cancelled: 'Оплата отменена',
  not_applicable: 'Не применимо', unknown: 'Нет данных' };
const dateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const dateText = v => v && Number.isFinite(new Date(v).getTime()) ? dateFormat.format(new Date(v)) : '';
const numeric = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
// ExcelJS receives only primitive strings/numbers, never formula or hyperlink
// objects. Prefix formula-like strings as an additional defence on re-import.
const cellText = v => /^[\s]*[=+@-]/.test(String(v ?? '')) ? "'" + String(v) : String(v ?? '');

function excelRow(row) {
  return [dateText(row.occurred_at), cellText(row.document_number), cellText(row.counterparty_name),
    KINDS[row.kind] || 'Операция', cellText(row.storage_title), cellText(row.comment),
    cellText(row.good_title), cellText(row.article), numeric(row.qty_pack), cellText(row.unit_title),
    numeric(row.qty_base), cellText(row.service_unit_title), numeric(row.cost_basis), numeric(row.balance_after),
    dateText(row.visit_at), cellText(row.record_id), PAYMENTS[row.payment_status] || 'Нет данных',
    row.origin === 'yclients' ? 'YClients' : 'LoyalPro',
    row.deleted_at ? 'Движение удалено' : { posted: 'Проведён', cancelled: 'Отменён', draft: 'Черновик' }[row.status] || ''];
}

const COLUMNS = [
  ['Дата (Москва)', 20], ['№ документа', 20], ['Поставщик/Получатель', 28], ['Тип операции', 25],
  ['Склад', 20], ['Комментарий', 32], ['Товар', 40], ['Артикул', 18], ['Количество упаковок', 20],
  ['Ед. упаковки', 15], ['Количество базовое', 20], ['Базовая единица', 18], ['Себестоимость, ₽', 20],
  ['Остаток после операции (баз.)', 28], ['Визит (Москва)', 20], ['ID визита', 18],
  ['Статус оплаты', 22], ['Источник', 16], ['Статус документа', 20],
];

async function exportOperations(salonId, filters, res) {
  const { listOperations } = require('./operations');
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    begun = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    const query = async (sql, values) => (await client.query(sql, values)).rows;
    const first = await listOperations(salonId, { ...filters, page: 1, limit: 100 }, { query });
    if (first.total > 1048575) throw new StockError('Выборка превышает лимит Excel. Уменьшите период.', 400, 'export_too_large');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="stock-operations.xlsx"');
    res.setHeader('Cache-Control', 'no-store');
    const book = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
    const sheet = book.addWorksheet('Складские операции', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = COLUMNS.map(([header, width]) => ({ header, width }));
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: 'A1', to: 'S1' };
    for (const n of [9, 11, 14]) sheet.getColumn(n).numFmt = '0.########';
    sheet.getColumn(13).numFmt = '#,##0.00';
    const append = rows => rows.forEach(row => sheet.addRow(excelRow(row)).commit());
    append(first.operations);
    for (let page = 2; (page - 1) * 100 < first.total; page++) {
      if (res.destroyed) throw new Error('Export connection closed');
      const data = await listOperations(salonId, { ...filters, page, limit: 100 }, { query });
      append(data.operations);
    }
    await client.query('COMMIT');
    begun = false;
    sheet.commit();
    await book.commit();
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => {});
    if (res.headersSent) { res.destroy(); return; }
    throw error;
  } finally { client.release(); }
}

module.exports = { exportOperations, excelRow, cellText };
