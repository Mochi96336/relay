> 歷史調查紀錄（2026-10-10／11），不是目前即時狀態。文中提及的原始錄音、JSONL、截圖與舊封存已依清理要求移除；保留結論與限制，不宣稱仍可重跑原始統計。

# Boot／Shadow 誤差：已確認與未確認

## 已確認：舊 Robot delta 用錯參考點

`5960678` 的 public/source.js 以 timeline.serverTime 為 target；Boot 公式卻把 delta 解讀為 Robot − 手機。當手機與穩定 room clock 相差 phase 時，Boot 的 live 候選把這段 phase 也帶進來。

`e27de50` 已改用 timeline.youtubeTime，與 450 ms 跟隨使用同一參考點。

舊兩輪 73／205 ms 是候選總誤差，不能宣稱是 Mic／Robot 探測差值的誤差。舊 JSONL 沒存 timelineDifferenceMs，所以不能精確分解其中多少由錯參考點造成。舊兩輪與新一輪不是同條件的 Boot／Shadow 優劣試驗。

## 已確認：探測編號與已完成結果會錯配

bootProbeTimingEvidence 會隨新探測替換；bootCalibration 在重測期間保留已完成結果。先前報告直接用當前探測編號標示保留結果，因此可能標成新 probe，數值其實是舊 probe。

修正：完成 promotion 時保存 completedBootProbeTimingEvidence，清除 Boot 時一同清除；報告採用完成結果的編號。歷史資料只有當探測 latency 與 Boot latency 相同時才採用該探測編號，否則標為未知，不假造來源。

## 已確認：sample/song 不是聲學量測

手機把當下 IFrame 秒數配上 Mic capture 時間，沒有量出該秒數何時從喇叭出聲、又何時進 Mic。Robot 的播放器與 capture 也有輸出／擷取路徑。兩邊 sample/song 可以避開跨主機接收時間與 RTT 對稱假設，但無法只靠這些錨點辨識所有物理路徑延遲。

物理反例測試：相同錨點算出 190 ms；若手機與 Robot 輸出路徑分別為 120／20 ms，聲學真值是 290 ms。這 100 ms 不能從相同錨點還原。這是可辨識性限制，不是對實機延遲的宣稱。

## 目前數據支持到哪裡

現有 1800 筆可重跑報告，不必重錄。602 筆符合嚴格配對條件，五段但只有一個 Capture／一首有效比較歌曲；時間相依，不能算五次獨立實驗。

其中 205／95 ms Boot leg 段，逐筆扣掉 Robot delta：Boot 路徑差 110 ms，Content 推得約 130.5 ms，Shadow 殘差約 6.8 ms（此分項診斷使用較寬的 complete Content 條件，不能與 602 筆嚴格結果混作同樣本統計）。這定位了差值所在，但尚不能指認確切硬體或 YouTube 內部緩衝。

## 未完成

Boot 剩餘約 20 ms 的實機物理來源、舊兩輪錯參考點的精確份額，以及手機／Robot 的各個聲學輸出延遲仍未證實。不能以固定加 110／120 ms 修補所有裝置，也不能把 Shadow 宣稱為完整聲學真值。

這輪沒有新增採集需求；新開的採集已停止。

## 50445e4：修正可證實的 Boot 排程偏差

舊 target = serverSentAt + (networkDown + localPreparation + networkUp)/2 + lead。
實際排程 = serverSentAt + networkDown + schedulingDelay + lead。

新客戶端分別回報接收至 ACK 的 processingMs，以及接收至排程的 schedulingDelayMs。新 target = serverSentAt + (roundTrip - processingMs)/2 + schedulingDelayMs + lead。這仍對純網路部分採對稱假設，沒有使用跨主機絕對時間。

缺欄位、processing > RTT、scheduling > processing 等資料維持 legacy 算法。完成探測診斷另外記錄採用方法與 targetAtMs，可確認特定客戶端是否已載入新版；舊頁面不會被誤稱為已採新版算法。

時序反例測試：單向網路 20 ms、resume 200 ms、排程後建立節點 4 ms、lead 200 ms。真排程 420 ms，舊 target 322 ms；新算法得到 420 ms。實際 WS handler 測試驗證 correction 生效、舊回覆與 generation fence 保留。

歷史 1800 筆大多 processing 0.1–0.8 ms，不能用此修正解釋其中全部約 20 ms 剩餘誤差。一次即時查詢觀察到 Robot 首次 AudioContext 初始化 processing 26.9 ms，證明慢 preparation 並非只有理論情境；但當時沒有 schedulingDelayMs，不能精確反推這次修正量。

修改前單次狀態保存於 observations/boot-before-scheduling-fix.jsonl；沒有新增長時間採集。

## Boot 拒絕原因不再消失

載入排程修正後，服務與 Mic 音訊健康，但實機 Boot 缺少 ACK，尚不能宣稱新算法已在實機完成一輪校準。程式存在另一個確定的觀測缺口：頁面 hidden 時 playCalibrationProbe 直接 return，伺服器只見 timeout；resume 中途 hidden 時甚至可能報 AudioContext is running，掩蓋真正原因。

改成 capture/request fence 仍有效時明確回報 page is hidden；舊 capture 不得回覆失敗。生產函式 VM 測試覆蓋呼叫前 hidden、resume 後 hidden，以及過期 capture。此修改隨 public/app.js 提供，新載入頁面才有此行為，不強制重載使用者頁面。

尚未觀察到當時實機 visibility，所以不能把剛才 ACK timeout 定案為背景頁面。沒有因此再重啟服務或開啟長時間採集。

