'use strict';

const video = document.getElementById('media');
const status = document.getElementById('status');
const placeholder = document.getElementById('placeholder');
const avatar = document.getElementById('avatar');
const initials = document.getElementById('initials');
const participantName = document.getElementById('participant-name');
const slot = location.pathname.match(/^\/output\/([1-4])$/)?.[1];
const viewerId = crypto.randomUUID();
let sessionKey = '';
let socket;
let pc;
let socketRetryTimer;
let peerRetryTimer;
let statsTimer;
let reconnectAttempt = 0;
let peerReconnectAttempt = 0;
let connectionGeneration = 0;
let socketGeneration = 0;
let connectingSocket = false;
let activeOfferId = '';
let previousVideoBytes = 0;
let previousVideoTimestamp = 0;

function setStatus(text) { status.textContent = text; status.hidden = !text; }

function initialsFor(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || '?';
}

function allowedAvatarUrl(value) {
  if (!value) return '';
  if (/^data:image\//i.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch (_) { return ''; }
}

function showPlaceholder(peer) {
  const name = peer?.name || 'Participant';
  const avatarUrl = allowedAvatarUrl(peer?.avatarSrc);
  participantName.textContent = name;
  initials.textContent = initialsFor(name);
  initials.hidden = false;
  avatar.hidden = true;
  avatar.removeAttribute('src');
  if (avatarUrl) {
    avatar.onload = () => { if (avatar.src === avatarUrl) { avatar.hidden = false; initials.hidden = true; } };
    avatar.onerror = () => { avatar.hidden = true; initials.hidden = false; };
    avatar.src = avatarUrl;
  }
  video.hidden = true;
  placeholder.hidden = false;
}

function hidePlaceholder() {
  placeholder.hidden = true;
  video.hidden = false;
}

async function connectSocket() {
  if (!slot) return setStatus('Invalid OBS slot URL. Use /output/1 through /output/4.');
  if (connectingSocket || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  connectingSocket = true;
  const generation = ++socketGeneration;
  try {
    if (!sessionKey) {
      const response = await fetch('/session', { cache: 'no-store' });
      sessionKey = (await response.json()).key;
    }
    const connection = new WebSocket(`ws://127.0.0.1:8766/ws?role=viewer&slot=${slot}&viewerId=${encodeURIComponent(viewerId)}&key=${encodeURIComponent(sessionKey)}`);
    socket = connection;
  } catch (error) {
    connectingSocket = false;
    setStatus(`Local bridge error: ${error.message}. Retrying…`);
    return scheduleSocketReconnect();
  }
  const connection = socket;
  connectingSocket = false;
  connection.addEventListener('open', () => {
    if (socket !== connection || generation !== socketGeneration) return;
    reconnectAttempt = 0;
    clearTimeout(socketRetryTimer);
    safeRequestFeed();
  });
  connection.addEventListener('message', async (event) => {
    if (socket !== connection || generation !== socketGeneration) return;
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message.type === 'publisher-status') {
      if (message.connected) safeRequestFeed();
      else { closePeer(); setStatus('Waiting for the HiveTalk tab and extension…'); }
    }
    if (message.type === 'answer' && pc && message.offerId === activeOfferId) {
      try {
        await pc.setRemoteDescription(message.sdp);
        peerReconnectAttempt = 0;
        const hasVideo = message.tracks?.includes('video');
        if (!hasVideo && message.peer?.cameraOff) showPlaceholder(message.peer);
        else if (hasVideo) hidePlaceholder();
        setStatus(message.peer?.cameraOff || message.tracks?.length ? '' : `Slot ${slot}: ${message.peer?.name || 'participant'} is assigned — waiting for camera or microphone.`);
      } catch (error) { schedulePeerReconnect(`Answer failed: ${error.message}`); }
    }
    if (message.type === 'selection' || message.type === 'media-changed') safeRequestFeed();
    if (message.type === 'error') setStatus(`Bridge error: ${message.message}`);
  });
  connection.addEventListener('close', (event) => {
    if (socket !== connection || generation !== socketGeneration) return;
    closePeer();
    socket = null;
    if (event.code === 4002) return setStatus('This slot was opened by another OBS source. Close the duplicate source.');
    sessionKey = '';
    setStatus('Local bridge disconnected. Retrying…');
    scheduleSocketReconnect();
  });
  connection.addEventListener('error', () => connection.close());
}

function scheduleSocketReconnect() {
  clearTimeout(socketRetryTimer);
  const delay = Math.min(10000, 500 * (2 ** Math.min(reconnectAttempt++, 5)));
  socketRetryTimer = setTimeout(connectSocket, delay);
}

function closePeer() {
  connectionGeneration += 1;
  clearTimeout(peerRetryTimer);
  clearInterval(statsTimer);
  pc?.close();
  pc = null;
  if (video.srcObject) video.srcObject.getTracks().forEach((track) => track.stop());
  video.srcObject = null;
  previousVideoBytes = 0;
  previousVideoTimestamp = 0;
  activeOfferId = '';
  hidePlaceholder();
}

function safeRequestFeed() {
  requestFeed().catch((error) => schedulePeerReconnect(`WebRTC setup failed: ${error.message}`));
}

async function requestFeed() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  clearTimeout(peerRetryTimer);
  closePeer();
  const generation = connectionGeneration;
  const offerId = crypto.randomUUID();
  activeOfferId = offerId;
  const connection = new RTCPeerConnection({ iceServers: [] });
  const stream = new MediaStream();
  pc = connection;
  connection.addTransceiver('video', { direction: 'recvonly' });
  connection.addTransceiver('audio', { direction: 'recvonly' });
  connection.addEventListener('track', (event) => {
    if (pc !== connection) return;
    if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
    video.srcObject = stream;
    if (event.track.kind === 'video') hidePlaceholder();
    video.play().catch(() => {});
  });
  connection.addEventListener('connectionstatechange', () => {
    if (pc !== connection) return;
    sendStats().catch(() => {});
    if (connection.connectionState === 'failed') schedulePeerReconnect('WebRTC failed; reconnecting…', generation);
    if (connection.connectionState === 'disconnected') setTimeout(() => {
      if (pc === connection && connection.connectionState === 'disconnected') schedulePeerReconnect('WebRTC disconnected; reconnecting…', generation);
    }, 2500);
  });
  await connection.setLocalDescription(await connection.createOffer());
  await waitForIce(connection);
  if (pc !== connection) return;
  socket.send(JSON.stringify({ type: 'offer', offerId, sdp: { type: connection.localDescription.type, sdp: connection.localDescription.sdp } }));
  setStatus(`Waiting for Slot ${slot} selection…`);
  statsTimer = setInterval(() => sendStats().catch(() => {}), 2000);
}

