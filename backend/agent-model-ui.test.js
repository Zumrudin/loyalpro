'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function setup(role = 'admin') {
  const elements = new Map();
  function element(tag) {
    return { tag, children: [], style: {}, value: '', disabled: false, textContent: '',
      setAttribute: jest.fn(), focus: jest.fn(),
      appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); },
      append(...children) { children.forEach(c => this.appendChild(c)); },
      replaceChildren() { this.children = []; },
      remove() { elements.delete(this.id); },
    };
  }
  for (const id of ['agent-model-current', 'agent-model-select', 'agent-model-save']) elements.set(id, element('div'));
  const context = vm.createContext({ document: { getElementById: id => elements.get(id), createElement: element,
    body: element('body'), querySelector: () => null }, ME: { role },
    api: jest.fn(), notify: jest.fn(), navTo: jest.fn(), navStg: jest.fn() });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js/pages/agent-model.js'), 'utf8'), context);
  return { context, elements };
}
const state = { active: 'claude', revision: '2', health: 'ok', model: 'Claude Sonnet', channel: 'Subscription',
  choices: [{ id: 'gpt', title: 'GPT', channel: 'ChatGPT' }, { id: 'claude', title: 'Claude', channel: 'Subscription' }],
  notice: { revision: '2', fromTitle: 'GPT', toTitle: 'Claude', reason: 'Model failed', at: '2026-09-27T12:00:00Z' } };
test('settings display current model/channel and send selected model with revision', async () => {
  const { context: c, elements } = setup(); c.api.mockResolvedValue(state);
  await c.loadAgentModel();
  expect(elements.get('agent-model-current').textContent).toContain('Claude Sonnet · Subscription · Работает');
  elements.get('agent-model-select').value = 'gpt'; await c.saveAgentModel();
  expect(c.api).toHaveBeenCalledWith('PUT', '/api/agent/model', { active: 'gpt', revision: '2' });
});
test('failed load disables applying stale selection', async () => {
  const { context: c, elements } = setup(); c.api.mockRejectedValue(new Error());
  await c.loadAgentModel(); await c.saveAgentModel();
  expect(elements.get('agent-model-save').disabled).toBe(true); expect(c.api).toHaveBeenCalledTimes(1);
});
test.each(['owner', 'admin'])('notice at %s login is acknowledged only by explicit click', async role => {
  const { context: c, elements } = setup(role); c.api.mockResolvedValue(state);
  await c.checkAgentModelNotice();
  const modal = elements.get('agent-model-notice'); expect(modal).toBeDefined();
  expect(c.api).toHaveBeenCalledTimes(1);
  const button = modal.children[0].children.find(x => x.textContent === 'Понятно');
  await button.onclick();
  expect(c.api).toHaveBeenCalledWith('POST', '/api/agent/model/acknowledge', { revision: '2' });
  expect(elements.has('agent-model-notice')).toBe(false);
});
test('specialist never requests model state or sees notification', async () => {
  const { context: c, elements } = setup('specialist'); await c.checkAgentModelNotice();
  expect(c.api).not.toHaveBeenCalled(); expect(elements.has('agent-model-notice')).toBe(false);
});
test('ack failure retains visible notification and permits retry', async () => {
  const { context: c, elements } = setup(); c.api.mockResolvedValueOnce(state).mockRejectedValue(new Error());
  await c.checkAgentModelNotice();
  const modal = elements.get('agent-model-notice');
  const button = modal.children[0].children.find(x => x.textContent === 'Понятно'); await button.onclick();
  expect(elements.has('agent-model-notice')).toBe(true); expect(button.disabled).toBe(false);
});
test('a login response arriving after user changes does not expose notification', async () => {
  const { context: c, elements } = setup();
  c.api.mockImplementation(async () => { c.ME = { role: 'specialist' }; return state; });
  await c.checkAgentModelNotice(); expect(elements.has('agent-model-notice')).toBe(false);
});
