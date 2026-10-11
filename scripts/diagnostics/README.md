# 即時診斷

在 repo 根目錄執行：

```sh
node scripts/diagnostics/live-query.mjs
```

查詢 Take 與校準狀態，輸出 JSON；不註冊音訊來源、不錄音、不更改房間狀態。
預設連接本機 ws://127.0.0.1:3100/ws；可用 RELAY_DIAGNOSTICS_URL 指定端點。
需要驗證時，從既有服務環境設定 RELAY_KEY，勿把金鑰寫進腳本或提交到 Git。
輸出可能含影片與校準資訊，請保存至既有的持久證據目錄。

歷史調查腳本、觀測、日誌與草稿保存於 repo 外
/home/mochi/relay-shadow-evidence/tmp-archive-20261011/，
完整來源與 SHA-256 見 manifest.json。歷史腳本未當成正式工具收進 repo。

Playwright 依賴與瀏覽器可從 GitHub workflow 的安裝步驟重建，
不要依賴 /tmp/relay-opus-browser 在重開機後仍存在。
