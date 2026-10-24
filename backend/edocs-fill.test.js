'use strict';
const { linesFromRecord, normalizeLines, actTotals, doctorOf } = require('./services/edocs/act-lines');
const { buildRenderData } = require('./services/edocs/fill');
const { FIELDS, SERVICE_FIELDS } = require('./services/edocs/placeholders');
const { mapStatus, isFinal, applyWorkflow } = require('./services/edocs/statuses');
const { NBSP } = require('./services/edocs/format');

// Реальная форма records.services (запись 2056697734 и строки со скидкой/бонусом, дев 24.10.2026).
const SERVICES = [
  { id: 9536663, cost: 48000, title: 'Revi strong 2 ml', amount: 2, discount: 0, first_cost: 48000, cost_to_pay: 48000, manual_cost: 48000, cost_per_unit: 24000 },
  { id: 15394152, cost: 7737.61, title: 'Фотоомоложение Lumeca - лицо', amount: 1, discount: 10, first_cost: 17500, cost_to_pay: 7737.61, manual_cost: 15750, cost_per_unit: 17500 },
  { id: 1, cost: 0, title: 'Консультация', amount: 1, discount: 100, first_cost: 5000, cost_to_pay: 0, manual_cost: 0, cost_per_unit: 5000 },
  { id: 2, title: '  Пилинг   PRX ', amount: 1, discount: 30, first_cost: 6000, cost_per_unit: 6000 },
];

describe('act-lines', () => {
  test('строки из записи: сумма — manual_cost (бонусы не уменьшают), без него — по проценту скидки', () => {
    expect(linesFromRecord(SERVICES)).toEqual([
      { service_id: 9536663, title: 'Revi strong 2 ml', qty: 2, price: 24000, sum: 48000 },
      { service_id: 15394152, title: 'Фотоомоложение Lumeca - лицо', qty: 1, price: 17500, sum: 15750 },
      { service_id: 1, title: 'Консультация', qty: 1, price: 5000, sum: 0 },
      { service_id: 2, title: 'Пилинг PRX', qty: 1, price: 6000, sum: 4200 },
    ]);
    expect(linesFromRecord(null)).toEqual([]);
  });
  test('итог и скидка строки', () => {
    const t = actTotals(linesFromRecord(SERVICES));
    expect(t.total_sum).toBe(67950);
    expect(t.lines.map((l) => [l.n, l.discount])).toEqual([[1, 0], [2, 1750], [3, 5000], [4, 1800]]);
    expect(t.total_discount).toBe(8550);
  });
  test('normalizeLines: строки из формы, запятая в числе, ошибки по строкам', () => {
    expect(normalizeLines([{ title: ' Чистка ', qty: '1', price: '3 500,50', sum: 3500.5, service_id: '7' }]))
      .toEqual({ value: [{ service_id: 7, title: 'Чистка', qty: 1, price: 3500.5, sum: 3500.5 }] });
    expect(normalizeLines([]).error).toMatch(/1–50/);
    expect(normalizeLines([{ title: '', qty: 1, price: 1, sum: 1 }]).error).toMatch(/Строка 1: название/);
    expect(normalizeLines([{ title: 'a', qty: 0, price: 1, sum: 1 }]).error).toMatch(/количество/);
    expect(normalizeLines([{ title: 'a', qty: [5], price: 1, sum: 1 }]).error).toMatch(/количество/);
    expect(normalizeLines([{ title: 'a', qty: 1, price: -1, sum: 1 }]).error).toMatch(/цена/);
    expect(normalizeLines([{ title: 'a', qty: 1, price: 1, sum: 'x' }]).error).toMatch(/сумма/);
    expect(normalizeLines([{ title: 'a', qty: 1, price: 1, sum: 1, service_id: 1.5 }]).error).toMatch(/id услуги/);
  });
  test('doctorOf', () => {
    expect(doctorOf({ name: 'Гаджиева Пери', position: { title: 'Врач-косметолог' } })).toEqual({ name: 'Гаджиева Пери', position: 'Врач-косметолог' });
    expect(doctorOf({ name: 'Юлия', specialization: 'Косметолог' })).toEqual({ name: 'Юлия', position: 'Косметолог' });
    expect(doctorOf(null)).toEqual({ name: '', position: '' });
  });
});

