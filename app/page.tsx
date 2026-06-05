"use client";

import { useCallback, useMemo, useRef, useState } from "react";

const MAX_SOFT_BYTES = 10 * 1024 * 1024; // 10MB soft warning

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Page() {
  const [file, setFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string>("");
  const [language, setLanguage] = useState<string>("auto");
  const [context, setContext] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [transcript, setTranscript] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [over, setOver] = useState<boolean>(false);
  const [toast, setToast] = useState<string>("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 1800);
  }, []);

  const pickFile = useCallback(
    (f: File | null) => {
      if (!f) return;
      if (!f.type.startsWith("audio/") && !/\.(mp3|wav|m4a|aac|flac|ogg|opus|amr|wma|webm|aiff?)$/i.test(f.name)) {
        setError("請揀一個音頻檔案（mp3 / wav / m4a / aac / flac / ogg 等）。");
        return;
      }
      setError("");
      setTranscript("");
      setFile(f);
      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(f);
      });
    },
    []
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const f = e.dataTransfer.files?.[0];
      pickFile(f || null);
    },
    [pickFile]
  );

  const sizeWarning = useMemo(
    () => (file && file.size > MAX_SOFT_BYTES ? true : false),
    [file]
  );

  const transcribe = useCallback(async () => {
    if (!file || loading) return;
    setLoading(true);
    setError("");
    setTranscript("");
    try {
      const fd = new FormData();
      fd.append("audio", file);
      fd.append("language", language);
      fd.append("context", context);

      const resp = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.error) {
        setError(data?.error || `轉寫失敗 (${resp.status})`);
        return;
      }
      setTranscript(data.text || "");
      if (!data.text) setError("辨識結果為空，請檢查錄音內容。");
    } catch (e: any) {
      setError(e?.message || "網絡錯誤，請再試。");
    } finally {
      setLoading(false);
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
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
    if (inputRef.current) inputRef.current.value = "";
  }, []);

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
              支援 mp3 / wav / m4a / aac / flac / ogg 等 · 建議單次 ≤ 約 3 分鐘
            </div>
          </div>
        ) : (
          <>
            <div className="filebox">
              <div className="meta">
                <div className="name">🎵 {file.name}</div>
                <div className="size">{fmtSize(file.size)}</div>
              </div>
              <button className="btn-ghost" onClick={reset} disabled={loading}>
                換檔案
              </button>
            </div>
            {audioUrl ? <audio controls src={audioUrl} /> : null}

            {sizeWarning ? (
              <div className="alert note">
                ⚠️ 檔案較大（{fmtSize(file.size)}），可能超過單次辨識上限。如果失敗，請將錄音剪短（建議 ≤ 約 3 分鐘）後再試。
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
                    辨識緊…
                  </>
                ) : (
                  "開始轉逐字稿"
                )}
              </button>
              <button className="btn-ghost" onClick={reset} disabled={loading}>
                清除
              </button>
            </div>
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
              <h3>逐字稿</h3>
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
        由 Qwen3-ASR-Flash 提供辨識 · 結果僅供參考，請自行核對
      </div>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
