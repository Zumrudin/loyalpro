// frontend/js/pages/medical-cert-coords-transform.js
// Чистые функции преобразования координат бланка PDF (pt) ↔ экран (px).
// В браузере функции глобальные; в Node экспортируются для тестов.
'use strict';

// PDF: origin внизу-слева, y растёт вверх. drawText рисует от базовой линии.
// Маркер привязываем к базовой линии: top = (H - y)*scale - fontSize*scale.
function mcPtToScreen(field, ctx) {
  const fs = (field.fontSize || 11) * ctx.scale;
  return {
    left: field.x * ctx.scale,
    top: (ctx.pageHeightPt - field.y) * ctx.scale - fs,
  };
}

// Обратное к mcPtToScreen; возвращает целые pt.
function mcScreenToPt(left, top, fontSize, ctx) {
  return {
    x: Math.round(left / ctx.scale),
    y: Math.round(ctx.pageHeightPt - (top + (fontSize || 11) * ctx.scale) / ctx.scale),
  };
}

// Образцовое содержимое для отрисовки «следа» поля.
const MC_SAMPLES = {
  cert_number: '6', correction_number: '0', report_year: '2025',
  org_name: 'ООО КЛИНИКА ЭСТЕТИЧЕСКОЙ МЕДИЦИНЫ', org_inn: '972406039200', org_kpp: '772401001',
  payer_last: 'АГАФОНОВ', payer_first: 'АРТЕМ', payer_middle: 'ЭДУАРДОВИЧ',
  payer_inn: '583605353756', payer_birthdate: '08051989',
  doc_type_code: '21', doc_serie_number: '5608852813', doc_issue_date: '02062009',
  payer_is_patient: '1', amount1_rub: '82203', amount1_kop: '00',
  amount2_rub: '0', amount2_kop: '00',
  signer_last: 'ГАДЖИЕВА', signer_first: 'ПЕРИ', signer_middle: 'ИСАМУДИНОВНА',
  sign_date: '13012026', pages_count: '2',
  patient_last: 'АГАФОНОВ', patient_first: 'АРТЕМ', patient_middle: 'ЭДУАРДОВИЧ',
  patient_inn: '583605353756', patient_birthdate: '08051989',
  patient_doc_type: '21', patient_doc_serie: '5608852813', patient_doc_date: '02062009',
};

function mcSampleFor(name, field) {
  if (MC_SAMPLES[name] != null) return MC_SAMPLES[name];
  if (field && field.type === 'cells') return '1'.repeat(field.max || 4);
  return name;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mcPtToScreen, mcScreenToPt, mcSampleFor };
}