## 48429e4：新 Content 確認被誤當成 Robot 位置抖動

線上 RELAY_CALIBRATION_DELTA_REAPPLY_MS=150。decideCalibrationMixerApplication 原先對所有 Robot Content 目標都使用這個門檻，沒有區分「新確認結果」與「同一確認結果下的播放器位置微動」。因此新的 Content 比 Boot 少於 150 ms 時，confirmed authority 已變成 Content，但 mixer 仍留在 Boot。這是已重現的套用錯誤，不是物理延遲猜測。

一次即時狀態：Content reference=-80 ms、live target=-86.056957 ms；實際套用=-131.590141 ms，恰等於保留 Boot 的 advance。這次相差約 45.53 ms，低於 150 ms，所以被舊政策忽略。之後保存的 observations/content-before-authority-fix.jsonl 仍顯示 activeCalibrationKind=content、applied 等於 Boot，但當時歌曲時間已過期，live target=null；不可拿這份稍後快照假造最初 live target。

修正：記住真正送到 mixer 的 confirmed revision 與來源。新 revision 或來源改變時跳過「同一份校準的抖動」門檻；後續同 revision 位置微動仍保護。Take 和 mapping hold 不消耗新 revision，恢復可套用時仍須完成切換。撤銷結果會清除已套用來源，不能拿舊標記阻擋復原。

新增 confirmedCalibrationRevision 與 mixerCalibrationAuthority，與 activeCalibrationKind、目標及實際 advance 分開記錄。mixerCalibrationAuthority 表示目前 read-head target 所屬來源；slew 途中仍須看 appliedMicAdvanceMs 知道實際讀頭位置。

生產 syncAppliedCalibration 函式與真正 AudioSession 的可執行測試覆蓋：Boot→Content 小於門檻仍套用；同 revision 抖動維持 hold；Take 期間確認後延後套用；mapping hold 後補套用；撤銷及復原。22 項相關測試、型別及語法檢查通過。Pi 上沒有跑完整 CI。

這項修正也說明為何舊的「Content 有效」標籤不代表聽到的是 Content 目標。原始相關量測誤差與套用錯誤必須分開。

## 上線後已驗證：Robot 慢準備曾被誤算進管線延遲

48429e4 上線後的一次完整 Boot 成功，兩腿相關度 Mic 0.9808／Robot 0.9910；真實原始狀態存於 observations/boot-scheduling-live-verified.jsonl，逐項算式存於 observations/boot-scheduling-live-verified.analysis.json。

|來源／數值|Mic|Robot|
|---|---:|---:|
|探測 requestId|1|2|
|量到路徑延遲 ms|140|160|
|本地準備 processingMs|9|497.3|
|排程前等待 schedulingDelayMs|未回報|493.4|
|含準備的往返 roundTripMs|41.69|645.15|
|實際採用方法|legacy-rtt-half|processing-separated|

Robot 的新 target 比舊 target 晚 schedulingDelay - processing/2 = 244.75 ms。對同一個 actualSample，用舊 target 回算會得 160 + 244.75 = 404.75 ms；新 target 得 160 ms。404.75 是同一筆資料的反事實回算，不是另一次舊版實測，不能冒稱 A/B 實驗。

因此「本地 Robot 路徑看起來很慢」已有一個實機證實的誤差來源：AudioContext 本地準備被包含進 RTT 並對半分。剩下 160 ms 包含輸出、擷取、管線放置與網路對稱估計誤差，不能直接叫作純網路延遲。

此輪總 Boot = 140 − 160 + 0 = −20 ms。此時無 YouTube delta，所以不可拿 −20 ms 與之前播放中的 −131／−86 ms 比大小。手機這頁缺少 schedulingDelayMs，因此仍使用明確標示的 legacy 算法；沒有強制重新載入。

實機 Content 切換尚待有 YT 時間回報時驗證；可執行生產函式／AudioSession 測試已通過，但不能當成已驗證本次實機切換。


## Content authority 實機驗證（2026-10-10）

播放回報恢復後，單次唯讀快照 observations/content-authority-live-verified.jsonl 證實 confirmed revision 與 Mixer authority 一致，Content target 已實際套用，未繼承 Boot。此為套用邏輯驗證，並非聽感準確度驗證。

```json
{
  "observedAtMs": 512326.635232,
  "confirmedCalibrationRevision": 7,
  "mixerCalibrationAuthority": {
    "revision": 7,
    "kind": "content"
  },
  "activeCalibrationKind": "content",
  "micLagMs": -165,
  "calibratedMicLagTargetMs": -160.69107915496585,
  "appliedMicAdvanceMs": -160.69107915496585,
  "bootCalibration": {
    "advanceMs": -179.9087920870781,
    "micLatencyMs": 225,
    "backingLatencyMs": 100,
    "deltaMs": -304.9087920870781,
    "confidence": 0.8137901476386407
  },
  "validation": {
    "enabled": true,
    "state": "waiting",
    "baselineLagMs": -165,
    "lastMeasuredLagMs": -165,
    "lastDeltaMs": 0,
    "suspectLagMs": null,
    "lastOutcome": "stable",
    "lastValidationAgeMs": 18636,
    "nextValidationInMs": 11364
  }
}
```


## 最終 CI 驗證 ab6caeb

GitHub run 38043603329：2,597 tests 通過、0 失敗；畫面／DOM 與 WebTransport 通過。Production browser audio proof run 38043603328 通過。Pi 僅執行必要局部檢查，兩個服務仍 active，測試目錄修正不需重啟。Shadow 真正擷取時間及實體路徑誤差仍未解決，CI 不證明聲學準確度。
