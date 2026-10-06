# Server：保留 authority，搬完整的編排邊界

前置：00-EXECUTION、04-VALIDATION、SESSION_MODEL、ARCHITECTURE_BOUNDARIES。以下擬新增模組均是 application orchestration，不是新的 domain truth。

## 1. 接線規則

1. 舊 domain owner 的資料不得複製成 assembly 自己的第二份 cache。查詢採 read-only facts 或窄 `Pick<Owner, ...>`；命令走具名 methods。
2. 可以傳入 `publish`、clock、邊界 command ports；不可以傳整個 `ServerContext`，也不使用 runtime registry/service locator。
3. 領域 assembly 可依賴同一 domain 的 owner；domain owner 不可反向 import server/assembly。
4. 跨領域呼叫不能藉新 event bus 隱藏。每一個 transaction 的 effect-order 應仍可由同步程式與測試直接看見。
5. 不把所有 query 收成 `getState(): any`。只傳目前方法需要的 facts；方法需要 live truth 時必須在原時點取樣，不提前 cache。
6. coordinator 有時只保護順序，這是有效用途；但抽取工作完成後 server 應確實少掉一群決策／接線，不是新增 forwarding module 後原樣留下原函式。

## S10 — status facts collection

前置：A21（若音訊卡經明確記錄 defer，可從已驗證 A20 後進）。白名單：`src/server.ts`、擬新增 `src/relay-status-facts.ts`、對應新 unit test、下列現有 status/boundary tests。`relay-status-projection.ts` 原則不改，因 pure projection 已存在。

先讀完整函式：`readinessRouteMode`、`readinessPayload`、`remoteStatusFacts`、`productStatusFacts`、`remoteStatusPayload`、`observationStatusV1Payload`、`productStatusPayload`；查每個被呼叫 getter 是否純讀、可能清過期資料或可能 settle domain。

### 分兩個 checkpoint

- S10a：只搬 `remoteStatusFacts` 與它專用的 `frameAgeMs`；既有 payload wrappers 留在 server。依賴用「mix/mic/participants/monitor/readiness」分組窄 ports，不改 payload shape。
- S10b：再搬 readiness/product collectors。原有 source-contract tests 對函式定位的變更要同包處理；將來 factory 裡的方法可用新的 owner 定位，不保留死函式騙測試。

擬定形式：`createRelayStatusFacts(readers)` 回傳 `remote(nowMs)`、`product(nowMs)`、`readiness(nowMs)`。先做當前 checkpoint 需要的方法，禁止一次補全所有 status/diagnostics 邏輯。

### 取樣契約（必測）

| 入口 | 現有取樣點 | 不可改 |
| --- | --- | --- |
| remoteStatusPayload | 自己取 performance.now，再收 remote facts | 不使用上次 broadcast 的 cached facts |
| remoteStatusFacts | alignment、participant snapshot、mix health、monitor recentDrops(now)、readiness(now) | readiness 不在 projection 再次向 runtime 問 |
| productStatusFacts | readiness、participants、room、timeline age、Take status、alignment、calibration status | 不因已收 readiness 就任意刪其餘實際需要的查詢 |
| observationStatusV1Payload | 先 remote payload，再取額外 lease/sample-rate facts | 不假裝這早已是單一原子 snapshot；先保留原讀取次數與順序 |
| broadcastProductStatus | JSON.stringify 比上次內容；相同則不送 | 不新增 observedAt 字段造成每 tick 都 broadcast |

查詢的過期資料清理（例如 recentDrops）可能是既有 housekeeping；「只讀 collection」指不新增 calibration settle、ownership commit 或其他 domain mutation，不是擅自改掉既有 getter 行為。

新增 tests 用可記錄 calls 的窄 ports：assert 同一入口傳遞同一 nowMs、所需 snapshot 次數、呼叫順序、結果交給既有 projection；現有 integration 驗證 payload shape。不得只測新 collector 返回你自己寫的固定 fake object。

Gate：profile S-STATUS＋FULL；legacy attention 不加欄位、observation v1 不升級 shape。若新 collector 要觸發 `syncAppliedCalibration()` 才能正確，停止：這跨到 settlement，不是 status 重構。

## S11 — mix pump，先 step 後 scheduler

