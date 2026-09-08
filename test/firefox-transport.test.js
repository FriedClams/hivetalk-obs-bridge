'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Firefox content transport obtains a session key and relays both directions', async () => {
  let pageListener;
  let socket;
  let socketCount = 0;
  const pageMessages = [];

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) {
      socketCount += 1;
      assert.equal(url, 'ws://127.0.0.1:8766/ws?role=publisher&key=test-key');
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      this.sent = [];
      socket = this;
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() {}
    emit(type, value = {}) { this.listeners.get(type)?.(value); }
  }

  const window = {
    location: { origin: 'https://honey.hivetalk.org' },
    addEventListener(type, listener) { if (type === 'message') pageListener = listener; },
    postMessage(message) { pageMessages.push(message); }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content-transport.js'), 'utf8');
  const fetch = async (url) => {
    assert.equal(url, 'http://127.0.0.1:8766/session');
    return { ok: true, json: async () => ({ key: 'test-key' }) };
  };
  vm.runInNewContext(source, { window, WebSocket: FakeWebSocket, fetch, encodeURIComponent, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {} });

  pageListener({ source: window, data: { marker: 'hivetalk-obs-page-v1', payload: { type: 'publisher-ready' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socketCount, 1, 'startup and publisher-ready must not race into two publisher sockets');

  socket.readyState = FakeWebSocket.OPEN;
  socket.emit('open');
  assert.equal(pageMessages.at(-1).payload.connected, true);

  pageListener({ source: window, data: { marker: 'hivetalk-obs-page-v1', payload: { type: 'selection', slot: '4', peerId: 'peer-a' } } });
  assert.deepEqual(socket.sent.at(-1), { type: 'selection', slot: '4', peerId: 'peer-a' });

  socket.emit('message', { data: JSON.stringify({ type: 'offer', slot: '4' }) });
  assert.equal(pageMessages.at(-1).payload.type, 'offer');
});
