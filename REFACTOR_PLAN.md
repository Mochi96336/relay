# Relay 重構現況

更新：2026-10-11。唯一入口：[docs/refactor/REVIEW-START.md](docs/refactor/REVIEW-START.md)。

已合併：音訊拆分 #507／#508、26 個 server coordinator 減層 #509–#520、
app.js 行為保護網 #521、GitHub mutation #529、mix controls／uplink evidence #531、
頁面結構清理 #545／#547。

尚未完成：app.js capture、probe、訊息與 publisher lifecycle 的後續邊界收斂。
其他 browser／receiver／storage 範圍需另行評估。

舊 deep-refactor 是停止採用的方案，不能整支合回主線；仍有未提交測試修改，
不是目前執行路線。舊音訊候選已核對為歷史複製品並移除。
不以行數、卡片數或歷史測試數宣稱全部重構完成。

Pi 只做必要局部檢查，完整 CI／mutation 在 GitHub。
