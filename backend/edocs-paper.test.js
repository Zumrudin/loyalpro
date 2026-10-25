'use strict';
// «Подписано на бумаге» (services/edocs/paper.js).
jest.mock('./services/edocs/store', () => ({
  getClient: jest.fn(), getTemplatesByIds: jest.fn(), getRecord: jest.fn(), insertPackage: jest.fn(), logEvent: jest.fn(),
  getPackage: jest.fn(), revokePaperPackage: jest.fn(),
}));
jest.mock('./services/s3', () => ({ putObject: jest.fn(), presignGet: jest.fn() }));
const store = require('./services/edocs/store');
const s3 = require('./services/s3');
const paper = require('./services/edocs/paper');
const { todayMsk } = require('./utils/period');

const T_CONTRACT = { id: 5, kind: 'contract', title: 'Договор', is_active: true };
const T_CONSENT = { id: 6, kind: 'consent_pd', title: 'Согласие ПД', is_active: false };   // выключенный шаблон — отметить можно
const T_ACT = { id: 7, kind: 'act', title: 'Акт', is_active: true };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(32)]);
const PDF = Buffer.from('%PDF-1.7\n%…\n', 'latin1');

beforeEach(() => {
  jest.clearAllMocks();
  store.getClient.mockResolvedValue({ id: 52, name: 'Иванова Анна' });
  store.getTemplatesByIds.mockImplementation(async (sid, ids) => [T_CONTRACT, T_CONSENT, T_ACT].filter((t) => ids.includes(t.id)));
  store.getRecord.mockResolvedValue({ id: 100, client_id: 52, attendance: '1', deleted: false });
});

test('договор и согласие на бумаге со сканом PDF: комплект paper/paper, вид документов, скан в S3, журнал', async () => {
  const r = await paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5, 6], signedDate: '2026-07-03',
    note: ' подписано\nв клинике ', file: { buffer: PDF, originalname: 'scan.pdf' } });
  const [pkg, docs] = store.insertPackage.mock.calls[0];
  expect(pkg).toMatchObject({ id: r.packageId, salon_id: 1, client_id: 52, record_id: null, kind: 'onboarding', status: 'paper', source: 'paper',
    sent_by: 4, signed_at: '2026-07-03T12:00:00+03:00', title: 'На бумаге: Договор, Согласие ПД' });
  expect(pkg.payload.paper).toEqual({ signedDate: '2026-07-03', note: 'подписано в клинике',
    scan: { key: expect.stringMatching(new RegExp(`^edocs/1/paper/${r.packageId}/[0-9a-f-]{36}\\.pdf$`)), mime: 'application/pdf', size: PDF.length } });
  expect(docs.map((d) => [d.template_id, d.kind])).toEqual([[5, 'contract'], [6, 'consent_pd']]);
  expect(s3.putObject).toHaveBeenCalledWith(pkg.payload.paper.scan.key, PDF, 'application/pdf');
  expect(store.logEvent).toHaveBeenCalledWith({ salonId: 1, packageId: r.packageId, clientId: 52, kind: 'paper', userId: 4,
    payload: { templateIds: [5, 6], recordId: null, scan: true } });
});

test('без скана и даты — сегодняшняя дата, S3 не трогается', async () => {
  await paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5] });
  const [pkg] = store.insertPackage.mock.calls[0];
  expect(pkg.payload.paper).toEqual({ signedDate: todayMsk(), note: '', scan: null });
  expect(s3.putObject).not.toHaveBeenCalled();
});

test('скан — по содержимому: PNG с расширением .png проходит, «PNG» с .pdf и чужой файл — нет', async () => {
  await paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5], file: { buffer: PNG, originalname: 'photo.png' } });
  expect(s3.putObject.mock.calls[0][2]).toBe('image/png');
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5], file: { buffer: PNG, originalname: 'photo.jpg' } }))
    .rejects.toMatchObject({ code: 'bad_scan', status: 400 });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5], file: { buffer: Buffer.from('<html>…</html>'), originalname: 'x.html' } }))
    .rejects.toMatchObject({ code: 'bad_scan' });
  expect(store.insertPackage).toHaveBeenCalledTimes(1);
});

test('акт на бумаге — только по состоявшемуся визиту этого пациента', async () => {
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [7] })).rejects.toMatchObject({ code: 'act_needs_record' });
  store.getRecord.mockResolvedValueOnce({ id: 100, client_id: 99, attendance: '1' });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [7], recordId: 100 })).rejects.toMatchObject({ code: 'not_found' });
  store.getRecord.mockResolvedValueOnce({ id: 100, client_id: 52, attendance: '0' });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [7], recordId: 100 })).rejects.toMatchObject({ code: 'act_visit_not_done' });
  await paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [7], recordId: 100 });
  expect(store.insertPackage.mock.calls[0][0]).toMatchObject({ kind: 'act', record_id: 100 });
});

test('проверки: пациент, шаблоны, дата из будущего', async () => {
  store.getClient.mockResolvedValueOnce(null);
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5] })).rejects.toMatchObject({ code: 'not_found', status: 404 });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [] })).rejects.toMatchObject({ code: 'bad_templates' });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [999] })).rejects.toMatchObject({ code: 'bad_templates' });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5], signedDate: '2099-01-01' })).rejects.toMatchObject({ code: 'bad_date' });
});

test('снять отметку: только бумажный комплект, с причиной, в журнал', async () => {
  await expect(paper.revokePaper({ salonId: 1, userId: 4, packageId: 'p', reason: '' })).rejects.toMatchObject({ code: 'bad_reason' });
  store.getPackage.mockResolvedValueOnce({ id: 'p', client_id: 52, status: 'signed', source: 'manual' });
  await expect(paper.revokePaper({ salonId: 1, userId: 4, packageId: 'p', reason: 'ошиблись пациентом' })).rejects.toMatchObject({ code: 'bad_status' });
  store.getPackage.mockResolvedValueOnce({ id: 'p', client_id: 52, status: 'paper', source: 'paper' });
  store.revokePaperPackage.mockResolvedValueOnce(true);
  expect(await paper.revokePaper({ salonId: 1, userId: 4, packageId: 'p', reason: 'ошиблись пациентом' })).toEqual({ ok: true });
  expect(store.logEvent).toHaveBeenCalledWith({ salonId: 1, packageId: 'p', clientId: 52, kind: 'paper_revoke', userId: 4, payload: { reason: 'ошиблись пациентом' } });
});

test('ссылка на скан — presigned на 15 минут; скана нет — 404', async () => {
  store.getPackage.mockResolvedValueOnce({ id: 'p', payload: { paper: { scan: { key: 'edocs/1/paper/p/x.pdf' } } } });
  s3.presignGet.mockResolvedValueOnce('https://s3/x');
  expect(await paper.scanUrl({ salonId: 1, packageId: 'p' })).toEqual({ url: 'https://s3/x' });
  expect(s3.presignGet).toHaveBeenCalledWith('edocs/1/paper/p/x.pdf', 900);
  store.getPackage.mockResolvedValueOnce({ id: 'p', payload: {} });
  await expect(paper.scanUrl({ salonId: 1, packageId: 'p' })).rejects.toMatchObject({ code: 'not_found' });
});
