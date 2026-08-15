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

`chrome-tab-audio-probe/` is the current browser backing-source adapter. It proves that rendered YouTube audio can be turned into framed PCM and fed into Relay, but it is **not a fully unattended headless robot capture path**.

Chrome's `tabCapture` API can only start after the user invokes the extension. The current implementation makes that explicit by calling `chrome.tabCapture.getMediaStreamId()` from `chrome.action.onClicked`. This is a browser security boundary, not a reconnect bug that the Relay server can work around.

`source.html` also currently waits for the **Enable source audio** gesture before the mirrored YouTube player is allowed to emit sound. Therefore a fresh Chromium session still needs local interaction before backing audio exists, even though Relay reconnect, mixing and timing calibration can run unattended after that point.

Do not build a system service that claims to auto-start this extension capture at boot. It would encode a deployment promise Chrome does not provide.

## Backing protocol bridge

`npm run backing:stdin` is the robot-side protocol seam for replacing the extension.

It reads **raw mono signed 16-bit little-endian PCM** from stdin and sends it to Relay as the existing `backing` role. It uses the same framed PCM contract as the phone and extension (`generation` + `firstSampleIndex`), keeps the capture clock running across a WebSocket outage, and lets a dropped transport interval remain an explicit hole on the Relay timeline.

```text
robot audio capture
      │ raw s16le mono PCM
      ▼
npm run backing:stdin
      │ framed backing PCM
      ▼
Relay server
```

Defaults are 48 kHz and 20 ms frames. Relevant environment variables:

- `RELAY_URL` — backing WebSocket URL, default `ws://127.0.0.1:3000/ws`
- `RELAY_KEY` — optional shared Relay key
- `RELAY_BACKING_SAMPLE_RATE` — input rate, default `48000`
- `RELAY_BACKING_FRAME_MS` — frame duration, default `20`

The bridge deliberately does **not** decide how the robot captures Chromium audio. That is deployment policy, not mixer ownership. Any robot-local audio route that can produce the documented PCM stream can feed this client without teaching `AudioSession` about Chromium, PipeWire, a browser extension or a specific operating system.

## Deployment stages

### Development

A normal computer runs Chromium, `source.html` and the unpacked extension. This is only the development substitute for the robot-side browser host.

### Robot browser session

Relay server and Chromium run on the robot. `source.html` is opened locally and the extension is loaded there. With the current prototype, a Chromium restart still requires the source-audio gesture and one extension invocation before capture begins.

This mode is useful for integrated robot testing, but it is not the final unattended target.

### Final unattended robot

Keep the existing Relay `backing` protocol and replace only the **backing-source adapter** with a robot-local capture path that can be started and supervised as a service. Feed that PCM into `npm run backing:stdin`.

That change must stay outside the audio core:

- `source.html` owns mirroring the phone's YouTube media timeline.
- the backing-source adapter owns extracting rendered song audio, framing it and reconnecting its transport.
- `src/server.ts` owns WebSocket routing and source lifecycle orchestration.
- `AudioSession` owns the shared PCM timelines, alignment, mixer and signal processing.
- `CalibrationSession` observes those timelines and owns measurement validity.

A new robot capture adapter should continue sending the same framed PCM as the extension does today. It should not create a second mixer clock or a second alignment model.

## Next implementation seam

The remaining deployment-specific work is to wire the robot browser's rendered audio into the stdin backing bridge without depending on a `tabCapture` user invocation.

On Raspberry Pi OS, modern releases use PipeWire for desktop audio, and PipeWire provides service-friendly capture/routing primitives. The exact robot audio route should be validated on the target installation before it is checked in as a boot service; it does not belong in the Relay mixer itself.

Until that route is installed, the accurate statement is:

> Relay is unattended after backing capture has been activated; the Chrome-extension prototype still needs manual activation, while `backing:stdin` is the protocol path for the final unattended robot capture.
