# Relay 深度削屎山計畫

日期：2026-10-05（Asia/Taipei）

狀態：規劃文件；本輪不繼續改 runtime、不提交、不部署。

## 執行模型必讀：第二版已補成操作手冊

這份是架構總綱，**不能只讀總綱就開始搬檔**。後續執行從 [00-EXECUTION](docs/refactor/00-EXECUTION.md) 開始，再讀 [PROGRESS](docs/refactor/PROGRESS.md) 與當包卡。下一步是 P00，不是直接做 W4 或 W6。

| 文件 | 用途 |
| --- | --- |
| [執行入口](docs/refactor/00-EXECUTION.md) | worktree 防呆、卡號順序、checkpoint、失敗分流、交接提示 |
| [音訊執行卡](docs/refactor/01-AUDIO.md) | 座標／reset語意、20組seam oracle、逐call-site替換表、read-plan切法 |
| [Server執行卡](docs/refactor/02-SERVER.md) | facts/pump/timing/Mic/Song切分與固定交易順序 |
| [Browser執行卡](docs/refactor/03-BROWSER.md) | epoch字典、resource cleanup、ACK／retransmit／handoff race matrix |
| [驗證命令](docs/refactor/04-VALIDATION.md) | 精確test profiles、browser/WT環境前提、效能與失敗定位 |
| [持久化與收尾](docs/refactor/05-STORAGE-AND-CLOSEOUT.md) | crash/fault matrix、ready/metadata順序、條件式支線、最終驗收 |
| [基線manifest](docs/refactor/BASELINE.json) | 33個關鍵檔案SHA-256，含11個既有dirty檔；不是還原包 |

執行卡區分現有實作與擬新增介面，並規定可改檔案、留下的state、每個gate。細節以執行卡為準；與未來新版本衝突時先稽核，不按舊行號硬切。

## 1. 結論：削掉隱含的狀態關係，不只削檔案長度

Relay 不是缺少模組，而是已經有不少正確的 domain owner，剩餘跨 owner 的生命週期、收尾順序、非同步失效條件，仍集中在大 closure 或瀏覽器 module globals 裡。

優先順序：

1. 收斂目前 MixBus／Mic DSP 抽取，確立可以回歸的基線。
2. 把 AudioSession 剩餘的 seam／讀取計畫拆成有明確座標與狀態所有權的單位。
3. 收斂 server 的領域組裝、跨領域交易與 tick；最高價值是 timing／Mic lifecycle，不是單純搬 protocol switch。
4. 收斂 browser capture、transport、playback 的非同步生命週期。
5. 最後才評估 receiver、Take storage 內部拆分，以及目錄／命名整理。

所有階段都以「外部行為不變」為預設。發現 bug，先留下重現，再另立行為修正；不讓修 bug、調音、調 timeout 混進結構重構。

## 2. 盤點基線與證據界線

### 2.1 兩個工作目錄不能混算

- 主目錄：`/home/mochi/relay`，`main`，HEAD `7fe0c27`。本文件寫在這裡；盤點開始時工作樹乾淨。
- 重構工作樹：`/tmp/claude-1000/-home-mochi-relay/e8ac15ae-68bf-4977-9fa9-2c586edcef32/scratchpad/wt9`，分支 `refactor/mic-timeline`，HEAD `7b5d550`，含未提交的 bus／Mic DSP 變更。
- 下列原始碼行數、函式位置、測試與熱點，以重構工作樹為準，不是較舊的 main。
- 後續開工沿用這個 worktree 的變更；不得把 main 當最新基線覆蓋回去。整合分支另行處理，不自動 reset、cherry-pick、push。

### 2.2 量化結果

掃描範圍為 `src/**/*.ts`、`public/**/*.js`、`shared/**/*.js`，不含 `.d.ts`：218 個檔案、50,406 行。行數含註解與空白，僅供定位。

