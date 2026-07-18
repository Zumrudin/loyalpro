'use strict';
const aitunnel = require('./services/aitunnel');

describe('aitunnel.makeClient', () => {
  test('создаёт OpenAI-клиент с baseURL aitunnel и переданным ключом', () => {
    const c = aitunnel.makeClient('sk-aitunnel-test');
    expect(c.baseURL).toContain('api.aitunnel.ru/v1');
    expect(c.apiKey).toBe('sk-aitunnel-test');
  });

  test('без аргумента берёт ключ из config (пустой в тестах, но клиент создаётся)', () => {
    const c = aitunnel.makeClient();
    expect(c.baseURL).toContain('api.aitunnel.ru/v1');
  });
});
