'use strict';
const fs = require('fs');

const backendFiles = ['middleware/auth.js', 'routes/index.js', 'routes/chat.js', 'routes/segments.js', 'routes/finance.js'];

test('staff authentication and reachable routes no longer accept query JWT', () => {
  for (const file of backendFiles) {
    expect(fs.readFileSync(`${__dirname}/${file}`, 'utf8')).not.toContain('authOrQuery');
  }
});

test('chat reconnect obtains a fresh ticket and export downloads use Bearer auth', () => {
  const chat = fs.readFileSync(`${__dirname}/../frontend/js/pages/chat.js`, 'utf8');
  expect(chat).toContain("api('POST', '/api/chat/stream-ticket')");
  expect(chat).toContain("new EventSource('/api/chat/stream?ticket='");
  expect(chat).toContain('stream.onerror');
  expect(chat).not.toContain('/api/chat/stream?token=');

  const segments = fs.readFileSync(`${__dirname}/../frontend/js/pages/segments.js`, 'utf8');
  expect(segments).toContain('URL.createObjectURL(await response.blob())');
  expect(segments).toContain("Authorization: 'Bearer ' + TOKEN");
  expect(segments).not.toContain('?token=');
});
