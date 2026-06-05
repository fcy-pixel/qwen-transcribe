"use client";

import { useCallback, useRef, useState } from "react";
import { buildSegments } from "./audio";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

interface Progress {
  done: number;
  total: number;
}

async function transcribeBlob(
  blob: Blob,
  language: string,
  context: string
): Promise<string> {
  const fd = new FormData();
  fd.append("audio", blob, "segment.wav");
  fd.append("language", language);
  fd.append("context", context);
  const resp = await fetch("/api/transcribe", { method: "POST", body: fd });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.error) {
    throw new Error(data?.error || `轉寫失敗 (${resp.status})`);
  }
  return (data.text as string) || "";
}

export default function Page() {
  const [file, setFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string>("");
  const [duration, setDuration] = useState<number>(0);
  const [language, setLanguage] = useState<string>("auto");
  const [context, setContext] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [stage, setStage] = useState<string>("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [over, setOver] = useState<boolean>(false);
  const [toast, setToast] = useState<string>("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 1800);
  }, []);

  const pickFile = useCallback((f: File | null) => {
    if (!f) return;
    if (
      !f.type.startsWith("audio/") &&
      !/\.(mp3|wav|m4a|aac|flac|ogg|opus|amr|wma|webm|aiff?)$/i.test(f.name)
    ) {
      setError("請揀一個音頻檔案（mp3 / wav / m4a / aac / flac / ogg 等）。");
      return;
    }
    setError("");
    setTranscript("");
    setDuration(0);
    setFile(f);
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(f);
    });
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      pickFile(e.dataTransfer.files?.[0] || null);
    },
    [pickFile]
  );

  const estSegments = duration > 0 ? Math.max(1, Math.ceil(duration / 120)) : 0;

  const transcribe = useCallback(async () => {
    if (!file || loading) return;
    setLoading(true);
    setError("");
    setTranscript("");
    setProgress(null);
    setStage("正在分析錄音…（解碼 / 分段）");

    try {
      let segments;
      try {
        segments = await buildSegments(file);
      } catch (decodeErr: any) {
        // Fallback: browser can't decode this codec — send the raw file as one piece.
        setStage("無法分段，嘗試整檔辨識…");
        const text = await transcribeBlob(file, language, context);
        setTranscript(text);
        if (!text) setError("辨識結果為空，請檢查錄音內容。");
        return;
      }

      const total = segments.length;
      setProgress({ done: 0, total });

      const parts: string[] = [];
      for (let i = 0; i < total; i++) {
        setStage(total > 1 ? `辨識緊第 ${i + 1} / ${total} 段…` : "辨識緊…");
        const text = await transcribeBlob(segments[i].blob, language, context);
        if (text) parts.push(text.trim());
        setProgress({ done: i + 1, total });
        setTranscript(parts.join("\n")); // stream partial result
      }

      const finalText = parts.join("\n").trim();
      setTranscript(finalText);
      if (!finalText) setError("辨識結果為空，請檢查錄音內容。");
    } catch (e: any) {
      setError(e?.message || "處理失敗，請再試。");
    } finally {
      setLoading(false);
      setStage("");
      setProgress(null);
    }
  }, [file, language, context, loading]);

  const copyText = useCallback(async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      showToast("已複製到剪貼簿");
    } catch {
      showToast("複製失敗");
    }
  }, [transcript, showToast]);

  const downloadTxt = useCallback(() => {
    if (!transcript) return;
    const base = (file?.name || "transcript").replace(/\.[^.]+$/, "");
    const blob = new Blob([transcript], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}-逐字稿.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [transcript, file]);

  const reset = useCallback(() => {
    setFile(null);
    setTranscript("");
    setError("");
    setContext("");
    setDuration(0);
    setProgress(null);
    setStage("");
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  return (
    <div className="wrap">
      <div className="header">
        <div className="badge">Qwen3-ASR-Flash</div>
        <h1>錄音轉逐字稿</h1>
        <p>上載課堂或會議錄音，AI 自動轉成逐字稿（支援中文、粵語、英文）</p>
      </div>

      <div className="card">
        {!file ? (
          <div
            className={`drop${over ? " over" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <div className="big">📁 拖放錄音檔案到呢度，或者撳一下揀檔案</div>
            <div className="small">
              支援 mp3 / wav / m4a / aac / flac / ogg 等 · 長錄音會自動分段，唔受 3 分鐘限制
            </div>
          </div>
        ) : (
          <>
            <div className="filebox">
              <div className="meta">
                <div className="name">🎵 {file.name}</div>
                <div className="size">
                  {fmtSize(file.size)}
                  {duration > 0 ? ` · ${fmtDuration(duration)}` : ""}
                </div>
              </div>
              <button className="btn-ghost" onClick={reset} disabled={loading}>
                換檔案
              </button>
            </div>
            {audioUrl ? (
              <audio
                controls
                src={audioUrl}
                onLoadedMetadata={(e) =>
                  setDuration(e.currentTarget.duration || 0)
                }
              />
            ) : null}

            {estSegments > 1 ? (
              <div className="alert note">
                ℹ️ 錄音長度約 {fmtDuration(duration)}，將自動分成約 {estSegments} 段處理，每段約 2 分鐘。長錄音解碼需時，請耐心等候。
              </div>
            ) : null}

            <div className="grid">
              <div>
                <label className="field">語言</label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  disabled={loading}
                >
                  <option value="auto">自動偵測（含粵語）</option>
                  <option value="zh">中文 / 粵語</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div>
                <label className="field">專有名詞 / 背景（選填）</label>
                <textarea
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  placeholder="例：人名、學校名、科目術語…有助提高辨識準確度"
                  disabled={loading}
                />
              </div>
            </div>

            <div className="actions">
              <button
                className="btn-primary"
                onClick={transcribe}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <span className="spinner" />
                    {stage || "處理緊…"}
                  </>
                ) : (
                  "開始轉逐字稿"
                )}
              </button>
              <button className="btn-ghost" onClick={reset} disabled={loading}>
                清除
              </button>
            </div>

            {loading && progress && progress.total > 1 ? (
              <div className="progress">
                <div className="progress-bar" style={{ width: `${pct}%` }} />
                <div className="progress-text">
                  {progress.done} / {progress.total} 段 · {pct}%
                </div>
              </div>
            ) : null}
          </>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.m4a,.amr,.opus,.wma"
          style={{ display: "none" }}
          onChange={(e) => pickFile(e.target.files?.[0] || null)}
        />

        {error ? <div className="alert err">{error}</div> : null}

        {transcript ? (
          <div className="result">
            <div className="bar">
              <h3>逐字稿{loading ? "（辨識中…）" : ""}</h3>
              <div className="tools">
                <button className="btn-ghost" onClick={copyText}>
                  複製
                </button>
                <button className="btn-ghost" onClick={downloadTxt}>
                  下載 .txt
                </button>
              </div>
            </div>
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
            <div className="count">{transcript.length} 字</div>
          </div>
        ) : null}
      </div>

      <div className="footer">
        由 Qwen3-ASR-Flash 提供辨識 · 長錄音於瀏覽器自動分段 · 結果僅供參考，請自行核對
      </div>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