describe('fill.buildRenderData', () => {
  const identity = {
    plain: { last_name: 'Иванова', first_name: 'Анна', middle_name: 'Сергеевна', birth_date: '1983-03-21', gender: 'F', phone: '79001234567', email: null, contract_no: '1739', contract_date: null },
    secure: { passport_series: '4510', passport_number: '123456', issued_by: 'ОВД', issue_date: '2015-05-01', authority_code: '770-001' },
  };
  const requisites = { name: 'ООО «Пери Клиник»', inn: '9724060392', city: 'Москва' };

  test('каждый тег словаря получает значение (без акта — все, кроме тегов акта)', () => {
    const data = buildRenderData({ identity, requisites, docDate: '2026-10-24' });
    for (const [tag, f] of Object.entries(FIELDS)) {
      if (f.actOnly) expect(data).not.toHaveProperty(tag);
      else expect(typeof data[tag]).toBe('string');
    }
  });
  test('значения и форматы; пустое — видимый пропуск, отчество — пусто', () => {
    const data = buildRenderData({ identity, requisites, docDate: '2026-10-24' });
    expect(data).toMatchObject({
      fio: 'Иванова Анна Сергеевна', fio_short: 'Иванова А. С.', birth_date: '21.03.1983', gender: 'женский', phone: '+7 (900) 123-45-67',
      email: '________', passport: '4510 123456', passport_issue_date: '01.05.2015', birth_place: '________',
      contract_no: '1739', contract_date: '24.10.2026', doc_date: '24.10.2026', doc_city: 'Москва', org_kpp: '________',
    });
    const noMiddle = buildRenderData({ identity: { plain: { last_name: 'Ким', first_name: 'Ли' }, secure: {} }, requisites: {}, docDate: '2026-10-24' });
    expect(noMiddle.middle_name).toBe('');
    expect(noMiddle.fio).toBe('Ким Ли');
  });
  test('акт: все теги акта и поля строки, суммы прописью', () => {
    const act = { act_no: '2056697734', visit_date: '2026-10-23', doctor_name: 'Гаджиева Пери', doctor_position: 'Врач-косметолог', lines: linesFromRecord(SERVICES.slice(0, 2)) };
    const data = buildRenderData({ identity, requisites, docDate: '2026-10-24', act });
    for (const [tag, f] of Object.entries(FIELDS)) if (f.actOnly) expect(data).toHaveProperty(tag);
    expect(Object.keys(data.services[0]).sort()).toEqual(Object.keys(SERVICE_FIELDS).sort());
    expect(data.services[1]).toEqual({ n: '2', title: 'Фотоомоложение Lumeca - лицо', qty: '1', price: `17${NBSP}500,00`, discount: `1${NBSP}750,00`, sum: `15${NBSP}750,00` });
    expect(data.total_sum).toBe(`63${NBSP}750,00`);
    expect(data.total_sum_words).toBe('Шестьдесят три тысячи семьсот пятьдесят рублей 00 копеек');
    expect(data.visit_date).toBe('23.10.2026');
  });
});

describe('statuses', () => {
  test('mapStatus и isFinal', () => {
    expect(mapStatus('WAIT_SIGN')).toBe('sent');
    expect(mapStatus('signed')).toBe('signed');
    expect(mapStatus('CANCELED')).toBe('declined');
    expect(mapStatus('SIGNING_EXPIRED')).toBe('expired');
    expect(mapStatus('NEW_THING')).toBeNull();
    expect(isFinal('annulled')).toBe(true);
    expect(isFinal('signed')).toBe(false);
  });
  const pkg = { id: 'p-1', status: 'sent', signed_at: null, fdoc_package_guid: null };
  const docs = [{ id: 'd-1', file_name: 'Договор.docx', title: 'Договор' }, { id: 'd-2', file_name: 'Согласие.docx', title: 'Согласие' }];
  test('подписан: время подписи клиента и сотрудника, сопоставление по id', () => {
    const r = applyWorkflow(pkg, docs, { id: 'p-1', status: 'SIGNED', documents: [
      { id: 'd-2', status: 'SIGNED', clientSigners: [{ isSigned: true, dateSignOrCancel: '2026-10-24T10:05:00+03:00' }], employeeSigners: [{ isSigned: true, dateSignOrCancel: '2026-10-24T10:00:00+03:00' }] },
      { id: 'd-1', status: 'SIGNED', clientSigners: [{ isSigned: true, dateSignOrCancel: '2026-10-24T10:04:00+03:00' }], employeeSigners: [] },
    ] });
    expect(r.package).toEqual({ status: 'signed', fdoc_status: 'SIGNED', fdoc_package_guid: null, signed_at: '2026-10-24T07:05:00.000Z', unknownStatus: false });
    expect(r.documents).toEqual([
      { id: 'd-1', fdoc_document_guid: null, fdoc_status: 'SIGNED', client_signed_at: '2026-10-24T07:04:00.000Z', corp_signed_at: null },
      { id: 'd-2', fdoc_document_guid: null, fdoc_status: 'SIGNED', client_signed_at: '2026-10-24T07:05:00.000Z', corp_signed_at: '2026-10-24T07:00:00.000Z' },
    ]);
  });
  test('свои GUID у F.Doc: сопоставление по имени файла, GUID запоминается', () => {
    const r = applyWorkflow(pkg, docs, { id: 'G-PKG', status: 'WAIT_SIGN', documents: [
      { id: 'G-2', name: 'согласие.docx', status: 'WAIT_SIGN' }, { id: 'G-1', name: 'Договор', status: 'WAIT_SIGN' },
    ] });
    expect(r.package.fdoc_package_guid).toBe('G-PKG');
    expect(r.documents.map((d) => [d.id, d.fdoc_document_guid])).toEqual([['d-1', 'G-1'], ['d-2', 'G-2']]);
  });
  test('незнакомый статус не теряет комплект; черновик становится отправленным', () => {
    expect(applyWorkflow(pkg, [], { id: 'p-1', status: 'SOMETHING_NEW' }).package).toMatchObject({ status: 'sent', unknownStatus: true });
    expect(applyWorkflow({ ...pkg, status: 'draft' }, [], { id: 'p-1', status: 'SOMETHING_NEW' }).package.status).toBe('sent');
  });
  test('по порядку — только при совпадении количества', () => {
    const r = applyWorkflow(pkg, docs, { id: 'p-1', status: 'WAIT_SIGN', documents: [{ id: 'X', name: 'Чужое', status: 'WAIT_SIGN' }] });
    expect(r.documents).toEqual([]);
  });
});