function schedulePeerReconnect(message, generation = connectionGeneration) {
  if (generation !== connectionGeneration) return;
  setStatus(message);
  clearTimeout(peerRetryTimer);
  const delay = Math.min(10000, 500 * (2 ** Math.min(peerReconnectAttempt++, 5)));
  peerRetryTimer = setTimeout(safeRequestFeed, delay);
}

async function sendStats() {
  if (!pc || socket?.readyState !== WebSocket.OPEN) return;
  const reports = [...(await pc.getStats()).values()];
  const videoInbound = reports.find((report) => report.type === 'inbound-rtp' && report.kind === 'video' && !report.isRemote);
  const audioInbound = reports.find((report) => report.type === 'inbound-rtp' && report.kind === 'audio' && !report.isRemote);
  const codec = reports.find((report) => report.id === videoInbound?.codecId);
  let bitrate = 0;
  if (videoInbound && previousVideoTimestamp) {
    bitrate = Math.round(((videoInbound.bytesReceived - previousVideoBytes) * 8) / (videoInbound.timestamp - previousVideoTimestamp));
  }
  if (videoInbound) { previousVideoBytes = videoInbound.bytesReceived; previousVideoTimestamp = videoInbound.timestamp; }
  socket.send(JSON.stringify({ type: 'viewer-stats', stats: {
    state: pc.connectionState,
    resolution: videoInbound?.frameWidth && videoInbound?.frameHeight ? `${videoInbound.frameWidth}×${videoInbound.frameHeight}` : '',
    fps: Math.round(videoInbound?.framesPerSecond || 0) || '',
    codec: codec?.mimeType?.replace(/^video\//, '') || '',
    bitrate: bitrate || '',
    audio: Boolean(audioInbound)
  } }));
}

function waitForIce(connection) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000);
    connection.addEventListener('icegatheringstatechange', () => {
      if (connection.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); }
    });
  });
}

window.addEventListener('beforeunload', () => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'viewer-closing' }));
  socket?.close();
  clearTimeout(socketRetryTimer);
  clearTimeout(peerRetryTimer);
  closePeer();
}, { once: true });

connectSocket();