| 熱點 | 行數 | 觀察到的耦合 | 優先性 |
| --- | ---: | --- | --- |
| `src/server.ts` | 4,229 | 95 個不同本地模組依賴；組裝、決策、排程、事件收尾同處 | 高 |
| `src/audio-session.ts` | 2,196 | 時間線、ingest、read planning、seam、PCM/evidence 的協作 | 高，已有保護網 |
| `public/app.js` | 2,085 | capture graph、session epoch、socket、health ACK、DOM | 高 |
| `public/youtube.js` | 1,710 | player adapter、命令收斂、handoff、prewarm、多組 timer | 高，但在前述基線後 |
| `public/audio-transport.js` | 1,341 | WS/WT 切換、未完成寫入、重傳、重新綁定、generation | 高 |
| `public/listen.js` | 898 | 音訊圖、monitor socket、mute causes、iOS recovery | 中 |
| `src/audio-packet-receiver.ts` | 851 | reorder／continuity／retransmit／loss 結算 | 中，行為風險高 |
| `src/calibration-session.ts` | 839 | 已有明確量測 owner；先拆外面的編排 | 延後內拆 |
| `src/take-library.ts` / `take-controller.ts` | 755 / 702 | 持久化恢復與 live recording 已分層，但交易仍複雜 | 延後、高風險 |

最近 120 筆涉及 `src/public/shared` 的提交中，`audio-session.ts` 出現 41 次、`server.ts` 23 次、`app.js` 22 次、`listen.js` 12 次、`audio-transport.js` 10 次。這是變動熱度，不是缺陷數。

本地字面值 import／re-export 的啟發式依賴掃描沒有找到循環。它不涵蓋 callback、DOM events、`window.*`、socket messages 或動態執行關係，不能據此宣稱 runtime 沒有循環耦合。

`src/*coordinator*` 已有 26 個檔案：部分是重要的 effect-order 防線；部分仍將所有實際 authority 留在 server callbacks。下一輪不是繼續無限增加 coordinator 檔案。

這是針對熱點、規範、測試與依賴的靜態深度盤點；不是逐行審完全部程式，也沒有做效能量測或宣稱發現了新的 production bug。

### 2.3 已完成與未完成要分開

重構分支已有 PCM timeline、Mic input clipping、frontier correction、clock trim、mixFrame phases 與六個 bit-exact golden scenarios。

目前未提交變更：

- `MixBus`：expectation、release hold、song duck、summing headroom、safe join。
- `MicLimiter`：detector／envelope／gain；reset 的語意時機仍在 AudioSession。
- `MicRawMeter`：accepted pre-gain PCM 計量；不冒充 browser realtime meter。
- `MicGainRamp`：accepted target 的 ramp；授權與 clamp 不下放。
- AudioSession 從這輪開始前的 2,600 行降到 2,196 行。這是 coordinator 瘦身，不是整個 repository 淨刪 404 行。
- 新增元件測試共 44 cases；聚焦的 11 個測試檔、typecheck、既有六個 golden 均已通過，golden digest 未改。
- 早一版 bus-only 全套：2,509 tests 通過，耗時約 12 分 40 秒。
- bus＋三個 DSP 元件的整合版全套已完成：2,531 tests／115 suites 通過，0 failure／skip／cancel，耗時約 12 分鐘。測試前後上述變更檔案的 SHA-256 完全相同；這不是拿 bus-only 結果替整合版背書。
- `CaptureRestartBoundaries` 只有 scratch 草稿，尚未納入 src、尚未有其獨立測試，不列為完成。

## 3. 必須守住的語意邊界

`SESSION_MODEL.md` 與 `ARCHITECTURE_BOUNDARIES.md` 是規範，不是重構時順便改寫的說明文字。

| 真相／資源 | 應有 owner | 不可以混成同一件事 |
| --- | --- | --- |
| 人、Mic lease、transport | ParticipantSession；MicRuntime 管獲准後的 media transport | WS reconnect 不等於換人／換 capture；presence grace 不等於 transport grace |
| PCM 時間線、mix clock、輸出 evidence | AudioSession 與其明確委派元件 | packet sequence、source sample、session sample、wall clock 不可互換 |
| bus membership／duck／join | MixBus | expected=false 不代表舊 PCM 已不可聽；retained hole 不代表 release 完成 |
| Mic DSP | gain ramp／limiter／raw meter 各自 owner | capture-recognition reset、audible-boundary reset、health counter reset 不是同時發生 |
| timing | CalibrationSession、BootProbeRuntime、validator、mapping owners；TimingRuntime 僅管編排 metadata | physical route、candidate、applied authority、fallback 必須分開 |
| Song／播放權威／命令 | SongSession、RoomSongCommandRuntime、PlaybackTransportRuntime | speculative prewarm、準備完成、正式 promotion 不是同一個承諾 |
| browser capture | current publisher session 與 current graph | 關閉舊資源的 promise 不得撤銷新 session；graph epoch 不等於 capture generation |
| Take | TakeSession 的 live lifecycle；TakeLibrary 的 durable history | 換 current Take 不可丟 history；status ready 不可早於有效 artifact 結算 |
| product／diagnostics | 既有 status projection 與 product model | UI 不重建 domain authority；診斷詳細資料不成為正常使用的必要輸入 |

