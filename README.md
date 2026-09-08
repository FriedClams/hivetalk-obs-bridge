# HiveTalk OBS Bridge

HiveTalk OBS Bridge is a Firefox extension plus a small local Node.js bridge that exposes up to four remote HiveTalk participants as independent OBS Browser Sources.

It reuses the participant media that Firefox has already received for the normal HiveTalk call. Each selected feed travels over a new WebRTC connection that stays on the same computer:

```text
HiveTalk room in Firefox → Firefox extension → local bridge on 127.0.0.1 → OBS Browser Source
```

The project does **not** modify the HiveTalk server, join the room four additional times, or send participant media to a project-owned server. It is alpha/test software, not an official HiveTalk or OBS project. Read [KNOWN_ISSUES.md](KNOWN_ISSUES.md) before using it for a recording.

## Requirements

- Fedora or another desktop OS capable of running Firefox, Node.js 20+, and OBS Studio
- Firefox
- OBS Studio with Browser Source support
- Node.js 20 or newer

## Install the test version

1. Download and extract the complete release ZIP.
2. Open a terminal in the extracted folder.
3. Install the single Node dependency with `npm install`.
4. Start the local bridge with `npm start` and leave the terminal open.
5. In Firefox, open `about:debugging` and select **This Firefox**.
6. Remove any older HiveTalk OBS test add-on.
7. Click **Load Temporary Add-on…** and select the release's `.xpi` file.
8. Open or reload a room on `https://*.hivetalk.org`.

The first HiveTalk tab to connect controls the local bridge. The temporary add-on disappears when Firefox exits; a signed persistent build is planned after live testing.

## Use it

The HiveTalk page gains a movable control panel with four slots. Drag its header to move it and use the top-right button to collapse it. The position and collapsed state are remembered on that HiveTalk site.

Assign a different remote participant to each slot. Use the **Copy** button beside a slot to copy its OBS URL.

Participants remain selectable while their cameras are off and retain their slot assignment when video returns. The alpha attempts to render the participant's HiveTalk/Nostr avatar in OBS, but this placeholder is currently unreliable in the tested Honey/OBS environment and must not be treated as production-ready.

| Slot | OBS Browser Source URL |
| --- | --- |
| 1 | `http://127.0.0.1:8766/output/1` |
| 2 | `http://127.0.0.1:8766/output/2` |
| 3 | `http://127.0.0.1:8766/output/3` |
| 4 | `http://127.0.0.1:8766/output/4` |

For each OBS Browser Source, set width to `1280`, height to `720`, enable **Control audio via OBS**, and leave **Shutdown source when not visible** disabled while testing reconnection.

Do not create two active Browser Sources using the same slot URL. The newest one intentionally replaces the older one. Avoid capturing the normal HiveTalk audio at the same time as isolated participant audio, or the broadcast may have doubling or echo.

## What runs and what it can access

- `extension/page-bridge.js` discovers remote media elements already present in the HiveTalk page and creates the local WebRTC senders.
- `extension/content-transport.js` carries signaling messages between the page and the local bridge.
- `server/server.js` is a WebSocket/HTTP bridge bound only to `127.0.0.1:8766`.
- `server/public/output.js` is loaded by each OBS Browser Source and receives one local WebRTC feed.
- The extension is limited to `https://*.hivetalk.org/*` and the bridge at `127.0.0.1:8766`.
- There is no analytics or telemetry code.
- `npm install` downloads the pinned `ws` WebSocket library from npm. The audio/video media path itself stays local. When a Nostr/profile avatar is hosted at an external HTTPS URL, the OBS Browser Source requests that image directly from its host to render the camera-off card.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow, security boundaries, and failure behavior.

## Verify it yourself

Everything used to build the extension and bridge is included as source. Before running it, a reviewer can use:

```bash
npm ci
npm test
npm audit --omit=dev
npm run build
sha256sum dist/*
```

`npm run build` creates the `.xpi` and full release ZIP from the checked-out source. A teammate can compare those hashes with the hashes attached to a GitHub Release.

## Current limitations

- Live participant video isolation is proven in the initial test environment.
- The camera-off placeholder is known not to render reliably; OBS may continue showing a waiting message.
- Four-person audio pairing and sustained four-feed load still need broader live testing.
- HiveTalk deployments that hide participant identity may appear as `Live video 1`, etc.
- An anonymous feed that is destroyed and recreated is deliberately marked unavailable rather than silently replaced by a different person.
- Firefox sender limits are requests, not guarantees; actual resolution and frame rate appear in the panel.
- The current `.xpi` is loaded as a temporary development add-on. It is not yet signed for persistent Firefox installation.

## Development

Run `npm ci` and `npm test` to test the project. Run `npm run build` to write reproducible release artifacts to `dist/`. GitHub Actions runs the same tests and build on every proposed change.

## License

MIT. See [LICENSE](LICENSE).
