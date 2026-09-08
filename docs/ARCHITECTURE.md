# Architecture and trust model

## Purpose

The bridge turns media already visible or audible in one Firefox HiveTalk room into as many as four independent local OBS Browser Sources. It avoids an additional HiveTalk server participant or an external RTMP/WebRTC relay for each isolated feed.

## Components

1. **Page bridge** (`extension/page-bridge.js`): runs in the HiveTalk page's JavaScript world, discovers live remote `MediaStream` tracks, provides the four-slot UI, and creates one sending `RTCPeerConnection` per active slot.
2. **Extension transport** (`extension/content-transport.js`): connects the page bridge to the localhost WebSocket server and forwards signaling only.
3. **Local server** (`server/server.js`): binds to `127.0.0.1:8766`, pairs the one HiveTalk publisher with as many as four OBS viewers, and serves the output page.
4. **OBS output** (`server/public/output.js`): creates a receiving `RTCPeerConnection`, displays the selected video, exposes audio to OBS, and reports connection statistics.

## Data flow

```text
Internet
  │ existing HiveTalk call
  ▼
Firefox/HiveTalk
  │ selected MediaStream tracks
  │ local WebRTC (no STUN/TURN)
  ▼
OBS Browser Source at 127.0.0.1
```

The WebSocket bridge carries SDP/signaling and statistics, not encoded media. WebRTC media flows directly between Firefox's HiveTalk tab and OBS's embedded browser on the same computer.

## Security boundaries

- The server listens only on the loopback address, not the LAN.
- A random session key is generated every time the bridge starts.
- Viewer connections must originate from the localhost output page and use a valid slot from 1–4.
- The extension manifest grants access only to HiveTalk subdomains and the local bridge.
- No STUN or TURN servers are configured for output peer connections.
- The project contains no telemetry, account system, cloud service, or automatic updater.
- The only runtime npm dependency is `ws`, pinned through `package-lock.json`.
- Camera-off audio/video remains local, but displaying an externally hosted Nostr/profile avatar causes the OBS Browser Source to request that HTTPS image from its original host. Initials are used if it fails or is unavailable.

These controls reduce exposure but do not constitute a formal security audit. Anyone using the alpha build should review the source and test it before relying on it in production.

## Slot isolation and failure behavior

Each slot has its own assignment, OBS viewer, peer connection, statistics, cleanup, and reconnect state. Stale answers carry an offer identifier and are ignored after a newer connection starts. A duplicate OBS source using the same slot replaces the first by design.

- **Bridge restart:** the extension and OBS outputs fetch a new session key and reconnect with capped exponential backoff.
- **Camera or microphone change:** only affected slots renegotiate.
- **Camera off:** HiveTalk's persistent roster tile keeps the stable participant ID and Nostr/profile avatar URL assignable. The OBS output page attempts to render that avatar, name, and status as HTML, but this display is a documented unresolved alpha issue. The slot still retains its assignment for real video returning.
- **Identified participant returns:** the existing slot assignment reconnects to that participant ID.
- **Anonymous identity is lost:** the slot requires manual reselection rather than guessing.
- **Second controller tab:** rejected so it cannot silently take over active outputs.
- **OBS source closes:** its peer connection and received tracks stop.

## Performance cost

Every active slot adds one local Firefox WebRTC encode and one OBS decode. It does not add a duplicate HiveTalk download, but four slots can materially increase CPU/GPU usage. The sender requests a ceiling of 720p, 30 fps, and 2.5 Mb/s when supported; the panel displays observed results.
