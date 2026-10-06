# 驗證手冊：命令、證據與失敗分流

下列命令在已確認的**程式 worktree root** 執行，不在較舊 main。每個命令失敗就先處理／記錄，不因下一個命令成功而蓋掉失敗。這些是未來執行指引；文件深化本身沒有重跑 runtime tests。

## P00 — 確認基線

先完成00的 git/worktree 檢查，再用下列唯讀程式核對首次基線：

```bash
node --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(fs.readFileSync('/home/mochi/relay/docs/refactor/BASELINE.json', 'utf8'));
const drift = [];
for (const [file, expected] of Object.entries(manifest.files)) {
  const target = path.join(process.cwd(), file);
  if (!fs.existsSync(target)) { drift.push({ file, reason: 'missing' }); continue; }
  const actual = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if (actual !== expected.sha256) drift.push({ file, reason: 'changed', actual });
}
console.log(JSON.stringify({ checked: Object.keys(manifest.files).length, drift }, null, 2));
process.exitCode = drift.length ? 1 : 0;
JS
```

文件移動時先確認 manifest 實際位置，再改 readFileSync 路徑。hash 不符不是讓你覆蓋檔案的命令；按00做差異稽核。後續以新 checkpoint 為準。

已知歷史記錄：`npm test` → 2,531 tests、115 suites、0 fail/skip/cancel，log `/tmp/relay-mixer-dsp-full-suite.log`。`1..1830` 是 top-level TAP 項目，不是總 test case 數；以 `# tests 2531` 為準。

P00 首次交接至少再跑 CHECK 和 A；若原本 full log 遺失、任一 runtime/test/config hash 變動、執行環境顯著不同，就重新跑 FULL。不能只看到檔名相同就引用舊綠燈。

## CHECK — 每刀共用

```bash
npm run check
git diff --check
```

Browser 刀另跑（只讀 syntax，使用目前檔案名）：

```bash
rg --files public shared chrome-tab-audio-probe -g '*.js' -0 | xargs -0 -r -n1 node --check
```

pipeline 要在支援 `set -o pipefail` 的 bash 中執行並檢查整體 exit。新 untracked 檔案不在普通 git diff 中；另讀新檔與檢查 whitespace，不為方便自動 git add。

## A — AudioSession 快圈

```bash
node --import tsx --test --test-concurrency=1 \
  test/audio-session.test.ts \
  test/audio-session-golden.test.ts \
  test/audio-session-alignment-seam-invariant.test.ts \
  test/audio-session-limiter-ownership-seam-invariant.test.ts \
  test/audio-session-seam-invariant.test.ts \
  test/audio-session-take-evidence.test.ts \
  test/audio-session-mic-gain-authority.test.ts \
  test/audio-session-alignment-slew.test.ts \
  test/audio-session-mic-timeline-fold.test.ts \
  test/audio-session-mic-resume.test.ts \
  test/audio-session-capture-rate.test.ts \
  test/audio-session-cubic-resampler.test.ts \
  test/mix-bus.test.ts \
  test/mic-gain-ramp.test.ts \
  test/mic-limiter.test.ts \
  test/mic-raw-meter.test.ts
```

當包新 test 需另外顯式執行，再加入 checkpoint 清單。不能寫不存在的檔名執行失敗後將整組 A 當「已測」。新增 seam／reader tests 的名字在01裡是擬新增。

## S-STATUS

```bash
node --import tsx --test --test-concurrency=1 \
  test/relay-status-projection.test.ts \
  test/runtime-single-snapshot.test.ts \
  test/observation-status.test.ts \
  test/remote-status.test.ts \
  test/product-status-server.test.ts \
  test/product-view-model.test.ts \
  test/readiness.test.ts \
  test/readiness-model.test.ts \
  test/architecture-dependency-boundary.test.ts
```

## S-MEDIA

```bash
node --import tsx --test --test-concurrency=1 \
  test/audio-packet-server.test.ts \
  test/audio-uplink-health-server.test.ts \
  test/audio-uplink-health-webtransport.test.ts \
  test/mic-runtime-accepted-frame-ack.test.ts \
  test/mic-flow-semantics-server.test.ts \
  test/take-server.test.ts \
  test/take-owner-release-evidence-server.test.ts \
  test/server-take-shutdown.test.ts \
  test/voice-only-server.test.ts \
  test/monitor-socket-transport.test.ts
```

## S-TIMING

完整相關 family（glob 都是已存在的 test family；先用 `rg --files test` 確認目前版本仍有匹配）：

