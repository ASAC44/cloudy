import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import { RootProvider as FumadocsProvider } from "fumadocs-ui/provider/next";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

const serif = localFont({
  src: "./fonts/serifa.woff2",
  variable: "--font-anthropic-serif",
  weight: "400",
  style: "normal",
  display: "swap",
  fallback: ["Georgia", "serif"],
});

const sans = Inter({
  variable: "--font-anthropic-sans",
  subsets: ["latin"],
});

const mono = JetBrains_Mono({
  variable: "--font-anthropic-mono",
  subsets: ["latin"],
  weight: ["400"],
});

export const metadata: Metadata = {
  title: "Podex",
  description: "Approve agent actions at a glance.",
  icons: {
    icon: "/podex-mascot.png",
    apple: "/podex-mascot.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${serif.variable} ${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full" suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          <FumadocsProvider theme={{ enabled: false }}>
            {children}
            <Toaster />
          </FumadocsProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