額外硬限制：

- 保留現有 wire format、事件名稱、`/api/status/v1` 與 legacy compatibility payload shape。
- 保留 Mic takeover 的 expected-owner 檢查、ready publisher 綁定、舊 publisher 撤銷與公開狀態的順序。
- 保留「已獲准 Take」才站下背景 calibration 的 admission 邊界；被拒絕的命令沒有取消背景工作的權力。
- mapping revocation 必須同時維護 generation 與 pending analysis 的失效，不能拆成散落的 cleanup calls。
- 所有異步完成、timer、舊 socket callback 都要在其原有身份範圍內驗證；不要發明一個通吃所有 identity 的 global epoch。

## 4. 目標結構：入口薄，owner 不搬家

```text
server-entry / server（config、組裝、start、shutdown、protocol 接線）
  ├─ Mic lifecycle 編排 → Participant / MicRuntime / grace / timing / Take evidence
  ├─ Timing 編排       → Calibration / Probe / Validation / Robot mapping
  ├─ Song 編排         → Song / Commands / Playback transport
  ├─ Mix pump          → ingest / drain / Take append / monitor / evidence consumers
  └─ Status facts      → 既有 pure projections → HTTP / socket payload

AudioSession（clock、timeline 協作、frame commit）
  ├─ timeline / restart boundaries / frontier / clock trim
  ├─ Mic read planning 與 PCM＋evidence 同步讀取
  └─ Mic DSP / source edges / MixBus（保留 frame 內原有順序）

browser entry（DOM / window-event 相容轉接）
  ├─ Publisher session → Capture graph / health correlation / transport facade
  ├─ Playback session  → YouTube adapter / command convergence / handoff transaction
  └─ Listen session    → monitor transport / playback graph / mute & recovery policy
```

這是責任圖，不是要求新增同名 giant classes。跨 domain 的交易可以用明確的窄介面呼叫現有 owners；狀態仍只在原 owner 中存一份。

一個新模組應至少帶走一組狀態及其完整操作／清理，或帶走能獨立驗證的純計算。若只是接收大量 callbacks 再呼叫回 server，且原本全域狀態一個都沒消失，就必須說明其唯一價值是否是必要的交易順序測試；否則不算削山。

## 5. 工作包與執行順序

估量採 S／M／L：S 是單一封閉邊界；M 有數個 call sites／身份 fence；L 橫跨生命週期或領域。它們是相對風險與審查量，不是工時承諾。L 必須分次交付。

### W0 — 封存目前基線（先做，S）

範圍：目前 bus／DSP 變更、測試、architecture section 8。

1. 採用已完成的整合版全套與 source hash 作為基線，保存 source revision／dirty diff、命令、測試數及 log；若再調整 runtime，必須重跑相應驗證。
2. 對照 golden 同時確認 PCM、frame evidence、position、health，不只看新增元件 unit tests。
3. 以可獨立驗收的變更群整理現有 diff，不混入下一個 seam 抽取；不自行提交或發布。
4. 用現有 boundary tests 檢查 DSP 不吸收 command policy，AudioSession 仍持有 reset／evidence 的決策。

出口：既有這輪改動有完整驗證；後面每個工作包都有確定的比較點。目前驗證已通過，diff 仍未提交。若後續基線重驗失敗，先定位失敗，不往上疊新抽取。

### W1 — Capture restart seam owner（W0 後，S/M）

位置：`audio-session.ts` 的 boundary arrays、`queueCaptureRestartBoundary`、`consumeCaptureRestartBoundaryIfDue`、`retainedMicRestartBoundaryBetween`，以及 rebase／trim／crossfade call sites。

