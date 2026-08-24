import { guardRequest } from "@/lib/auth";

export const runtime = "edge";

const DASHSCOPE_URL =
  "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const FUN_ASR_MODEL = "fun-asr-flash-2026-06-15";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function guessMime(name: string, fallback: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const map: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    aac: "audio/aac",
    flac: "audio/flac",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/opus",
    amr: "audio/amr",
    wma: "audio/x-ms-wma",
    webm: "audio/webm",
  };
  return map[ext] || fallback || "audio/mpeg";
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.length))
    );
  }
  return btoa(binary);
}

function audioFormat(dataUri: string): string {
  const mime = dataUri.slice(5, dataUri.indexOf(";base64,")).toLowerCase();
  const formats: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "video/mp4": "mp4",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/amr": "amr",
    "audio/webm": "webm",
    "video/webm": "webm",
    "audio/x-ms-wma": "wma",
  };
  return formats[mime] || "wav";
}

function languageHint(language: string): string {
  if (language === "yue" || language === "zh") {
    return "主要語言：香港粵語；請保留錄音中的英文詞語。";
  }
  if (language === "en") return "Primary language: English.";
  return "語言：自動辨識，可能包含香港粵語、中文及英文。";
}

function extractText(data: any): string {
  // The dedicated Fun-ASR-Flash response differs slightly between the generic
  // and workspace-specific DashScope endpoints, so accept both documented
  // shapes. Both contain the same cumulative transcript.
  const candidates = [
    data?.output?.text,
    data?.output?.output?.text,
    data?.output?.output?.sentence?.text,
    data?.output?.sentence?.text,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// Read the audio data URI + options from either the low-CPU raw path
// (text/plain body = data URI, options in query) or a multipart form.
async function readInput(req: Request): Promise<{
  dataUri: string;
  language: string;
  context: string;
}> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const provided = form.get("audioDataUri");
    const language = String(form.get("language") || "auto");
    const context = String(form.get("context") || "").trim();
    if (typeof provided === "string" && provided) {
      return { dataUri: provided, language, context };
    }
    const file = form.get("audio");
    if (file instanceof File) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = guessMime(file.name, file.type);
      return {
        dataUri: `data:${mime};base64,${base64FromBytes(bytes)}`,
        language,
        context,
      };
    }
    return { dataUri: "", language, context };
  }

  const url = new URL(req.url);
  const dataUri = (await req.text()).trim();
  return {
    dataUri,
    language: url.searchParams.get("language") || "auto",
    context: (url.searchParams.get("context") || "").trim(),
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const denied = await guardRequest(req);
    if (denied) return denied;

    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      return json(
        {
          error:
            "伺服器未設定 DASHSCOPE_API_KEY。請在 Cloudflare 設定 secret 後再試。",
        },
        500
      );
    }

    const { dataUri, language, context } = await readInput(req);

    if (!dataUri || !dataUri.startsWith("data:") || !dataUri.includes(";base64,")) {
      return json({ error: "冇收到有效嘅音頻資料。" }, 400);
    }
    // Fun-ASR's Base64 request limit is 10 MB. The browser normally sends a
    // two-minute 16 kHz WAV segment, safely below this guard.
    if (dataUri.length > 13_500_000) {
      return json(
        { error: "音頻段太大，請縮短或等系統自動分段。", code: "TooLarge" },
        413
      );
    }

    const contextText = [languageHint(language), context]
      .filter(Boolean)
      .join("\n")
      .slice(0, 400);
    const contextMessage = contextText
      ? '{"role":"user","content":[{"type":"input_text","text":' +
        JSON.stringify(contextText) +
        "}]},"
      : "";

    // Avoid JSON.stringify over the multi-MB base64 payload. Only the small
    // user-provided context is stringified; the Data URI alphabet is JSON-safe.
    const bodyStr =
      '{"model":' +
      JSON.stringify(FUN_ASR_MODEL) +
      ',"input":{"messages":[' +
      contextMessage +
      '{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"' +
      dataUri +
      '"}}]}]},"parameters":{"format":' +
      JSON.stringify(audioFormat(dataUri)) +
      "}}";

    let resp: Response | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(500 * attempt);
      try {
        resp = await fetch(DASHSCOPE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-DashScope-SSE": "disable",
          },
          body: bodyStr,
        });
      } catch (e: any) {
        lastErr = e?.message || "上游連線失敗";
        resp = null;
        continue;
      }
      if (resp.ok || !RETRYABLE.has(resp.status)) break;
      lastErr = `Fun-ASR 服務暫時不可用 (${resp.status})`;
    }

    if (!resp) {
      return json({ error: lastErr || "無法連接 Fun-ASR 服務。", code: "Upstream" }, 503);
    }

    const data: any = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const code = data?.code || data?.output?.code || "";
      let message =
        data?.message || data?.output?.message || `Fun-ASR 服務回傳錯誤 (${resp.status})`;
      if (code === "AllocationQuota.FreeTierOnly") {
        message =
          "Fun-ASR 免費額度已用完。請喺 Alibaba Cloud Model Studio 後台關閉「只用免費額度 / use free tier only」模式，開啟付費使用後再試。";
      }
      return json({ error: message, code }, resp.status);
    }

    const text = extractText(data);
    if (!text) {
      return json(
        { error: "未能從錄音辨識出文字（可能係靜音或格式問題）。", raw: data },
        200
      );
    }

    return json({
      text,
      model: FUN_ASR_MODEL,
      requestId: data?.request_id || data?.output?.request_id || null,
    });
  } catch (e: any) {
    return json({ error: e?.message || "伺服器發生未知錯誤。" }, 500);
  }
}
