'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('panel mutations are ignored and HiveTalk scans are coalesced', () => {
  let observerCallback;
  const scanTimers = [];
  const panel = {
    nodeType: 1,
    id: '',
    style: {},
    isConnected: false,
    innerHTML: '',
    addEventListener() {},
    closest(selector) { return selector === '#hivetalk-obs-local-panel' ? this : null; }
  };
  const documentElement = {
    nodeType: 1,
    appendChild(element) { element.isConnected = true; },
    closest() { return null; }
  };
  const document = {
    documentElement,
    createElement() { return panel; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    addEventListener() {}
  };
  const window = {
    location: { origin: 'https://honey.hivetalk.org' },
    addEventListener() {},
    postMessage() {},
    setTimeout(callback) { scanTimers.push(callback); return scanTimers.length; },
    clearTimeout() {}
  };
  class MutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
  }
  class MediaStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'page-bridge.js'), 'utf8');
  vm.runInNewContext(source, {
    window,
    document,
    Node: { ELEMENT_NODE: 1 },
    MutationObserver,
    MediaStream,
    RTCPeerConnection: class {},
    setInterval() {},
    setTimeout,
    clearTimeout
  });

  observerCallback([{ target: panel }]);
  assert.equal(scanTimers.length, 0, 'the add-on must not react to its own panel');

  observerCallback([{ target: documentElement }]);
  observerCallback([{ target: documentElement }]);
  assert.equal(scanTimers.length, 1, 'multiple page changes should schedule only one scan');

  scanTimers.shift()();
  observerCallback([{ target: documentElement }]);
  assert.equal(scanTimers.length, 1, 'a later page change should schedule a new scan');
});

test('a live video without HiveTalk participant attributes remains selectable', () => {
  const panel = {
    nodeType: 1,
    id: '',
    style: {},
    isConnected: false,
    innerHTML: '',
    addEventListener() {},
    closest() { return null; }
  };
  const stream = {
    id: 'opaque-browser-stream-id',
    getTracks() { return [{ kind: 'video' }]; },
    getVideoTracks() { return [{ kind: 'video' }]; },
    getAudioTracks() { return []; }
  };
  const video = {
    srcObject: stream,
    dataset: {},
    getAttribute() { return null; },
    closest() { return null; }
  };
  const documentElement = {
    nodeType: 1,
    appendChild(element) { element.isConnected = true; },
    closest() { return null; }
  };
  const document = {
    documentElement,
    createElement() { return panel; },
    querySelectorAll(selector) { return selector === 'video' ? [video] : []; },
    getElementById() { return null; },
    addEventListener() {}
  };
  const window = {
    location: { origin: 'https://honey.hivetalk.org' },
    addEventListener() {},
    postMessage() {},
    requestAnimationFrame() {}
  };
  class MutationObserver { observe() {} }
  class MediaStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'page-bridge.js'), 'utf8');
  vm.runInNewContext(source, {
    window,
    document,
    Node: { ELEMENT_NODE: 1 },
    MutationObserver,
    MediaStream,
    RTCPeerConnection: class {},
    setInterval() {},
    setTimeout,
    clearTimeout,
    WeakMap
  });

  assert.match(panel.innerHTML, /Live video 1/);
  assert.match(panel.innerHTML, /Detected 1 remote participant/);
  assert.match(panel.innerHTML, /OBS Slot 4/);
  assert.match(panel.innerHTML, /\/output\/4/);
});

