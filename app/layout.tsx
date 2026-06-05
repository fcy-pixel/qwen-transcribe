import "./globals.css";

export const metadata = {
  title: "錄音轉逐字稿 · Qwen3-ASR-Flash",
  description: "老師上載錄音，AI 自動轉成逐字稿（支援中文、粵語、英文）",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-HK">
      <body>{children}</body>
    </html>
  );
}
