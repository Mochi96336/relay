# 本次實際執行的局部驗證

基準 `1bc6b50`。下列 Node 測試使用 `nice -n 10` 串行執行；命令省略不影響測試行為的日誌重導向。

```sh
npm run check

node --import tsx --test --test-concurrency=1 \
  test/boot-calibration.test.ts \
  test/boot-probe-mixer-application.test.ts \
  test/calibration-applicability.test.ts \
  test/calibration-mixer-application.test.ts \
  test/calibration-analysis-deadline.test.ts \
  test/calibration-collection-context.test.ts \
  test/calibration-confirmed-result.test.ts \
  test/content-calibration-validator.test.ts \
  test/robot-boot-to-content-promotion.test.ts \
  test/take-timing-divergence.test.ts

node --import tsx --test --test-concurrency=1 \
  test/audio-packet-receiver-retransmit.test.ts \
  test/browser-audio-retransmit.test.ts \
  test/browser-websocket-backpressure.test.ts \
  test/browser-webtransport-repromotion.test.ts \
  test/media-path-fallback-hole-proof.test.ts \
  test/media-path-generation-transition-proof.test.ts \
  test/mic-bitrate-policy.test.ts \
  test/mic-audible-loss-matrix.test.ts \
  test/monitor-backpressure.test.ts \
  test/playback-worklet-buffering.test.ts \
  test/listen-opus-decoder.test.ts

node --import tsx --test --test-concurrency=1 \
  test/calibration-ui-behavior.test.ts \
  test/calibration-ui-lifecycle.test.ts \
  test/product-view-model.test.ts \
  test/product-issues.test.ts \
  test/remote-status.test.ts \
  test/room-song-command-client.test.ts \
  test/song-replay-after-reload-runtime.test.ts \
  test/live-status-freshness.test.ts \
  test/listen-gesture-transition.test.ts \
  test/restart-mobile-audio-contract.test.ts

node --import tsx investigations/health-check-20261013/reproduce.mjs
```

Chromium 驗證使用 `/tmp/relay-health-browser-20261013` 的隔離副本：`public/`、`shared/`、兩個 test/browser 檔案及 `__room-sound-geometry.html` fixture。套件為 `@playwright/test@1.55.0`，瀏覽器為 `/usr/bin/chromium`，HTTP 只 bind `127.0.0.1:4178`。

```sh
RELAY_INTERACTION_URL=http://127.0.0.1:4178/ \
RELAY_CHROMIUM_PATH=/usr/bin/chromium \
node node_modules/@playwright/test/cli.js test \
  test/browser/live-interaction.spec.mjs \
  test/browser/room-sound-geometry.spec.mjs \
  --workers=1 --reporter=line
```

DOM＋geometry 50/50 通過。另一個隔離頁面以 `scripts/build-live-visual-fixture.mjs` 產生，載入正式 calibration-ui／system-details，注入錄音中 timing-fallback 的 ProductStatus，取得 evidence-summary 中的 UI 文字與 disabled 狀態。測試機缺少中文字型，截圖出現缺字；這是此驗證環境的限制，沒有將該截圖當作產品字體缺陷或視覺驗收成果。

原始局部 log 暫存在 `/tmp/relay-health-20261013-{check,calibration-tests,transport-tests,ux-tests,browser-tests}.log`；它們不是長期證據依賴。摘要、基準 commit 與可重跑命令保存在這個目錄。