test('local preview is excluded and audio embedded in a remote video is reported', () => {
  const panel = { nodeType: 1, id: '', style: {}, isConnected: false, innerHTML: '', addEventListener() {}, closest() { return null; } };
  const track = (kind, id) => ({ kind, id, readyState: 'live', addEventListener() {}, getSettings() { return {}; } });
  const localStream = { id: 'local', getTracks() { return [track('video', 'local-v')]; }, getVideoTracks() { return this.getTracks(); }, getAudioTracks() { return []; } };
  const remoteTracks = [track('video', 'remote-v'), track('audio', 'remote-a')];
  const remoteStream = { id: 'opaque', getTracks() { return remoteTracks; }, getVideoTracks() { return [remoteTracks[0]]; }, getAudioTracks() { return [remoteTracks[1]]; } };
  const localVideo = { tagName: 'VIDEO', muted: true, volume: 0, classList: { contains: () => true }, srcObject: localStream, dataset: {}, getAttribute(name) { return name === 'name' ? 'local-peer' : null; }, closest() { return null; } };
  const remoteVideo = { tagName: 'VIDEO', muted: false, volume: 1, classList: { contains: () => false }, srcObject: remoteStream, dataset: {}, getAttribute() { return null; }, closest() { return null; } };
  const documentElement = { nodeType: 1, appendChild(element) { element.isConnected = true; }, closest() { return null; } };
  const document = {
    documentElement, createElement() { return panel; }, getElementById() { return null; }, addEventListener() {},
    querySelectorAll(selector) { return selector === 'video' ? [localVideo, remoteVideo] : []; }
  };
  const window = { location: { origin: 'https://honey.hivetalk.org' }, addEventListener() {}, postMessage() {}, requestAnimationFrame() {} };
  class MutationObserver { observe() {} }
  class MediaStream { constructor(tracks = []) { this.tracks = tracks; } getTracks() { return this.tracks; } }
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'page-bridge.js'), 'utf8');
  vm.runInNewContext(source, { window, document, Node: { ELEMENT_NODE: 1 }, MutationObserver, MediaStream, RTCPeerConnection: class {}, setInterval() {}, setTimeout, clearTimeout, WeakMap, WeakSet });
  assert.match(panel.innerHTML, /Live video 2 — video \+ audio/);
  assert.match(panel.innerHTML, /1 audio tracks/);
  assert.match(panel.innerHTML, /1 local excluded/);
  assert.doesNotMatch(panel.innerHTML, /local-peer/);
});

test('a remote participant remains selectable while the camera is off', () => {
  const panel = { nodeType: 1, id: '', style: {}, isConnected: false, innerHTML: '', addEventListener() {}, closest() { return null; } };
  const name = { textContent: 'Podcast Guest' };
  const avatar = { currentSrc: 'https://images.example/nostr-avatar.jpg' };
  const cameraOffTile = { id: 'peer-guest__videoOff', dataset: {}, closest() { return null; }, querySelector() { return avatar; } };
  const documentElement = { nodeType: 1, appendChild(element) { element.isConnected = true; }, closest() { return null; } };
  const document = {
    documentElement, activeElement: null, createElement() { return panel; }, addEventListener() {},
    getElementById(id) { return id === 'peer-guest__name' ? name : id === 'peer-guest__img' ? avatar : null; },
    querySelectorAll(selector) { return selector === '[id$="__videoOff"]' ? [cameraOffTile] : []; }
  };
  const window = {
    location: { origin: 'https://honey.hivetalk.org' }, addEventListener() {}, postMessage() {},
    setTimeout() {}, clearTimeout() {}, localStorage: { getItem() { return null; }, setItem() {} }
  };
  class MutationObserver { observe() {} }
  class MediaStream { constructor(tracks = []) { this.tracks = tracks; } getTracks() { return this.tracks; } }
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'page-bridge.js'), 'utf8');
  vm.runInNewContext(source, { window, document, Node: { ELEMENT_NODE: 1 }, MutationObserver, MediaStream, RTCPeerConnection: class {}, setInterval() {}, setTimeout, clearTimeout, WeakMap, WeakSet });
  assert.match(panel.innerHTML, /Podcast Guest — camera off/);
  assert.match(panel.innerHTML, /Detected 1 remote participant/);
  assert.match(panel.innerHTML, /1 camera off/);
});
