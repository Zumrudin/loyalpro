'use strict';
const { mockClient } = require('aws-sdk-client-mock');
const { S3Client, PutObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');

// Подменяем S3Client глобально ДО require пайплайна
const s3Mock = mockClient(S3Client);

describe('uploadPhoto pipeline', () => {
  let svc;
  beforeAll(async () => {
    svc = require('./services/patient-portfolio');
  });
  beforeEach(() => { s3Mock.reset(); });

  async function makeJpeg(width=2000, height=1500) {
    return sharp({ create: { width, height, channels: 3, background: '#888' } })
      .jpeg().toBuffer();
  }

  test('генерирует 3 варианта и кладёт в S3', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const buf = await makeJpeg();
    const result = await svc.processAndUpload({
      salonId: 1, clientId: 42, visitId: 7, photoId: 100,
      buffer: buf, mimeType: 'image/jpeg',
    });
    const puts = s3Mock.commandCalls(PutObjectCommand);
    expect(puts).toHaveLength(3);
    const keys = puts.map(c => c.args[0].input.Key).sort();
    expect(keys).toEqual([
      'salon_1/client_42/visit_7/100_med.jpg',
      'salon_1/client_42/visit_7/100_orig.jpg',
      'salon_1/client_42/visit_7/100_thumb.jpg',
    ]);
    expect(result).toMatchObject({
      s3_key_original: 'salon_1/client_42/visit_7/100_orig.jpg',
      s3_key_medium:   'salon_1/client_42/visit_7/100_med.jpg',
      s3_key_thumb:    'salon_1/client_42/visit_7/100_thumb.jpg',
      width: 2000, height: 1500, mime_type: 'image/jpeg',
    });
    expect(result.size_bytes).toBeGreaterThan(0);
  });

  test('откатывает уже загруженные при сбое одного из PUT', async () => {
    // Первый PUT успешен, второй падает
    s3Mock.on(PutObjectCommand)
      .resolvesOnce({})
      .rejectsOnce(new Error('S3 down'))
      .resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({ Deleted: [] });
    const buf = await makeJpeg(800, 600);

    await expect(svc.processAndUpload({
      salonId: 1, clientId: 42, visitId: 7, photoId: 101,
      buffer: buf, mimeType: 'image/jpeg',
    })).rejects.toThrow();

    // Должна быть попытка batch-delete уже загруженных
    const dels = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(dels.length).toBeGreaterThanOrEqual(1);
  });

  test('снимает EXIF', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    // Соберём JPEG с фейковым EXIF (через sharp.withMetadata())
    const withExif = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#fff' } })
      .withMetadata({ exif: { IFD0: { Software: 'TEST_EXIF_MARKER' } } })
      .jpeg().toBuffer();
    await svc.processAndUpload({
      salonId: 1, clientId: 1, visitId: 1, photoId: 200,
      buffer: withExif, mimeType: 'image/jpeg',
    });
    // Считываем то, что мы передали в PutObject для original
    const origPut = s3Mock.commandCalls(PutObjectCommand)
      .find(c => c.args[0].input.Key.endsWith('_orig.jpg'));
    const sentBody = origPut.args[0].input.Body;
    const meta = await sharp(sentBody).metadata();
    // EXIF блок должен отсутствовать
    expect(meta.exif).toBeUndefined();
  });

  test('бросает на не-картинку', async () => {
    await expect(svc.processAndUpload({
      salonId: 1, clientId: 1, visitId: 1, photoId: 300,
      buffer: Buffer.from('not an image'), mimeType: 'image/jpeg',
    })).rejects.toThrow();
  });
});
