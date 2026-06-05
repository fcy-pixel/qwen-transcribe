import { guardRequest } from "@/lib/auth";

export const runtime = "edge";

const DASHSCOPE_URL =
  "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

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
    opus: "audio/ogg",
    amr: "audio/amr",
    wma: "audio/x-ms-wma",
    webm: "audio/webm",
    aiff: "audio/aiff",
    aif: "audio/aiff",
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

function extractText(data: any): string {
  const content = data?.output?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
      .join("")
      .trim();
  }
  if (typeof content === "string") return content.trim();
  if (typeof data?.output?.text === "string") return data.output.text.trim();
  return "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// Read the audio data URI + options from either the low-CPU raw path
// (text/plain body = data URI, options in query) or a multipart form
// (used by curl/tests, or as a whole-file fallback).
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
  // Low-CPU path: raw body is the data URI; options come from the query string.
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
    // Reject unauthenticated callers (no-op when SESSION_SECRET is unset).
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
    // ~9.5MB raw → reject early (client should have segmented it).
    if (dataUri.length > 13_500_000) {
      return json(
        { error: "音頻段太大，請縮短或等系統自動分段。", code: "TooLarge" },
        413
      );
    }

    const asrOptions: Record<string, unknown> = {
      enable_lid: true,
      enable_itn: true,
    };
    if (language && language !== "auto") {
      asrOptions.language = language;
    }

    // Assemble the request body by string concat so we never run JSON.stringify
    // over the multi-MB base64 audio (that CPU cost triggered Cloudflare 1102).
    // The data URI alphabet (data:<mime>;base64,[A-Za-z0-9+/=]) needs no JSON
    // escaping, so direct injection is safe. Only the user-supplied text fields
    // are escaped via JSON.stringify.
    const bodyStr =
      '{"model":"qwen3-asr-flash","input":{"messages":[' +
      '{"role":"system","content":[{"text":' +
      JSON.stringify(context || "") +
      "}]}," +
      '{"role":"user","content":[{"audio":"' +
      dataUri +
      '"}]}' +
      ']},"parameters":' +
      JSON.stringify({ asr_options: asrOptions }) +
      "}";

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
          },
          body: bodyStr,
        });
      } catch (e: any) {
        lastErr = e?.message || "上游連線失敗";
        resp = null;
        continue; // network blip → retry
      }
      if (resp.ok || !RETRYABLE.has(resp.status)) break; // done or non-retryable
      lastErr = `ASR 服務暫時不可用 (${resp.status})`;
    }

    if (!resp) {
      return json({ error: lastErr || "無法連接 ASR 服務。", code: "Upstream" }, 503);
    }

    const data: any = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const code = data?.code || "";
      let message = data?.message || `ASR 服務回傳錯誤 (${resp.status})`;
      if (code === "AllocationQuota.FreeTierOnly") {
        message =
          "Qwen3-ASR-Flash 免費額度已用完。請喺 Alibaba Cloud Model Studio 後台關閉「只用免費額度 / use free tier only」模式，開啟付費使用後再試。";
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

    return json({ text, requestId: data?.request_id || null });
  } catch (e: any) {
    return json({ error: e?.message || "伺服器發生未知錯誤。" }, 500);
  }
}