先加測試，再審 scratch 草稿；不能因為草稿存在就直接搬入。

- 元件只管理 sample boundaries、查詢、rebase、trim、consume。SourceOutputEdge、limiter reset、timeline retirement 的決策仍在 session。
- Mic 的 seam 必須保留到 retention cutoff，因 read head 可往返；Backing 是 forward consumption。不要用「統一行為」消除差異。
- forward crossing 為 `(from, to]`；backward crossing 為 `(to, from]`，搜尋順序也有語意。
- trim 移除嚴格小於 cutoff 的項目；equal boundary 必須保留。
- 現行 queue 只忽略末端相同項目，不是全域去重；重構不得順便改掉較早位置的重複值規則。
- `crossfadeMicReadHeadJump` 的 old leg 查詢是 **forward-only**：`previous < boundary <= oldLegEnd`。`oldLegEnd` 可能在 previous 後方或前方，不能換成雙向 `between()`，否則會憑空跨 seam。

驗收：equal／forward／backward／zero-length／rebase／trim／out-of-order insertion／old-leg end behind previous 的 unit cases；既有 alignment、limiter ownership、general seam invariants；六個 golden 完全不變。

出口：session 不再直接修改 restart-boundary arrays；所有特殊區間語意有測試及明確方法名。

### W2 — Mic read planning 與 evidence 共用座標（W1 後，M/L）

位置：`planMicRead`、`readMicSlewedRange`、`crossfadeMicReadHeadJump`、`readMicFrame`、`restartBoundedDetectOffset`。

分兩次：

1. 先只抽 read-motion 的純計算；`planMicRead` 的 fold／slew／frontier／edge 副作用仍按原順序留在 session。continuity state owner 改列 A22 條件式支線，不一次搬走整個 planner。
2. 抽取同一路徑的 PCM、gap、clipping、source evidence 取樣。輸出採一份帶 position／rate 的讀取結果，不讓 audio 與 evidence 各自重新算一次座標。

風險：fractional sample、lookahead、old/new crossfade legs、retained seams、首個可聽樣本、rebase 同步。以既有內部 `MicReadPlan`／read result 為種子，不做萬用 signal-processing framework。

驗收：輸出 bit-exact；resampling／crossfade 的 evidence 對同一 source span；plan queries 不意外多推進 ramp；rebase 同時維護 origin、frontier、seam、clipping 的既有關係。

出口：看讀取元件就能理解 read head 如何走、evidence 如何對齊；AudioSession 仍負責 frame 的單次 commit。若必須暴露十幾個 private setter 才能抽出，先縮小抽取面。

`ingest`（目前約 237 行）不是同一包順手抽取。它涉及 capture restart、resampling tail、gap concealment、accepted PCM 與 reanchor，等 W2 穩定後重新評估，不能先套 Mic／Backing 共用繼承樹。

### W3 — Server status facts 與 mix pump（W0 後；W2 穩定後接 AudioSession 介面，M）

目前已經有 `relay-status-projection.ts`，不重新發明第二套 projection。

第一刀：將 server 的 facts collection 做成明確、只讀的邊界；保留原來每個 payload 的取樣時點，不跨不相關 request 強制共用 snapshot。不要讓 status query 變成 provenance settlement 的必要入口。

第二刀：抽 `processPublisherFrame`／`deliverMicPackets`／5ms mixer callback 的編排與 lifecycle；用可直接測試的 tick/drain 邊界，scheduler 在外面。

- 保留 receive → accepted ingest → live-flow evidence 的順序；datagram 成功不等於 PCM 已被接受。
- 保留重傳服務、flush、drain、Take append、monitor broadcast、health consumer 的先後。
- 保留每個 emitted frame 原有的 `nowMs` 與 `position` 配對；不能為了 snapshot 整齊而改成一個 catch-up batch 共用新時間語意。
- tick owner 管自己 timer 的 start/stop；shutdown 先凍結 mix frontier，再等 Take finalize，再停 transports。

驗收：`runtime-single-snapshot`、status projection／product status、uplink health、Take evidence、voice-only、`server-take-shutdown`；新增 pump effect-order test 與 stop idempotency test。

出口：server 不再內嵌 per-frame media 工作；status 讀取不改 domain state；Take／monitor 消費同一權威輸出。

