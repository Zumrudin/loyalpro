const crypto = require('crypto');
const config = require('../config');
const { db, withTransaction } = require('../db');

const MAX_OTP_ATTEMPTS = 5;
const DEFAULT_REQUEST_LIMIT = 5;
const DEFAULT_REQUEST_WINDOW_MINUTES = 15;

function mobileAuthConfig() {
  const salonId = Number(config.MOBILE_AUTH?.salonId);
  const otpHashKey = config.MOBILE_AUTH?.otpHashKey || '';
  if (!Number.isInteger(salonId) || salonId <= 0 || otpHashKey.length < 32) {
    const error = new Error('Mobile authentication is not configured');
    error.code = 'MOBILE_AUTH_NOT_CONFIGURED';
    throw error;
  }
  return { salonId, otpHashKey };
}

function configuredSalonId() {
  return mobileAuthConfig().salonId;
}

function normalizePhone(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `7${digits}`;
  if (digits.length !== 11) return null;
  if (digits[0] === '8') return `7${digits.slice(1)}`;
  return digits[0] === '7' ? digits : null;
}

async function findClientByPhone(phone, salonId, executor = db) {
  const normalized = normalizePhone(phone);
  if (!normalized || !Number.isInteger(Number(salonId)) || Number(salonId) <= 0) {
    return { status: 'not_found', client: null };
  }
  const result = await executor.query(
    `SELECT id,yclients_client_id,phone,name,email FROM (
       SELECT id,salon_id,yclients_client_id,phone,name,email,
              regexp_replace(COALESCE(phone,''),'[^0-9]','','g') AS phone_digits
       FROM clients WHERE salon_id=$1
     ) normalized_clients
     WHERE (char_length(phone_digits)=10 AND phone_digits=right($2,10))
        OR (char_length(phone_digits)=11 AND left(phone_digits,1) IN ('7','8')
            AND right(phone_digits,10)=right($2,10))
     LIMIT 2`,
    [Number(salonId), normalized]
  );
  if (result.rows.length > 1) return { status: 'ambiguous', client: null };
  if (!result.rows[0]) return { status: 'not_found', client: null };
  return { status: 'ok', client: result.rows[0] };
}

function hashOtp(phone, otp, salonId, key) {
  return crypto.createHmac('sha256', key).update(`${salonId}:${phone}:${otp}`).digest('hex');
}

async function consumeRequestAllowance(executor, salonId, phone) {
  const requestLimit = Number(config.MOBILE_AUTH?.requestLimit) || DEFAULT_REQUEST_LIMIT;
  const windowMinutes = Number(config.MOBILE_AUTH?.requestWindowMinutes) || DEFAULT_REQUEST_WINDOW_MINUTES;
  const result = await executor.query(
    `INSERT INTO mobile_otp_request_limits
       (salon_id,phone,window_started_at,request_count,updated_at)
     VALUES ($1,$2,NOW(),1,NOW())
     ON CONFLICT (salon_id,phone) DO UPDATE SET
       window_started_at=CASE
         WHEN mobile_otp_request_limits.window_started_at<=NOW()-($3*INTERVAL '1 minute')
         THEN NOW() ELSE mobile_otp_request_limits.window_started_at END,
       request_count=CASE
         WHEN mobile_otp_request_limits.window_started_at<=NOW()-($3*INTERVAL '1 minute')
         THEN 1 ELSE mobile_otp_request_limits.request_count+1 END,
       updated_at=NOW()
     RETURNING request_count`,
    [salonId, phone, windowMinutes]
  );
  return result.rows[0].request_count <= requestLimit;
}

async function issueOtp({ phone, salonId }) {
  const settings = mobileAuthConfig();
  if (Number(salonId) !== settings.salonId) {
    const error = new Error('Mobile salon mismatch');
    error.code = 'MOBILE_SALON_MISMATCH';
    throw error;
  }
  const normalized = normalizePhone(phone);
  if (!normalized) return { issued: false, reason: 'invalid_phone' };

  return withTransaction(async executor => {
    if (!await consumeRequestAllowance(executor, settings.salonId, normalized)) {
      return { issued: false, reason: 'rate_limited' };
    }

    const match = await findClientByPhone(normalized, settings.salonId, executor);
    if (match.status !== 'ok') return { issued: false, reason: match.status };

    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = hashOtp(normalized, otp, settings.salonId, settings.otpHashKey);
    const stored = await executor.query(
      `INSERT INTO mobile_otp_sessions
         (phone,salon_id,client_id,otp,otp_hash,attempts,created_at,expires_at,consumed_at)
       VALUES ($1,$2,$3,NULL,$4,0,NOW(),NOW()+INTERVAL '5 minutes',NULL)
       ON CONFLICT (phone) DO UPDATE SET
         salon_id=EXCLUDED.salon_id,
         client_id=EXCLUDED.client_id,
         otp=NULL,
         otp_hash=EXCLUDED.otp_hash,
         attempts=0,
         created_at=NOW(),
         expires_at=NOW()+INTERVAL '5 minutes',
         consumed_at=NULL
       WHERE mobile_otp_sessions.salon_id=$2 OR mobile_otp_sessions.salon_id IS NULL
       RETURNING client_id`,
      [normalized, settings.salonId, match.client.id, otpHash]
    );
    if (!stored.rows[0]) {
      const error = new Error('OTP tenant conflict');
      error.code = 'MOBILE_OTP_TENANT_CONFLICT';
      throw error;
    }
    return { issued: true, otp, client: match.client };
  });
}

async function consumeOtp({ phone, otp, salonId }, executor = db) {
  const settings = mobileAuthConfig();
  const normalized = normalizePhone(phone);
  if (!normalized || Number(salonId) !== settings.salonId || !/^\d{6}$/.test(String(otp || ''))) {
    return null;
  }
  const candidateHash = hashOtp(normalized, String(otp), settings.salonId, settings.otpHashKey);
  const result = await executor.query(
    `UPDATE mobile_otp_sessions
     SET attempts=attempts+1,
         consumed_at=CASE WHEN otp_hash=$2 THEN NOW() ELSE consumed_at END
     WHERE phone=$1 AND salon_id=$3
       AND otp_hash IS NOT NULL AND client_id IS NOT NULL
       AND expires_at>NOW() AND consumed_at IS NULL AND attempts<$4
     RETURNING client_id,consumed_at`,
    [normalized, candidateHash, settings.salonId, MAX_OTP_ATTEMPTS]
  );
  const row = result.rows[0];
  return row?.consumed_at ? row.client_id : null;
}

async function invalidateOtp(executor, salonId, phone) {
  await executor.query(
    `UPDATE mobile_otp_sessions
     SET otp=NULL,otp_hash=NULL,consumed_at=NOW()
     WHERE phone=$1 AND (salon_id=$2 OR salon_id IS NULL)`,
    [phone, salonId]
  );
}

module.exports = {
  MAX_OTP_ATTEMPTS,
  mobileAuthConfig,
  configuredSalonId,
  normalizePhone,
  findClientByPhone,
  issueOtp,
  consumeOtp,
  invalidateOtp,
};
