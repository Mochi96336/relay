# S40：原 26 個 coordinator 的責任與 caller

基線為 S31b C2 verified：wt9 HEAD `7b5d550682d43ae8eba3f55aeff3bf0b239ba056`，801 檔 fingerprint `46b6bb39be90d9dc1104ae87221c48969d75d204fc2601d1ac272b97672e02b4`，FULL 3370/115/process0。這是目前的 production inventory，不是已完成的 S40 清理清單。

下表名稱省略 `relay-` 前綴與 `-coordinator` 後綴。每項原算法在 `src/relay-<名稱>-coordinator.ts`，原 unit 在 `test/relay-<名稱>-coordinator.test.ts`；原算法／unit 保留。順序描述包含 guard，不能只保留成功路徑。

| 名稱 | 目前配置 owner | Production caller／入口 | 必須保留的順序契約 |
| --- | --- | --- | --- |
| audio-uplink | server | socket binary → handle | Mic 優先；Backing admission→decode→generation/clock→ingest→accepted-flow→restart→transition→mapping→evidence |
| backing-activation | server | registration backingHello → activate | previous→clear transition→retire capture→quality→retire previous→rate/bind/expected→connected quality→legacy drop→replacement timing→registered→start |
| backing-capture-restart | server | uplink capture restart → restart | clear transition→quality→abandon→clear validation；collecting 只 fail，否则 sync→timing→source |
| backing-disconnect | server | socket close 的 !replaced fence 內 → handle | active guard→quality→clear transition→detach→expectation→calibration→validation/report→source→status |
| backing-grace-expiry | server | BackingRuntime grace callback → expireBackingGrace | caller 取 room/Mic facts；song 或無 Mic 就 stop，否則 retire route→clear transition→timing invalidation→status |
| boot-probe-calibration-promotion | Boot probe assembly | promotion → promote | mutate probe→mark authority→取 result→apply external result |
| boot-probe-failure-settlement | Boot probe assembly | failProbeAttempt → settle | terminal restore candidate→fail preserving primed；retry 只 report timing |
| live-source-stop | Calibration lifecycle | stopLiveSource → stop | cancel grace→retire route→active guard→Take end→clear boot/validation→reset mapping/transition→session stop→calibration/timing/schedule→timing/source/status |
| manual-boot-recalibration | Calibration lifecycle | manual command → restart | clear validation→begin external→sync→manual probe→abandon→correlation reset→admission(now)→timing/source |
| mic-capture-restart | Mic lifecycle（S40b verified） | Mix pump ingest 的 captureRestarted → restart port → relayMicLifecycle.restartCapture | quality→abandon→clear validation；collecting 只 fail，否則 sync→timing→source；其後才新 PCM evidence consumers |
| mic-disconnect | Mic lifecycle | socket close fence 內 → disconnect | current guard→quality→reconnect owner→detach→preserve 或 clear/stop→calibration→validation→status |
| mic-release | Mic lifecycle | release-mic → release | ownership quality hook→cancel grace；timing 前 cleanup；cleanup exactly once→session status→released |
| mic-timing-invalidation | Calibration lifecycle | Mic timing command → invalidate | capture-changed 保留既有 timing authority 路徑；其他 reason 清 timing/schedule；兩路 sync→timing→source |
| playback-disconnect | Song lifecycle | socket close fence 外 → disconnect | identity guard→clock→pending/fail/report→conditional detach→timeline/room |
| playback-registration-continuation | Song lifecycle | playbackHello register 後 → continueRegistration | registered→room/default→command/default→plan/default→prepare→另 clock→pending→apply |
| publisher-activation | Mic lifecycle | admitted publisher registration → activate | ownership effects deferred→bind→retire capture→retire previous→grace/expectation→timing→restart→registered→initial/status→session→deferred handoff |
| robot-activation | Robot mapping source lifecycle（S40c verified） | admitted Source attach 後 → relayRobotMapping.activateSource | replacement notify/quality/abandon/fail，或 first-connect quality；reset offset/timeline/transition→legacy drop→sync→source/timing |
| robot-content-mapping-revocation | Robot mapping lifecycle | revoke／rate change／destructive seek | offset→timeline→transition→reference generation→primed→validation→collecting fail→sync→source/timing |
| robot-content-transition-commit | Robot mapping lifecycle（S40a verified） | RobotContentTransitionRuntime.host.commit → relayRobotMapping.commit | boundary 拒絕無後效；discard 才 restart／讀 validator／cancel；pre chunks 原順序→post map→非 null 才 feed；同步 throw 不吞 |
| robot-disconnect | Robot mapping source lifecycle（S40c verified） | socket close fence 內 → relayRobotMapping.disconnectSource | active guard→quality→detach→offset/timeline/transition→abandon→collecting fail→sync→source/timing |
| robot-legacy-calibration-drop | Robot mapping source lifecycle（S40c verified） | tick #6／Backing原wrapper→root.dropLegacyCalibration，Robot activation內部same drop | route/content guard→boot settled guard→validation→calibration/kind/schedule reset→sync |
| room-song-command-acceptance | Song command assembly | admitted room command → accept | accepted ack→pending identity recheck→matching apply→command status |
| song-handoff-result | Song lifecycle | ready／failed handlers 的 identity guard 後 | markReady→commit→timeline/room；defer 成功才 timeline/room，ready 不是 promotion |
| source-seek-transaction | Robot mapping source lifecycle（S40c verified） | admitted/classified infrastructure seek → relayRobotMapping.handleSourceSeek | reset offset；mapped 可 begin→sync→source/timing；destructive 重用完整 revoke |
| take-command | server | start／stop Take handler → start/stop | boundary→song→sync start admission；拒絕不 stand down，成功才 validation/calibration→accept；stop 保留 wall-clock boundary delta |
| youtube-telemetry-acceptance | Song lifecycle | gate／Song.update accepted 後 → acceptTelemetry | register/clear rejection→rate revoke／validation→timing→timeline cadence→room→command complete/status→outgoing release→target complete |

