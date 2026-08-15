# Robot deployment contract

Relay's final product topology is **phone + robot**. The desktop used during development is only a stand-in for the robot-side browser host; it is not a permanent runtime component.

```text
Singer phone
├─ visible YouTube
├─ YouTube media timeline ───────────────┐
└─ microphone PCM ───────────────────────┤
                                         │
Robot                                    │
├─ Relay server <────────────────────────┘
├─ Chromium
│  └─ source.html
│     └─ mirrored YouTube
└─ backing-source adapter
   └─ rendered song PCM ────────────────> Relay server

Relay server
└─ aligned song + microphone
   └─ Monitor / Record / later Discord
```

## Current prototype boundary

`chrome-tab-audio-probe/` is the current backing-source adapter. It proves that the rendered YouTube tab audio can be turned into framed PCM and fed into Relay, but it is **not yet a fully unattended headless robot capture path**.

Chrome's `tabCapture` API can only start after the user invokes the extension. The current implementation makes that explicit by calling `chrome.tabCapture.getMediaStreamId()` from `chrome.action.onClicked`. This is a browser security boundary, not a reconnect bug that the Relay server can work around.

`source.html` also currently waits for the **Enable source audio** gesture before the mirrored YouTube player is allowed to emit sound. Therefore a fresh Chromium session still needs local interaction before backing audio exists, even though Relay reconnect, mixing and timing calibration can run unattended after that point.

Do not build a system service that claims to auto-start this extension capture at boot. It would encode a deployment promise Chrome does not provide.

## Deployment stages

### Development

A normal computer runs Chromium, `source.html` and the unpacked extension. This is only the development substitute for the robot-side browser host.

### Robot browser session

Relay server and Chromium run on the robot. `source.html` is opened locally and the extension is loaded there. With the current prototype, a Chromium restart still requires the source-audio gesture and one extension invocation before capture begins.

This mode is useful for integrated robot testing, but it is not the final unattended target.

### Final unattended robot

Keep the existing Relay `backing` protocol and replace only the **backing-source adapter** with a robot-local capture path that can be started and supervised as a service.

That change must stay outside the audio core:

- `source.html` owns mirroring the phone's YouTube media timeline.
- the backing-source adapter owns extracting rendered song audio, framing it and reconnecting its transport.
- `src/server.ts` owns WebSocket routing and source lifecycle orchestration.
- `AudioSession` owns the shared PCM timelines, alignment, mixer and signal processing.
- `CalibrationSession` observes those timelines and owns measurement validity.

A new robot capture adapter should continue sending the same framed PCM (`generation` + `firstSampleIndex`) as the extension does today. It should not create a second mixer clock or a second alignment model.

## Next implementation seam

The next deployment-specific work is **not** another `AudioSession` refactor. It is to choose and implement the robot-local way to obtain the browser's rendered audio without depending on a `tabCapture` user invocation, while preserving the existing `backing` WebSocket contract.

Until that exists, the accurate statement is:

> Relay is unattended after backing capture has been activated; backing capture itself is still manually activated in the Chrome-extension prototype.
