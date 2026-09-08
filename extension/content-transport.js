'use strict';

const PAGE_MARKER = 'hivetalk-obs-page-v1';
const EXT_MARKER = 'hivetalk-obs-extension-v1';
const BASE = 'http://127.0.0.1:8766';
let socket;
let reconnectTimer;
let keepAliveTimer;
let reconnectAttempt = 0;
let sessionKey = '';
let connecting = false;

function tellPage(payload) {
  window.postMessage({ marker: EXT_MARKER, payload }, window.location.origin);
}

async function getSessionKey() {
  const response = await fetch(`${BASE}/session`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Bridge session request failed (${response.status})`);
  const session = await response.json();
  if (!session.key) throw new Error('Bridge returned no session key');
  sessionKey = session.key;
}

async function connect() {
  if (connecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  connecting = true;
  try {
    if (!sessionKey) await getSessionKey();
    socket = new WebSocket(`ws://127.0.0.1:8766/ws?role=publisher&key=${encodeURIComponent(sessionKey)}`);
  } catch (error) {
    connecting = false;
    tellPage({ type: 'bridge-status', connected: false, detail: error.message });
    scheduleReconnect();
    return;
  }
  connecting = false;
  socket.addEventListener('open', () => {
    reconnectAttempt = 0;
    tellPage({ type: 'bridge-status', connected: true });
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => send({ type: 'ping' }), 20000);
  });
  socket.addEventListener('message', (event) => {
    try { tellPage(JSON.parse(event.data)); } catch (_) {}
  });
  socket.addEventListener('close', (event) => {
    clearInterval(keepAliveTimer);
    socket = null;
    sessionKey = '';
    if (event.code === 4001) {
      tellPage({ type: 'bridge-status', connected: false, detail: 'Another HiveTalk tab already controls the OBS bridge.' });
    } else {
      tellPage({ type: 'bridge-status', connected: false, detail: 'Local connection closed; retrying…' });
    }
    scheduleReconnect();
  });
  socket.addEventListener('error', () => socket?.close());
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(10000, 500 * (2 ** Math.min(reconnectAttempt++, 5)));
  reconnectTimer = setTimeout(connect, delay);
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.marker !== PAGE_MARKER) return;
  if (event.data.payload?.type === 'publisher-ready') {
    tellPage({ type: 'bridge-status', connected: socket?.readyState === WebSocket.OPEN });
    connect();
    return;
  }
  send(event.data.payload);
});

connect();
