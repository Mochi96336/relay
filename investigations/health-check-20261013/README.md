# Relay 校準、傳輸與使用體驗健檢

調查日期：2026-10-13，Asia/Taipei。程式基準：`1bc6b500c8d9ac2be175d6943671b430e50016df`，分支 `deploy/2026-10-12`。
使用者確認：**外放與耳機唱歌都需要支援，目前只有外放能成功校準。**

結論：傳輸與生命週期已有相當完整的保護；這次沒有發現持續中的傳輸中斷。優先問題是耳機缺少合適的對齊路徑，以及校準實際狀態、恢復指引和部署版本不一致。測試通過不能替代實際聲學對齊驗收。

本次讀取程式、現有錄音品質 metadata、服務 journal、HTTP／唯讀 WebSocket 診斷，執行局部測試及隔離的 Chromium DOM 驗證。未重啟正式服務、操作正式房間播放／Mic／Take、修改產品程式或提交 Git。完整快照留在 `/tmp`；此處只保存去識別摘要和可重跑的政策重現。

## 優先處理事項

P1 表示應優先完成的功能或部署修正；P2 表示會誤導操作或降低品質判讀的問題。這不是已發生資料損毀或服務停機的分級。

| 優先 | 發現 | 證據強度 | 建議 |
| --- | --- | --- | --- |
| P1 | 耳機與外放共用需要聲音回到 Mic 的校準流程，耳機沒有可靠的完成路徑 | 使用者確認＋實際三次失敗＋實作 | 分開外放聲學量測與耳機估算／獨立量測流程；明示品質與限制 |
| P1 | 服務 build 標記與實際提供的前端不同 | 實際 HTTP、磁碟 hash、服務啟動時間 | 部署應切換一致的資產快照與程序；版本偵測必須描述實際提供的檔案 |
| P2 | 已保留的 Boot 校準被 UI 說成 fallback | 純函式組合重現，未在本次正式房間注入狀態 | ProductStatus 依已套用 authority 判讀，另呈現同步資料暫時過期 |
| P2 | 錄音中要求重新校準，但操作被錄音政策禁止 | 政策重現＋Chromium 實際 DOM | 明示本段使用估算、錄完再量測；錄音前提示當前對齊方式 |
| P2 | 閒置 Robot 被監控持續報 degraded | 30 秒實測＋政策重現 | 有實際演唱／同步需求時才判斷相關告警，避免無法恢復的閒置告警 |
| P2 | 錄音品質缺少足夠的校準來源與重度限幅證據 | 四份 metadata＋Take quality 實作 | 保留估算來源、量測失敗原因／時間和重度限幅比例，改善事後判讀 |

## 1. 校準：耳機支援缺口比放寬相關度門檻更重要

現有 Boot 組合為 `Mic 路徑延遲 − Robot 伴奏路徑延遲 + Robot/播放端媒體差 ÷ 播放速率`。
手機／電腦透過 AudioContext destination 播放探測音，伺服器在上傳的 Mic PCM 中尋找該聲音。Content 校準則比對 Mic 與伴奏中的共同內容。
當耳機沒有把可辨識的伴奏／探測音送回 Mic，這兩種方法都缺少必要的共同量測訊號。單純提高音量、降低相關度門檻或增加重試不能建立缺少的證據；降低門檻反而可能接納錯誤峰值。

實際事件：

- 01:04:44–01:04:55，Windows Chrome 的藍牙耳機輸入做了三次 Mic probe，相關度為 **0.299、0.374、0.385**，均低於 **0.500**。
- 該次回報的 echo cancellation、noise suppression、auto gain control 均為 false，不能把失敗直接歸因於這三個瀏覽器設定。
- 日誌裡的 1790／2585／975 ms 是未通過相關度驗證的候選位置，**不是可靠的耳機延遲量測**。
- 同一程序更早存在相關度約 0.86–0.96 的成功 Mic probe 與完成 Boot 組合。這只能證明某些條件能找到探測音，不能證明跨裝置聲學誤差已驗收。
- 日誌記錄了輸入裝置，未可靠證明那次實體輸出路由。耳機因缺少回授而失敗是與使用者回報、架構一致的解釋，並非從一筆日誌量得完整物理因果。

已有可利用的耳機估算基礎：`SampleSongFallback` 使用 capture sample／YouTube media 錨點，不依靠伴奏洩漏進 Mic。正式程序已設定 `RELAY_SAMPLE_SONG_FALLBACK=sample-song`；證據不足會退回 transport estimate。它在程式中明確屬於 approximate，不能消除所有 DAC、ADC、Bluetooth、OS 路徑延遲。

建議產品決策：

