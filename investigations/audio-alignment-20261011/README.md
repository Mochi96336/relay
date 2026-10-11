# 聲音對齊與網路診斷結案紀錄

此處保存必要結論、量測摘要與限制；可重用程式在 scripts/diagnostics/。
2026-10-11 清理後不再依賴 Pi 家目錄的 relay-shadow-evidence。

## 已確認與已處理

- Robot delta 曾以 serverTime 為參考，但 Boot 把它解讀為 Robot − 手機；已改用 youtubeTime。
- 完成 Boot 的 probe 身分曾可能被新探測覆蓋；已分開保留完成結果來源。
- Robot 本地 AudioContext 準備曾算入往返時間再對半分，造成路徑延遲高估。實例準備 497.3 ms、排程等待 493.4 ms；同筆資料新算法 160 ms，舊算法反事實回算 404.75 ms。這不是兩次 A/B 實測。
- 新確認 Content 結果曾被當成同一結果的位置抖動，小於 150 ms 而未套用；已以來源／revision 區分，且單次實機快照確認 Mixer authority 與目標一致。
- Robot 收斂跳動不應混入校準權威，對應 PR #550。
- Mic Opus 與自動碼率：128 → 64 → 32 kbps；持續媒體壓力 3 秒降檔、至少間隔 5 秒、連續穩定 30 秒逐級恢復；RTT 不單獨觸發。對應 #551／#553。
- 各收聽端分開回報健康度；接收速率為約一秒音訊應用層實測，不是網路容量或編碼目標。對應 #552／#554。

## 保留的量測摘要

room-cadence-phone-leader.summary.json：本機收聽 45 秒、2,250 個 frame，樣本位置無斷點，
最大送達間隔 36.675 ms、p99 25.022 ms，沒有超過 40 ms 的間隔。

room-codec-phone-leader.summary.json：本機 PCM／Opus 配對 749 個 frame，解碼失敗 0，
對齊後相關度 0.9986334，位移 312 samples。
這些只描述當次本機接收，不證明遠端裝置播放健康。使用者後來確認細碎破音是裝置問題，調查已停止。

## 尚未證明

- 樣本編號／YouTube 時間錨點可避開跨主機收包時間與 RTT 對稱假設，
  但無法辨識手機喇叭至 Mic、Robot 輸出至擷取的全部實體路徑延遲。
- Boot 剩餘約 20 ms 的物理來源及各裝置實際聲學延遲未定案。
- 歷史 602 筆嚴格配對來自一個 Capture／一首有效歌曲，不是多次獨立實驗；
  不可據此宣稱備援估計或 Boot 全面較準。
- 自動降碼率已有 WS／WT 瀏覽器測試，手機差網路的完整降檔與恢復仍需現場驗證。
- CI 與套用邏輯通過不等於實際聲學準確度已證明。

## 原始資料清理

保留三份歷史報告與兩份小型數值摘要；其餘原始錄音、長 JSONL、
過時畫面、暫存草稿、測試產物與舊壓縮包不放入 Git，遠端推送確認後移除 Pi 副本。
因此歷史報告的原始檔名只作來源記錄，不能再據此重跑當次分析。

重構工作不在本次功能修改範圍。有未提交修改及正在使用的 worktree 保留。
四個已移除的乾淨 worktree 版本仍在 Git：
archive/cleanup-audio-perf-baseline、archive/cleanup-perf-origin-main、
mutation/publisher-activation、fix/timing-fallback-estimate。
