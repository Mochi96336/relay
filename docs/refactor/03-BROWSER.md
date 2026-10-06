# Browser：資源、epoch 與 callback 執行卡

不要在這一輪同時換框架、全改 TS、建全域 store，或改 window event／wire message 名稱。每刀先跑現有 production browser path 的適用基線，然後保留入口相容層。

## 1. Identity 字典：相同 number 型別不代表同一個 epoch

| Identity | 失效什麼 | 不等於 |
| --- | --- | --- |
| publisherSessionEpoch | 該次 Mic startup／stop／socket callbacks | captureGeneration、Participant/Mic lease |
| captureGeneration（Uint32 wire） | acoustic capture clock／packet generation | 換 WS 就換 generation |
| captureGraphEpoch + graph object | worklet/node/worker/device enumeration callback | capture generation；graph fence 還要 session/stream/context 一致 |
| publisherSocketEpoch | transport facade 的控制 socket listener／health correlation | publisherSessionEpoch |
| preferenceGeneration + writer/transport object | WT preference／未完成 datagram write | 寫入完成就證明 server accepted PCM |
| sourceEligibilityEpoch | 舊 health snapshot 不可重啟 diagnosis | publisher authority epoch |
| handoffId / commandId / authority epoch | 正式交接、命令收斂、目前播放權威 | playerReady、videoId 相同 |
| autoplayRecoveryGeneration | 舊 autoplay recovery timer | 新 play intent 已獲准 |
| Listen transportEpoch / micMuteEpoch | 各自的連線或 Mic restore callback | 同一個全域音訊 epoch |

測 async fence 必須驗證副作用：錯的 epoch 不得發 packet、改 gain、close 新 context、清新 queue 或發布錯的事件。只 assert return false 不夠。

## B10 — Capture graph 資源 owner

前置：S40（或經記錄的穩定 server baseline）。白名單：`public/app.js`、擬新增 `public/mic-capture-graph.js`／必要 `.d.ts`、`test/mic-capture-graph.test.ts`、既有 capture/publisher lifecycle tests。

### 先搬哪一群

1. graph 物件建立、source/capture/silent nodes、graph-local listeners 與 visual worker disposal。
2. devicechange 與 processorerror listener 的安裝／撤銷。rebuild/finish 的政策仍呼叫已有 recovery owner 與 session command。
3. worklet callback 與 analysis worker callback 接線；`handleCaptureWorkletMessage` 裡的 cursor/generation/uplink 語意先留 session，不能順手搬光。

精確符號：`installCaptureGraph`、`disposeCaptureGraph`、`captureGraphIsCurrent`、`captureTrackDeviceId`、`rebuildCaptureForInputDeviceChange`、`attachMicVisualAnalysisWorker`、`submitMicVisualAnalysis`、`returnCaptureBuffer`。逐個標記 graph-resource vs session-policy，不能看名字就全搬。

擬介面：`createMicCaptureGraph({sessionEpoch, graphEpoch, stream, context, isCurrent, onCaptureMessage, onProcessorError, onDeviceEvidence})` 回 graph handle；handle 擁有 nodes/listeners/worker 與 `dispose()`。不是強制逐字照抄，先檢查所有 callback 是否有限且具名，不許用任意 `appState`。

graph 不停止整個 session 的 stream、不關 session context、不發 release-mic。session teardown 擁有 track.stop/context.close；graph dispose 只處理它自己建立的資源。

### 原 current guard 必須完整保留

```text
activeCaptureGraph === graph
AND graph.epoch === captureGraphEpoch
AND isCurrentPublisherSession(graph.sessionEpoch)
AND mediaStream === graph.stream
AND audioContext === graph.context
```

不可因 graph.epoch 已唯一就刪 stream/context/object guards，也不可在 constructor 安裝 listeners 時假設 graph 已是 active。原本 active 指派在 graph 安裝末尾，保留 callback admission 時點。

### 資源表

| 資源 | 建立者 | 收尾 | stale 完成後 |
| --- | --- | --- | --- |
| MediaStream | publisher startup | session stop tracks | 只能清理當次捕獲的舊 stream |
| AudioContext | publisher session | session close（可能 await） | 不得把全域新 context=null |
| source/capture/silent nodes | graph | disconnect 原物件 | 不得斷新 graph |
| capture port handler | graph | onmessage=null | current guard 之前不能推 cursor |
| devicechange / processorerror listeners | graph | remove 同一 listener | 不可 rebuild 新 session |
| visualAnalysisWorker | graph | terminate 舊 worker | 舊分析不能更新新 meter |
| deviceChangeCheckPending | graph | graph-local finally 清除 | 不能清新 graph 的 flag |
| capture watchdog | session/recovery 編排 | 對應 stop/rebuild 邊界 | 不併入 graph constructor 私開第二個 timer |

