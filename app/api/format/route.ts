import { guardRequest } from "@/lib/auth";

export const runtime = "edge";

const CHAT_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
const FORMAT_MODEL = "qwen3.5-flash";
const MAX_TRANSCRIPT_CHARS = 200_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function extractText(data: any): string {
  const value = data?.choices?.[0]?.message?.content;
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function languageInstruction(language: string): string {
  if (language === "en") return "Output in English and preserve any Chinese words.";
  return "輸出使用香港繁體中文，保留錄音中原有的英文詞語。";
}

export async function POST(req: Request): Promise<Response> {
  try {
    const denied = await guardRequest(req);
    if (denied) return denied;

    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      return json({ error: "伺服器未設定 DASHSCOPE_API_KEY。" }, 500);
    }

    const body = (await req.json().catch(() => null)) as {
      transcript?: unknown;
      context?: unknown;
      language?: unknown;
    } | null;
    const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
    const context = typeof body?.context === "string" ? body.context.trim().slice(0, 800) : "";
    const language = typeof body?.language === "string" ? body.language : "auto";

    if (!transcript) return json({ error: "冇收到逐字稿。" }, 400);
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      return json({ error: "逐字稿太長，暫時無法一次過由 Qwen 整理。" }, 413);
    }

    const system = [
      "你是學校逐字稿校對員。請整理語音辨識產生的逐字稿。",
      languageInstruction(language),
      "只可：加入合適標點和分段、統一繁體用字，以及按背景資料修正非常明顯的同音辨識錯誤。",
      "必須保留原意、細節、語氣和所有已辨識內容；不可摘要、刪減、改寫、補充事實或自行推斷。",
      "如果原文沒有清楚說出講者身分，不可虛構姓名或 Speaker 標籤。",
      "必須原樣保留所有【⚠️ ...】處理警告。只輸出整理後的純文字，不要解釋。",
      context ? `背景／專有名詞：${context}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const payload = JSON.stringify({
      model: FORMAT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: transcript },
      ],
      temperature: 0,
      enable_thinking: false,
    });

    let resp: Response | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(500 * attempt);
      try {
        resp = await fetch(CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: payload,
        });
      } catch (e: any) {
        lastErr = e?.message || "上游連線失敗";
        resp = null;
        continue;
      }
      if (resp.ok || !RETRYABLE.has(resp.status)) break;
      lastErr = `Qwen 整理服務暫時不可用 (${resp.status})`;
    }

    if (!resp) {
      return json({ error: lastErr || "無法連接 Qwen 整理服務。" }, 503);
    }

    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const message =
        data?.error?.message || data?.message || `Qwen 整理服務回傳錯誤 (${resp.status})`;
      return json({ error: message, code: data?.error?.code || data?.code || "" }, resp.status);
    }

    const text = extractText(data);
    if (!text) return json({ error: "Qwen 沒有回傳整理結果。" }, 502);

    return json({ text, model: FORMAT_MODEL, requestId: data?.id || null });
  } catch (e: any) {
    return json({ error: e?.message || "伺服器發生未知錯誤。" }, 500);
  }
}
