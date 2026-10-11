# 差網路與恢復觀測

觀測日期：2026-10-11，以下時間 Asia/Taipei。來源為實際 /statusz 五秒／十秒採樣及 relay-server journal，沒有保存錄音或外部大型封存。

## 確認的現象

- 18:04:50 左右 Mic 音訊與健康回報停止；18:05:15 採樣恢復為 WebSocket，同 capture generation 711618834。
- 18:05:11、15、19 發出 Mic probe 重試，未看到成功結果；校準暫為 none/network-estimate。
- 18:06:02 以 server-pcm-late 更換一次 WebSocket；18:06:06 回報 recovered/server-pcm-coverage-healthy-on-websocket，同筆健康資料仍為 mixPlayable=false、mixHeadroomMs=-398。
- 18:06:30 已降至 Opus 32 kbps，reason=congestion。仍反覆缺音，不能把降碼率觸發視為問題已解決。
- 18:07:44 journal 同一秒反覆 recovered/degraded-latched；18:08:25 再現。後者 ACK 往返 7677 ms、controlSilenceMs 8531，仍產生 server-pcm-resumed。
- 正常網路恢復後，18:10:21–18:12:21 觀測穩定：128 kbps、ACK 約42–68 ms、人聲 headroom 約460 ms；micStarvedFrames=8140、receiver lost=1092/late=52 及 sender droppedSamples=1043520 均未增加。
- Content 校準重新成功，最後持續約 -68 ms；收聽端無新增 underrun。不能只憑這些計數聲稱主觀聲學同步已證明。

## 程式歸因與修正範圍

控制 ACK 的六秒新鮮度限制已存在；舊 ACK 不延長 control watchdog，但仍進入媒體恢復政策。
政策看到 accepted PCM serial 前進／coverage 健康就可解除 degraded 或證明 WS recovery，
未考慮 ACK 是否仍可描述當下，也未使用 ACK 已帶回的 Mixer 不可播放結果。
因此 control watchdog 可維持降級、晚到媒體證據卻解除降級，造成實際觀測的反覆事件。

新增 recoveryAllowed 邊界：ACK RTT <1500 ms（沿用現有 Mixer/backlog evidence 新鮮度），且沒有明確 mix.playable=false，才可認證恢復／累積 WT quarantine release。
歷史 ACK 繼續提供 coverage/stall 診斷；不修改 capture、sample 座標、校準、緩衝、碼率門檻或 wire。
Mixer 欄位缺省的舊 peer 仍保留新鮮 ACK 的 legacy progress 行為。
這是恢復認證的必要條件，不保證波動網路上日後永不再次缺音，也不宣稱本機收到的 ACK 能代表零延遲真值。

## 驗證

transport 回歸測試先在舊程式重現 delayed ACK／明確 unplayable Mixer 解除 degraded 失敗，修正後通過。
另涵蓋 quantitative/legacy WS proof、WT quarantine release、fresh playable recovery 與額度不重置。
84 項相關局部測試、型別通過；完整 CI 在 GitHub 驗收，未在 Pi 執行。