### W4 — Timing／Robot 編排收斂（W3 後，L，至少三刀）

依據：server 約 566–978、1278–1465、2223–2772 行及 250ms tick 的 timing 呼叫序列。

1. **Robot mapping lifecycle**：freshness／readiness facts、transition begin／sweep／commit／revoke 接線收在一處。保留現有 commit／revocation coordinators 的順序保證。
2. **Boot probe workflow**：admission、request／reply／failure fencing、timeout／analysis settlement、promotion／reapplication。request ID、capture generation、route context 各自明確。
3. **Calibration orchestration**：manual／automatic admission、background validation、baseline/slew、Take admission 後 stand-down、confirmed provenance settlement。

不把以上塞進 `TimingRuntime`：該類目前明確只擁有 orchestration metadata；`timing-runtime-boundary.test.ts` 禁止它吞進 measurement／mixer／Take authorities。可以另建 application-level assembly，組裝現有 owners，不複製其 state。

250ms tick 順序先以 ordered trace 固定，再轉接；不要趁拆分讓 owners 自己各開一個 timer，否則排序從程式碼保證變成 scheduler 偶然。

驗收必含：

- Robot route 在 probe flag 關閉時仍是真實 route。
- 新 candidate 失敗仍保留舊 confirmed authority，讀 status 不改 provenance。
- 有效／失敗的 bounded probe 都能走到 settlement；被允許的 topology 都能終止。
- mapping revoke 同時失效 generation、待分析工作；舊結果晚到不得 promotion。
- 成功 Take admission 站下背景工作，被拒 Take 不影響它。
- PCM span 足夠但真實 coverage 不足時，不提交錯誤量測。

既有保護：`timing-authority-*`、`server-boot-probe-*`、`server-probe-client-result-fencing`、`server-robot-bootstrap-timing-deadlock`、`calibration-transaction-server`、`content-calibration-validation-server`、robot transition replay。

出口：某個 timing 事件該取消誰、更新哪個 revision、最後發布什麼，可從一個交易入口讀完；server 不再維護第二份 timing 決策。

### W5 — Mic／Song 跨領域交易與 server 收尾（W4 後，L，分領域交付）

Mic 刀：聚合 activation、same-capture reconnect、capture replacement、release、grace expiry、disconnect 的接線。復用 ParticipantSession、MicRuntime、MicTransportGraceRuntime 和已測試 coordinators。

- lease mutation 仍由 ParticipantSession 負責；MicRuntime 不取得 release／takeover 的授權決策。
- 用具名 transaction input/result 與少量 typed ports，不傳入整包可變 `ServerContext`。
- 每個事件明列：先保存哪些 Take evidence、何時撤銷 media、何時 invalid timing、何時通知。
- 特別保留 WT media 活著而 control WS 正在 grace 的路徑。

Song 刀：命令 acceptance／timeout、telemetry acceptance、handoff prepare／commit／result、playback continuation／disconnect。保留目前 SongSession 與 command runtime 的 authority epoch，UI 和 adapter 不自封 owner。

最後整理 server composition root：資源建構、依賴注入、protocol wiring、啟停。不是硬設 `<500 行`，而是入口不再內嵌新的 domain rule 或 loose lifecycle state。

驗收：Mic same-owner/new-capture 與 same-capture/new-socket 的交叉案例、stale socket close、superseded no-reconnect、takeover CAS、owner-release evidence；Song latest-intent、command epochs、handoff timeout／late results／final authority。

出口：原 26 個 coordinators 逐個審查保留／併入領域 assembly，保留有價值的順序測試；不做一次性大刪除，也不追求檔案數最少。

### W6 — Browser Publisher／Capture 生命週期（W0 後可規劃；server 基線收斂後實作，L）

第一刀：**CaptureGraph 資源 owner**。收 `installCaptureGraph`、worklet message acceptance、analysis worker、buffer return、track listeners、dispose/rebuild；擁有 graph identity 與 disposal，session 層仍決定 capture generation 何時前進。

第二刀：**Uplink health correlation**。收 drop/gap/clipping interval、pending health request IDs、revision 與 ACK settlement；舊 ACK 不得抹掉較新的 clipped window，斷線清 request correlations 不等於抹掉未確認 evidence。

