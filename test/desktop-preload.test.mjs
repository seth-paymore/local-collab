import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');

function setup(existing) {
  const messages = [], inserted = [], listeners = [];
  const button = { addEventListener: (...args) => listeners.push(args) };
  const header = { querySelector: () => 'instructions', insertBefore: (...args) => inserted.push(args) };
  vm.runInNewContext(source, {
    require: name => { assert.equal(name, 'electron'); return { ipcRenderer: { send: channel => messages.push(channel) } }; },
    window: { addEventListener: (event, callback) => { assert.equal(event, 'DOMContentLoaded'); callback(); } },
    document: { querySelector: selector => selector === '.topbar' ? header : existing ? button : null, createElement: () => button },
  });
  return { button, messages, inserted, listeners };
}

test('native Settings reuses the permanent page button and intercepts the browser-only dialog', () => {
  const f = setup(true);
  assert.equal(f.inserted.length, 0); assert.equal(f.listeners.length, 1);
  const [eventName, handler, options] = f.listeners[0];
  assert.equal(eventName, 'click'); assert.equal(options.capture, true);
  let stopped = false; handler({ stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, true); assert.deepEqual(f.messages, ['desktop:open-settings']);
});

test('native Settings stays available when connected to an older server without the permanent button', () => {
  const f = setup(false);
  assert.equal(f.inserted.length, 1); assert.equal(f.button.id, 'desktop-settings'); assert.equal(f.button.type, 'button');
  f.listeners[0][1]({ stopImmediatePropagation() {} });
  assert.deepEqual(f.messages, ['desktop:open-settings']);
});
