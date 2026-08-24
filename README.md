# 錄音轉逐字稿 · Fun-ASR + Qwen

老師上載課堂／會議錄音，AI 自動轉成逐字稿。支援中文、粵語、英文。
前端 Next.js（App Router），部署於 Cloudflare Pages。阿里雲 **Fun-ASR-Flash**
負責語音辨識，再由 **Qwen3.5-Flash** 整理繁體中文、標點和分段。

## 功能

- 拖放／揀選音頻檔（mp3 / wav / m4a / aac / flac / ogg 等）
- **長錄音兩段並行處理**：喺瀏覽器將錄音解碼→16kHz 單聲道→按靜音位切成約 2 分鐘一段，每次最多同時辨識兩段，再按原次序拼合
- 處理時顯示進度（第幾段 / 共幾段），逐字稿即時逐段顯示
- 語言：自動偵測（含粵語）/ 中文 / English
- 選填「專有名詞／背景」做 context 提示，提高準確度
- 選填由 Qwen 整理繁體、標點和段落；失敗時自動保留 Fun-ASR 原始逐字稿
- 逐字稿可即場編輯、複製、下載 `.txt`

## 本地開發

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入你嘅 DASHSCOPE_API_KEY
npm run dev                      # http://localhost:3000
```

> 注意：API key **唔會**寫入程式碼，只透過環境變數 `DASHSCOPE_API_KEY` 讀取。

## 部署到 Cloudflare Pages

```bash
# 1) 設定 production secret（唔會出現喺 git）
wrangler pages secret put DASHSCOPE_API_KEY --project-name qwen-transcribe

# 2) build + 部署
npm run deploy
```

部署後網址：`https://qwen-transcribe.pages.dev`

## ⚠️ 帳戶設定（必讀）

如果辨識回傳 `AllocationQuota.FreeTierOnly`，代表 Fun-ASR／Qwen 嘅免費額度已用完，
而帳戶仲處於「只用免費額度」模式。請去 **Alibaba Cloud Model Studio 後台 → 關閉
「use free tier only」**，開啟付費使用後即可正常辨識。

## 安全

- `DASHSCOPE_API_KEY` 只存喺 Cloudflare secret／本地 `.dev.vars`（已 gitignore），唔好硬編碼或 commit。
- API endpoint 由 Google 工作階段 cookie 保護，只開放 `@keitsz.edu.hk` 帳號。

## API 技術細節

- Fun-ASR endpoint：`POST https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- 模型：`fun-asr-flash-2026-06-15`；音頻以 `data:<mime>;base64,...` 內嵌方式傳送
- Qwen 整理 endpoint：`POST https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`
- 模型：`qwen3.5-flash`；只整理逐字稿，不摘要、不虛構講者

## 分段機制（長錄音）

Fun-ASR-Flash 的 Base64 請求上限為 5 分鐘／10MB。為支援長錄音，前端（[app/audio.ts](app/audio.ts)）會：

1. 用 Web Audio `decodeAudioData` 解碼任何瀏覽器支援嘅格式
2. 降為單聲道並線性重採樣到 16kHz
3. 以 20ms 視窗計算能量，喺每約 120 秒邊界±8 秒內揀**最靜**嗰點切段（避免切斷字詞）
4. 每段編碼成 16-bit WAV，以固定兩段並行送去 `/api/transcribe` 由 Fun-ASR 辨識
5. 將各段拼合；如啟用整理，再送去 `/api/format` 由 Qwen 校對格式

若瀏覽器解唔到該格式，會自動退回「整檔辨識」（適用於短檔）。

> 說話人分離需要標準 `fun-asr` 及一個讓阿里雲短暫讀取錄音的私有物件儲存流程。
> 目前 Cloudflare 帳戶未啟用 R2，因此本版本不會公開上載錄音，也暫不提供說話人分離。