必測：dispose 兩次；舊 enumerateDevices promise 晚到；filtered/empty device list 不等於裝置消失；同 live track 由 A 自動換 B 是 replacement；processorerror 一次花完既有 rebuild budget，不能無限重建。

buffer ownership：送入 worker／transport 後可能 transfer/detach；保留現有 returnCaptureBuffer 協議。不能為了 unit test 把所有 PCM 都 `.slice()`，也不能提前回收仍被 retransmit cache 引用的 bytes。

Gate：profile B-CAPTURE＋FULL＋BROWSER-AUDIO；graph 新 unit 要跑真實新 owner 配 fake WebAudio dependencies，不只是讀 app.js 字串。

## B11 — Uplink health correlation

白名單：app、擬新增 `public/mic-uplink-health-state.js`／`.d.ts`／unit test、現有 publisher/capture health tests。server ACK 協議不改。

搬移 state 群：drop counters/byReason、gap samples、clippingSinceHealth、clippingRevision、pendingCaptureClippingHealth。level/visual evidence 的 current capture 判斷仍在 session；graph 不持有另一份 health state。

移動函式：record drop 的純計數部分、clipping snapshot、ACK settlement；DOM warning 文案/節流留 presenter 或薄 callback；`sendAudioUplinkHealth` 的 socket authority 決策留 session/transport。

### 必測具體序列

| ID | 時序 | 必須成立 |
| --- | --- | --- |
| HC01 | 新 capture 尚未見 clipping-capable worklet | recentDetected 保持 unknown/null 契約，不捏造 false |
| HC02 | clipped→送 request A(revision1)→A ACK | 清該已確認 interval；lifetime 證據不消失 |
| HC03 | clipped→A→再 clipped(revision2)→A ACK | 新 clipping 不被清掉 |
| HC04 | A→B→B ACK→A ACK | B 結算舊 correlation；A 不再有權撤銷任何新狀態 |
| HC05 | request A→socket authority reset | 清 request map/liveness；未確認 interval evidence 保留 |
| HC06 | 舊 generation ACK／不合法 request ID | 不 settle clipping，也不刷新 command freshness |
| HC07 | capture backlog 與 disconnected drops | 原因分類／warning 節流與 sample 數不變 |

ACK admission 的 version、Uint32 generation/id、session/capture current、PublisherCommandLiveness.noteAck 都保留；新 health state 不自己推論 socket ownership。

Gate：profile B-CAPTURE＋FULL＋BROWSER-AUDIO。禁止把 request map 改成「只記最後一次」，除非另案證明協議改動。

## B12 — Publisher session 與 presenter

白名單：app、擬新增 `public/mic-publisher-session.js`／`.d.ts`／unit test、必要 lifecycle tests。禁止同時更動 server registration 與 transport facade 的 API。

先讀：startPublisher、requestPublisherStart、stop、finishMicrophoneSession、connectPublisherSocket、schedulePublisherReconnect、restartPublisherConnectionForGeneration、rebuildPublisherCaptureGraph、handleServerMessage。

session 收走 startup/capture-generation/socket/reconnect 的 state；app 保留 DOM bindings、slider touched state、localized rendering。既有 `MicStartupGate`、`MicCaptureRecoveryWatchdog`、`MicLifecycleTransaction`、`PublisherCommandLiveness` 注入或組裝，不再造第二套同義物件。

### stop 的兩段式清理（按現有序列，不可改成 await-first）

同步段：前進 session epoch → cancel startup/probe/reconnect/health/watchdog → 捕獲 closingSocket/Stream/Graph/Node/Context → 清目前 references、freshness、graph epoch → 按原條件 send release/close transport/socket → stop captured tracks/dispose graph → 發 local inactive/reset counters/UI。

非同步段：只 await **closingContext**.close() → 回 stoppedEpoch。沒有更多「重設目前 session」的動作。

finishMicrophoneSession 等 stop 回來後，只有 stoppedEpoch 仍 current，才能 dispatch ended／執行 afterEnded。這不是 optional best effort。

新增 deferred tests：

1. start A 的 getUserMedia 未完成 → stop A → start B → A resolve：A 只能清舊資源，不註冊 publisher。
2. A stop 的 context.close pending → B 已 active → A close resolve：B 不失去 active/graph/socket，沒有 A 的 ended 事件覆蓋 B。
3. socket A reconnect promise 晚完成 → generation 已換：關 A，不 adopt，不發新 capture 的 registration 到 A。
4. revoke/superseded 是語意終止，不因 close callback 自動 reconnect。
5. track mute/unmute/ended 來自舊 capture：無新 session 副作用。

