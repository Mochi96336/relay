# 條件式支線與最後驗收

Take storage、receiver不是前面削不動時拿來湊行數的替代品。先完成Z00的局部評估，證明值得動且有完整failure matrix，再開對應卡；不滿足則記deferred。

## R10 — AudioPacketReceiver 內拆（預設延後）

啟動條件：已把 pending、finalized、continuity owners、retransmit requested/candidates 的所有 read/write/reset/eviction列完，而且能抽出一組完整生命週期，不需要兩個物件共同修改同一map。

白名單：`src/audio-packet-receiver.ts`、擬新增 receiver-internal helper／test、既有packet receiver/continuity/retransmit tests。wire AudioPacket v2、MicRuntime admission、browser retransmit政策不改。

先選一個：retransmit request accounting 或 continuity retention。不能同一刀重寫 reorder、hold deadline、loss settlement 三者。

必要輸入表：generation、sequence、firstSampleIndex、source sample rate、arrival now、重傳路徑可用性、mix headroom。每項保留原單位與default clock，不把packet sequence當sample position；Uint32 wrap不是一般有號數排序。

oracle至少含：重複packet、out-of-order、wraparound、已finalized洞的late arrival、same capture reconnect、generation替換、request已排隊但未送與已送的差別、headroom不足放棄hold、loss確定後不可回填到已播放區間。

測試：`test/audio-packet-receiver.test.ts`、`test/audio-packet-receiver-retransmit.test.ts`、`test/audio-packet-continuity.test.ts`、`test/mic-loss-matrix.test.ts`、`test/mic-audible-loss-matrix.test.ts`、S-MEDIA、B-TRANSPORT、FULL。不要把已有確定seed的loss matrix改成機率性「大約沒事」。

## T10 — Storage validation 與 recovery decision

啟動條件：明確維護需求已記錄；S/B高頻熱點有穩定基線；T-STORAGE先全過。白名單：`src/take-library.ts`、擬新增 `src/take-artifact-validation.ts` 或 recovery-decision helper、對應新unit與現有metadata/recovery tests。

先讀：`take-metadata-validation.ts`、library的parse/validate/recovery/listAsync、`file-durability.ts`、`wav-take-writer.ts`。已經有 rich-field normalization，不複製第二份validator。

### T10a：只抽純驗證

輸入是讀出的bytes／parsed metadata／實際WAV artifact facts；輸出valid/invalid與既有normalized entry。sync/async I/O wrappers都呼叫同一純驗證，但I/O模式不互換。

保留actual WAV對sampleRate/sampleCount/sizeBytes/mixSampleRange的權威。metadata說有一個檔案，不代表WAV有效。日期、富欄位、derived claims沿既有validation，不自創寬鬆coercion。

### T10b：再抽 recovery decision，先不改執行效果

decision helper只能給具名計畫；fs rename/remove/write仍在storage層。每個計畫含精確takeId與已驗證artifact，不能回任意可刪路徑。directory containment／takeId validation不可移掉。

| Disk／process狀態 | 現有必須保留的結果 |
| --- | --- |
| 有valid WAV＋valid final metadata | final metadata優先；stale part cleanup失敗也不能隱藏正常Take |
| 有valid WAV＋valid staged part、無valid final | recovery可promotion；rename失敗仍以validated staged entry提供可讀fallback |
| 有valid WAV＋invalid metadata/part | 退到WAV-only recovery；不採信錯的rich metadata |
| 有valid WAV、無metadata | 可由WAV生成fallback entry；repair write失敗不等於WAV corrupt |
| 無final WAV＋metadata part，新的process | orphan stage，不可當ready recording；依既有repair清理 |
| 無final WAV＋metadata part，仍在本process `stagedTakeIds` | 保留live stage；history讀取不能把正在finalize的交易清掉 |
| corrupt/non-Relay WAV | 忽略該artifact，不令整個library失效 |
| reader先promotion了正在commit的同一stage | commit核對確切metadata後可idempotent成功，不是只因檔名相同就接受 |
| reader promotion得到不同metadata | fail closed，不接受成為該次commit的結果 |
| 孤立WAV `.part`／未完成writer | 不列ready；保留現有writer/cleanup政策，不在本刀發明修復音檔算法 |

`listAsync()` 是live read-only listing；不能為重用recovery函式而加rename/remove。既有sync read/repair路徑可能在同process發生，所以`stagedTakeIds`不是可移除的startup-only優化。

Gate：T-STORAGE＋FULL＋適用audio→Take proof。每個sync/async同輸入得到相同validation語意，但I/O side effects依原入口區分。測試只用自建tmpdir，不用repo `takes` 或使用者錄音。

## T11 — Finalization transaction（比T10更晚）

白名單：`src/take-controller.ts`、擬新增 `src/take-finalization.ts`／test、writer/library的必要窄interface型別；不改檔案格式或保留策略。

啟動前逐行讀 `finalizeStop`、`finalizeWriter`、`failWriter`、`abortWriter`、`shutdown`。不要只看下面happy path。

### 真正的現行成功順序