S31基線為14項已assembly/12項server配置；S40a後15/11，S40b C2 verified後16/10。S40b最後FULL3446/115/exit0、139檔union1342/10/exit0、productionaudio/listener8pass、nativeWTexit0/browserWT1pass，完整803指紋e87343a1…一致；證據見PROGRESS。S40a **只處理transition commit配置**，S40b **只處理Mic capture restart配置**；不因保留coordinator就自動要求刪檔。S40c Robot source lifecycle（legacyDrop/seek/activation/disconnect）C0聯集1517/10、C1聯集1688/12均通過；C2四項已接唯一RobotMapping root，最後版本CHECK0/144檔union1526/10/FULL3620/115全過、productionaudio/listener8pass、nativeWT0/browserWT1pass，完整804指紋9b78e8b0…一致，S40c verified。因此目前production配置為20已assembly/6留server；剩餘Backing四項及audio-uplink/Take配置仍須按責任審查，S40整卡尚未verified。第一版FULL定位失敗證據保留，不能用它的舊綠燈代替修後gate。此inventory在後續各群接線後更新owner/caller，歷史基線保留。

S40a 必要接線 test：`server-robot-content-transition-commit-coordinator.test.ts`。既有 mapping query/lifecycle tests 只因增加窄 canonical facets 而補 fixture，原 fixed expected 保留；另新增 `relay-robot-mapping-commit.test.ts`，C0 執行實際舊 server initializer 與 host callback，不複製算法。

最終 S40 除全部 S profiles/FULL 外，必須 production audio＋listener；直接 media 接線需 WT。constructor/start 與 await Opus/WT、HTTP listen、WSS close、gracefulShutdown 的順序另外逐項驗收。不能以此 inventory 文件或 S31 的歷史綠燈代替新版本 gate。