可測性要求：以 factory + injectable platform/clock 跑真實 session code，不把新類別的 methods 全 stub 掉只測你安排的假的順序。舊 source-regex tests 每移除一項語意 assertion，要有上述行為測試接替及小型 wiring test。

Gate：profile B-CAPTURE＋FULL＋BROWSER-AUDIO＋DOM。window.relayActiveRole、relay-local-mic-level、relay-microphone-* 事件與本地 meter 時效保持相容。

## B20 — Retransmit cache（先做封閉資料結構）

前置：B12。白名單：`public/audio-transport.js`、擬新增 `public/audio-retransmit-buffer.js`／`.d.ts`／test、既有 browser retransmit tests。

實際 state：`retransmitBufferPackets`、`retransmitBuffer`、`retransmitGeneration`、`retransmitAnswered`。搬 `clearRetransmitBuffer`、`rememberForRetransmit`，再搬 attempt reservation/rollback bookkeeping；真正 resendPacket 與 transport counters 留 facade。

重要更正：現行 buffer 是 packet-count bound，**沒有 TTL**。不要照「expire cache」這種泛稱偷偷加時間淘汰。Map 依插入順序，重複 sequence 是 delete 再 set，會移到末端；讀取不更新順序，不能改成一般 LRU。

擬介面：remember(bytes)、clear()、reserveAttempt(generation,sequence,attempt) 回 `{bytes, release}` 或 null。reservation 在交給 live path 前標記；sync reject、queued repeat expire、write fail 用原 release 語意撤回。不要把 reserve 改成「write resolve 才算 answered」，會改雙路去重時序。

必測：budget=0、非法packet、generation切換全清、超容量移除最舊及 answered、duplicate sequence重插、wrong generation request、same attempt雙路去重、higher attempt、sync rejection後可重試、舊 attempt release 不能覆蓋較高 attempt 的記錄。

release callback 對 capture 換代的行為先與現碼對照；若發現原本存在跨代問題，另立 bug，不在抽取時加一個新 epoch 後把新行為當基線。

Gate：profile B-TRANSPORT＋FULL＋WT-LOOPBACK＋BROWSER-WT。不能因新 cache unit 過了就刪端到端 byte-for-byte retransmit 測試。

## B21 — Datagram backlog 與 outstanding writes（分兩個 checkpoint）

白名單：audio-transport、擬新增 `public/datagram-send-queue.js`／`.d.ts`／unit test、必要既有 transport tests。`MicMediaPathRecovery` 算法不改。

先 inventory：datagramBacklog、pendingDatagramWrites、outstandingDatagramWrites、nextDatagramWriteId；以及 take/expire/flush/release/pump/reset、writeDatagram 中全部 read/write。不要只搬 enqueue 而留下 cleanup 碰另一份 map。

### 四種「成功」不能混為一談

1. enqueue：只是本地 backlog。
2. writer.write 被呼叫：submitted，不一定離開。
3. write promise resolve：不是 application accepted PCM。
4. server 接受 PCM 的 health/evidence：原 recovery policy 的 authority。

### 原 completion fence

`generation === preferenceGeneration && writer === datagramWriter && transport === webTransport` 三者都要相符，才可 delete pending write、更新 outstanding count、pump backlog、累計本代 send failure、demote 本代 WT。

但 rejection 的 `onFailure?.()` 原本在 ownsCapture guard 之前執行：失敗的舊 repeat 仍需釋放它的 reservation。不能為了「所有 stale callbacks 都 return」把該 cleanup 跳過。

兩刀：B21a 封閉 backlog 的 take/expire/discard/release；B21b 封閉 pending writes 的 registration/settlement。epoch authority 先留 facade，由明確 current predicate/identity input 接進去；不要各自生成另一套同義 generation。

案例矩陣：

- 老 writer pending→close→新 writer submitted→老 resolve：新 count 不減。
- 同時序老 reject：onFailure 依原語意一次，但不 demote 新 WT。
- writer.write 同步 throw 與 promise reject 各走原路，不統一成新 async 路徑。
- 原 packet 與 retransmit packet 的 submitted／retransmitted counters 不互算。
- backlog 尚未交 writer，demotion 後可 flush fallback；已 submitted 的 packet 不盲目 replay。
- queue count/age 邊界、datagram budget shrink、source ineligible boundary、close/rebind。
- resolved writes 但 server 不前進：不可由 unresolved-write watchdog 冒充另一種 semantic recovery。

