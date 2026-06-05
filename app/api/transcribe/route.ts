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

export async function POST(req: Request): Promise<Response> {
  try {
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

    const form = await req.formData();
    const file = form.get("audio");
    const language = String(form.get("language") || "auto");
    const context = String(form.get("context") || "").trim();

    if (!(file instanceof File)) {
      return json({ error: "冇收到音頻檔案。" }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) {
      return json({ error: "音頻檔案是空的。" }, 400);
    }

    const mime = guessMime(file.name, file.type);
    const dataUri = `data:${mime};base64,${base64FromBytes(bytes)}`;

    const asrOptions: Record<string, unknown> = {
      enable_lid: true,
      enable_itn: true,
    };
    if (language && language !== "auto") {
      asrOptions.language = language;
    }

    const body = {
      model: "qwen3-asr-flash",
      input: {
        messages: [
          { role: "system", content: [{ text: context }] },
          { role: "user", content: [{ audio: dataUri }] },
        ],
      },
      parameters: { asr_options: asrOptions },
    };

    const resp = await fetch(DASHSCOPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

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
