import type { Metadata } from "next";
import { Geist, Geist_Mono, Press_Start_2P } from "next/font/google";
import { WsProvider } from "@/lib/ws";
import { GameSessionProvider } from "@/lib/gameSession";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const pressStart2P = Press_Start_2P({
  variable: "--font-retro",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Overtake",
  description: "A card-driven board race game.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${pressStart2P.variable}`}>
      <body>
        <WsProvider>
          <GameSessionProvider>{children}</GameSessionProvider>
        </WsProvider>
      </body>
    </html>
  );
}
