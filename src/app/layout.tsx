import type { Metadata } from "next";
import "./globals.css";
import "./monitoring.css";

export const metadata: Metadata = {
  title: "Smart Server Room — KELAPA",
  description:
    "Monitoring DHT, PIR dan MQ · Kelompok KELAPA · BINUS Online University",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
