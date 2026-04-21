# Logging System Design

## Summary

Winston-based structured logging for LoyalPro backend. Single central `logger.js` module, all existing `console.log/error/warn` replaced with named module loggers. Output: human-readable text to console + `logs/app.log` + `logs/error.log` with daily rotation, 14-day retention.

## Format

```
2026-04-20 14:32:11 [INFO]  [Sync] Records fetched: 1500
2026-04-20 14:32:12 [ERROR] [API]  /api/clients - Cannot read property of undefined
```

## Files

| File | Module label |
|------|-------------|
| `backend/logger.js` | — (new, central logger factory) |
| `backend/server.js` | `[Server]`, `[Cron]` |
| `backend/routes/api.js` | `[API]` |
| `backend/routes/salon.js` | `[Salon]` |
| `backend/routes/mobile-client.js` | `[Mobile]` |
| `backend/routes/webhook.js` | `[Webhook]` |
| `backend/services/loyalty.js` | `[Sync]` |
| `backend/services/yclients.js` | `[YClients]` |
| `backend/services/telegram.js` | `[Telegram]` |
| `backend/services/sms.js` | `[SMS]` |
| `backend/services/staff.js` | `[Staff]` |

## Transports

- **Console** — colorized, dev-friendly
- **`logs/app.log`** — all levels (info/warn/error), daily rotation, 14 days, max 20MB/file
- **`logs/error.log`** — errors only, same rotation

## Dependencies

- `winston` — core logger
- `winston-daily-rotate-file` — file rotation transport

## .gitignore

`logs/` directory must be added to `.gitignore`.
