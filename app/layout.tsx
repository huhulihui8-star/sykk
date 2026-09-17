import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

// 站点自身的公开地址。部署域名可能变，所以允许用环境变量覆盖；
// 不设置时回落到当前已发布的地址（否则分享卡片的图片会指向不存在的域名）。
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  'https://huhulihui8-star.github.io/sykk/';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: '最强分析师｜A 股、美股与全球指数展望',
  description:
    '基于当日经济新闻、企业财报公告与公开行情，生成 A 股、美股行业及全球主流指数的下一交易日信息展望。',
  openGraph: {
    title: '最强分析师｜A 股、美股与全球指数展望',
    description:
      '聚合今日新闻、财报公告与公开行情，生成下一交易日行业统计展望。',
    url: siteUrl,
    siteName: '最强分析师',
    images: [
      {
        url: '/sykk/og.jpg',
        width: 1200,
        height: 630,
        alt: '最强分析师：A 股、美股与全球指数信息分析',
      },
    ],
    locale: 'zh_CN',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: '最强分析师｜A 股、美股与全球指数展望',
    description:
      '聚合今日新闻、财报公告与公开行情，生成下一交易日行业统计展望。',
    images: ['/sykk/og.jpg'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {process.env.NEXT_PUBLIC_STATIC_EXPORT === '1' && <div className="border-b border-white/10 bg-slate-900 px-4 py-2 text-center text-xs text-slate-400">v11 新闻衰减与事件去重 · 准确率尚待留档验证 · GitHub Pages 每 30 分钟计划更新，任务可能延迟 · 请核对行情时间 · 不提供实时 API 或 MCP</div>}
        {children}
      </body>
    </html>
  );
}
