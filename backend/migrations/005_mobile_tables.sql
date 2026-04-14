-- Mobile OTP Sessions
CREATE TABLE IF NOT EXISTS mobile_otp_sessions (
  phone VARCHAR(20) PRIMARY KEY,
  otp VARCHAR(4) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mobile_otp_sessions_expires_at
  ON mobile_otp_sessions(expires_at);

-- Mobile Sessions
CREATE TABLE IF NOT EXISTS mobile_sessions (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  token TEXT NOT NULL UNIQUE,
  phone VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mobile_sessions_client_id
  ON mobile_sessions(client_id);
CREATE INDEX IF NOT EXISTS idx_mobile_sessions_expires_at
  ON mobile_sessions(expires_at);

-- Mobile Notifications
CREATE TABLE IF NOT EXISTS mobile_notifications (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  title VARCHAR(255) NOT NULL,
  message TEXT,
  type VARCHAR(50), -- 'booking' | 'reminder' | 'promo' | 'bonus' | 'offer'
  read BOOLEAN DEFAULT FALSE,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mobile_notifications_client_id
  ON mobile_notifications(client_id);
CREATE INDEX IF NOT EXISTS idx_mobile_notifications_created_at
  ON mobile_notifications(created_at DESC);

-- Mobile FCM Tokens (for push notifications)
CREATE TABLE IF NOT EXISTS mobile_fcm_tokens (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL UNIQUE REFERENCES clients(id),
  token TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mobile_fcm_tokens_client_id
  ON mobile_fcm_tokens(client_id);
