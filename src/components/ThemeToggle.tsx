'use client';

import { useCallback, useEffect, useState } from 'react';

const LS_THEME = 'research.theme';

type Theme = 'light' | 'dark';

function readStoredTheme(): Theme | null {
	try {
		const v = window.localStorage.getItem(LS_THEME);
		if (v === 'light' || v === 'dark') return v;
	} catch {
		/* ignore */
	}
	return null;
}

function systemTheme(): Theme {
	if (typeof window === 'undefined') return 'light';
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const LIGHT_VARS: Record<string, string> = {
	'--app-bg': '#eef1f5',
	'--app-fg': '#2b313a',
	'--app-surface': '#f7f8fa',
	'--app-surface-hover': '#e8ecf1',
	'--app-border': '#c9d0d9',
	'--app-muted': '#5b6572',
	'--app-chat-user': 'rgba(249, 115, 22, 0.14)',
	'--app-chat-assistant': 'rgba(43, 49, 58, 0.06)',
	'--app-ask-bar-bg': 'rgba(247, 248, 250, 0.94)',
	'--app-ask-bar-shadow': '0 -8px 24px rgba(43, 49, 58, 0.08)',
};

const DARK_VARS: Record<string, string> = {
	'--app-bg': '#1e2430',
	'--app-fg': '#e4e8ef',
	'--app-surface': '#2a3140',
	'--app-surface-hover': '#343c4d',
	'--app-border': '#4a5568',
	'--app-muted': '#a8b2c1',
	'--app-chat-user': 'rgba(249, 115, 22, 0.22)',
	'--app-chat-assistant': 'rgba(228, 232, 239, 0.08)',
	'--app-ask-bar-bg': 'rgba(42, 49, 64, 0.96)',
	'--app-ask-bar-shadow': '0 -8px 24px rgba(0, 0, 0, 0.28)',
};

function applyTheme(theme: Theme) {
	const root = document.documentElement;
	root.classList.toggle('dark', theme === 'dark');
	root.style.colorScheme = theme;
	const vars = theme === 'dark' ? DARK_VARS : LIGHT_VARS;
	for (const [key, value] of Object.entries(vars)) {
		root.style.setProperty(key, value);
	}
	try {
		window.localStorage.setItem(LS_THEME, theme);
	} catch {
		/* ignore */
	}
}

function SunIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
		</svg>
	);
}

function MoonIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5Z" />
		</svg>
	);
}

export default function ThemeToggle() {
	const [theme, setTheme] = useState<Theme>('light');
	const [ready, setReady] = useState(false);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			const next = readStoredTheme() || systemTheme();
			setTheme(next);
			applyTheme(next);
			setReady(true);
		}, 0);
		return () => window.clearTimeout(timer);
	}, []);

	const toggle = useCallback(() => {
		setTheme((prev) => {
			const next: Theme = prev === 'dark' ? 'light' : 'dark';
			applyTheme(next);
			return next;
		});
	}, []);

	const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

	return (
		<button
			type="button"
			onClick={toggle}
			aria-label={label}
			title={label}
			className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-surface)] text-[var(--app-fg)] shadow-sm transition hover:bg-[var(--app-surface-hover)]"
		>
			{!ready ? (
				<span className="h-4 w-4" />
			) : theme === 'dark' ? (
				<SunIcon className="h-[18px] w-[18px]" />
			) : (
				<MoonIcon className="h-[18px] w-[18px]" />
			)}
		</button>
	);
}
