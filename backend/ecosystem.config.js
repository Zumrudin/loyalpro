require('dotenv').config({ path: __dirname + '/.env' });

module.exports = {
  apps: [{
    name: 'loyalpro',
    script: '/root/loyalpro/backend/server.js',
    cwd: '/root/loyalpro/backend',
    env: {
      ...process.env,
      TZ: 'Europe/Moscow'
    }
  }]
}