前置：S10。白名單：server、擬新增 `src/relay-mix-pump.ts`／unit test、必要 server/audio evidence tests。不能改 AudioSession 算法、packet receiver、Take writer。

### 分刀

1. 抽 5ms callback 為具名 `tick`，先由 server 原 setInterval 呼叫，保持建構／啟動時點。
2. 將 ingest 的 `processPublisherFrame`／`deliverMicPackets` 放進同個 media 編排單位；如果 scalar health 記錄過大，明列未搬部分，不為硬搬而傳巨大 context。
3. 最後封裝 start/stop handle；不得變成 owner constructor 裡偷偷開 timer，也不得等 HTTP listen 成功才啟動（可能改掉 await Opus/WT 啟動期間的行為）。

### 固定 trace

```text
tick:
  若存在 Mic transport:
    nowA = performance.now
    serviceRetransmits(nowA, session.liveMicHeadroomMs)
    flush(nowA) → 依 packets 順序 ingest
  session.drain(emit)             # 保留 drain 目前自己的時間取樣/default maxFrames
    每 emitted frame:
      nowB = performance.now      # 不是整批共用 nowA
      Take.append(frame, quality(nowB), evidence, position)
      monitor.broadcast(frame, true, position)
      audibility.observeFrame → 有結果才 report
      level.observeFrame → 有變化才 report
  reportMicTimelineFolds()
```

ingest 也有固定順序：transport/rate guard → 必要時 startLiveSource → ingestMic → 只有 accepted samples.length>0 才 noteMicFrame → received meter evidence → clock drift observe／trim → captureRestarted cleanup → fallback prime → calibration observe → validator observe → transition noteMicProgress。

不要把有 bytes 但 ingest 沒接受的封包變成 live-flow proof。不要使 `drain` callback async；Take append／monitor 的同幀關係不可經 promise queue 重排。

新增 tests：無 transport 仍 drain；flush 一次出多包保持順序；drain 出多幀各有 nowB；zero accepted samples 不 noteFrame；stop 重複呼叫；start/stop 不創兩個 interval；shutdown 不再發新 frame。

Gate：profile S-MEDIA＋A＋FULL；shutdown 測試先凍結 sample frontier，再 finalize Take，再 stop WT／socket。不要順便改 process.exit／error handling policy。

## 2. 250ms tick 順序表：S20–S22 都受這個限制

目前 `youtubeTimelineTimer` 一次 callback 先取 monotonic `nowMs`，依下列順序執行。每項的 branch guard 也保留。

| 序 | 原操作 |
| --- | --- |
| 1 | 有 telemetry 且到 refresh 時點：timeline、room status broadcast |
| 2 | roomSongCommands.sweep；若 expired，failure 再 command status |
| 3 | calibration collecting：silentSides → fail；否則 calibration.tick → 必要時 timing status |
| 4 | active mix 到 health cadence：更新 lastMixHealthAt，再 mix health broadcast |
| 5 | takeExpiredRequest → failProbeAttempt |
| 6 | dropLegacyCalibrationForRobot |
| 7 | syncAppliedCalibration；若 changed，source status 再 timing status |
| 8 | maybeFinishProbeAnalysis |
| 9 | maybeStartProbeCalibration |
| 10 | maybeReapplyBootCalibration |
| 11 | sweepRobotContentTransition |
| 12 | maybeAutoCalibrate |
| 13 | maybeValidateContentCalibration |
| 14 | sweepPreparedSongHandoff |
| 15 | participants.sweep(Date.now())；必要時 owner effects、grace/media cleanup、session broadcast |
| 16 | broadcastProductStatus |

禁止新增三個不同 interval 分別跑 timing、presence、Song；禁止把第15項 Date.now 換成 nowMs。各 assembly 暴露 step methods，由原外層逐項呼叫；確定整體 trace 一致後才能合併鄰接步驟。

## S20 — Robot mapping 編排

白名單：server、擬新增 `src/relay-robot-mapping-orchestration.ts`／test；既有 mapping/transition coordinator 接線與定位測試。mapper／offset／transition 的算法不改。

