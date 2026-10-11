# 重構驗證方式

更新：2026-10-11。測試範圍以當次變更與 repo 現有檔案為準，不使用舊 profile／外部 archive 背書。

## Pi

- 先確認 git status、worktree 與 branch，避免測錯舊副本。
- 可以做型別檢查、對應範圍的局部測試與必要的短瀏覽器驗證。
- 不在 Pi 跑完整 CI、長時間完整套件或 mutation。
- 不為文件整理跑音訊測試，也不因 CI 問題任意放寬 timeout／assertion。
- 不把依賴工具、輸出與一次性證據堆在家目錄。重要結論或可重用程式提交 Git。

例：只修改 Mic diagnostics model 時可執行：

```sh
node --import tsx --test test/mic-diagnostics-model.test.ts
npm run check
```

## GitHub

推送後使用現有 .github/workflows/ci.yml、production-browser-audio-proof.yml，
以及有需要時的 mutation.yml。完整 test、DOM／畫面、實際瀏覽器音訊、
WebTransport 各自查結果，不把其中一個綠燈當成全部通過。

mutation 用於驗證新增的行為斷言能否抓到特定破壞，不是無條件要求每次文件更新跑一輪。
涉及手機 capture／播放流程時，Chromium CI 不能取代 iOS／手機實測。

## 證據與失敗

記錄 commit、實際命令、結果、未測範圍及待驗證風險。
失敗先判定是產品、fixture、環境還是未知；不得拿重跑到綠取代歸因。
歷史測試數、已刪 log 或舊 cell ID 不作為現在版本的驗收結果。
