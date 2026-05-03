require('dotenv').config({ path: __dirname + '/.env' });

module.exports = {
  apps: [
    {
      name: 'loyalpro',
      script: '/root/loyalpro/backend/server.js',
      cwd: '/root/loyalpro/backend',
      env: {
        ...process.env,
        TZ: 'Europe/Moscow'
      }
    },
    {
      name: 'otp-bot',
      script: '/root/loyalpro/backend/otp-bot-listener.js',
      cwd: '/root/loyalpro/backend',
      autorestart: true,
      max_memory_restart: '200M',
      env: {
        ...process.env,
        TZ: 'Europe/Moscow'
      }
    }
  ]
}