1. 明確區分外放與耳機情境；避免只憑輸入裝置名稱自動斷言輸出路由。
2. 外放維持 Boot／Content 量測，收集多次獨立實驗的殘差與成功率。
3. 耳機先提供有來源、有新鮮度的估算狀態；不要顯示成聲學校準成功，也不要持續暗示再按一次 Realign 就能解決。
4. 若耳機需要可靠的絕對對齊，另設可驗證的路由量測或人工驗收偏移流程；以特定裝置／路由保存並在換路由時失效。既有 `vocalFineTuneMs` 有伺服器欄位，但正常 Mic 頁面目前沒有操作控制，不能稱為已有完整耳機校準功能。
5. Record 之前讓使用者看得懂「已量測／估算／未就緒」，允許有意識地選擇估算錄音。毋須把所有估算狀態變成不能唱或不能錄。

相關實作：[Boot 公式](../../src/boot-calibration.ts)、[播放 probe](../../public/calibration-probe-playback.js)、[probe 時間估算](../../src/probe-timing-diagnostics.ts)、[sample/song 估算](../../src/sample-song-fallback.ts)、[Mic 頁面控制](../../public/mix-controls.js)。

## 2. 實際錄音：四段都沒有套用聲學校準

以下是本機現存四份 metadata，不能代表所有歷史使用，也不能據此推算整體成功率。

| 錄音結束時間（台北） | 時長 | 品質 | 非聲學估算比例 | Mic gap | Backing starvation | 限幅樣本比例 |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 10/08 00:36:52 | 88.88 s | degraded | 100% | 12,487.5 ms | 15,448.1 ms | 56.46% |
| 10/09 01:05:45 | 202.68 s | review | 100% | 229.5 ms | 0 ms | 53.61% |
| 10/09 01:13:30 | 204.10 s | review | 100% | 0 ms | 0 ms | 48.85% |
| 10/13 01:08:14 | 168.40 s | review | 100% | 0 ms | 0 ms | 46.00% |

最新 Take 從約 01:05:26 開始，早於它的 probe 已三次失敗；這段沒有記錄 Mic／Backing gap、starvation、輸入／輸出 clipping 或 transport lifecycle event。它標成 review 的唯一 issue 是 timing-fallback。

`networkEstimateMs` 把 RTT 與 sample/song fallback 都歸在非聲學估算，metadata 未保存足夠資訊區分兩者；**不能說四段全部只用了 RTT**。也沒有用混音 WAV 的主觀聽感替代原始雙軌量測。

Take 開始後會中止背景 Content 收集／驗證並凍結校準套用；sample/song 模式的 fallback 更新也暫停。因此「先錄起來，等它稍後自動量準」不符合目前行為。這是保護錄音不中途跳位的政策，需要在使用流程上說明。

限幅比例代表 limiter gain 低於 0.99 的樣本比例，**不等於 clipping、失真比例或 >3 dB 重壓縮比例**。最新事件另外出現過 `too-loud`，在 +10 dB Mic gain 下某個一秒窗口有約 691 ms 重度限幅。Take metadata 沒有保存 heavyLimitedSamples，無法計算整段重度壓縮比例。建議先補證據，再判斷是否調整預設增益；不從目前數字直接指定一個通用增益值。

相關實作：[Take 起錄與校準同步](../../src/server.ts)、[Take 品質](../../src/take-quality.ts)、[Limiter](../../src/mic-limiter.ts)。

## 3. 兩個已重現的產品狀態矛盾

執行：

```sh
node --import tsx investigations/health-check-20261013/reproduce.mjs
```

這個調查程式驗證「目前確實存在的輸出矛盾」，不是將錯誤行為加入正式回歸規格；修正後應更新或撤下對應斷言。

**保留有效 Boot 校準，卻被說成退回估算。** `decideCalibrationApplicability()` 對已建立、暫時不新鮮的 Robot delta 回傳 hold。Server readiness 也把保留且已套用的校準視為 valid。但 `product-view-model.ts` 的 `acousticAlignmentServing()` 再次要求 fresh delta，導致 timing=fallback、recovery=recalibrate。Remote health 更在沒有查看 mixer timing mode 的情況下，直接宣稱「fell back to the network estimate」。應保留「量測仍套用、同步資料暫時過期」的語意，不虛構權威已切換。

**錄音期間的恢復指引不可執行。** 以 network-estimate 起錄後，ProductIssue 指示 recalibrate，actions 卻是 canStartCalibration=false、blockedReason=take-active。Chromium 的正式 presenter 也同時產生：

> 時間對齊正在恢復／目前先用網路估計來對齊時間。／按「重新對齊」重新量一次。

