# Live product repair umbrella

This branch is the Draft integration umbrella for the next P0 Live UI repair pass. It starts from the frozen `agent/live-product-composition` branch and intentionally contains no product repair implementation yet.

## P0 scope

- Recording action readiness after taking Mic
- System / More interaction validation
- Take History mobile width and time-operation space
- Room sound vertical footprint
- Live horizontal alignment consistency
- Robot/manual calibration semantics: keep probe separate from Song playback
- Room Mic ribbon center-origin time presentation
- Real vocal F0 / pitch visibility
- Interaction-first screenshot fixtures instead of direct final-DOM setup

## Guardrails

Do not change audio transport framing, WebTransport packet design, sample timeline, calibration math, Mic ownership authority, playback authority, Song fixed 100%, Mic gain max +40 dB, recommended gain cap +36 dB, Take persistence/retention, or Robot supervisor.

Preserve Mic ownership as Song control ownership. Observers must not receive a real YouTube iframe. Mic visualization must not be derived from the final room mix. Do not merge #59, #61, or #62 as part of this umbrella setup.

## Child branches

All child work branches from `agent/live-product-repair` and integrates back here separately:

- `agent/live-p0-interactions`
- `agent/live-p0-layout`
- `agent/live-p0-calibration`
- `agent/live-p0-pitch-ribbon`
