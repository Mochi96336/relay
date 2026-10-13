# 即時診斷

在 repo 根目錄執行：

```sh
node scripts/diagnostics/live-query.mjs
```

查詢 Take 與校準狀態，輸出 JSON；不註冊音訊來源、不錄音、不更改房間狀態。
預設連接本機 ws://127.0.0.1:3100/ws；可用 RELAY_DIAGNOSTICS_URL 指定端點。
需要驗證時，從既有服務環境設定 RELAY_KEY，勿把金鑰寫進腳本或提交到 Git。
輸出可能含影片與校準資訊。一次性觀測只寫暫存；調查報告與量測摘要不放進 Git：
結論寫進對應 PR 的說明與測試，報告本身保存在 repo 外（Pi 上的 ~/relay-branch-archive/investigations/）。

PipeWire 研究程式見 [pipewire/](pipewire/README.md)。Pi 家目錄不再保留外掛式證據倉庫或歷史壓縮包。

Playwright 依賴與瀏覽器可從 GitHub workflow 的安裝步驟重建，
不要依賴 /tmp/relay-opus-browser 在重開機後仍存在。
