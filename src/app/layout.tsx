import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = { title: '團購 ERP', description: '團購營運管理系統' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
