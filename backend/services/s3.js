'use strict';
const { S3Client, PutObjectCommand, DeleteObjectsCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const cfg = require('../config');

const client = new S3Client({
  endpoint: cfg.S3_ENDPOINT,
  region: cfg.S3_REGION,
  credentials: { accessKeyId: cfg.S3_ACCESS_KEY, secretAccessKey: cfg.S3_SECRET_KEY },
  forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
});

async function putObject(key, body, contentType = 'image/jpeg') {
  await client.send(new PutObjectCommand({
    Bucket: cfg.S3_BUCKET, Key: key, Body: body, ContentType: contentType,
  }));
}

async function deleteObjects(keys) {
  if (!keys || keys.length === 0) return { deleted: [], errors: [] };
  const res = await client.send(new DeleteObjectsCommand({
    Bucket: cfg.S3_BUCKET,
    Delete: { Objects: keys.map(k => ({ Key: k })), Quiet: false },
  }));
  return { deleted: (res.Deleted || []).map(d => d.Key), errors: (res.Errors || []) };
}

async function presignGet(key, ttlSeconds = cfg.S3_URL_TTL_SECONDS) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: key }), { expiresIn: ttlSeconds });
}

module.exports = { client, putObject, deleteObjects, presignGet };