第三刀：**Publisher session 編排與 view 分離**。startup、stop、reconnect、authority freshness；復用已有 `MicStartupGate`、`MicCaptureRecoveryWatchdog`、`MicLifecycleTransaction`、`PublisherCommandLiveness`。`app.js` 保留 DOM binding 與相容的 window events，不再直接持有整包 capture/socket/timer state。

最重要 invariant：`stop()` 第一個 await 之前就撤銷 session；其後只關閉當時捕獲的舊資源。舊 getUserMedia／resume／graph rebuild／socket open 完成，不能復活上一個 session 或關掉下一個 session。

驗收：`publisher-session-epoch`、`mic-startup`、`mic-lifecycle-*`、`mic-capture-recovery`、capture dispatch、publisher control liveness；補 start→stop→start 交錯、device-change 舊 graph 晚回、未完成 startup 被 revoke 的 deterministic cases；production browser capture→mix→Take proof。

出口：每個 stream、node、worker、timer 的建立／取消有同一 owner；local realtime meter 仍只接受 current capture evidence；既有 UI 事件形狀不變。

### W7 — Browser AudioTransport 的 queue 與生命週期（W6 介面穩定後，L，至少兩刀）

維持 `PreferredAudioTransport` facade 與 API。先抽可獨立擁有狀態的資料結構，最後才動 preference state machine。

1. bounded retransmit cache：remember／lookup／按容量淘汰／clear；現行沒有 TTL，不新增時間expire。保留 generation、序號 wrap、重傳資格與封包 ownership。
2. outstanding datagram writes/backlog：enqueue／settle／expire／fallback flush；舊 writer 的 completion 不得清掉新 writer 的 pending bytes。
3. 若前兩刀已顯著減耦，再評估 preference／demotion／quarantine／repromotion timer 的單一 lifecycle owner，避免 facade 與元件同時維護 state enum。

不可混改 packet budget、hold duration、drop accounting、fallback／retransmit policy。控制 authority、bind incarnation、capture generation、WT generation 分開追蹤。

驗收：`browser-audio-retransmit`、`browser-websocket-backpressure`、`browser-webtransport-generation`／`repromotion`／`runtime`、media recovery correlation；fake unresolved writer、late settle、close→rebind、budget shrink；real WT loopback 與 Chromium WT production proof。

出口：bounded queue/cache 有可檢查的上限與 clear owner；舊 completion 無跨 epoch 寫入；WS fallback 與原始 timeline holes 行為不變。

### W8 — Browser Song handoff 與 YouTube adapter（W5、W6 穩定後，L）

先抽 player adapter：YT API loading、ready、snapshot、play/seek/rate/mute 操作。adapter 不自行接受 room command、不自行升格 playback role。

再抽 client handoff transaction：pending plan、ready timers、commit watchdog、outgoing release barrier、speculative prewarm 與 autoplay recovery 的擁有／取消。正式 handoff 與 speculative state 不合併為一個真假值。

命令收斂繼續使用既有 shared convergence、playback continuation、terminal／timing helpers，不複製一份「新 runtime policy」。在每個 player async 操作旁保留其 operation／handoff／authority fence。

`source.js` 是 Robot follower，不直接併進手機 handoff controller。最多在兩邊已有相同契約後共享純 YouTube adapter；seek authority、probe execution、superseded cleanup 仍各有 owner。

驗收：prepare→cancel→late ready、commit→timeout→late proof、reconnect continuation、outgoing release 晚到、舊 autoplay retry、新 play intent、被 supersede 的 player events；既有 handoff final authority／holdover epoch／review regressions。

出口：單一 transaction dispose 能撤銷其全部 timers，不影響下一個 transaction；`youtube.js` 主要呈現與接線，server 仍是 room truth。

### W9 — Listen 分層與其他中型 owner（W6–W8 後，中低優先）

Listen：視前面抽取後的需要，分 monitor connection（socket epoch、ACK、Opus fallback、PCM continuity）與 playback graph（context、nodes、resampler、resume）。現有 `listen-opus-decoder`、`monitor-pcm-continuity`、`IosAudioDestinationRecovery` 繼續使用。

保留 user／Mic／room Mic／playback／Take review 各 mute cause；多個 cause 不可壓成最後一次事件寫入的單一 boolean。view 仍由 `room-sound-ui.js` 負責。