```bash
node --import tsx --test --test-concurrency=1 \
  test/timing-authority-*.test.ts \
  test/timing-runtime*.test.ts \
  test/server-boot-probe-*.test.ts \
  test/boot-probe-*.test.ts \
  test/server-probe-client-result-fencing.test.ts \
  test/server-robot-bootstrap-timing-deadlock.test.ts \
  test/server-robot-content-*.test.ts \
  test/robot-content-transition*.test.ts \
  test/calibration-transaction-server.test.ts \
  test/content-calibration-validation-server.test.ts \
  test/relay-robot-content-mapping-revocation-coordinator.test.ts \
  test/relay-robot-content-transition-commit-coordinator.test.ts \
  test/relay-take-command-coordinator.test.ts
```

這組仍不替代所有 calibration tests；FULL 是C2 gate。每卡的具名 unit tests另加。

## S-MIC

```bash
node --import tsx --test --test-concurrency=1 \
  test/participant-session.test.ts \
  test/participant-server.test.ts \
  test/socket-incarnation-authority.test.ts \
  test/socket-role-authority.test.ts \
  test/mic-runtime.test.ts \
  test/mic-transport-grace-runtime.test.ts \
  test/mic-boundary-hardening-server.test.ts \
  test/mic-gain-handoff-server.test.ts \
  test/relay-publisher-activation-coordinator.test.ts \
  test/relay-mic-release-coordinator.test.ts \
  test/relay-mic-disconnect-coordinator.test.ts \
  test/server-publisher-activation-coordinator.test.ts \
  test/server-mic-release-coordinator.test.ts \
  test/server-mic-disconnect-coordinator.test.ts
```

## S-SONG

```bash
node --import tsx --test --test-concurrency=1 \
  test/song-session.test.ts \
  test/song-authority-server.test.ts \
  test/song-handoff*.test.ts \
  test/room-song-command-authority-epoch.test.ts \
  test/room-song-command-server.test.ts \
  test/room-song-intent-authority-epoch-server.test.ts \
  test/room-song-latest-intent-server.test.ts \
  test/server-room-song-command-acceptance-coordinator.test.ts \
  test/server-song-handoff-result-coordinator.test.ts \
  test/server-youtube-telemetry-acceptance-coordinator.test.ts
```

## B-CAPTURE

```bash
node --import tsx --test --test-concurrency=1 \
  test/publisher-session-epoch.test.ts \
  test/publisher-command-liveness.test.ts \
  test/publisher-control-liveness.test.ts \
  test/mic-startup.test.ts \
  test/mic-start-failure-audio-session-race.test.ts \
  test/mic-lifecycle-recovery.test.ts \
  test/mic-lifecycle-transaction.test.ts \
  test/mic-capture-recovery.test.ts \
  test/capture-dispatch.test.ts \
  test/capture-observability-wiring.test.ts \
  test/capture-worklet-buffer-return.test.ts \
  test/calibration-probe-client-lifecycle.test.ts
```

注意上面一部分是 source tests，不是 browser async 行為測試。B10–B12 新 owner 的 deferred tests 與 production proof 是必要補充，不可省略。

## B-TRANSPORT

```bash
node --import tsx --test --test-concurrency=1 \
  test/browser-audio-transport.test.ts \
  test/browser-audio-transport-telemetry.test.ts \
  test/browser-audio-retransmit.test.ts \
  test/browser-websocket-backpressure.test.ts \
  test/browser-webtransport-generation.test.ts \
  test/browser-webtransport-repromotion.test.ts \
  test/browser-webtransport-runtime.test.ts \
  test/browser-media-path-recovery-correlation.test.ts \
  test/browser-media-path-recovery.test.ts \
  test/media-path-resolved-write-proof.test.ts \
  test/media-path-fallback-hole-proof.test.ts \
  test/media-path-generation-transition-proof.test.ts \
  test/media-path-liveness-proof.test.ts \
  test/mic-retransmit-server.test.ts
```

## B-PLAYBACK

```bash
node --import tsx --test --test-concurrency=1 \
  test/playback-handoff-*.test.ts \
  test/playback-prewarm-client.test.ts \
  test/playback-reload-continuation.test.ts \
  test/playback-recovery-client.test.ts \
  test/playback-authority-convergence.test.ts \
  test/youtube-local-audibility-runtime.test.ts \
  test/youtube-playing-clock-stall.test.ts \
  test/room-song-command-client.test.ts \
  test/room-song-command-convergence.test.ts
```

## B-LISTEN

