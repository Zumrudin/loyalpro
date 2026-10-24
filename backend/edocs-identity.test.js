'use strict';
const { splitFullName } = require('./services/edocs/fio');
const { validateIdentity, encodeSecure, decodeRow, maskPassport, prefillFrom } = require('./services/edocs/identity');
const { makeBox } = require('./utils/secret-box');

describe('splitFullName', () => {
  test.each([
    ['Белоглазова Ольга викторовна', { last_name: 'Белоглазова', first_name: 'Ольга', middle_name: 'Викторовна', confident: true }],
    ['Алина Игоревна Милькова', { last_name: 'Милькова', first_name: 'Алина', middle_name: 'Игоревна', confident: true }],
    ['Мамедов Рашад Октай Оглы', { last_name: 'Мамедов', first_name: 'Рашад', middle_name: 'Октай Оглы', confident: true }],
    ['Анна Сергеевна', { last_name: '', first_name: 'Анна', middle_name: 'Сергеевна', confident: false }],
    ['Айнур Алиева', { last_name: 'Айнур', first_name: 'Алиева', middle_name: '', confident: false }],
    ['иванова-петрова мария', { last_name: 'Иванова-Петрова', first_name: 'Мария', middle_name: '', confident: false }],
    ['Мария', { last_name: '', first_name: 'Мария', middle_name: '', confident: false }],
    ['79001234567', { last_name: '', first_name: '', middle_name: '', confident: false }],
    ['', { last_name: '', first_name: '', middle_name: '', confident: false }],
  ])('%p', (name, expected) => expect(splitFullName(name)).toEqual(expected));
});

describe('validateIdentity', () => {
  const ok = {
    last_name: ' Иванова ', first_name: 'Анна', middle_name: '', birth_date: '1983-03-21', gender: 'f', phone: '8 (900) 123-45-67',
    email: 'a@b.ru', contract_no: ' 1739 ', contract_date: '',
    secure: { passport_series: '45 10', passport_number: '123456', issued_by: 'ОВД  «Тверской»‮', issue_date: '2015-05-01', authority_code: '770001', birth_place: 'г. Москва', address: '' },
  };
  test('нормализует и раскладывает на открытую и паспортную части', () => {
    expect(validateIdentity(ok, '2026-10-24')).toEqual({ value: {
      plain: { last_name: 'Иванова', first_name: 'Анна', middle_name: '', birth_date: '1983-03-21', gender: 'F', phone: '79001234567', email: 'a@b.ru', contract_no: '1739', contract_date: null },
      secure: { passport_series: '4510', passport_number: '123456', issued_by: 'ОВД «Тверской»', issue_date: '2015-05-01', authority_code: '770-001', birth_place: 'г. Москва' },
    } });
  });
  test('пустая форма законна', () => {
    expect(validateIdentity({}, '2026-10-24').value.secure).toEqual({});
  });
  test.each([
    [{ last_name: 'Иванова1' }, /Фамилия/],
    [{ birth_date: '2030-01-01' }, /Дата рождения/],
    [{ birth_date: '1983-02-30' }, /Дата рождения/],
    [{ gender: 'X' }, /Пол/],
    [{ phone: '12345' }, /Телефон/],
    [{ email: 'a@b' }, /E-mail/],
    [{ secure: { passport_series: '451' } }, /Серия/],
    [{ secure: { passport_number: '12345' } }, /Номер паспорта/],
    [{ secure: { issue_date: '2099-01-01' } }, /Дата выдачи/],
    [{ secure: { authority_code: '77-001' } }, /Код подразделения/],
  ])('%p → ошибка', (body, re) => expect(validateIdentity(body, '2026-10-24').error).toMatch(re));
});

describe('шифрование и маска', () => {
  const box = makeBox(Buffer.alloc(32, 3).toString('base64'));
  test('encodeSecure/decodeRow: туда и обратно, список полей без расшифровки', () => {
    const enc = encodeSecure({ passport_series: '4510', passport_number: '123456', address: '' }, box);
    expect(enc.secure_fields).toEqual(['passport_series', 'passport_number']);
    expect(enc.secure_enc).not.toContain('4510');
    const row = { last_name: 'Иванова', first_name: 'Анна', secure_enc: enc.secure_enc, secure_fields: enc.secure_fields };
    expect(decodeRow(row, box).secure).toEqual({ passport_series: '4510', passport_number: '123456' });
    expect(decodeRow(row, box).plain.middle_name).toBeNull();
  });
  test('пустой паспорт — без шифротекста', () => {
    expect(encodeSecure({}, box)).toEqual({ secure_enc: null, secure_fields: [] });
    expect(decodeRow(null, box)).toBeNull();
  });
  test('maskPassport', () => {
    expect(maskPassport({ passport_series: '4510', passport_number: '123456' })).toBe('45** ****56');
    expect(maskPassport({ passport_number: '123456' })).toBe('****56');
    expect(maskPassport({})).toBe('');
  });
});

