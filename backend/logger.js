const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logsDir = path.join(__dirname, 'logs');

const lineFormat = printf(({ level, message, timestamp, module, stack }) => {
  const mod = module ? `[${module}]` : '';
  const msg = stack || message;
  return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${mod} ${msg}`;
});

const fileTransportOptions = (filename, level) => ({
  filename: path.join(logsDir, filename),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  level,
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    lineFormat
  ),
});

const sharedTransports = [
  new winston.transports.Console({
    format: combine(
      colorize({ level: true }),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      errors({ stack: true }),
      lineFormat
    ),
  }),
  new winston.transports.DailyRotateFile(fileTransportOptions('app-%DATE%.log', 'info')),
  new winston.transports.DailyRotateFile(fileTransportOptions('error-%DATE%.log', 'error')),
];

function createLogger(module) {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: { module },
    transports: sharedTransports,
  });
}

module.exports = { createLogger };