Receiver：只有當重傳 budget state 或 continuity cache 可獨立封閉時才拆；保留 holes、wraparound、late packet、same-capture reconnect、request sent vs requested 的差別，不更動 loss 等待政策。

`mic-media-path-recovery.js` 已是有 owner 的狀態機；`calibration-session.ts`、`song-session.ts` 也不因行數大就先拆。先問修改一個規則是否真的需要理解無關 state。

### W10 — Take 持久化交易（最後、條件式啟動，L）

只有前述高頻熱點已改善且有實際維護需求，才進行：

1. 將 artifact／metadata validation 的純計算與 I/O 分開，減少 sync／async 分支重複驗證；不把 live async I/O 改回 sync。
2. 將 recovery 判斷整理成可測試的 decision matrix，再由既有 storage 層執行；不改 startup repair 與 live read-only listing 的分工。
3. 若 controller finalize 仍難理解，抽具名 finalization transaction，保留 current Take identity 與 writer identity 的隔離。

必測 crash/fault 點：metadata stage 前後、WAV sync 前後、WAV rename 後但 metadata commit 前、metadata mismatch、writer failure、shutdown waiting、retention prune 與新 Take 重疊。

持久化順序以現有實作為基線：stage metadata → finalize WAV → session.complete（ready）→ commit metadata。不能錯改成metadata提交後才complete；metadata failure與audio failure不同。live `listAsync` 不加destructive repair，既有sync recovery則須保護同process live stage。測試只用 temp fixtures，不碰使用者錄音。

驗收：`take-durability-boundary`、`take-library`／`list-async`、`take-metadata-artifact-authority`、`take-storage`、`take-wav-integrity`、`server-take-shutdown`。結構測試與 fault-injection 行為測試一起保留；不順便改磁碟 schema／保留政策。

## 6. 測試不是最後補：每一刀的交付契約

### 6.1 三層驗證

1. **快圈**：`npm run check`、本包 unit tests、直接相關 invariant／boundary tests、`git diff --check`；browser 變更做 `node --check`。
2. **整合圈**：完整 `npm test`，含 server/socket/Take；套件目前固定 `--test-concurrency=1`。不為了加速直接調高全套 concurrency。
3. **實際路徑圈**：依變更範圍跑現有 CI 的 DOM interaction／geometry、HTTP/3 WT loopback、production browser audio/listener、Chromium WT proof。純單元成功不能替代涉及 browser lifecycle 的實際路徑。

不把 `npm test` 說成完整 browser CI。後者在 `.github/workflows/ci.yml` 與 `production-browser-audio-proof.yml` 有獨立環境與步驟。

physical iOS route、藍牙、鎖屏、permission interruption、聲學 timing 仍需真機 rehearsal。無真機就標示未覆蓋，不從 Chromium 綠燈推論 iPhone 都正常。

### 6.2 Characterization 與架構測試分工

- Golden：保留現有 bit-exact baseline，新增補洞 scenario 不等於重算既有 digest。PCM 不變但 evidence／position 變了，同樣不是無行為改動。
- Transaction trace：before/after 對比 effect order、authority revision、accepted events 與拒絕原因；測試 trace，不新增 production event-sourcing 系統。
- Async harness：可控 clock／scheduler、deferred promise、fake socket/player；主動安排 stale completion，不依賴碰巧的 sleep。
- Source/AST tests：保留 forbidden dependency、single owner、必要 durability primitive；函式名稱／constructor 必須住在 server 的限制，應在相同 commit 改為擁有者邊界驗證，不整批刪除。
- 現有 `test/helpers/source-contract.ts` 依頂層 function／closing-brace 格式尋找原碼；抽到 class／closure 時可能因結構而失敗。先辨識是行為契約還是定位器假設，再調整測試。
- 每個新 owner 都要有 reset／dispose／再啟動與 stale input 測試；不是只測 happy path。

### 6.3 效能與資源門檻

尚未有本輪效能基線，不能宣稱重構更快。W2／W3／W7 前先量同一輸入、同一 runtime 的 mixer tick／drain 時間、event-loop delay、allocation/GC、queue high-water mark，再跑至少數次排除冷啟動差異。