而 Realign 控制已停用，旁邊是「停止錄音後才能重新對齊」。局部控制的禁止理由正確，System 的恢復文案卻沒有跟隨同一政策。錄音中也不會自動套用新的校準，不宜用「正在恢復」暗示稍等就會修好。

相關實作：[校準適用性](../../src/calibration-applicability.ts)、[產品對齊狀態](../../src/product-view-model.ts)、[問題與恢復](../../src/product-issues.ts)、[校準按鈕](../../public/calibration-ui.js)、[System 文案](../../public/system-details.js)、[Remote health](../../src/remote-status.ts)。

## 4. 傳輸：目前穩定，歷史累計需要分開讀

正式程序從 10/12 20:43 持續運作，Relay 與 Robot source 的 NRestarts 均為 0。30.07 秒、七次快照期間沒有 Mic，歌曲已結束：

- Robot backing 48 kHz，frame age 在 9–42 ms。
- 兩個既有 Opus 收聽端皆回報 running／playing；underruns、starvedMs、trimmedMs 的增量均為 0。
- Server monitorDroppedFrames 增量為 0。
- 觀測窗口結束時 listener queue 約 214／250 ms；服務 live prebuffer 為 400 ms。這些是各層緩衝，並非已量得的端到端延遲。
- 收聽端累計數字曾有 214 秒及約 3.07 小時 starved，但這段窗口未增加。Worklet 等待初始／重新 prebuffer 的 render 時間也算入該計數，不能將其直接翻成「剛剛網路掉音三小時」。
- `/statusz` 中負的 Mic headroom、舊 Mic level／capture generation 在沒有 Mic 時仍保留。這些欄位應搭配 active／connected／freshness 讀取；不能當成目前有人正在丟音。

部署已啟用 Listen Opus、Mic Opus trial 與 sample/song fallback。HTTP/3 UDP 4433 有 bind；設定的憑證在觀測當下有效，期限到 2026-11-20。這只確認本機設定與監聽，沒有證明外部手機的 UDP 路徑或正在使用 WebTransport。

檢查到的保護包括 sample-addressed PCM、丟包重送與 budget、WT→WS fallback／重新升級、sender backpressure、Opus 動態碼率、listener positioned frame／ack backlog、播放端緩衝與 concealment。相關局部測試通過；無 Mic 的正式快照不構成這些功能在當下真實弱網下運作的證據。

Remote health 在歌曲已結束、無 Mic、readyz.ready=true、ProductStatus healthy 的狀態下仍持續 degraded，原因只是 offsetFresh=false。建議把無演唱需求時的 delta 過期與有需求時的同步退化區分，並讓告警描述實際 mixer authority。

## 5. 部署：版本提示存在盲點

實際觀測：

- 程序 `/statusz.build.relay` 與新抓的 HTML meta 都是 `d848aced5c4d`。
- 對現在 `public/`、`shared/` 重新計算的 build 是 `08db18b667fa`。
- HTTP 提供的 `youtube.js` 與目前磁碟內容完全一致。

`computeRelayBuild()` 在程序啟動時計算，HTTP adapter 每次讀取現在的 HTML，static middleware 也讀現在的檔案，因此程序未重啟而資產更新後，**新舊頁面可以拿到同一標記卻執行不同程式**。Participant authentication 比較的是這個標記，不能可靠提示這種更新。

短期部署需要在合適時機同步程序與資產；長期應服務不可變版本目錄或加入一致性檢查。僅每次重算 HTML hash 仍不能完全解決載入期間跨版本模組混用。本次沒有替使用者重啟正在服務的房間。

另外，`/statusz` 已實際回覆 `Cache-Control: no-store`，本地 HTTP 的即時狀態快取修正有生效；沒有把這項觀測擴大成外部 CDN 的端到端驗證。

相關實作：[build 計算](../../src/relay-build.ts)、[HTTP 資產供應](../../src/relay-http-server.ts)、[頁面版本比較](../../public/participant-auth.js)。

## 6. 驗證與尚待實機驗收

| 本次驗證 | 結果 | 範圍 |
| --- | --- | --- |
| `npm run check` | 通過 | 目前工作樹型別檢查 |
| 校準局部測試，10 個檔案 | 84/84 | Boot 公式／套用、context、analysis deadline、Content validator、promotion、Take divergence |
| 傳輸局部測試，11 個檔案 | 113/113 | retransmit、backpressure、WT repromotion、fallback hole、generation、bitrate、audible loss、monitor、worklet、Opus decode |
| UX／產品局部測試，10 個檔案 | 91/91 | calibration UI、product issues、remote health、song replay、freshness、Listen gesture、mobile restart contract |
| Chromium DOM＋geometry | 50/50 | 正式 DOM／presenter，390×844 與 1024×768，使用隔離的 socket／audio harness |
| 新增政策重現 | 三組現況斷言通過 | held Boot 誤報、錄音恢復矛盾、idle Robot degraded |

