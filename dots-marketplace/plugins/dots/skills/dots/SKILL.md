---
name: dots
description: 把工作委派給使用者的 OpenAI dot（雲端常駐代理，GPT-6 Astra，跑在 OpenAI 雲電腦上）。當使用者說「走 dot」「交給 dot」「用免費額度」，或任務量大、耗時長、想省下本機/套餐額度時使用。一次性任務用 dot_ask（開新雲端 thread），需要 dot 長期記憶與上下文時用 dot_message（直達主 dot）。
---

# Dots

把請求轉發到雲端 dot，而非本機執行。

## 工具

- `dot_ask(prompt, instructions?, model?, timeout_sec?)` — 每次呼叫開一條新的雲端 thread（gpt-6-astra），跑完回傳文字結果後自動封存。適合一次性、彼此獨立的任務。
- `dot_message(prompt, timeout_sec?)` — 發給使用者的主 dot（有記憶、always-on）。適合需要 dot 累積上下文的事。注意：dot 的回覆可能通過 ChatGPT 頻道送達，工具回傳的是 thread 裡能捕獲到的文字。
- `dot_status()` — 帳號套餐、可用模型、dot thread 狀態。

## 使用指引

- 任務較重或使用者明說要省額度時，優先 `dot_ask`。
- 多個獨立子任務可以併發呼叫多次 `dot_ask`，各自是獨立 thread，互不污染。
- 需要串聯上下文的多輪互動，用 `dot_message`（同一條主 thread）。
- 雲端任務可能跑較久，預設等 300 秒；大任務把 `timeout_sec` 調大。
