# 執行入口：先讀這份，不要直接照總綱搬檔

適用範圍：Relay 的無行為變更重構。這份文件是執行契約，不代表本輪已開始實作。屆時仍以使用者最新授權、現有程式與工作樹為準。

## 1. 文件導航與使用方式

| 要做的事 | 必讀 |
| --- | --- |
| 任何一刀開始前 | 本文件、[PROGRESS](PROGRESS.md)、[驗證手冊](04-VALIDATION.md)、`SESSION_MODEL.md`、`ARCHITECTURE_BOUNDARIES.md` |
| AudioSession | [音訊執行卡](01-AUDIO.md) |
| server / timing / Mic / Song | [server 執行卡](02-SERVER.md) |
| browser / transport / playback | [browser 執行卡](03-BROWSER.md) |
| Take / 最後驗收 | [持久化與收尾](05-STORAGE-AND-CLOSEOUT.md) |
| 檢查是不是同一份起始程式 | [BASELINE.json](BASELINE.json) |

每次只執行一張卡。完成該卡的 checkpoint 後，才可進下一張已滿足前置條件的卡；不要把整個 W4 或 W6 當成一刀。

文件中的「現有」描述盤點時實作；「擬新增」表示建議介面／檔案，現在不存在。不能把擬新增名稱當成可直接執行的既有測試。測試清單見驗證手冊。

同一規則若總綱較粗略、執行卡較精確，採執行卡；若文件與目前程式不符，先完成差異稽核，不猜、不強制把程式改回舊版。

## 2. 開機檢查：先確認你沒有進錯工作樹

從 `/home/mochi/relay` 執行以下唯讀命令：

```bash
git worktree list --porcelain
git status --short
```

盤點時兩個目錄：

- 文件所在主目錄 HEAD：`7fe0c279c06ec14b12bec67e6ebf91db74ef3334`。
- 執行程式工作樹：`/tmp/claude-1000/-home-mochi-relay/e8ac15ae-68bf-4977-9fa9-2c586edcef32/scratchpad/wt9`。
- 執行分支：`refactor/mic-timeline`，HEAD `7b5d550682d43ae8eba3f55aeff3bf0b239ba056`，另有 11 個已知未提交／未追蹤檔案；它們是既有成果，不是垃圾。

在找到的執行工作樹內依序執行：

```bash
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
node --version
npm --version
git diff --stat
git diff --check
```

1. 讀取當前適用的 AGENTS 指令；盤點時沒有，不代表以後沒有。
2. 與 BASELINE 中 `files` 的 hash、`preexisting_dirty` 比對；hash 是辨識工具，**不是要求永遠保持它不變**。
3. 初次執行與 BASELINE 不同：列出差異，讀新版本與相關測試，更新本包判斷。不得先覆蓋差異以求 hash 相符。
4. 後續執行以最近已驗證 checkpoint 為基線；否則前一刀正常改動會被誤判成污染。
5. `/tmp` worktree 不存在時，用 worktree list／分支資訊找真實位置；找不到未提交成果就回報缺少來源。不能只 checkout HEAD 然後假裝包含未提交 bus／DSP。
6. 此文件包寫在主目錄；切到 worktree 之前記住文件位置。不要因 worktree 沒有 `docs/refactor` 而另建一份不同版本的計畫。

禁止 `git reset --hard`、`git clean`、`git checkout --`、覆蓋 node_modules 或刪掉 scratch。不要把使用者未提交變更自動 stash。若需要保存基線，明列含未追蹤檔的清單；單一 `git diff` 不包含新檔案，不是完整備份。

## 3. 固定執行順序與分支

主線：

```text
P00 基線核對
 → A10 seam characterization + 元件
 → A11 接回 AudioSession
 → A20 read-motion 純計算
 → A21 PCM/evidence 同座標讀取
 → S10 status facts
 → S11 mix pump
 → S20 Robot mapping 編排
 → S21 boot probe 編排
 → S22 calibration 編排
 → S30 Mic lifecycle 編排
 → S31 Song lifecycle 編排
 → S40 server composition 收尾
 → B10 capture graph
 → B11 health correlation
 → B12 publisher session
 → B20 retransmit cache
 → B21 datagram backlog / writes
 → B30 player adapter
 → B31 handoff transaction
 → B40 Listen
 → Z00 結構驗收
```

條件式支線：A22 continuity-state owner、B22 transport preference owner、R10 receiver 內拆、T10/T11 Take storage。它們不是「有剩時間就自動做」：需先依卡上的啟動條件證明有可封閉邊界，將具體 scope 寫入 PROGRESS，再進行。沒有證據時標記 deferred，Z00 可以在誠實列明 deferred 的情況下完成本輪，而不是把支線假報 done。

這是降低上下文切換的預設順序，不是並行開工清單。不要為快一點同時讓兩刀改 server／app，也不要另開多個 agent，除非使用者或適用指令另外要求。

