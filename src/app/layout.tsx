import type { Metadata } from 'next';
import { Geist, Spline_Sans_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
	variable: '--font-geist-sans',
	subsets: ['latin'],
});

const splineSansMono = Spline_Sans_Mono({
	variable: '--font-spline-sans-mono',
	subsets: ['latin'],
});

export const metadata: Metadata = {
	title: 'AI Research Tool',
	description: 'Local Ollama research assistant with adaptive multi-model routing and URL fetch tools.',
	robots: { index: false, follow: false },
};

const themeInitScript = `(function(){try{var k='research.theme';var t=localStorage.getItem(k);if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var r=document.documentElement;r.classList.toggle('dark',t==='dark');r.style.colorScheme=t;var L={'--app-bg':'#eef1f5','--app-fg':'#2b313a','--app-surface':'#f7f8fa','--app-surface-hover':'#e8ecf1','--app-border':'#c9d0d9','--app-muted':'#5b6572','--app-chat-user':'rgba(249, 115, 22, 0.14)','--app-chat-assistant':'rgba(43, 49, 58, 0.06)','--app-ask-bar-bg':'rgba(247, 248, 250, 0.94)','--app-ask-bar-shadow':'0 -8px 24px rgba(43, 49, 58, 0.08)'};var D={'--app-bg':'#1e2430','--app-fg':'#e4e8ef','--app-surface':'#2a3140','--app-surface-hover':'#343c4d','--app-border':'#4a5568','--app-muted':'#a8b2c1','--app-chat-user':'rgba(249, 115, 22, 0.22)','--app-chat-assistant':'rgba(228, 232, 239, 0.08)','--app-ask-bar-bg':'rgba(42, 49, 64, 0.96)','--app-ask-bar-shadow':'0 -8px 24px rgba(0, 0, 0, 0.28)'};var v=t==='dark'?D:L;for(var p in v)r.style.setProperty(p,v[p]);}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<'/'>) {
	return (
		<html
			lang="en"
			suppressHydrationWarning
			className={`${geistSans.variable} ${splineSansMono.variable} h-full antialiased`}
		>
			<head>
				<script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
			</head>
			<body className="flex min-h-full flex-col bg-[var(--app-bg)] font-mono text-[var(--app-fg)]">
				{children}
			</body>
		</html>
	);
}