共 288 個 Node 局部測試與 50 個瀏覽器測試通過。沒有在 Pi 跑完整 CI 或 mutation。測試命令見 [validation.md](validation.md)。

另外查到 `bd1bc5a` 的 [CI](https://github.com/Mochi96336/relay/actions/runs/38285083219) 與 [Production browser audio proof](https://github.com/Mochi96336/relay/actions/runs/38285083258) 完成成功。該候選與本部署整合樹仍有 23 個檔案差異，不能當成 `1bc6b50` 整合版完整 CI 通過的證明。

實機驗收應分開做以下矩陣，先約定可接受的偏移、恢復時間與掉音門檻，再量測：

| 情境 | 要取得的證據 |
| --- | --- |
| 手機外放＋手機 Mic | 多次獨立啟動的 Boot／Content 成功率，實際輸出／收音對齊殘差；避免把相關度當成殘差 |
| 有線耳機、藍牙耳機 | 確認輸入／輸出路由，sample/song estimate 可用率，殘餘延遲與路由切換後失效策略 |
| 初次開 Mic 後立即錄音、校準完成後錄音 | 對齊來源是否清楚、是否凍結未成熟估算、錄後 verdict 是否可解釋 |
| Wi-Fi／行動網路切換、弱網、背景／鎖屏 | capture epoch、WT／WS 切換、缺音增量、恢復時間與可聽結果 |
| 跳播／換歌／播放速率／Mic 接手 | authority、mapping 和裝置設定是否正確保留或失效 |
| 長錄音與增益調整 | 實際漂移、重度限幅比例及可聽動態；不能只看 clippedSamples=0 |

建議實作順序：先統一 held／fallback 與錄音恢復語意、修部署一致性，再完成耳機情境的估算／量測產品路徑，最後用上述矩陣驗收聲學結果。耳機支援是最高產品優先；語意與部署修正可先讓後續量測有可信的狀態基礎。

摘要數據：[evidence-summary.json](evidence-summary.json)。

## 7. 修正狀態（2026-10-13 更新）

以下 PR 已於 2026-10-13 合併到 `main`，CI 全數通過。合併前先以 `deploy/2026-10-12` 部署到 Pi（02:11 重啟，當時沒有人拿 Mic），現在 Pi 已改回直接跑 `main`。

| 本文項目 | 處理 | PR |
| --- | --- | --- |
| P1 耳機缺少完成路徑 | 部分：Mic 聽不到提示音而結束的 Boot 改顯示「時間對齊目前使用估計」，恢復建議改成「用外放的話調大音量再重新對齊；戴耳機時繼續使用估計」，不再一直要求重按。獨立耳機量測、手動偏移（`vocalFineTuneMs`）屬產品決策，未做 | #581（疊在 #574 上） |
| P1 build 標記與實際前端不同 | build 改為追蹤正在提供的檔案（最多每 2 秒比對大小與修改時間，有變才重算 hash）。載入途中跨版本混用模組仍未解決，需改用不可變的版本目錄 | #575 |
| P2 保留的 Boot 被說成 fallback | ProductStatus 依混音器實際套用的模式判讀；位置資料過期另以 `timing.syncHeld` 表示；Remote health 文字依實際狀態描述 | #574 |
| P2 錄音中要求重新校準 | 恢復建議改成 `recalibrate-after-take`；標題與系統時間對齊欄改說「這段錄音使用估計的時間對齊」 | #574 |
| P2 閒置 Robot 持續 degraded | 只在歌曲播放中才判斷 Robot 位置過期 | #574 |
| P2 錄音品質證據不足 | 品質 evidence 加上重度限幅、sample/song 與傳輸估計的分布、Boot／Content 對齊比例，以及開錄時的校準狀態與失敗原因（仍是 v5，判定規則不變） | #577 |

`reproduce.mjs` 的斷言已改為驗證修正後的行為；在 `1bc6b50` 上執行會失敗。

同一輪另外處理的相關問題：歌播完後重新整理，在 YouTube 按播放不會被房間承認（#572）；房間已結束時播放器回報 ENDED 會讓恢復流程卡住、「重新對齊 —」沒說明原因（#578）；WebTransport 重試成功後沒有紀錄（#579）；Relay 自身事件迴圈停頓的紀錄（#580）。

第 6 節的實機驗收矩陣仍待實際裝置執行。
