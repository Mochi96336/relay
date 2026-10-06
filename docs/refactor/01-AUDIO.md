# AudioSession：逐刀執行卡

前置閱讀：00-EXECUTION、04-VALIDATION、architecture section 8，以及當前 `audio-session.ts` 對應完整方法。行號只供找位置，以符號為準。

## 1. 先背清楚四種座標，不要按變數名字猜

| 名稱 | 單位／意義 | 不能做的事 |
| --- | --- | --- |
| packet `firstSampleIndex` / timeline `sourceFrontier` | 原始 capture sample rate 下的 sample index | 未轉 rate 就加 mix frameSamples |
| `PcmChunk.start` / `PcmTimeline.totalSamples` / restart boundary | 已映射到 session 的 mix-rate sample 座標 | 把 totalSamples 當「實際收到樣本數」；hole 也佔時間線長度 |
| `micReadStart` / `micSourceSample` / `lastEmittedMicSourceSample` | Mixer 讀取 Mic timeline 的位置，可能有小數；名字有 source，但此處不是 raw packet cursor | 直接拿來比不同 rate 的 packet cursor；為方便全部 round |
| frame `position.firstSampleIndex` | 已輸出 mix frame 的權威 session position，配 `sessionGeneration` | 因 Mic 換 capture 就重置整個 Take 的 mix generation |
| `performance.now()` | process/browser 內 monotonic ms，各自原點 | 與 Date.now 相減或跨程序直接當同一時計 |
| `Date.now()` | wall-clock ms，presence／記錄時間等使用 | 取代音訊讀取 head 或重傳的 monotonic clock |

boundary、read-head、clipping mask 必須跟著同一個 rebase shift 移動；重構中不要順便重命名所有 sourceSample，先保留語意。

## 2. 音訊 reset 不是一個通用 resetAll

| 事件 | 必須維持的現有差異 |
| --- | --- |
| in-band captureRestarted | queue 舊 frontier seam；raw meter 立即 reset；limiter 等讀頭真的跨 seam，再以新 PCM seed |
| bind 已證明換 capture → retireMicCapture | 不留舊 buffered PCM；保留最後已聽到 contribution 做 edge；limiter pending reset；mix epoch/Take 不因而重開 |
| same-capture transport reconnect | 不被新 socket 誤判成新音訊時鐘 |
| clearTimeline(mic) | reset clock trim、read continuity、last source sample、Mic seams、input clipping，再 reset timeline |
| resetHealth | 現在不重設 `heavyLimitedSamples`；保留這個事實，不能因名稱覺得不一致就補 reset |
| rebaseMicTimeline | 同步移 chunks.start、totalSamples、originOffset、seams、clipping、capture origin、last source sample、last emitted advance、frontier |

完整 reset 集合仍以當前方法為準；上表指出最容易被「整理」改掉的部分。

## A10 — 寫出 restart-boundary 元件與 characterization

前置：P00。產物目前未存在，scratch 草稿只作參考。

白名單（擬新增）：

- `src/capture-restart-boundaries.ts`
- `test/capture-restart-boundaries.test.ts`
- 若需對外部情境補 characterization：既有 `test/audio-session-alignment-seam-invariant.test.ts`、`test/audio-session-limiter-ownership-seam-invariant.test.ts`。

這張卡不改 production AudioSession。禁止修改 golden digest、PCM timeline、frontier、limiter、MixBus。

### 擬定 API（名稱可以依同專案慣例微調，語意不能混合）

```ts
class CaptureRestartBoundaries {
  get size(): number;
  queue(sample: number): void;
  clear(): void;
  rebase(shift: number): void;
  trimBefore(cutoff: number): void;
  has(sample: number): boolean;
  firstForwardCrossing(from: number, to: number): number | null;
  firstCrossing(from: number, to: number): number | null;
  consumeThrough(sample: number): boolean;
}
```

這是介面規格，不是可直接貼上編譯的實作。只有 private array；不得回傳可變 array、傳入 AudioSession、開 timer、碰 DSP。

