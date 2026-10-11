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

## 後續重傳調查

現場累計 requested=112、phone retransmitted=52、receiver recovered=0、receiver late=52。
不能用這些累計值做逐包配對：requested 是已發請求的不同 sequence；phone retransmitted 是交給傳輸層的重送次數（含重試），不是接收成功；recovered 只有尚未放棄的 sequence 最終被 emit 才計數。
因此 late=52 與重送52吻合是支持晚到的旁證，不是52包身分相同的證明。

核對正式程序2318185，四個 reorder/retransmit deadline/window/request-budget 環境鍵沒有覆寫。
預設普通 reorder 40 ms；有 Mixer headroom（>60 ms）時最多 hold 400 ms；hold window 48包。
缺口一旦過期，就會記 lost 並推進 sequence，之後原包／重送到達會記 late（更久超出 finalized 歷史時為 replay），不再回插。
手機快取128包；本次 Opus每包20 ms，連續送出下約2.56秒。請求落後超過這段快取時，手機可能無包可答。

以真正 AudioPacketReceiver + DEFAULT_AUDIO_TRANSPORT_CONFIG 與 PreferredAudioTransport cache 做 stdout-only 可控重播：
- request後100 ms回來：requested1/recovered1/late0。
- request後500 ms回來：requested1/recovered0/late1；快取仍在，但接收期限已過。
- request後8000 ms回來：recovered0，手機快取已淘汰該包；接收器 finalized 歷史也可淘汰，因此很晚的重送不一定仍算 late。
並跑現有 audio-packet-receiver-retransmit、mic-retransmit-server 22項測試全通過，涵蓋真server補包成功。
沒有逐包現場 trace，不能斷言112個請求中每包的確切失敗原因；沒有重現新的重傳接線錯誤。

## 另外兩項現象的證據界線

Probe 預設等待 playback ACK 3000 ms、最多3次；現場#5/#6/#7相隔約4秒、無相關成功分析紀錄，符合有限重試耗盡的行為。
failProbeAttempt 最終失敗會回報校準狀態，但沒有對應結構化journal，故無法從既有日誌證明這三次的具體拒絕／逾時理由。
正常網路後Content自行成功，不能說校準永遠卡死；也不宜因此盲目放大Probe等待時間。
WT 的現場 failure=connect:TimeoutError，程式 stage=connect 對應 transport.ready 尚未完成、writer尚未接管。
因此能定位到HTTP/3 session準備階段，不是已建立writer後的Opus重送／封包過大錯誤。
沒有手機QUIC診斷與逐次handshake證據，不能再細分UDP路徑、網路切換或瀏覽器因素。

結論：先完成#560的真實恢復判定修正；不為累計0-recovered直接拉長音訊等待、增加重傳流量或改校準秒數。
若後續要補診斷，優先提供有界且不含錄音的cache miss/late-repair統計與probe最終失敗原因；不是宣稱本次已證實新runtime defect。

## 後續診斷補強

#560 已合併。後續補上手機 transport health 的兩個可選累計欄位：
- `retransmitCacheMisses`：合法重送請求的序號已不在手機快取；重複未命中請求可以再次計數，不能直接當作唯一遺失包數。
- `retransmitSendRejects`：快取仍有資料，但所選傳輸同步拒絕提交；不包含之後的非同步寫入失敗或網路遺失。

兩欄由既有 health 回報送到伺服器；舊手機頁面未提供時保持缺省。
接收端 `latePackets` 仍可能包含原包或重送，不能據此宣稱逐包重送失敗。
Probe 每次失敗新增 `[probe-attempt-failed]` 結構化日誌，包含 target、reason、attempt、maxAttempts、terminal，區分重試與耗盡；不記錄音訊。
這些補強用於下一次事件歸因，不會改變音訊等待期限或補回已過播放時間的聲音。
驗證：53 項針對性測試與 TypeScript 檢查通過；完整 CI 交由 GitHub 執行。