```bash
node --import tsx --test --test-concurrency=1 \
  test/listen-*.test.ts \
  test/listener-diagnostics.test.ts \
  test/ios-audio-destination-*.test.ts \
  test/playback-listen-guard.test.ts \
  test/monitor-pcm-continuity.test.ts \
  test/streaming-resampler.test.ts \
  test/playback-worklet-buffering.test.ts
```

## T-STORAGE

```bash
node --import tsx --test --test-concurrency=1 \
  test/take-library*.test.ts \
  test/take-metadata-*.test.ts \
  test/take-durability-boundary.test.ts \
  test/take-recovery-repair-failure.test.ts \
  test/take-retention-partial-failure.test.ts \
  test/take-cleanup-failure.test.ts \
  test/take-controller-storage.test.ts \
  test/take-storage.test.ts \
  test/take-wav-integrity.test.ts \
  test/take-directory-isolation.test.ts \
  test/server-take-shutdown.test.ts \
  test/file-durability.test.ts \
  test/wav-take-writer.test.ts
```

新增 storage/server integration tests 必須以 tmpdir 指定 RELAY_TAKE_DIR；config 的預設是工作目錄下 `takes`，不能因 NODE_ENV=test 就假設錄音自動隔離。cleanup 只刪自己建立的明確 temp directory。

## FULL — 每個 production integration checkpoint

```bash
npm test
```

C1-only 元件可先跑 unit/相關 profile；接 production 的 C2 必須 FULL。不要拿新測試數量與2531硬比：新增案例本來會增加數目，但既有案例不得消失／skip。記錄 `tests/suites/pass/fail/cancelled/skipped` 和 process exit。

需要保留 log 時用唯一 task/checkpoint 檔名；若 pipe 到 tee，必須 pipefail，否則 node 失敗也可能被 tee exit0 蓋掉。背景測試記錄 session ID，poll 原 session，不重開一套並讓兩個 server suites 互搶資源。

長時間 FULL 另將 process exit 持久化到同一份唯一 log：有些續輪的執行環境會回收已結束的 session handle，完整 TAP 統計本身不能代替 process exit code。下列是留存方式（把 log 換成當包唯一名稱；沿用當包已核對的 TMPDIR）：

```bash
npm test > /tmp/relay-TASK-CHECKPOINT-full-suite.log 2>&1
relay_full_status=$?
printf '\nRELAY_FULL_PROCESS_EXIT=%s\n' "$relay_full_status" >> /tmp/relay-TASK-CHECKPOINT-full-suite.log
exit "$relay_full_status"
```

必須先保存原測試的 `$?`，最後回傳同 code，不能讓 printf／tee 的成功蓋過測試失敗。仍優先 poll 原 session；handle 只是觀察 timeout 時不得重啟。只有 authoritative handle 確實 missing，才改查已留存的完整 TAP 與 exit marker；沒有 marker 時誠實記錄 `complete-TAP / unconfirmed-exit`，不假報 exit0。新一輪必須用不同 log，保留原證據；運行期間的 source/test/config freeze 規則不變。

### 隔離重現：來源指紋不是完整測試副本

限定 `src/public/shared/test/scripts` 等根目錄的 hash 或 tar，能證明該清單中的版本，不能證明整個 repository／測試環境完整。FULL 也讀取 `deploy/` 的 systemd units；漏掉它會令 `robot-scripts`、semantic-recovery adapter/deploy/dry-run 等測試失敗，這是隔離環境缺檔，不是原版本的產品失敗。

建立診斷副本前：

1. 列出原版本全部 tracked 根項目、當前 dirty/untracked 清單與當包測試讀取的 repo 外／根目錄資源。
2. 在新、明確的隔離目錄先展開該 source HEAD 的完整 tracked tree，再 overlay 含既有未提交成果的 checkpoint archive；不能只有 HEAD 而丟掉 DSP，也不能只有限定來源 archive 而丟掉部署 assets。archive 外另有 dirty assets 時，明列並保存對應版本，不擅自用 HEAD 覆蓋。
3. 依赖優先重用既有隔離環境；只在新副本建立明確 symlink 時，也須核對解析到相同依赖，不改共享 package／lockfile／node_modules。錄音與輸出仍依本手冊隔離。
4. 驗證檔案存在、內容與 executable mode；指紋清單明列範圍。若有診斷補印，列每個差異，保留原 assert／fixture／deadline，不能把診斷副本的成功當成另一版本的 production gate。
5. 所有缺檔／缺工具失敗與真正 domain／timing 失敗分別記錄。运行中的副本不可補檔；等原 handle terminal 再修環境，另用唯一 log 重驗必要範圍。舊失敗證據不覆蓋、不刪除。

## 真實路徑 profiles：不是 npm test 的一部分

