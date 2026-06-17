// backend/services/medical-cert-pdf.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');
const { fillCertificate } = require('./medical-cert-pdf');

async function blankTwoPagePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

const coords = {
  fields: {
    org_inn:    { page: 0, type: 'cells', x: 100, y: 800, step: 12, max: 12, fontSize: 11 },
    payer_last: { page: 0, type: 'text',  x: 95,  y: 540, width: 440, lineHeight: 18, fontSize: 12 },
    payer_is_patient: { page: 0, type: 'checkbox', x: 470, y: 388, fontSize: 11 },
    patient_last: { page: 1, type: 'text', x: 95, y: 700, width: 440, lineHeight: 18, fontSize: 12 },
  },
};

test('fillCertificate возвращает валидный PDF, сохраняя страницы', async () => {
  const blank = await blankTwoPagePdf();
  const out = await fillCertificate({
    blank,
    coords,
    values: { org_inn: '972406039212', payer_last: 'АГАФОНОВ', payer_is_patient: '1', patient_last: '' },
  });
  assert.ok(Buffer.isBuffer(out));
  assert.strictEqual(out.subarray(0, 5).toString(), '%PDF-');
  const reload = await PDFDocument.load(out);
  assert.strictEqual(reload.getPageCount(), 2);
});

test('fillCertificate: неизвестное поле в values не валит генерацию', async () => {
  const blank = await blankTwoPagePdf();
  const out = await fillCertificate({ blank, coords, values: { not_a_field: 'X' } });
  assert.ok(Buffer.isBuffer(out));
});

test('fillCertificate: значение для несуществующей страницы пропускается', async () => {
  const blank = await blankTwoPagePdf();
  const badCoords = { fields: { x: { page: 9, type: 'text', x: 10, y: 10, width: 100, lineHeight: 12, fontSize: 10 } } };
  const out = await fillCertificate({ blank, coords: badCoords, values: { x: 'hi' } });
  assert.ok(Buffer.isBuffer(out));
});
