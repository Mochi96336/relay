#!/usr/bin/env bash

set -e -o pipefail

mkdir -p screenshots

live_states=(empty listener singer takeover recording reconnecting people more system)

for state in "${live_states[@]}"; do
  npx -y playwright@1.55.0 screenshot \
    --browser chromium \
    --viewport-size="390,844" \
    --full-page \
    --wait-for-timeout=250 \
    "http://127.0.0.1:4173/__live-visual.html?state=${state}" \
    "screenshots/${state}.png"
done

for state in empty listener singer takeover recording reconnecting people more; do
  npx -y playwright@1.55.0 screenshot \
    --browser chromium \
    --viewport-size="1024,768" \
    --full-page \
    --wait-for-timeout=250 \
    "http://127.0.0.1:4173/__live-visual.html?state=${state}" \
    "screenshots/desktop-${state}.png"
done

for state in take-history-one take-history-many room-sound-normal room-sound-muted room-sound-forced room-sound-retry; do
  npx -y playwright@1.55.0 screenshot \
    --browser chromium \
    --viewport-size="390,844" \
    --wait-for-timeout=700 \
    "http://127.0.0.1:4173/__live-p0-layout.html?state=${state}" \
    "screenshots/${state}.png"
done

for width in 759 760 768; do
  npx -y playwright@1.55.0 screenshot \
    --browser chromium \
    --viewport-size="${width},844" \
    --wait-for-timeout=700 \
    "http://127.0.0.1:4173/__live-p0-layout.html?state=take-history-one" \
    "/tmp/take-history-${width}.png"
done

npx -y playwright@1.55.0 screenshot \
  --browser chromium \
  --viewport-size="1024,768" \
  --wait-for-timeout=700 \
  "http://127.0.0.1:4173/__live-p0-layout.html?state=take-history-one" \
  "/tmp/take-history-desktop.png"

sleep 0.25
if grep -q '/__geometry-fail' /tmp/relay-visual-http.log; then
  echo 'Chromium layout geometry failed:'
  grep '/__geometry-' /tmp/relay-visual-http.log || true
  exit 1
fi

for marker in \
  'state=take-history-one&vw=390' \
  'state=take-history-many&vw=390' \
  'state=room-sound-normal&vw=390' \
  'state=room-sound-muted&vw=390' \
  'state=room-sound-forced&vw=390' \
  'state=room-sound-retry&vw=390' \
  'state=take-history-one&vw=759' \
  'state=take-history-one&vw=760' \
  'state=take-history-one&vw=768' \
  'state=take-history-one&vw=1024'; do
  if ! grep -q "/__geometry-pass?${marker}" /tmp/relay-visual-http.log; then
    echo "Missing Chromium geometry pass marker: ${marker}"
    grep '/__geometry-' /tmp/relay-visual-http.log || true
    exit 1
  fi
done
