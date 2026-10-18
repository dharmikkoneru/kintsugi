import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kintsugi — repair your habits with gold",
  description:
    "A habit tracker built around one keystone habit, ghost days, bounce-backs, and an 85% target.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="min-h-full">
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
