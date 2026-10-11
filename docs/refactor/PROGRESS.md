# 重構進度摘要

更新：2026-10-11；唯一入口是 [REVIEW-START.md](REVIEW-START.md)。

## 已完成並合併

- #507、#508：音訊狀態與 DSP／讀取元件抽取，保留 golden 行為驗證。
- #509–#520：26 個 coordinator 減層，具名 server 流程與實際行為測試。
- #521、#529：前端行為測試與 GitHub mutation。
- #531：mix controls／uplink evidence 從 app.js 拆出。
- #545、#547：固定頁面結構與舊隱藏節點清理。

上述「完成」指各 PR 的已合併範圍，不代表音訊、server、browser 全部重構完畢。

## 未完成

- app.js capture、probe、訊息與 publisher lifecycle 的後續邊界收斂。
- 其他 browser／transport／receiver／storage 範圍需另行評估，沒有進行中的自動卡序。
- 舊 deep-refactor 分支整合未通過；它的 S40d 進度不屬目前執行路線。
- deep-refactor 的 14 個 dirty 測試與 flake-ccv scratch 尚未判定是否值得移植。

## 清理紀錄

- 移除過時 A01／A02／A03 卡、舊基線與候選 hash manifest、舊 S40 coordinator inventory、
  綁死舊候選／已刪除 baseline 目錄的效能 runner。
- 將長篇舊 session 進度換成此摘要，不保留失效的 cell ID、live profile、外部 log／tar 路徑。
- 清除已核對為原候選複製品的 audio-only-candidate worktree，保留其來源 Git 提交與正式合併成果。
- 原始證據與舊外部封存已刪除；必要結論進 Git，不再在 Pi 另建備份倉庫。
- 正在使用或有未判定獨有修改的 worktree 不強制移除。

## 驗證界線

本次只整理文件與確認可清理的歷史副本，沒有修改 runtime，也沒有跑完整 Pi CI。
歷史測試數不能代表目前版本；新程式修改必須重新做對應局部驗證與 GitHub CI。
