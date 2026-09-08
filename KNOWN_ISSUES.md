# Known issues

## Camera-off placeholder is unreliable

Camera-off participants remain visible and assignable in the four slot selectors. The current alpha also attempts to render the participant's HiveTalk/Nostr profile image directly in the OBS Browser Source. In the tested Honey HiveTalk and OBS environment, that placeholder has not rendered reliably; OBS may continue to show a waiting message until the participant enables a camera or microphone.

Do not rely on the camera-off placeholder during a production recording. Live participant video isolation remains the proven use case.

## Audio needs broader validation

Audio is forwarded when HiveTalk exposes a stable audio stream that can be paired with the selected participant. Four-person audio pairing has not yet been validated across enough real rooms to call production-ready. Monitor every Browser Source in the OBS Audio Mixer before recording.

## Temporary Firefox installation

The test `.xpi` must be loaded from `about:debugging` and disappears when Firefox exits. A Mozilla-signed persistent extension is deferred until the alpha behavior is sufficiently validated.

## Performance ceiling is machine-dependent

Each active slot adds a local Firefox WebRTC encode and OBS decode. Four-slot stability depends on the computer, codecs, resolution, and whether hardware acceleration is functioning. Add slots one at a time while monitoring OBS Stats and system CPU/GPU usage.
