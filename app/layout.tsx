import "./globals.css";
import AuthGate from "./AuthGate";

export const metadata = {
  title: "中華基督教會基慈小學 · 錄音轉逐字稿",
  description: "老師上載錄音，AI 自動轉成逐字稿（支援中文、粵語、英文）",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-HK">
      <body>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