`firstForwardCrossing` 按 ascending array 找第一個 `from < b && b <= to`；即使 `to < from` 也不交換參數。

`firstCrossing`：前進同上；後退從尾端找 `to < b && b <= from`；相等回 null。返回第一個沿移動方向遇到的 seam，而不是最小值。

`consumeThrough` 消耗所有 `b <= sample`，回傳這次是否消耗至少一個；Mic 的 read path **不能**用它，只有 Backing 的 due consumption 用。

queue 保留原算法：若等於最後一項則忽略；否則在第一個較大值之前插入。因此 `[10,20]` 再 queue(10) 會變成 `[10,10,20]`。不可換 Set、不可全域去重、不可改排序比較符號。

### 必須逐列寫成測試的 oracle

每列獨立建 instance；`Q(...)` 表示依序 queue，不表示直接設定 private array。

| ID | 操作 | 預期 |
| --- | --- | --- |
| SE01 | 空集合所有查詢；consumeThrough(100) | size=0、has=false、crossing=null、consume=false |
| SE02 | Q(10,20,30) | size=3；has(20)=true；has(20.5)=false |
| SE03 | Q(20,10,15)；firstCrossing(0,30) | 10，不是插入順序的 20 |
| SE04 | Q(10,20,20) | size=2 |
| SE05 | Q(10,20,10) | size=3；trimBefore(11) 後 size=1 |
| SE06 | Q(10,20,30)；forward(10,20) | 20；起點不含、終點包含 |
| SE07 | 同集合；forward(20,10) | null，不可自動雙向 |
| SE08 | 同集合；firstCrossing(30,10) | 30，逆向起點可命中（既有半開區間） |
| SE09 | 同集合；firstCrossing(29,10) | 20 |
| SE10 | 同集合；firstCrossing(10,10) | null |
| SE11 | Q(10)；firstCrossing(9.5,10) | 10 |
| SE12 | Q(10)；firstCrossing(10,9.5) | 10 |
| SE13 | Q(10,20)；trimBefore(10) | size=2、has(10)=true |
| SE14 | Q(10,20)；trimBefore(10.1) | size=1、has(10)=false |
| SE15 | Q(10,20)；rebase(-5) | has(5)/has(15)=true、has(20)=false |
| SE16 | Q(10,20)；consumeThrough(10) | true、size=1；再次 consumeThrough(10)=false |
| SE17 | Q(10,20,30)；consumeThrough(100) | true、size=0 |
| SE18 | Q(10)；clear；Q(7) | 只剩 7，沒有前一輪 state |
| SE19 | Q(80,100)；old leg from=100,to=90 | firstForwardCrossing=null；不得改用 firstCrossing（會命中100） |
| SE20 | Q(10)；firstCrossing(9,11)，再 firstCrossing(11,9) | 兩次都 10；查詢不能消耗 retained Mic seam |

預期值來源是現有四段 array 算法，而不是新元件自行算出的答案。可做固定 seed 的 differential test 對照舊算法，但不能只用兩份同樣的新邏輯互比。

Gate：新 unit、音訊 profile A；如改既有 characterization，必須證明在 production 尚未切換時已通過。此卡完成只代表元件可接線；整個 seam 抽取要到 A11 才完成。

## A11 — 換掉每個 array call site，不動呼叫順序

前置：A10。白名單：A10 檔案、`src/audio-session.ts`、architecture section 8 必要補充、被此次定位影響的 source-contract tests（先記錄清單）。

先執行：

```bash
rg -n 'micCaptureRestartBoundarySamples|backingCaptureRestartBoundarySamples|queueCaptureRestartBoundary|consumeCaptureRestartBoundaryIfDue|retainedMicRestartBoundaryBetween' src/audio-session.ts
```

逐項替換，完成一項打勾：