盤點函式群：`robotRouteActive`、`robotDeltaIsFresh`、`robotContentMappingReady`、`robotContentEvidenceMappingReady`、`mappedContentBackingStart`、`robotFollowerSeekMayPreserveMapping`、`clearRobotContentTransition`、`revokeRobotContentMapping`、`revokeContentMappingOnRateChange`、`beginRobotContentTransition`、`reconcileRobotContentTransitionWithFreshDelta`、`noteRobotTransitionBackingFrame`、`requestRobotBackingBoundary`。

分兩刀：先 route/readiness facts 與 mapping helpers，再 lifecycle transactions。不要同時搬 CalibrationSession／SourceRuntime 所有 constructors；既有 owner instance 可以透過窄 port 注入，此時完成的是 orchestration 邊界。

### Revocation 的不可拆交易

```text
resetPlayerOffset
resetContentTimeline
clearContentTransition
invalidateSourceMapping           # 前進 reference generation
discardPrimedContent
clearContentValidation
abortCalibrationIfCollecting(reason)
syncAppliedCalibration
reportSourceStatus
reportTimingStatus
```

全部重用既有 `relay-robot-content-mapping-revocation-coordinator`，不要另写「差不多」版本。測舊 analysis deferred result 在此交易之後回來，不能重新 promotion。

transition commit 保留：noteBackingBoundary 拒絕則完全不提交；成功後依 flag restart working evidence／cancel collecting validator；先 feed confirmedPreChunks，再對 postChunks map；map=null 的 post chunk 不 feed。

Gate：profile S-TIMING＋FULL。route predicate 不讀 PROBE_CALIBRATE；strategy predicate 才讀。映射 readiness 與 evidence readiness 不為名稱相近而合併。

## S21 — Boot probe workflow

白名單：server、擬新增 `src/relay-boot-probe-orchestration.ts`／test、對應 routing/boundary tests。保留 BootProbeRuntime、boot-probe policy modules、CalibrationSession 的算法與 authority。

函式群：`probeGeneration`、`bootProbeContext`、`probePathReady`、`failProbeAttempt`、`sendProbeRequest`、`maybeStartProbeCalibration`、`acceptCurrentProbeClientResult`、`handleProbeReply`、`handleProbeFailure`、`promoteBootProbeCalibration`、`maybeFinishProbeAnalysis`、`maybeReapplyBootCalibration`。

每個 async entry 先寫 identity 表：requestId、target、capture generation、run/context revision，各在哪裡產生、何時失效、completion 先檢哪一個。不能用 source rate 相同推論 capture 沒換。

擬定 methods：`stepAnalysis(nowMs)`、`stepAdmission(nowMs)`、`stepReapply(nowMs)`、`handleReply(...)`、`handleFailure(...)`、`abandon()`；由原 tick/handlers 在原時點呼叫，不另起 scheduler。

必測拓撲表：有 Mic/無 Mic、有 Backing/無 Backing、Robot/legacy、probe flag on/off、Take recording/finalizing/idle；不必把所有組合都允許，但每個 admitted 組合必須有成功或 bounded failure 終點。

補 deferred result cases：回覆 requestId 錯、generation 錯、已 timeout、已 abandon、新 run 開始後舊 worker 回來；斷言沒改 confirmed revision、沒改 mixer alignment，不只斷言函式 return false。

Gate：profile S-TIMING＋FULL；成功 settled probe 與 exhausted probe 都不能永遠卡住內容 calibration successor。

## S22 — Calibration 編排與 applied authority

白名單：server、擬新增 `src/relay-calibration-orchestration.ts`／test、必要 boundary tests。禁止擴大 TimingRuntime 權力；其既有 boundary test 是設計限制，不是待移除障礙。

函式群分三刀：

1. `calibrationContext`／applicability／desired lag／`syncAppliedCalibration` 的組裝。
2. content baseline sync/clear/cancel、auto admission、validation path admission／step。
3. manual recalibration、live source stop、Mic timing invalidation 的跨領域 ports 接回既有 coordinators。

狀態 tuple 明列：`route`、`candidate kind`、`confirmed revision + authority kind`、`applied mixer alignment`、`retained fallback`；不能只保留一個 calibrationKind。

必測：candidate boot-probe 失敗、原 confirmed content 保留；先讀/不讀 status 都有相同 provenance；background content collecting 不假報 room preparing；但被 admitted Take 必須 stand down。

