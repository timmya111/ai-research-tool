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

const themeInitScript = `(function(){try{var k='research.theme';var t=localStorage.getItem(k);if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var r=document.documentElement;r.classList.toggle('dark',t==='dark');r.style.colorScheme='dark';var L={'--app-bg':'#0a1430','--app-fg':'#e8eeff','--app-surface':'#0d1a3a','--app-surface-hover':'#132248','--app-border':'rgba(59, 130, 246, 0.4)','--app-muted':'#a8b4cc','--app-chat-user':'rgba(249, 115, 22, 0.22)','--app-chat-assistant':'rgba(232, 238, 255, 0.08)','--app-ask-bar-bg':'rgba(10, 20, 48, 0.96)','--app-ask-bar-shadow':'0 -8px 24px rgba(0, 0, 0, 0.35)'};var D={'--app-bg':'#050a1c','--app-fg':'#e8eeff','--app-surface':'#0a1228','--app-surface-hover':'#121c38','--app-border':'rgba(59, 130, 246, 0.4)','--app-muted':'#a8b4cc','--app-chat-user':'rgba(249, 115, 22, 0.26)','--app-chat-assistant':'rgba(232, 238, 255, 0.08)','--app-ask-bar-bg':'rgba(5, 10, 28, 0.96)','--app-ask-bar-shadow':'0 -8px 24px rgba(0, 0, 0, 0.4)'};var v=t==='dark'?D:L;for(var p in v)r.style.setProperty(p,v[p]);}catch(e){}})();`;

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
