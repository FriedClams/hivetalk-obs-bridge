'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('OBS output renders a camera-off participant card and restricts avatar URLs', () => {
  const elements = new Map();
  for (const id of ['media', 'status', 'placeholder', 'avatar', 'initials', 'participant-name']) {
    elements.set(id, { hidden: false, textContent: '', src: '', removeAttribute(name) { if (name === 'src') this.src = ''; } });
  }
  const document = { getElementById(id) { return elements.get(id); } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'output.js'), 'utf8');
  const helpers = source.split('async function connectSocket')[0] + '\nthis.helpers = { allowedAvatarUrl, showPlaceholder, hidePlaceholder };';
  const context = { document, location: { pathname: '/output/1' }, crypto: { randomUUID: () => 'viewer-test' }, URL };
  vm.runInNewContext(helpers, context);

  context.helpers.showPlaceholder({ name: 'Nostr Guest', avatarSrc: 'https://images.example/avatar.jpg' });
  assert.equal(elements.get('participant-name').textContent, 'Nostr Guest');
  assert.equal(elements.get('initials').textContent, 'NG');
  assert.equal(elements.get('placeholder').hidden, false);
  assert.equal(elements.get('media').hidden, true);
  assert.equal(context.helpers.allowedAvatarUrl('javascript:alert(1)'), '');
  assert.equal(context.helpers.allowedAvatarUrl('http://insecure.example/avatar.jpg'), '');
});