```text
確認current Take仍是此takeId且finalizing
  → await library.stageFinalizing(...)
  → await writer.finalize()               # 包含WAV durable publication
  → 驗證file.sampleCount與recorded range
  → session.complete(takeId, artifact)     # 這裡current lifecycle成ready
  → 若complete成功且current artifact有效:
      metadataStaged ? await commitStaged : await record
      更新history cache（library成功時）
      emitChange
      scheduleRetentionPrune
```

不要改成「metadata final commit後才能session.complete」。現有contract明確是complete後才commit sidecar；WAV仍是recording authority。metadata故障與audio故障不是同一種failed Take。

### Failure matrix（每列都要有行為證據）

| 故障點 | 現有處理要點 |
| --- | --- |
| stage metadata失敗 | report storage error，仍嘗試writer.finalize保住audio；成功後走record fallback |
| writer.finalize失敗 | discard此交易stage、session.fail（只作用matching take）、abort此writer |
| WAV sampleCount與recorded range不同 | fail matching Take、discard stage、discard該finalized WAV，不列ready |
| session.complete拒絕matching identity | 清此交易stage與finalized writer artifact，不碰下一個Take |
| commitStaged失敗 | 保留可恢復WAV；若stage存在保留供recovery；report error，不把audio當成不存在 |
| record fallback失敗 | report storage error；validated WAV仍可恢復 |
| discardStage／cleanup失敗 | report／維持既有錯誤隔離，不掩蓋主要結果，也不刪其他Take |
| prune失敗 | 不讓新的recording lifecycle變failed；保留prune chain的既有隔離 |
| shutdown遇finalizing | 先停止新mix frames，await finalization，再停其他服務 |

Fault injection先沿現有tests使用的方式；不要修改全域fs/prototype後未restore，造成下一個測試失敗。用故意失敗的窄storage port或隔離fixtures；不要對真實目錄chmod或刪檔模擬故障。

`writer identity`、`takeId`、`current session lifecycle`三種檢查各有用途；不能改成只比較takeId。`finalization` promise 的清除也必須確認仍是同一個promise，不讓舊finally清掉新交易。

Gate：T-STORAGE＋S-MEDIA＋FULL＋BROWSER-AUDIO。不得以「所有exceptions都catch後continue」讓測試綠，必須檢查ready/failed/history/files四種觀察結果。

## Z00 — 本輪削山的實際完成標準

不是所有支線一定做完，也不是整個repository宣稱永遠乾淨。列出本輪實做卡、deferred卡與原因，再驗收已承諾的範圍。

### 結構清單

- 各owner state只寫一處，caller沒有鏡像影子state。
- 新元件確實有production caller；未接線helper不能算瘦身。
- 新依賴沒有domain→server/DOM/socket adapter反向邊；shared沒有平台特定實作。
- 原coordinator已逐個分類，重要順序契約沒有因合檔消失。
- 關鍵操作不再需要沿server/app的十幾個閉包找cleanup；若仍需，列殘餘，不用行數宣稱完成。
- `.d.ts`與browser exports一致；相容wrapper有明確使用者與移除條件，不新增永久雙實作。

### 變更情境演練（只做定位驗證，不真的改產品政策）

| 假設未來要改 | 預期只需理解的主要邊界 | 壞味道 |
| --- | --- | --- |
| 調整Mic gain ramp算法 | MicGainRamp＋其tests；server仍授權 | 要同時改app/source/Take |
| 查一個capture seam爆音 | boundaries／reader／source edge對應trace | 只有一個巨大的mixFrame可讀 |
| 增加timing策略拒絕原因 | admission policy＋orchestration＋product projection | UI從diagnostics另猜一份 |
| 處理Mic換裝置 | graph/session＋generation invalidation交易 | 每個socket.close各自拼cleanup |
| 查WT stale rejection | queue/pending writes＋preference identity | 舊promise能任意讀寫facade所有state |
| 查handoff timeout | 具名transaction＋timer ownership表 | 六個timer各自在入口global修改player |
| metadata修復失敗 | library recovery＋durability | status reader會順手刪現行stage |

若演練仍落入壞味道，記下下一輪具體切點；不要再開大重寫來追求本輪「全部完成」。

### 最終證據包

1. source worktree/HEAD/完整dirty inventory，含untracked；測試時的fingerprint。
2. 每卡C0–C2、scope變更、state ownership migration表。
3. CHECK、相關profiles、最後FULL、所需browser/WT proof的命令、exit、count與log。
4. golden digest未變；若原golden檔因共享fixtures定位變動，需逐項證明digest constants不變，不能只看整檔hash不同就放棄檢查。
5. source/AST測試移轉清單與替代的行為保障。
6. PERF結果／資源cleanup證據；未量測不寫效能提升。
7. 真機／YouTube／acoustic場景哪些未測、誰能驗證；deferred工作不包裝成done。
8. 沒有自動commit/push/deploy；若屆時使用者另有授權，照該授權另行執行與報告。

最後handoff用具體句子：完成哪些owner、仍留下哪些責任、全部gate是否通過、下一張卡是哪張。不要只說「已重構、測試通過」。