穩定超出基線波動的 regression 必須解釋或撤回；具體容許值在 baseline 後設定，不先杜撰 p99 數字。不要在 per-sample path 新增臨時物件、通用事件派發、log 或 promise。

資源驗收是硬條件：stop/dispose 後舊 timer／listener／worker／writer 不得繼續作用於新 owner；bounded queue/cache 在反覆 reconnect 後不持續成長。重構測試可加計數 hooks，但不要為測試暴露整包可變內部狀態。

## 7. 一個工作包怎樣才算真的完成

每包都附上：

- 舊責任 → 新 owner 對照，以及確實從 caller 移除的 state／決策。
- inputs、outputs、sample/time 座標、身份 fence、reset/dispose 語意。
- 不變量和測試對應；測過／未測過分開列。
- source baseline、相關測試、完整套件、必要 browser/WT proof 的結果。
- 可獨立回退的 diff；不得依賴下一包才恢復正確行為。

接受條件不是總行數下降，而是：單一狀態只在一個地方寫；一次交易能看到完整收尾；改局部規則不必讀整個 server／app；沒有多一層 delegation 卻仍需要碰原檔全部 state。

以新增結構為範圍設 dependency tests：domain 不依賴 server entry、DOM、socket adapter；`shared` 不引入平台實作；既有 `src ↔ public` 禁止依賴繼續通過。總 imports／檔案數不必單調下降。

發現需要改 external behavior、wire schema、錄音格式、產品策略才抽得動時，停在該包邊界，另立設計決策；不擴大成「順便重寫」。

## 8. 回退與範圍控制

- 一次只推進一個有狀態的高風險邊界；backend／browser 不同時更換彼此契約。
- 拆分提交應可單獨驗證、單獨 revert；相容 facade 可以短期保留，但不得永久雙寫新舊 state。
- 純重構不需要新增 rollout flag，也不在 production 同時跑兩條有副作用的音訊管線。
- Golden diff、authority fencing 失效、cleanup 順序不一致、錄音 integrity 失敗：先縮回當包，保留重現測試，不修改 expected 使其變綠。
- 已有使用者變更不重設；commit／push／部署不包含在這份規劃的執行授權內。

明確不做：

- framework 全面替換、browser 全面 TS migration、目錄大搬家、一次性命名清掃。
- generic EventBus／全域 store／service locator／可變 context bag。
- 把 Mic、Backing、Robot follower 強行套同一個萬用 lifecycle。
- 為了刪重複而合併不同 authority、不同 epoch、不同 clock。
- 改音量、duck、limiter、alignment、buffer、retry、掉包與保留策略。
- 優先拆 i18n／diagnostics copy 等大但低狀態耦合的資料檔。
- 以檔案變多、tests 數量變多、行數變少當成功的唯一證據。

## 9. 第一輪實際落地清單

先只承諾下面順序，做完再用實際 diff／驗證成本重新評估下一輪，不先承諾某天清完 50k 行：

1. W0：確認並收斂現有 bus／DSP 完整基線。
2. W1 前半：補 restart seam 區間／方向／trim／rebase characterization。
3. W1 後半：審完草稿，抽 boundary owner，保留所有 golden。
4. W2 第一刀：縮小並抽 Mic read plan；若 ownership 邊界不乾淨，先停在純計算部分。
5. W3 第一刀：status facts collection，復用既有 projection，替 server 領域組裝鋪路。

第一輪檢查點：若每次抽取都只多一層 callbacks、測試僅追著 source 字串改、沒有移除 caller state，應修正切分方式，而不是繼續照表搬檔。

## 10. 驗證記錄

- bus-only 全套 log：`/tmp/relay-mix-bus-full-suite-unrestricted.log`，2,509 tests 通過。
- 整合版全套 log：`/tmp/relay-mixer-dsp-full-suite.log`；在上述 worktree 執行 `npm test`，exit 0，2,531 tests／115 suites 全數通過，duration 719,745.588 ms。原有 bus／DSP 程式、相關新測試、gain authority 測試與 architecture 文件的測前／測後 SHA-256 相符。
- 完整 browser／WT CI 與真機 rehearsal 沒有在本輪重新執行；上述綠燈只指已明列的驗證範圍。
- 計畫深化新增本總綱與 `docs/refactor/` 執行文件包；既有未提交 runtime 修改保留在上述 worktree，沒有繼續改動。
