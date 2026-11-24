import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = { title: "Marketing Engine", description: "Marketing command center" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body style={{ ["--font-sans" as string]: "Inter, 'Segoe UI', system-ui" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
