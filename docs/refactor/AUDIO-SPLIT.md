# 音訊拆分：合併結果與邊界

更新：2026-10-11。正式成果是 #507、#508；舊 audio-only 候選不再使用。

## 已保留的責任邊界

| 元件 | 責任／必守語意 |
| --- | --- |
| PCM timeline／input clipping | sample 座標與 clipping 對應，不能混用 source 與 session index |
| frontier correction／clock trim | 讀頭與產速調整，不能因拆分變更時序政策 |
| MicGainRamp | target 與逐 sample 推進分開，lookahead projection 不推進狀態 |
| MicLimiter | capture-scoped envelope；reset／seed 時機仍由 AudioSession 決定 |
| MicRawMeter | accepted pre-gain PCM 計量，按音訊時長衰減 |
| MixBus | membership、release hold、duck 與安全混音；保留 frame snapshot 語意 |
| Mic read path | PCM／missing／clipping 共用讀取軌跡，不跨 restart seam 插值 |
| CaptureRestartBoundaries | Mic 可能回讀需保留；Backing 單向讀可消耗，不合併兩種清除政策 |

golden 守已記錄的 PCM／evidence 行為，不證明所有 transport、手機或聲學時序。

## 舊候選為何清除

audio-only-candidate 建在 7fe0c27，而正式 #508 在較新的主線重新建立。
清理前逐檔核對：28 個複製檔與已提交來源 68f6b12 完全相同，
唯一適配測試 hash 與原 runner 紀錄相同，沒有新增修改。
正式產品版本與相關測試已在主線；因此移除舊 worktree、候選 manifest 與 A01–A03 卡。

舊效能 runner 綁死已移除的 baseline／候選路徑，亦予以移除。
未來效能比較需使用當時主線與候選，先確認 PCM／evidence 一致，
不能把已失效的舊基準數字拿來評價新變更。

[Audio 歷史設計參考](01-AUDIO.md) 保留座標、seam 與 reset 邊界，
不是要求重新執行已合併的抽取卡。
