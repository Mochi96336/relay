# PipeWire 時序探測原稿

保留 2026-10-10 調查用的三支 C 程式，非正式擷取管線，也不會由服務或 CI 自動執行。

- pipewire-buffer-timing-probe.c：擷取 relay_browser sink，輸出 buffer、clock 與 metadata 時序。
- pipewire-queued-loop.c：在 relay_timestamp_test sink 播放樣本編號訊號，觀察 queued/buffered。
- pipewire-sample-boundary-loop.c：同一隔離 sink 的樣本邊界檢查。

需要 PipeWire 開發標頭與 pkg-config。語法檢查範例：

```sh
cc -fsyntax-only $(pkg-config --cflags libpipewire-0.3) scripts/diagnostics/pipewire/pipewire-buffer-timing-probe.c
```

兩個 loop 程式會播放測試訊號，需事先建立隔離的 relay_timestamp_test sink，
不能把它們當作一般唯讀查詢，也不要接到正式房間輸出。
程式持續執行直到手動停止；本次只保存來源，未啟動音訊探測。Pi 缺 libpipewire-0.3 開發標頭，編譯／語法檢查未完成，未為此安裝套件。
