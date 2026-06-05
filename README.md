# 錄音轉逐字稿 · Qwen3-ASR-Flash

老師上載課堂／會議錄音，AI 自動轉成逐字稿。支援中文、粵語、英文。
前端 Next.js（App Router），部署於 Cloudflare Pages，辨識由阿里雲 **Qwen3-ASR-Flash** 提供。

## 功能

- 拖放／揀選音頻檔（mp3 / wav / m4a / aac / flac / ogg 等）
- 語言：自動偵測（含粵語）/ 中文 / English
- 選填「專有名詞／背景」做 context 提示，提高準確度
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

如果辨識回傳 `AllocationQuota.FreeTierOnly`，代表 Qwen3-ASR-Flash 嘅免費額度已用完，
而帳戶仲處於「只用免費額度」模式。請去 **Alibaba Cloud Model Studio 後台 → 關閉
「use free tier only」**，開啟付費使用後即可正常辨識。

## 安全

- `DASHSCOPE_API_KEY` 只存喺 Cloudflare secret／本地 `.dev.vars`（已 gitignore），唔好硬編碼或 commit。
- 此 endpoint 預設冇登入限制；如要避免被濫用（會產生 API 費用），建議加上身分驗證或 Cloudflare Access。

## API 技術細節

- Endpoint：`POST https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- 音頻以 `data:<mime>;base64,...` 內嵌方式傳送
- `parameters.asr_options`：`enable_lid`（語言偵測）、`enable_itn`（數字正規化）、`language`（可選）
- 回傳逐字稿位置：`output.choices[0].message.content[0].text`
