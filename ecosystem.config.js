module.exports = {
  apps: [{
    name: 'loyalpro',
    script: '/var/www/loyalpro/backend/server.js',
    cwd: '/var/www/loyalpro/backend',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      DATABASE_URL: 'postgresql://loyalpro:1!Nky8A4T*bY@googugiherie.beget.app:5432/loyalpro',
      DB_SSL: 'true',
      JWT_SECRET: '8c9abeb04b7f3743183191c748a0b554eabd40ec02827f538d7a2ff8729ebbf1ba5054eeb8882d6c7eb4d89311dd598a0e0dbff9d5ce3685ded93f2231da2449',
      FRONTEND_URL: 'http://217.114.0.254:3001',
      TZ: 'Europe/Moscow'
    }
  }]
}
