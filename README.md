# dots-proxy

![架構圖](assets/architecture.png)

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](LICENSE)

把 OpenAI 的 dot（雲端常駐代理）變成 Codex 裡的一個 picker 模型：選中 `gpt-dot` 後，請求走 dot 雲端通道執行，還能通過本機橋接環境直接操控你的電腦。其餘模型原樣透傳官方後端，互不影響。

> 本分支是 [Pelican0126/dots-proxy](https://github.com/Pelican0126/dots-proxy) 的 **macOS 適配版**（同時保留 Windows 支援），在原 CC BY-NC 4.0 許可下修改發佈。

> ⚠ 本項目使用 OpenAI 未公開的內部接口（逆向自官方桌面端），僅供個人學習研究，可能隨官方調整失效；請自行評估帳號風險。

## 組成

| 文件 | 作用 |
|---|---|
| `dots-manager.mjs` | 常駐管理器（`127.0.0.1:8788`）：調用記錄面板、代理啟停、一鍵切回官方直連 |
| `dots-proxy.mjs` | 代理子進程（`127.0.0.1:8789`）：Responses API → dot 雲端 thread；其他模型透傳 |
| `dots-model-catalog.json` | 模型目錄（picker 列表來源），含 `gpt-dot` 條目 |
| `dots-marketplace/` | Codex 插件（MCP 工具：`dot_ask` / `dot_message` / `dot_status`） |
| `ws-client.mjs` | 裸 TLS WebSocket JSON-RPC 客戶端（過 Cloudflare 的關鍵） |
| `start-dots.sh` | macOS 啟動腳本：自動尋找 Node（含 ChatGPT 桌面端內置 runtime） |

## 原理

```
codex app/CLI ──Responses API──▶ 127.0.0.1:8788 (manager)
                                   └─▶ 127.0.0.1:8789 (proxy)
                                         ├─ model=gpt-6-astra-dot → wss://codex-cloud-backend.chatgpt.com 開雲端 thread
                                         │    （可綁定本機橋接環境 → 命令直接在本機執行）
                                         └─ 其他模型 → 透傳 chatgpt.com/backend-api/codex/responses
```

- dot 本體是 hosted 雲端 thread（`threadSource: "aeon"`），協議與本地 app-server 相同
- 過 Cloudflare 需要帶齊 `Authorization` / `chatgpt-account-id` / codex UA / `originator: codex_cli_rs` 四個頭，且用裸 TLS 握手（Node 內建 WebSocket 會被擋）
- 認證複用 `~/.codex/auth.json`，過期自動用 refresh_token 續期

## 安裝（macOS）

前置：已登錄的 Codex 桌面 app 或 CLI（`~/.codex/auth.json` 存在）、Node ≥ 22。

> 沒有裝 Node 也能跑：`start-dots.sh` 會自動使用 ChatGPT 桌面端內置的 Node runtime（`ChatGPT.app/Contents/Resources/cua_node`）。

```bash
# 1. 啟動管理器（會自動拉起代理）
./start-dots.sh
# 或手動指定 node：
node dots-manager.mjs

# 2. config.toml 加入（或直接在面板點「恢復 dots 代理」，會自動處理已有的 model_provider）
model_provider = "dots"
model_catalog_json = "<本目錄絕對路徑>/dots-model-catalog.json"

[model_providers.dots]
name = "dots"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
requires_openai_auth = true
```

重啟 codex / 桌面 app，picker 裡選 `gpt-dot`。

### 本機操控（可選）

默認 dot 在雲端跑、碰不到本機。要讓它直接操作你的電腦：

1. 確認桌面 app 正在運行（它會啟動 exec-server 橋接進程）
2. macOS 下橋接環境 ID 可以自動探測：

   ```bash
   DOTS_ENV_ID=auto ./start-dots.sh
   ```

   手動查找也可以：`ps aux | grep 'exec-server.*--environment-id'`，取 `--environment-id` 後的值，設置 `DOTS_ENV_ID=<id>` 啟動。
   （Windows 下是進程列表裡 `codex.exe exec-server --environment-id <id>` 的值。）

⚠ 此模式以 `danger-full-access` + 免審批運行，dot 可在你本機執行任何命令。

### MCP 插件（可選）

`dots-marketplace/` 可作為本地 marketplace 掛載，提供 `dot_ask` / `dot_message` / `dot_status` 三個工具。macOS/Linux 使用內置的 `sh` 啟動器；Windows 用戶請把 `plugins/dots/.mcp.windows.json` 改名替換 `.mcp.json`。

## 環境變量

| 變量 | 默認 | 說明 |
|---|---|---|
| `DOTS_ENV_ID` | （空，純雲端） | 本機橋接環境 ID；`auto` = 從運行中的 exec-server 進程自動探測 |
| `DOTS_WORKSPACE` | 啟動目錄 | dot 雲端 thread 的默認 cwd |
| `DOTS_PROXY_PORT` | `8789` | 代理子進程端口 |
| `DOTS_PROXY_MODEL` | `gpt-6-astra-dot` | 觸發 dot 通道路由的 picker 模型 slug |
| `DOTS_UA` | 按平台生成 | 上游 WS 握手的 codex UA |
| `CODEX_HOME` | `~/.codex` | codex 配置目錄 |
| `DOTS_FALLBACK_MODEL` / `DOTS_FALLBACK_EFFORT` | `gpt-6.1-sol` / `low` | 切回官方直連時的模型回退 |
| `DOTS_MANAGER_TOKEN` | 每次啟動隨機生成 | 管理面板 token；設置後可固定，請妥善保管 |

## 面板

啟動後終端會輸出帶一次性管理 token 的面板地址，例如 `http://127.0.0.1:8788/?token=...`。面板提供調用記錄（模型/effort/耗時/狀態）、服務啟停和一鍵切回官方直連；不要把帶 token 的地址分享給其他人。

## License

[CC BY-NC 4.0](LICENSE) — 可自由使用、修改、分享，**禁止商用**；使用需署名。
原作：[Pelican0126/dots-proxy](https://github.com/Pelican0126/dots-proxy)。

這是 source-available 的非商用授權，不等同於 OSI 定義的「開源」；若要改成 MIT/Apache-2.0 等開源授權，需先確認原作程式碼的再授權權限。

## 安全說明

- 調用記錄存於 `dots-proxy-calls.jsonl`（已被 gitignore）；dot prompt、回覆和本機橋接產生的內容會按上游 OpenAI hosted thread 的服務流程處理，不代表數據只在本機
- `auth.json` 的 token 僅用於官方後端認證，不要把它提交到倉庫或分享給其他人
- 回滾：面板點「切回官方直連」，或用 `~/.codex/config.toml.bak-*` 備份覆蓋
