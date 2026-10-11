# 重構現況與唯一入口

更新：2026-10-11。以主線已合併提交及目前工作區盤點為準；這份文件不是繼續開工的授權。

## 已合併

| 範圍 | 結果 | PR |
| --- | --- | --- |
| 音訊 | golden、PCM timeline、frontier correction、clock trim、MixBus、limiter、gain ramp、raw meter、read path 與 restart boundaries | #507、#508 |
| Server | 移除 26 個只轉呼叫的 coordinator；改為具名 server 函式，補實際協定／生命週期測試 | #509–#520 |
| Browser 保護網 | app.js 瀏覽器行為測試與 GitHub mutation workflow | #521、#529 |
| app.js 第一輪 | 拆出 mix-controls、uplink-evidence；手機實測後合併 | #531 |
| 頁面結構 | Realign、Mic 標籤與固定結構回到 HTML；清掉隱藏狀態讀出 | #545、#547 |

主線盤點點：5aedc8c（#549）。後續 #550–#555 是校準、Opus、診斷 UI 與資料清理，
不是重構卡完成率，也不能用它們的 CI 替舊重構分支背書。
PR 狀態會變動；需要操作時先查 GitHub，不把此日期的待辦當成即時狀態。

## 剩餘範圍

app.js 仍擁有 capture graph、watchdog、裝置切換、校準 probe、訊息處理，
以及發布 session 的啟動／重連／恢復／停止。見 [前端下一步](APP-JS-PLAN.md)。
YouTube／transport／Listen／receiver／Take storage 沒有一併完成全面重構，亦不因舊卡順序自動啟動。

## 目前工作區

- 主 repo：正常產品工作；不要用舊重構分支覆蓋。
- deep-refactor，wip/deep-refactor-s40，68f6b12：已停止採用的 orchestration 方案，
  留有 14 個未提交測試修改。不可整支合併，也不是下一步來源。
- app-behaviour：歷史 #521 工作區，仍有程序使用，暫時保留。
- flake-ccv：有獨有 scratch 模擬測試，未認定為正式回歸測試。
- audio-only-candidate：已移除；28 個複製檔與來源 68f6b12 完全一致，
  唯一適配測試符合原核對 hash，無新增工作。正式音訊成果已由 #508 合併。

## 清理與證據界線

舊外部錄音、JSONL、測試日誌、畫面及封存已依使用者要求移除。
必要音訊調查結論保存在 [調查紀錄](../../investigations/audio-alignment-20261011/README.md)。
舊 S40d 曾有完整測試與 browser WT 失敗，未取得正式整合通過；原始證據已不存在，
不得再宣稱可重新核對舊 log，也不得拿後來主線 CI 當成那份分支已通過。

## 閱讀順序

- [進度摘要](PROGRESS.md)：已完成、未完成與清理紀錄。
- [音訊邊界](AUDIO-SPLIT.md)、[Server 規則](SERVER-PATTERN.md)、[前端下一步](APP-JS-PLAN.md)。
- [驗證方式](04-VALIDATION.md)：Pi 局部檢查，完整 CI 與 mutation 放 GitHub。
- 01-AUDIO、02-SERVER、03-BROWSER、05-STORAGE-AND-CLOSEOUT 是歷史設計參考，
  不是執行卡、最新檔案清單或已授權待辦。