| 現有位置 | 新操作 | 留在 AudioSession 的事 |
| --- | --- | --- |
| 兩個 `number[]` 欄位 | 兩個獨立 instance | Mic/Backing 不共用同一 instance |
| ingestMic restart | Mic.queue(previousTotalSamples) | 判斷 restart/running 的原 guard |
| ingestBacking restart | Backing.queue(previousTotalSamples) | 原 guard 與 queue 時點 |
| rebaseMicTimeline 的 array loop | Mic.rebase(shift) | 其餘座標同步更新 |
| resetHealth | 兩者 clear | limiter、edge、health 的既有 reset 差異 |
| clearTimeline 的分支 | 對應 owner clear | 不清另一個來源 |
| readMicSlewedRange `.includes(index+1)` | Mic.has(index+1) | audio/evidence/clipping 三條都用同一條件 |
| crossfadeMicReadHeadJump `.find` | Mic.firstForwardCrossing(previous,oldLegEnd) | previous=null 分支 |
| trim mic array | Mic.trimBefore(beforeSample) | clipping trim；Backing 不加新 trim 行為 |
| retainedMicRestartBoundaryBetween | Mic.firstCrossing | 可保留薄 wrapper，確認已無 duplicate algorithm |
| beginBackingCaptureRestartEdgeIfDue | Backing.consumeThrough | due 後的 edge.beginReplacement |
| restartBoundedDetectOffset | Mic.firstCrossing 或同語意 wrapper | detector 減小 offset 的 while loop |
| mixFrame `.length > 0` | Mic.size > 0 | 無 seam 的原始快路徑 |

不要為了統一 API 把兩個 firstCrossing 合併；不要在查詢時 trim；不要在 queue 時 reset limiter。

Gate：profile A＋FULL，git diff 不得變動既有 golden 檔。檢查 source 原 array 欄位／array algorithms 已移除，且新元件有 production import。SE19 單元＋既有 audible seam 測試一起通過；只有 SE19 不能證明整條音訊鏈安全。

## A20 — 只抽 read-motion 的純算式，保留 state mutation

前置：A11、profile A baseline、效能量測 baseline（驗證手冊 PERF）。白名單：`src/audio-session.ts`、擬新增 `src/mic-read-plan.ts`、`test/mic-read-plan.test.ts`，必要相關 boundary tests。

重要：`planMicRead()` 不是 pure function。以下順序原封不動留在 AudioSession：

1. `foldConfirmedMicCaptureLoss()`（可能 rebase 全部座標）。
2. 讀取 previouslyEmittedAdvance、previous calibrated lag、previous frontier correction。
3. 依 previous alignment 計算 modeled previous advance；有 emitted history 時以 history 為準。
4. `advanceCalibrationSlew()`。
5. `startSample = frameIndex * frameSamples`。
6. `updateMicFrontierCorrection(startSample)`。
7. 讀取新的 applied advance。
8. 分類 bounded motion／jump，必要時讀 old/new transition evidence。
9. 若跳動且不能 crossfade，`micEdge.beginConvergence()`。
10. 回傳 MicReadPlan；不是在此提前 commit lastEmitted state。

第一刀擬新增純函式 `classifyMicReadMotion`，只吃 scalar snapshot：frameSamples、sampleRate、startSample、previouslyEmittedAdvanceSamples、previousAdvanceSamplesExact、lastEmittedMicFrameComplete、appliedAdvanceMs、既有兩個常數。輸出對應現有算式的 advance exact/rounded、micReadStart、bound、bounded flag、immediate jump、readHeadJumped、crossfadeSamples、previousTransitionStart。

不要把 session instance／getter closure 傳進純函式；不要把 applied authority 的計算搬進去；不要新造 `MicReadController` 吞 frontier、alignment、edge。兩段 transition evidence reads 及 canCrossfade 判定先留 caller。

### 精確算法不得「代數化簡」

- `advanceSamplesExact = (appliedAdvanceMs * sampleRate) / 1000`，再 `Math.round`。
- bound = `2 * frameSamples * RUNTIME_CALIBRATION_SLEW_FRACTION + 1`。
- bounded motion：`abs(exactDelta) > 1e-9 && abs(exactDelta) <= bound`。
- immediate jump 用 rounded new advance 與 previously emitted advance 比，還要求 previous frame complete。
- readHeadJumped 不要求 previous frame complete，因不完整舊 frame 仍需要 convergence。
- 舊位置預設模型不能取代已輸出的 history；fineTune 可能在兩 frame 間立即改變。

