'use strict';

(() => {
  if (window.__hiveTalkObsLocalBridge) return;
  window.__hiveTalkObsLocalBridge = true;

  const PAGE_MARKER = 'hivetalk-obs-page-v1';
  const EXT_MARKER = 'hivetalk-obs-extension-v1';
  const MAX_SLOTS = 4;
  const PANEL_STORAGE_KEY = 'hivetalk-obs-panel-v1';
  const slots = new Map(Array.from({ length: MAX_SLOTS }, (_, index) => [String(index + 1), {
    selectedPeerId: '',
    pc: null,
    viewerId: '',
    mediaKey: '',
    peerPresent: false,
    stats: null,
    status: 'idle'
  }]));
  const state = {
    peers: new Map(),
    connected: false,
    connectionDetail: '',
    diagnostics: { videos: 0, audios: 0, cameraOff: 0, streams: 0, audioTracks: 0, localExcluded: 0 }
  };
  const anonymousMediaIds = new WeakMap();
  const watchedTracks = new WeakSet();
  let nextAnonymousMediaId = 1;
  let panel;
  let scanQueued = false;
  let scanTimer = null;
  let lastRenderKey = '';
  let panelCollapsed = false;
  let copiedSlot = '';
  let dragState = null;

  function send(payload) {
    window.postMessage({ marker: PAGE_MARKER, payload }, window.location.origin);
  }

  function cleanName(value) {
    return String(value || '').replace(/^⭐️\s*/, '').replace(/\s+\(me\)$/, '').trim();
  }

  function peerName(peerId, element, fallbackName) {
    const named = cleanName(document.getElementById(`${peerId}__name`)?.textContent);
    if (named) return named;
    const container = element?.closest?.('.Camera');
    const containerName = cleanName(container?.querySelector?.('[id$="__name"], .peer-name')?.textContent);
    return containerName || cleanName(element?.getAttribute?.('aria-label')) ||
      cleanName(element?.getAttribute?.('title')) || fallbackName || peerId.slice(0, 10);
  }

  function usableStream(element) {
    const stream = element?.srcObject;
    return stream && typeof stream.getTracks === 'function' ? stream : null;
  }

  function isLocalElement(element) {
    if (element?.dataset?.local === 'true') return true;
    if (element?.tagName?.toLowerCase() === 'video') {
      return element.muted === true && (element.volume === 0 || element.classList?.contains?.('mirror'));
    }
    const name = String(element?.getAttribute?.('name') || '');
    return element?.muted === true && /__localAudio$/.test(name);
  }

  function mediaIdentity(element, kind, ordinal) {
    const volumeId = element.getAttribute('volumeBar') || element.getAttribute('volumebar') || element.getAttribute('volume');
    const named = kind === 'video' ? element.getAttribute('name') : '';
    const explicit = volumeId?.replace(/___pVolume$/, '') || named;
    if (explicit) return { peerId: explicit, fallback: false };

    const streamId = String(element.srcObject?.id || '');
    const streamPeerId = streamId.replace(/-(?:mic-webcam|screen-sharing)$/, '');
    if (streamPeerId && streamPeerId !== streamId) return { peerId: streamPeerId, fallback: false };

    const namedElement = element.closest?.('.Camera')?.querySelector?.('[id$="__name"]');
    const namedPeerId = namedElement?.id?.replace(/__name$/, '');
    if (namedPeerId) return { peerId: namedPeerId, fallback: false };

    if (!anonymousMediaIds.has(element)) anonymousMediaIds.set(element, `anonymous-${kind}-${nextAnonymousMediaId++}`);
    return { peerId: anonymousMediaIds.get(element), fallback: true, ordinal };
  }

  function watchTrack(track) {
    if (!track || watchedTracks.has(track)) return;
    watchedTracks.add(track);
    track.addEventListener?.('ended', queuePeerScan, { once: true });
    track.addEventListener?.('unmute', queuePeerScan);
  }

  function readPeers() {
    const previousKeys = new Map([...slots].map(([slot, value]) => [slot, value.mediaKey]));
    const previousPresence = new Map([...slots].map(([slot, value]) => [slot, value.peerPresent]));
    const peers = new Map();
    const diagnostics = { videos: 0, audios: 0, cameraOff: 0, streams: 0, audioTracks: 0, localExcluded: 0 };
    const ensure = (peerId, element, fallbackName) => {
      if (!peers.has(peerId)) {
        peers.set(peerId, { peerId, name: peerName(peerId, element, fallbackName), camera: null, audio: null, screen: null, avatarSrc: '', cameraOff: false, anonymous: peerId.startsWith('anonymous-') });
      }
      return peers.get(peerId);
    };

    for (const video of document.querySelectorAll('video')) {
      diagnostics.videos += 1;
      const stream = usableStream(video);
      if (!stream) continue;
      diagnostics.streams += 1;
      diagnostics.audioTracks += stream.getAudioTracks?.().length || 0;
      if (isLocalElement(video)) { diagnostics.localExcluded += 1; continue; }
      stream.getTracks().forEach(watchTrack);
      const identity = mediaIdentity(video, 'video', diagnostics.videos);
      const peer = ensure(identity.peerId, video, identity.fallback ? `Live video ${identity.ordinal}` : undefined);
      const isScreen = /-screen-sharing$/.test(String(stream.id || '')) || video.dataset?.type === 'screen';
      if (isScreen) peer.screen = stream;
      else peer.camera = stream;
    }

    for (const audio of document.querySelectorAll('audio')) {
      diagnostics.audios += 1;
      const stream = usableStream(audio);
      if (!stream) continue;
      diagnostics.streams += 1;
      diagnostics.audioTracks += stream.getAudioTracks?.().length || 0;
      if (isLocalElement(audio)) { diagnostics.localExcluded += 1; continue; }
      stream.getTracks().forEach(watchTrack);
      const identity = mediaIdentity(audio, 'audio', diagnostics.audios);
      ensure(identity.peerId, audio, identity.fallback ? `Live audio ${identity.ordinal}` : undefined).audio = stream;
    }

    // HiveTalk retains a roster tile when a participant disables their camera.
    // Its id is <peer-id>__videoOff, so the person remains assignable even
    // though there is no video MediaStream to discover.
    for (const cameraOffTile of document.querySelectorAll('[id$="__videoOff"]')) {
      const peerId = String(cameraOffTile.id || '').replace(/__videoOff$/, '');
      if (!peerId) continue;
      const rawName = String(document.getElementById(`${peerId}__name`)?.textContent || '');
      if (cameraOffTile.dataset?.local === 'true' || /\(me\)\s*$/.test(rawName)) {
        diagnostics.localExcluded += 1;
        continue;
      }
      diagnostics.cameraOff += 1;
      const peer = ensure(peerId, cameraOffTile, cleanName(rawName) || peerId.slice(0, 10));
      peer.cameraOff = true;
      const avatar = document.getElementById(`${peerId}__img`) || cameraOffTile.querySelector?.('img');
      const avatarSrc = String(avatar?.currentSrc || avatar?.src || '');
      peer.avatarSrc = avatarSrc.length <= 65536 ? avatarSrc : '';
    }

    state.peers = peers;
    state.diagnostics = diagnostics;
    for (const [slotId, slot] of slots) {
      const peer = peers.get(slot.selectedPeerId);
      const nextKey = peer ? streamKey(peer) : '';
      const nextPresent = Boolean(peer);
      slot.mediaKey = nextKey;
      slot.peerPresent = nextPresent;
      if (slot.selectedPeerId && (previousKeys.get(slotId) !== nextKey || previousPresence.get(slotId) !== nextPresent)) {
        closeSlot(slotId);
        slot.status = nextKey ? 'reconnecting' : 'unavailable';
        send({ type: 'media-changed', slot: slotId, peerId: slot.selectedPeerId, available: Boolean(nextKey) });
      }
    }
    render();
  }

  function streamKey(peer) {
    if (!peer) return '';
    const tracks = [peer.camera, peer.audio].filter(Boolean).flatMap((stream) => stream.getTracks());
    const trackKey = tracks.filter((track) => track.readyState !== 'ended').map((track) => `${track.kind}:${track.id}:${track.readyState}`).sort().join('|');
    return peer.cameraOff ? `${trackKey}|camera-off:${peer.name}:${peer.avatarSrc}` : trackKey;
  }

  function queuePeerScan() {
    if (scanQueued) return;
    scanQueued = true;
    // requestAnimationFrame may stop entirely when the HiveTalk tab is behind
    // OBS. A zero-delay timer remains throttled but continues to run.
    scanTimer = window.setTimeout(() => {
      scanQueued = false;
      scanTimer = null;
      readPeers();
    }, 0);
  }

  function selectedStream(slotId) {
    const peer = state.peers.get(slots.get(slotId)?.selectedPeerId);
    if (!peer) return new MediaStream();
    const tracks = [];
    if (peer.camera) {
      tracks.push(...peer.camera.getVideoTracks());
      tracks.push(...peer.camera.getAudioTracks());
    }
    if (peer.audio) tracks.push(...peer.audio.getAudioTracks());
    return new MediaStream([...new Map(tracks.filter((track) => track.readyState !== 'ended').map((track) => [track.id, track])).values()]);
  }

  async function limitVideoSender(sender, track) {
    if (track.kind !== 'video' || typeof sender.getParameters !== 'function') return;
    const settings = track.getSettings?.() || {};
    const scale = Math.max(1, Number(settings.width || 1280) / 1280, Number(settings.height || 720) / 720);
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    Object.assign(parameters.encodings[0], { maxBitrate: 2500000, maxFramerate: 30, scaleResolutionDownBy: scale });
    try { await sender.setParameters(parameters); } catch (_) { /* Browser support varies; forwarding still works. */ }
  }

  async function answerOffer(message) {
    const slotId = String(message.slot || '');
    const slot = slots.get(slotId);
    if (!slot || !slot.selectedPeerId || !message.viewerId) return;
    closeSlot(slotId);
    const pc = new RTCPeerConnection({ iceServers: [] });
    slot.pc = pc;
    slot.viewerId = message.viewerId;
    slot.status = 'connecting';
    const stream = selectedStream(slotId);
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      await limitVideoSender(sender, track);
    }
    pc.addEventListener('connectionstatechange', () => {
      if (slot.pc !== pc) return;
      slot.status = pc.connectionState;
      render();
    });
    await pc.setRemoteDescription(message.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIce(pc);
    if (slot.pc !== pc) return;
    const peer = state.peers.get(slot.selectedPeerId);
    send({
      type: 'answer', slot: slotId, viewerId: message.viewerId,
      offerId: message.offerId,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      peer: { id: slot.selectedPeerId, name: peer?.name, cameraOff: Boolean(peer?.cameraOff), avatarSrc: peer?.avatarSrc || '' },
      tracks: stream.getTracks().map((track) => track.kind)
    });
    render();
  }

  function closeSlot(slotId) {
    const slot = slots.get(String(slotId));
    if (!slot) return;
    slot.pc?.close();
    slot.pc = null;
    slot.viewerId = '';
  }

  function waitForIce(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); }
      });
    });
  }

  function createPanel() {
    if (panel?.isConnected) return;
    panel = document.createElement('div');
    panel.id = 'hivetalk-obs-local-panel';
    panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:360px;max-width:calc(100vw - 16px);max-height:80vh;overflow:auto;padding:12px;background:#141821;color:#fff;border:1px solid #586174;border-radius:10px;font:14px/1.35 system-ui,sans-serif;box-shadow:0 4px 18px #0008';
    restorePanelState();
    panel.addEventListener('change', (event) => {
      const slotId = event.target.dataset?.slot;
      const slot = slots.get(slotId);
      if (!slot) return;
      slot.selectedPeerId = event.target.value;
      slot.mediaKey = streamKey(state.peers.get(slot.selectedPeerId));
      slot.peerPresent = state.peers.has(slot.selectedPeerId);
      slot.stats = null;
      slot.status = slot.selectedPeerId ? 'selected' : 'idle';
      closeSlot(slotId);
      send({ type: 'selection', slot: slotId, peerId: slot.selectedPeerId });
      render(true);
    });
    panel.addEventListener('click', async (event) => {
      const action = event.target.closest?.('[data-action]')?.dataset?.action;
      if (action === 'collapse') {
        panelCollapsed = !panelCollapsed;
        copiedSlot = '';
        render(true);
        if (panel.style.left) {
          const rect = panel.getBoundingClientRect();
          clampPanelPosition(rect.left, rect.top);
        }
        savePanelState();
      }
      if (action === 'copy-url') {
        const slotId = event.target.closest('[data-slot]')?.dataset?.slot;
        if (slotId) await copyObsUrl(slotId);
      }
    });
    panel.addEventListener('pointerdown', (event) => {
      if (!event.target.closest?.('[data-drag-handle]') || event.target.closest?.('[data-action]')) return;
      const rect = panel.getBoundingClientRect();
      dragState = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      event.preventDefault();
    });
    document.documentElement.appendChild(panel);
  }

  function restorePanelState() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PANEL_STORAGE_KEY) || '{}');
      panelCollapsed = Boolean(saved.collapsed);
      if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        panel.style.left = `${saved.left}px`;
        panel.style.top = `${saved.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      }
    } catch (_) { /* A blocked storage API should not prevent the panel loading. */ }
  }

  function savePanelState() {
    try {
      const rect = panel.getBoundingClientRect();
      window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({ left: rect.left, top: rect.top, collapsed: panelCollapsed }));
    } catch (_) {}
  }

  function clampPanelPosition(left, top) {
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8);
    panel.style.left = `${Math.max(8, Math.min(left, maxLeft))}px`;
    panel.style.top = `${Math.max(8, Math.min(top, maxTop))}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  async function copyObsUrl(slotId) {
    const url = `http://127.0.0.1:8766/output/${slotId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch (_) {
      const input = panel.querySelector(`[data-url-slot="${slotId}"]`);
      input?.select?.();
      document.execCommand?.('copy');
    }
    copiedSlot = slotId;
    render(true);
    window.setTimeout(() => {
      if (copiedSlot === slotId) { copiedSlot = ''; render(true); }
    }, 1200);
  }

  function slotStatus(slot) {
    if (!slot.selectedPeerId) return 'Not assigned';
    if (!state.peers.has(slot.selectedPeerId)) return 'Feed unavailable — reselect when it returns';
    const peer = state.peers.get(slot.selectedPeerId);
    const kinds = [peer.camera?.getVideoTracks().length ? 'video' : peer.cameraOff ? 'placeholder' : '', (peer.audio?.getAudioTracks().length || peer.camera?.getAudioTracks().length) && 'audio'].filter(Boolean).join(' + ') || 'no live tracks';
    if (!slot.stats) return `${kinds} · waiting for OBS`;
    const parts = [kinds, slot.stats.resolution, slot.stats.fps && `${slot.stats.fps} fps`, slot.stats.codec, slot.stats.bitrate && `${slot.stats.bitrate} kb/s`, slot.stats.state].filter(Boolean);
    return parts.join(' · ');
  }

  function render(force = false) {
    if (!panel || !panel.isConnected) createPanel();
    // Live stats update every two seconds. Do not rebuild the panel while a
    // selector is focused, or Firefox can close its open dropdown mid-choice.
    if (!force && panel.contains?.(document.activeElement)) return;
    const renderKey = JSON.stringify({
      connected: state.connected, connectionDetail: state.connectionDetail, diagnostics: state.diagnostics,
      peers: [...state.peers.values()].map((peer) => [peer.peerId, peer.name, Boolean(peer.camera), Boolean(peer.audio), Boolean(peer.screen), peer.cameraOff]),
      slots: [...slots].map(([id, slot]) => [id, slot.selectedPeerId, slot.status, slot.stats])
    });
    if (!force && renderKey === lastRenderKey) return;
    lastRenderKey = renderKey;
    const slotRows = [...slots].map(([slotId, slot]) => {
      const options = [...state.peers.values()].filter((peer) => peer.camera || peer.audio || peer.cameraOff).map((peer) => {
        const selected = peer.peerId === slot.selectedPeerId ? ' selected' : '';
        const assignedElsewhere = [...slots].some(([otherId, other]) => otherId !== slotId && other.selectedPeerId === peer.peerId);
        const disabled = assignedElsewhere && !selected ? ' disabled' : '';
        const media = [peer.camera && 'video', (peer.audio || peer.camera?.getAudioTracks().length) && 'audio', peer.cameraOff && !peer.camera && 'camera off'].filter(Boolean).join(' + ') || 'no media';
        return `<option value="${escapeHtml(peer.peerId)}"${selected}${disabled}>${escapeHtml(peer.name)} — ${media}${assignedElsewhere && !selected ? ' (assigned)' : ''}</option>`;
      }).join('');
      return `<div style="margin-top:9px;padding-top:8px;border-top:1px solid #303747">
        <label for="hivetalk-obs-peer-${slotId}"><b>OBS Slot ${slotId}</b></label>
        <select id="hivetalk-obs-peer-${slotId}" data-slot="${slotId}" style="display:block;width:100%;margin-top:4px;padding:6px;background:#252b38;color:#fff;border:1px solid #687186;border-radius:5px">
          <option value="">Choose a remote participant…</option>${options}
        </select>
        <div style="margin-top:4px;font-size:11px;color:#aeb7c8">${escapeHtml(slotStatus(slot))}</div>
        <div style="display:flex;gap:5px;margin-top:5px">
          <input readonly data-url-slot="${slotId}" value="http://127.0.0.1:8766/output/${slotId}" aria-label="OBS Slot ${slotId} URL" style="min-width:0;flex:1;padding:5px;background:#0f131b;color:#dce5f5;border:1px solid #455064;border-radius:4px;font:11px ui-monospace,monospace">
          <button type="button" data-action="copy-url" data-slot="${slotId}" style="padding:4px 8px;background:#344158;color:#fff;border:1px solid #65738b;border-radius:4px;cursor:pointer">${copiedSlot === slotId ? 'Copied!' : 'Copy'}</button>
        </div>
      </div>`;
    }).join('');
    const header = `<div data-drag-handle style="display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:move;user-select:none">
      <div style="font-weight:700">HiveTalk → OBS (4 slots)</div>
      <button type="button" data-action="collapse" aria-label="${panelCollapsed ? 'Expand' : 'Collapse'} panel" title="${panelCollapsed ? 'Expand' : 'Collapse'}" style="width:29px;height:25px;background:#252b38;color:#fff;border:1px solid #687186;border-radius:5px;cursor:pointer;font-size:16px;line-height:1">${panelCollapsed ? '▣' : '−'}</button>
    </div>`;
    const statusLine = `<div style="margin-top:5px;color:${state.connected ? '#65e38a' : '#ffbd66'}">${state.connected ? 'Local bridge connected' : escapeHtml(state.connectionDetail || 'Connecting to local bridge…')}</div>`;
    const expanded = `${slotRows}<div style="margin-top:9px;font-size:11px;color:#8f99aa">Detected ${state.peers.size} remote participant${state.peers.size === 1 ? '' : 's'} · ${state.diagnostics.videos} video elements · ${state.diagnostics.audios} audio elements · ${state.diagnostics.cameraOff} camera off · ${state.diagnostics.audioTracks} audio tracks · ${state.diagnostics.localExcluded} local excluded</div>`;
    panel.innerHTML = `${header}${statusLine}${panelCollapsed ? '' : expanded}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.marker !== EXT_MARKER) return;
    const message = event.data.payload;
    if (message?.type === 'bridge-status') {
      state.connected = message.connected;
      state.connectionDetail = message.connected ? '' : (message.detail || state.connectionDetail);
      render();
    }
    if (message?.type === 'offer') answerOffer(message).catch((error) => send({ type: 'error', slot: message.slot, viewerId: message.viewerId, message: error.message }));
    if (message?.type === 'viewer-stats' && slots.has(String(message.slot))) {
      const slot = slots.get(String(message.slot));
      slot.stats = message.stats;
      slot.status = message.stats?.state || slot.status;
      render();
    }
    if (message?.type === 'viewer-closed' && slots.has(String(message.slot))) closeSlot(String(message.slot));
  });

  const observer = new MutationObserver((mutations) => {
    const hiveTalkChanged = mutations.some((mutation) => {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      return !target?.closest?.('#hivetalk-obs-local-panel');
    });
    if (hiveTalkChanged) queuePeerScan();
  });

  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'muted'] });
    createPanel();
    readPeers();
    setInterval(queuePeerScan, 2000);
    send({ type: 'publisher-ready' });
    window.addEventListener('pointermove', (event) => {
      if (!dragState) return;
      clampPanelPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
    });
    window.addEventListener('pointerup', () => {
      if (!dragState) return;
      dragState = null;
      savePanelState();
    });
    window.addEventListener('resize', () => {
      const rect = panel.getBoundingClientRect();
      if (panel.style.left) clampPanelPosition(rect.left, rect.top);
    });
    window.addEventListener('beforeunload', () => {
      if (scanTimer !== null) window.clearTimeout(scanTimer);
      [...slots.keys()].forEach(closeSlot);
    }, { once: true });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