## 4. 每張卡的機械流程

### 4.1 開始前輸出一份變更提案

在 PROGRESS 的當包區域填完：

```text
task_id:
baseline HEAD + checkpoint:
目前符號在哪些檔案:
準備新增檔案:
準備修改檔案:
哪些 state/函式會離開 caller:
哪些 state/函式刻意留下:
保留的對外 API:
clock / coordinate / identity:
本包需要的測試 profile + 新案例:
超出 scope 時停止的條件:
```

檔案白名單是審查界線，不是 regex：新增未列檔案前先說明必要性；一般的相鄰型別／測試定位更新可記錄後繼續，不需要每一行請示。涉及另一個 owner、wire contract、schema 或行為則不能自行擴張。

### 4.2 每刀分三個 checkpoint

1. **C0 characterization**：先跑相關既有測試；新測試在舊行為下取得預期結果。記錄所有新失敗，不能先改 expected。
2. **C1 新邊界**：新增純 helper／owner 與 unit tests。尚未接線時，不宣稱 production 已完成抽取。
3. **C2 production integration**：替換全部列出的 call sites；移除 caller 的對應 state／重複算法；跑相關測試、全套與所需 proof。

小卡可同一 diff 完成 C0–C2，但證據仍分開列。中途離開時必須標記只到 C1；下一模型不得把未接線的新類別當完成。

### 4.3 綠燈後的固定審查問題

- 是否還有兩份 state 或同名 algorithm？
- reset／clear／trim／rebase／dispose 的所有 call sites 是否都接到新 owner？
- 是否改了 `Math.round/floor/ceil`、運算順序、fallback、預設參數、例外吞掉範圍？
- 是否多加／少加 await、microtask、timer、broadcast 或 callback 次數？
- 是否把「收到／送出」當成「對方／應用已接受」？
- 是否為讓 source test 通過而保留一份死 code，或只刪 assertion？
- 有沒有改 golden digest、放寬 waveform threshold、增大 timeout、skip 測試？若有，不能以純重構驗收。
- 新元件是否真的被 production import 並使用，而非只被 unit test import？

## 5. 失敗時怎麼辦

| 現象 | 下一步 | 禁止做法 |
| --- | --- | --- |
| Golden 不同 | 找第一個不同 frame／ingest／health，回查本刀順序與 rounding；縮小本刀 | 更新 digest、改 epsilon、只比較 RMS |
| Source/AST test 找不到函式 | 讀該 assertion 要保護的語意；先保留呼叫 wrapper 或改 owner 定位，再以行為測試補強 | 批量刪測試、整棵 source 字串拼起來掩蓋錯誤接線 |
| `EADDRINUSE` / `EPERM` | 保存 stderr、確認隔離端口與工具權限；環境無法跑則列未驗證 | 改 server 正式 port／關 auth／假報成功 |
| 測試 timeout | 先確認 pending child/server/worker 是否由本包洩漏，再比基線 | 全部 timeout 乘十、kill 所有 node |
| 新 owner 需要任意讀寫 caller 私有欄位 | 縮回純計算或移完整同生命週期群；先重寫設計卡 | `any`／mutable context bag／十幾個 setter |
| 舊行為疑似有 bug | 留最小重現與 `behavior-change-needed` 記錄，保持本包語意 | 在重構中順便「修合理一點」 |
| 文件和程式不一致 | 列 revision／symbol 差異，重建該卡 C0 | 按行號硬切、從文件重造 production code |

不得為撤回本刀而覆蓋基線的既有未提交工作。未提交時用針對自身 hunks 的反向 patch；已提交時只有在具備授權且目標明確時使用非破壞性的 revert。

## 6. 交接記錄：讓下一個模型不用猜

每刀結束填 PROGRESS：`planned / active / integration-pending / verified / deferred / needs-decision` 之一。`needs-decision` 是計畫記錄，不是任何產品 goal 狀態。

必填 source HEAD、dirty files、完成到 C0/C1/C2、新舊 hash 或 checkpoint、測試命令與 exit code、log 位置、測試前後是否修改 source、未跑 proof、下一步精確卡號。12 分鐘的歷史綠燈不代表後來新增 code 也已驗證。

沒有使用者要求，不自行 commit／push／部署。使用者以後要求實作時可以正常進行卡內改動；本次「深化計畫」本身只授權文件工作。

可直接給下一模型的啟動提示：

> 讀 REFACTOR_PLAN.md 的執行入口，再完整讀 docs/refactor/00-EXECUTION.md、PROGRESS.md、當包執行卡與驗證手冊。先確認工作樹和已有未提交成果，只執行下一張滿足前置條件的卡。先列檔案白名單、state ownership、語意不變量與測試。保持 golden、wire contract、clock、epoch、effect order；不改政策、不重寫框架。每卡更新 checkpoint；不能驗證或要改行為時，列出具體差異與需要的決策，不猜。
