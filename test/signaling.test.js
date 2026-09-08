'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { server, sessionKey } = require('../server/server');

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function next(ws, wantedType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${wantedType}`)), 1000);
    const handler = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== wantedType) return;
      clearTimeout(timeout);
      ws.off('message', handler);
      resolve(message);
    };
    ws.on('message', handler);
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    require('node:http').get(`http://127.0.0.1:${port}${pathname}`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

test('routes four independent slots and refuses a second publisher', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  for (let slot = 1; slot <= 4; slot += 1) assert.equal((await get(port, `/output/${slot}`)).status, 200);
  assert.equal((await get(port, '/output/5')).status, 404);
  const session = await get(port, '/session');
  assert.equal(session.status, 200);
  assert.equal(JSON.parse(session.body).key, sessionKey);
  const publisher = await open(`ws://127.0.0.1:${port}/ws?role=publisher&key=${sessionKey}`);
  const secondPublisher = await open(`ws://127.0.0.1:${port}/ws?role=publisher&key=${sessionKey}`);
  const rejected = new Promise((resolve) => secondPublisher.once('close', (code) => resolve(code)));
  assert.equal(await rejected, 4001);

  const viewers = [];
  for (let slot = 1; slot <= 4; slot += 1) {
    const viewerId = `viewer-${slot}`;
    const viewer = await open(`ws://127.0.0.1:${port}/ws?role=viewer&slot=${slot}&viewerId=${viewerId}&key=${sessionKey}`);
    viewers.push(viewer);

    const offerReceived = next(publisher, 'offer');
    viewer.send(JSON.stringify({ type: 'offer', sdp: { type: 'offer', sdp: `offer-${slot}` } }));
    const offer = await offerReceived;
    assert.equal(offer.viewerId, viewerId);
    assert.equal(offer.slot, String(slot));

    const answerReceived = next(viewer, 'answer');
    publisher.send(JSON.stringify({ type: 'answer', viewerId, slot: String(slot), sdp: { type: 'answer', sdp: `answer-${slot}` } }));
    assert.equal((await answerReceived).sdp.sdp, `answer-${slot}`);

    const selectionReceived = next(viewer, 'selection');
    publisher.send(JSON.stringify({ type: 'selection', slot: String(slot), peerId: `peer-${slot}` }));
    assert.equal((await selectionReceived).peerId, `peer-${slot}`);
  }

  const closePromises = [publisher, ...viewers].map((ws) => new Promise((resolve) => ws.once('close', resolve)));
  publisher.close();
  viewers.forEach((viewer) => viewer.close());
  await Promise.all(closePromises);
  await new Promise((resolve) => server.close(resolve));
});