### 必測案例

無 history、零 delta、`1e-9` 兩側、剛好 bound／略超 bound、正負 advance、round 的半樣本邊界；previous complete=true/false；fineTune 改變後 emitted history 與 modeled history 不同；fold 發生後 history 已被 rebase。

canCrossfade 的 boolean 組合測試留在 session integration：old/new 任一有 gap/frontier miss 都不可 crossfade；改用 convergence 不能重播舊 PCM 掩蓋洞。

Gate：profile A＋FULL＋PERF；既有 golden／waveform step thresholds 不改。交接明列「本刀只抽純計算，state 尚留 session」是刻意設計，不得誇稱整個 planner 已有新 owner。

## A21 — 一起搬 PCM／evidence／clipping 的取樣，不拆成三套軌跡

前置：A20。白名單：session、擬新增 `src/mic-frame-reader.ts`、`test/mic-frame-reader.test.ts`、必要型別 export。`pcm-timeline.ts` 只允許必要型別變更，不改算法。

建議先搬 `readMicSlewedRange`，驗證後再搬 `crossfadeMicReadHeadJump`；可分 A21a/A21b checkpoint。保留普通 `readMicFrame` 快路徑，最後才決定是否將其一起收進 reader。

reader 輸入：timeline 的讀取視圖、frameSamples、lookahead、plan scalar fields、read-only clipping 查詢、read-only seam 查詢。不得持有可任意 reset/rebase 的 AudioSession，不能呼叫 limiter／edge／bus。

輸出保留現有 MicSlewRead 與 crossfade result：PCM、evidence、missingMask、inputClippingMask、firstPosition、rate；crossfade 還有兩種 evidence delta。crossfade 目前原地修改它收到的 current PCM，保留此契約，不能把 retained chunks 當 current 傳入。

精確不變量：

- slew rate = `1 + (toAdvance-fromAdvance)/frameSamples`。
- emitted samples 走 fractional rate；lookahead tail 從 frameEndPosition 之後走每格 +1，不把整條 tail 也套 slew rate。
- fraction 不為零通常吃左右兩格的 PCM 與 evidence；若 `index+1` 是 restart seam，只吃左格，三種 mask 一致。
- concealed PCM 可聽，但仍算 gap evidence；不要把 concealed 當 missingMask 的 silence。
- raw gap 與 frontier miss 保留其不同分類；負座標 pre-roll 在 audio silence 與 evidence 的差異不改。
- old crossfade leg 遇 restart seam，使用 seam 前的 held sample/evidence；不要跨到新 capture，也不要用雙向查詢。
- frame evidence 只算 emitted frame，不能把 lookahead tail 記入 Take。

numeric fixture 至少包含：左右樣本 1000/3000、fraction=0.5，無 seam 得2000、有 seam 得1000；右格單獨 unheadered/clipped/gap 時，證明 seam 擋住 audio 同時擋住 evidence；concealed gap waveform 非零但 gapSamples>0。

Gate：reader unit＋profile A＋FULL＋PERF。每條新 public return field 都需有 caller；不要為測試新增 production snapshot/getMutableState。

## A22 — continuity state owner（條件式，預設延後）

只有能把 `lastEmittedMicAdvanceSamples`、`lastEmittedMicFrameComplete`、`lastEmittedMicSourceSample` 的全部 reset/rebase/commit 點列完，且不產生 caller 與 owner 各一份 history，才可開卡。

尤其 `lastEmittedMicSourceSample` 在逐 sample mix loop 更新，另外兩者在 frame 結尾更新；不能整理成單一 frame-end commit 而改變本 frame 內 seam 判斷。無法維持這個差異，就保留現有欄位，不抽。

## 3. 音訊刀共同停手條件

需要改增益常數、duck duration、limiter lookahead、crossfade length、retention、maxFrames、clipping 閾值或 golden digest，均已超出本計畫。記錄第一個失敗樣本位置與 source/evidence，不以「聽不出來」通關。
