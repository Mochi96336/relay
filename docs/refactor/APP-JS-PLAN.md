# app.js：已完成範圍與後續邊界

更新：2026-10-11。此文件是後續評估，不是自動開始拆分的指示。

## 已完成

- #521：加入真瀏覽器行為保護網。
- #529：mutation checks 在 GitHub runner 執行。
- #531：混音滑桿／拖動與確認狀態移到 mix-controls.js；回報間累積的掉樣本、
  chunk 延遲與削峰證據移到 uplink-evidence.js；手機實測後合併。
- #545、#547：實際頁面結構直接寫在 HTML，清掉替換／隱藏的舊狀態節點。

#522／#523／#528 是被 #531 取代的舊草稿，不再當成待合併項目。
原計畫中「所有 app.js 測試都是 regex」已過時，不得照抄。

## 仍在 app.js 的責任

- capture graph 安裝、處理器訊息、watchdog、輸入裝置切換與資源處置。
- 校準 probe 的播放、取消與有效 capture／request 判斷。
- 伺服器訊息的授權與效果分派。
- publisher session 啟動、socket 接替、重連、背景恢復與停止。
- 健康回報與自動碼率的呼叫編排；uplink-evidence 只擁有累積證據。

後續可先評估 probe 播放邊界，再評估 capture graph。
publisher lifecycle 涉及 epoch／generation／舊 promise 的失效，風險較高，不因檔案長而先拆。

## 每一塊的開始條件

1. 以當時主線與已授權功能為基準；舊分支不是最新版本。
2. 列清該狀態的所有讀取、寫入、reset、cancel 與資源擁有者。
3. 先有行為測試與必要 race case；若使用 mutation，在 GitHub 執行。
4. 保持 wire protocol、sample 座標、原來效果順序與手機行為。
5. 每次只收斂一個邊界，不加入通用 controller 或 dependency bag。
6. 局部檢查通過後推 GitHub 跑完整 CI；涉及手機音訊流程需實機驗證。

較舊的 [Browser 設計參考](03-BROWSER.md) 可提供 race 清單，但其中卡序與命名不是現況。