Gate：profile B-TRANSPORT＋FULL＋PERF＋WT-LOOPBACK＋BROWSER-WT。

## B22 — Preference lifecycle owner（條件式）

只有 B20/B21 後 facade 仍有可封閉的 offer/retry/quarantine/timer state 群才開。必須先列 `prefer/demote/retry/close/bind/unbind` transition table，保留 constructor options/defaults、holdMediaUntilPreference 的 bounded hole 行為。不得自行引入新 enum 或合併 recoveries。

## B30 — YouTube player adapter

前置：S31、B12。白名單：`public/youtube.js`、擬新增 `public/youtube-player-adapter.js`／必要型別／test、既有 player/handoff tests。`source.js` 暫不改。

adapter 只管 API load/ready、player instance、readSnapshot、player commands 與 events。既有 `serverMutation`／commandId／handoff decision 暫留 controller。不能把播放器事件直接當 room intent。

先搬 API loading 與 snapshot，再 player event binding，最後命令 adapter；保留前一個 `window.onYouTubeIframeAPIReady` handler 的協作及 script error/retry 行為，不能把全域 handler 無條件覆蓋。

snapshot 欄位、時間單位與 telemetry cadence 不改；mute/play/pause/seek/rate 呼叫次數與順序需要 fake player trace。player API ready 不是已可聽 proof。

Gate：profile B-PLAYBACK＋FULL＋DOM。若新 adapter 本身依賴 room authority 或 Take state，邊界切錯，先縮回純 player 操作。

## B31 — Handoff transaction owner

白名單：youtube、擬新增 `public/playback-handoff-session.js`／test、既有 handoff tests。既有 convergence、continuation、terminal、timing helpers 繼續使用。

state 分組：正式 pendingHandoff + ready/commit timers；speculativePrewarm + timer；outgoingHandoffId + release timer；autoplayRecoveryRequired + generation/timer。可由同一 owner 組裝，但不把四個群壓成一個 `playing` boolean。

每組 timer 記錄建立者、取消入口、captured identity、callback 是否仍 current。cancel/complete/release/rollback/error/reconnect 要逐個映射，不能只在 happy-path complete 清 timer。

| 情境 | 必須維持 |
| --- | --- |
| speculative prewarm | 不取得正式播放權威；timeout 可以退役 speculative 資源 |
| prepare ready | 只證明準備，不自行 promotion |
| server commit | 按原 room clock/handoff timing 操作，等待既有證據／結果協議 |
| local commit watchdog | 是 server deadline 之後的安全網，不能取代 server authority |
| outgoing release 晚到 | 只作用於對應 outgoing handoff，不能 mute 新的正式播放 |
| autoplay retry 晚到 | generation/play intent 不符則不可啟動舊意圖 |
| review/reconnect/cancel | 使用既有 continuation/restore policy，不按單一 paused 狀態猜 |

保留既有常數：commit fallback 6500ms、speculative timeout 15000ms、outgoing fallback 2000ms、realign threshold 0.75s；這些是盤點基線，不是建議調參。

Gate：profile B-PLAYBACK＋S-SONG＋FULL＋DOM；真實平台的 autoplay／YouTube 限制若未測，列未驗證，不用 fake player 綠燈宣稱解決真機限制。

## B40 — Listen 的 connection／graph 分層

前置：B31。白名單：listen、擬新增 `public/listen-session.js` 或兩個具名 connection/graph 模組、unit tests、既有 Listen tests。不要複製 decoder/resampler/continuity/iOS recovery。

先 connection 再 graph；保留入口只在四個 DOM controls 都存在時啟動的條件。Opus decode 失敗後本頁 `opusRefused` 的 lifetime 不等於 socket lifetime，不得 reconnect 就重新 offer。

mute truth = userMuted OR micForcedMuted OR roomMicForcedMuted OR playbackForcedMuted OR takeReviewForcedMuted。顯示 reason 原優先序是 Mic → playback → review。移除一個 cause 不能清其他 cause。

測試：Mic+review 同時 mute，Mic解除仍保持review；兩個 Mic epoch 的晚 restore 不解除新mute；pending socket 舊 open 不 adopt；Opus錯誤退回PCM；AudioContext resume舊結果；成功running後重設 consecutive stalled-resume budget，不當頁面一生的點擊次數。

Gate：profile B-LISTEN＋FULL＋BROWSER-LISTENER＋DOM；iOS physical route 仍列真機需求。
