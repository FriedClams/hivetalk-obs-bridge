'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const HOST = '127.0.0.1';
const PORT = Number(process.env.HIVETALK_OBS_PORT || 8766);
const MAX_SLOTS = 4;
const MAX_MESSAGE_BYTES = 128 * 1024;
const publicDir = path.join(__dirname, 'public');
const sessionKey = crypto.randomBytes(24).toString('base64url');

function isOutputPath(pathname) {
  const match = pathname.match(/^\/output\/([1-4])$/);
  return match ? match[1] : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname === '/session') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': req.headers.origin && /^https:\/\/([^.]+\.)*hivetalk\.org$/.test(req.headers.origin) ? req.headers.origin : 'http://127.0.0.1:8766',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end(JSON.stringify({ key: sessionKey, maxSlots: MAX_SLOTS }));
  }
  const slot = isOutputPath(url.pathname);
  const file = url.pathname === '/' ? 'status.html' : slot ? 'output.html' : url.pathname.slice(1);
  if (!['status.html', 'output.html', 'output.js'].includes(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws://127.0.0.1:8766; style-src 'unsafe-inline'; media-src blob:; img-src 'self' https: data:"
  });
  fs.createReadStream(path.join(publicDir, file)).pipe(res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
let publisher = null;
const viewers = new Map();
const slotViewers = new Map();

function safeSend(ws, message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname !== '/ws' || url.searchParams.get('key') !== sessionKey) return socket.destroy();
  const role = url.searchParams.get('role');
  const slot = url.searchParams.get('slot') || '';
  const viewerId = url.searchParams.get('viewerId');
  if (role === 'publisher') {
    // Firefox may use either the page or moz-extension origin for a content
    // script WebSocket. The per-process session key is the publisher guard.
  } else if (role === 'viewer') {
    if (!/^[1-4]$/.test(slot) || !viewerId) return socket.destroy();
    if (req.headers.origin && req.headers.origin !== `http://${HOST}:${PORT}`) return socket.destroy();
  } else return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, { role, slot, viewerId }));
});

wss.on('connection', (ws, meta) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (meta.role === 'publisher') {
    if (publisher?.readyState === WebSocket.OPEN) {
      ws.close(4001, 'Another HiveTalk tab already controls the bridge');
      return;
    }
    publisher = ws;
    safeSend(ws, { type: 'bridge-status', connected: true });
    for (const viewer of viewers.values()) safeSend(viewer, { type: 'publisher-status', connected: true });
  } else {
    const previous = slotViewers.get(meta.slot);
    if (previous && previous !== ws) previous.close(4002, 'Replaced by refreshed OBS source');
    ws.viewerId = meta.viewerId;
    ws.slot = meta.slot;
    viewers.set(ws.viewerId, ws);
    slotViewers.set(ws.slot, ws);
    safeSend(ws, { type: 'publisher-status', connected: publisher?.readyState === WebSocket.OPEN });
  }

  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!message || typeof message.type !== 'string' || message.type === 'ping') return;
    if (meta.role === 'viewer') {
      safeSend(publisher, { ...message, viewerId: ws.viewerId, slot: ws.slot });
      return;
    }
    if (message.viewerId) {
      const viewer = viewers.get(message.viewerId);
      if (viewer?.slot === String(message.slot)) safeSend(viewer, message);
    }
    if (['selection', 'media-changed'].includes(message.type) && /^[1-4]$/.test(String(message.slot))) {
      const viewer = slotViewers.get(String(message.slot));
      safeSend(viewer, message);
    }
  });

  ws.on('close', () => {
    if (meta.role === 'publisher' && publisher === ws) {
      publisher = null;
      for (const viewer of viewers.values()) safeSend(viewer, { type: 'publisher-status', connected: false });
    }
    if (meta.role === 'viewer') {
      const wasCurrentSlotViewer = slotViewers.get(ws.slot) === ws;
      if (viewers.get(ws.viewerId) === ws) viewers.delete(ws.viewerId);
      if (wasCurrentSlotViewer) {
        slotViewers.delete(ws.slot);
        safeSend(publisher, { type: 'viewer-closed', viewerId: ws.viewerId, slot: ws.slot });
      }
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();

server.on('close', () => clearInterval(heartbeat));

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`HiveTalk OBS local bridge: http://${HOST}:${PORT}`);
    for (let slot = 1; slot <= MAX_SLOTS; slot += 1) console.log(`OBS Slot ${slot}:                 http://${HOST}:${PORT}/output/${slot}`);
  });
}

module.exports = { server, sessionKey, MAX_SLOTS };
