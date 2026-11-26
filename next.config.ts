import type { NextConfig } from 'next';

/** Extra hosts for `next dev` when sharing on LAN (comma-separated). */
const extraDevOrigins = String(process.env.RESEARCH_ALLOWED_DEV_ORIGINS || '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

const nextConfig: NextConfig = {
	allowedDevOrigins: [
		'127.0.0.1',
		'localhost',
		// Current Wi‑Fi LAN IP (also set RESEARCH_ALLOWED_DEV_ORIGINS for others)
		'192.168.1.216',
		...extraDevOrigins,
	],
	compress: true,
	turbopack: {
		rules: {
			'*.css': {
				loaders: ['@tailwindcss/turbopack'],
				as: '*.css',
			},
		},
	},
};

export default nextConfig;