describe('prefillFrom', () => {
  test('раздельные поля YClients главнее строки name; пол по sex_id; номер договора', () => {
    const r = prefillFrom({
      name: 'Иванова Анна Сергеевна', phone: '+79001234567', email: '', birthday_iso: '1983-03-21',
      yclients_data: { surname: 'иванова', name: 'анна', patronymic: 'сергеевна', sex_id: 2, custom_fields: { 'nomer-dogovra': 1739 } },
    }, null);
    expect(r.plain).toEqual({ last_name: 'Иванова', first_name: 'Анна', middle_name: 'Сергеевна', birth_date: '1983-03-21', gender: 'F', phone: '79001234567', email: null, contract_no: '1739', contract_date: null });
    expect(r.confident).toBe(true);
    expect(r.notes).toEqual([]);
  });
  test('ФИО одной строкой без отчества — пометка «проверьте»', () => {
    const r = prefillFrom({ name: 'Айнур Алиева', phone: '79001234567', yclients_data: { sex_id: 0 } }, null);
    expect(r.confident).toBe(false);
    expect(r.notes[0]).toMatch(/проверьте/);
    expect(r.plain.gender).toBeNull();
  });
  test('паспорт из заявки на справку: пациент сам плательщик', () => {
    const r = prefillFrom({ name: 'Иванова Анна Сергеевна', phone: '79001234567', yclients_data: {} }, {
      payer_is_patient: true, payer_doc_type_code: '21', payer_doc_serie_number: '4510 123456', payer_doc_issue_date_iso: '2015-05-01',
      payer_birthdate_iso: '1983-03-21', created_date: '01.10.2026',
    });
    expect(r.secure).toEqual({ passport_series: '4510', passport_number: '123456', issue_date: '2015-05-01' });
    expect(r.plain.birth_date).toBe('1983-03-21');
    expect(r.notes.join(' ')).toMatch(/заявки на справку от 01\.10\.2026/);
  });
  test('свидетельство о рождении (не паспорт) не подставляется', () => {
    const r = prefillFrom({ name: 'X', phone: '', yclients_data: {} }, {
      payer_is_patient: false, patient_doc_type_code: '03', patient_doc_serie_number: 'IVМЮ123456',
    });
    expect(r.secure).toEqual({});
  });
});

describe('fromRecognized', () => {
  const { fromRecognized } = require('./services/edocs/identity');
  test('поля распознавания паспорта РФ → форма', () => {
    const r = fromRecognized({
      confidence: true, doc_type: 'rus.passport.national',
      fields: {
        surname_nat: { value: 'ИВАНОВА' }, given_name_nat: { value: 'АННА' }, patronymic_nat: { value: 'СЕРГЕЕВНА' },
        birth_date: { value: '1983-03-21' }, sex: { value: 'F' }, document_series: { value: '45 10' }, document_number: { value: '123456' },
        issue_date: { value: '2015-05-01' }, authority_nat: { value: 'ОВД ТВЕРСКОЙ Г. МОСКВЫ' }, authority_code: { value: '770-001' },
        birth_place_nat: { value: 'Г. МОСКВА' }, address: { locality: 'г. Москва', street: 'ул. Ленина', house: '1', apartment: '5', area: null },
      },
      spoofing_reasons: [{ kind: 'screen_photo', fields: [] }],
    });
    expect(r).toEqual({
      plain: { last_name: 'Иванова', first_name: 'Анна', middle_name: 'Сергеевна', birth_date: '1983-03-21', gender: 'F' },
      secure: { passport_series: '4510', passport_number: '123456', issue_date: '2015-05-01', issued_by: 'ОВД ТВЕРСКОЙ Г. МОСКВЫ', authority_code: '770-001', birth_place: 'Г. МОСКВА', address: 'г. Москва, ул. Ленина, д. 1, кв. 5' },
      confidence: true, spoofing: ['screen_photo'],
    });
  });
  test('пустой или кривой ответ — пустые поля', () => {
    expect(fromRecognized(null)).toEqual({ plain: {}, secure: {}, confidence: false, spoofing: [] });
    expect(fromRecognized({ fields: { document_number: { value: '12' }, birth_date: { value: '21.03.1983' } } }).secure).toEqual({});
  });
});