執行前完整讀當前 `.github/workflows/ci.yml` 或 `.github/workflows/production-browser-audio-proof.yml` 的對應 job。以下命令僅是測試步驟，不是完整環境安裝腳本。

- WT-LOOPBACK：`npm run test:webtransport-loopback`。需要 native HTTP/3、UDP、測試憑證/端口；檢查當前腳本的 port，不殺未知程序讓路。
- BROWSER-AUDIO：`npx --no-install playwright test test/browser/production-audio-proof.spec.mjs --workers=1 --reporter=line`。
- BROWSER-LISTENER：`npx --no-install playwright test test/browser/production-listener-proof.spec.mjs --workers=1 --reporter=line`。
- BROWSER-WT：`RELAY_PRODUCTION_AUDIO_PROOF_WEBTRANSPORT=1 npx --no-install playwright test test/browser/production-audio-proof.spec.mjs --workers=1 --reporter=line`。
- DOM：依 ci.yml 準備 static fixtures 與 shared 靜態路徑，再用 job 原列出的六個 interaction/geometry/history spec，最後 `scripts/ci-visual-geometry.sh`。不能漏掉 fixtures，跑到404後當 UI failure。

盤點時 production job 使用 Playwright1.56.0、Chromium 與 PulseAudio；visual job 用1.55.0與CJK字型。這些是現有 job 的事實，不要求在共享工作樹不停換套件。優先用現有隔離 CI 環境；本地缺環境就寫缺什麼與未跑範圍，不能讓 npx 偷裝最新版。安裝或環境變更先確認作用範圍，禁止改 lockfile 來讓 test runner 出現。

### 哪些卡需要哪些 proof

| 卡 | 必需實際路徑（除FULL） |
| --- | --- |
| A11/A20/A21 | production audio proof 在里程碑驗收；每刀另外有A/golden與適用PERF |
| S11/S30/S40 | production audio + listener；涉及直接 media 的接線另加WT |
| S20–S22 | production audio 里程碑；acoustic/physical route仍需真機，不以它推論已覆蓋 |
| B10–B12 | audio；B12另DOM |
| B20/B21/B22 | WT loopback + browser WT |
| B30/B31 | DOM；YouTube真實autoplay/交接另列人工實測 |
| B40 | listener + DOM |
| T10/T11 | audio→Take artifact proof，故障恢复靠隔離fixtures |

卡內通過但里程碑 proof 未完成，標 `integration-pending` 或明列「unit/full完成，milestone proof pending」，不可宣稱整體已驗收。

## PERF — 明確量測方法，不靠測試总時間猜效能

目前沒有專用 mixer-refactor performance harness；不能報已達成任何 p99 指標。第一次進A20/S11/B21時，先做 test-only harness checkpoint，再修改 production。

harness 規格：固定種子與相同 schedule，warm-up後收每 tick/drain duration；至少包括普通Mic+Backing、bounded slew、retained seam、gap/concealment、catch-up maxFrames。復用既有 fixture 生成方式，不 import 整個 `.test.ts` 觸發另一套測試；不更動golden digest。

前後各9次同Node/CPU/參數、串行執行，記錄median、p95/p99及樣本數、GC/allocation觀測、event-loop delay；benchmark不能以反覆讀真實錄音當input。B21另記queue高水位、outstanding數、重連循環後timer/listener數。

建議審查觸發線（不是產品SLO）：post median 超過 pre median + max(pre的10%, pre runs的3×MAD) 就暫不通過；再測並解釋原因。即使未超線，新 per-sample allocation/Promise/log、queue持續成長或舊timer作用新session都直接不通過。噪音太大時標結果不確定，不報「更快」。

既有 `test/loss-simulation.bench.ts` 是 real-server wall-clock lossy uplink cross-check，不是 mixer CPU benchmark。可補充跑，但不能代替上面的量測。

## 測試失敗的定位法

1. 保存第一個 failure與stderr，先單跑該檔；判斷behavior、source定位、環境或resource leak。
2. 把「production改動」與「新測試定位改動」分開看；禁止只因assert原碼文字就全刪。
3. source assertion 原保障是權威／順序：新owner的行為測試＋小型接線測試接替；原保障是禁止import／fsync primitive則繼續結構檢查。
4. 元件test全過、integration fail：查漏接call site、default clock、broadcast順序與reset入口，不先怪flaky。
5. 同基線也失敗才記 baseline failure，附相同命令/環境對照。不要把沒有跑過的基線寫成已知flaky。

結束前 source/test/config 指紋再取一次；若在FULL執行期間還改過程式，該FULL不能作最後驗收，必須針對最後版本重新跑。