Take start 的現有順序是：frame boundary → Song snapshot → synchronous startTake → 若拒絕只回 reject → 若成功 cancel validation（有變更才報）→ standDown calibration（有變更才報）→ acceptStart。禁止在 `startTake` 前先取消背景工作。

Gate：profile S-TIMING＋S-STATUS＋FULL；若 assembly 發生 circular init，不以 mutable `let x!` + setter 解套。先畫依賴：status 經 readonly query port；calibration events 經 publisher port；construction 與 start 分離，不在未完成組裝時產生 callback。

## S30 — Mic lifecycle assembly

白名單：server、擬新增 `src/relay-mic-lifecycle.ts`／test、Mic coordinator wiring tests。ParticipantSession／MicRuntime／grace 的 authority 不重寫。

把 activation、release、disconnect、grace expiry 的配置放同一 assembly；不要把各 operation 的 effects 混成一個 `handle(event: any)`。對外保留具名 activate/release/disconnect/expire 入口。

### Publisher activation 順序（lease admission 已先完成）

1. apply ownership effects；timing invalidation 與 handoff preparation 此時先 deferred。
2. bindPublisher：這才是 media authority 的切換點。
3. captureReplaced → 同步 retireReplacedCapture，不能先 await。
4. 若有不同 previous publisher，retirePrevious。
5. cancel grace → setMicExpected → 必要時 noteTransportConnected。
6. deferred ownership timing reason 優先；否則 captureReplaced 才用 capture-changed reason。
7. restartLiveSource → sendRegistered（含當前 direct offer）→ initial state → status。
8. 有 participant 才 broadcast session；最後才 begin deferred handoff。

### Disconnect 不是 release

非 current publisher close → 無效果；current close → noteDisconnected → 取 reconnect owner → detach。

- 可 reconnect：preserve media/grace，不因 socket=null 撤掉活的 WT。
- 不可 reconnect：clear media，再 maybeStopLiveSource。
- 之後才 fail collecting calibration、cancel/report validation、report status。

Mic explicit release 另外保留 `relay-mic-release-coordinator`：quality effect 前後 hooks、cancel grace、cleanup before timing、cleanup exactly once、session broadcast、released reply。不要拿 disconnect 流程代替。

新增 matrix：same participant/same capture、新 capture、different participant takeover、stale replaced socket close、WT alive/control down、grace expired 後舊 frame、take recording 中 release。每格驗证 lease、media、mix generation、timing revision、Take event。

Gate：profile S-MIC＋S-MEDIA＋FULL。

## S31 — Song lifecycle assembly

白名單：server、擬新增 `src/relay-song-orchestration.ts`／test、Song coordinator routing tests。SongSession、RoomSongCommandRuntime、PlaybackTransportRuntime 仍各是 owner。

先移 command accept/cancel/timeout 與 telemetry rejection；再 handoff send/prepare/result/sweep/continuation。公開 API 各自具名，不讓 room command 與手動本地 player 操作共用同一 admission。

必要 truth table：newer accepted intent vs older pending intent；prepare target ready 但尚未 promotion；commit proof expired；舊 participant transport reconnect；outgoing holder 收到 late release。結果以既有 tests 的精確 authority/holdover 契約為準，不自行設計新的播放產品規則。

Gate：profile S-SONG＋FULL。抽取完成後每個 commandId／handoffId／authority epoch 的判斷只由原 owner 決定；組裝層只排序效果。

## S40 — 收薄 server，停止繼續造小轉接檔

前置：S10–S31 都有已驗證 checkpoint。只做已搬完責任的清除與組裝整理，不新增 domain 行為。

逐一列原26個 coordinator：保留的順序契約、所屬 assembly、production callers、測試。可將無額外價值的單純轉接合併回所屬 assembly，但每次只合併一群，保留語意測試；不要總清理。

server 的驗收不是特定行數：剩下 config/resource construction、protocol 接線、tick order、start/shutdown；不應再藏新的 mapping policy、publisher retirement 條件、handoff 判定。

最後檢查 constructor/start 相對於 await Opus/WT、HTTP listen、WSS close、gracefulShutdown 的順序。啟停有既有 race 時另案，不借這刀換生命週期。

Gate：全部 S profiles＋FULL；required production proof 依04的對照表。未跑 proof 時標 integration-pending，不說全案完成。
