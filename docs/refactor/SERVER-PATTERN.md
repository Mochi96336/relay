# Server 減層：已完成成果與規則

更新：2026-10-11。#509–#520 已合併，26 個 relay-*-coordinator 已移除，
不再存在「audio-uplink／publisher-activation 待開 PR」的待辦。

## 已採用的形狀

只依序呼叫 server 傳入 callbacks、沒有自身狀態或決策的 coordinator，
改成 server.ts 內具名函式。Mic 斷線、寬限、到期、釋放等相鄰流程可直接一起閱讀。
有真實狀態與權威的 owner 繼續保留，不因 server 行數增加就再搬回薄包裝。

| PR | 範圍 |
| --- | --- |
| #509–#512 | Mic／Backing／Playback／Robot 斷線、寬限、capture restart、timing invalidation、live stop |
| #513–#516 | Boot 結算、來源 activation、Robot mapping、播放註冊與 song handoff |
| #517–#520 | Take／Song 命令、seek／YouTube telemetry、binary uplink、publisher activation |

## 後續仍適用的規則

- 先讀全部 caller、state reset 與效果順序，再決定是否值得改。
- 不把假 callback 呼叫次序或 regex 當作實際協定行為證明。
- 以真 server 情境守 lease／generation／capture、拒絕路徑與可觀測結果。
- 保持原交易順序；不要一邊移動程式一邊改掉校準、重連或收尾政策。
- 沒有測試看得到的步驟如實列出，不用更多 regex 假裝補齊。
- 不使用舊 deep-refactor orchestration 方案整批取代目前主線。

這一輪完成的是 coordinator 減層，不是宣稱 server.ts 只剩 boilerplate，
也沒有宣稱所有 quality 判斷與跨領域交易都已重新設計。
