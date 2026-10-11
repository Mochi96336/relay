> 歷史調查紀錄（2026-10-10／11），不是目前即時狀態。文中提及的原始錄音、JSONL、截圖與舊封存已依清理要求移除；保留結論與限制，不宣稱仍可重跑原始統計。

# 實作與驗證核對（a4487cc）

|要求|目前證據|結論|
|---|---|---|
|先試樣本／YT 估計取代 RTT/2|Pi systemd drop-in 啟用 sample-song；sample-song-fallback-server 實際協定測試驗證啟用／過期撤回；live status mode=sample-song|已實作上線；聲學正確性未等同證明|
|Boot／Content 優先，錄音期間凍結|AudioSession requestedMicAdvanceMs 選擇 acoustic；refreshLiveMicNetworkCompensation 在 Take recording/finalizing 返回；實際 synchronizer 測試覆蓋 Take 後 pending revision|程式行為已核對；單一測試不是整場錄音驗證|
|Robot 超過 450 ms 跳回|source-holder-follow 測試 signed 449/450/451、等待窗口、holder 與 server drift 分歧；production source target 使用 youtubeTime|已修正；測試涵蓋控制邊界|
|速度不同造成房間相位累積|youtube-timeline-phase-drift 覆蓋慢／快、速度恢復、凍結與 jitter|已修正並通過 CI|
|Boot 誤差來源與誰量到多少|completed probe timing evidence；BOOT-ROOT-CAUSE.md 的實機本地準備案例與原始快照|已分離完成量測來源；手機舊頁面仍 legacy 算法|
|Content 新權威真的套用|server-calibration-mixer-application 執行生產函式；observations/content-authority-live-verified.jsonl revision 7 target=applied|已證明當次套用；不代表最新 candidate 成功|
|資料分組，避免混淆原始／換算／實際值|YT-MEASUREMENTS.md、sample-song-shadow-report 與 raw anchor pair；目前 UI 同一折疊內分測試音／內容／備援／驗證|已整理；歷史舊 Robot 參考不可事後完全復原|
|時序 UI 有 YT 時間與折疊層次，不顯示 RTT/2／Shadow 內部名稱|390px 真實 Chromium DOM 與折疊截圖；GitHub visual/DOM 通過|已上線；Pi 缺中文顯示字型時不能以截圖證明中文字形|
|Pi 不跑完整 CI，GitHub 跑完整 CI|run 38044906417：2,600/2,600；production audio run 38044906444 通過|通過|
|實際聲學對齊準確度|latest-authority-audit：Content candidate 訊號不足失敗，保留 Boot revision 14，無 fresh Robot delta／有效 sample-song candidate|未完成驗證；缺新的有效聲學參考及實際聽感|
|Robot 原生時間戳能消除誤差|獨立 probe、編號迴路與 queued 分解資料；尚未變更正式 capture|只有研究證據，不是已實作改善|

Mic AudioContext 底層產速不足仍未根治；使用者先前要求回到 450 ms／YT 時間工作，未重新展開 Mic 調查。正式服務均 active；PR 未合併；未更動 REFACTOR_PLAN.md 與 docs/。
