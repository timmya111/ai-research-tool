import { headers } from 'next/headers';
import ProfilesClient from '@/components/ProfilesClient';
import { isLocalResearchHost } from '@/lib/research/guard';

export const dynamic = 'force-dynamic';

export default async function ProfilesCatchAllPage({
	params,
}: {
	params: Promise<{ slug: string[] }>;
}) {
	const h = await headers();
	const host = h.get('x-forwarded-host') || h.get('host');
	if (!isLocalResearchHost(host) && process.env.ALLOW_LOCAL_AI !== '1') {
		return (
			<main className="mx-auto max-w-xl p-6 font-sans">
				<h1 className="text-2xl font-semibold">Entity Profiles &amp; Alignment</h1>
				<p className="mt-2 opacity-80">
					This page is available on <code>localhost</code> only.
				</p>
			</main>
		);
	}

	const { slug } = await params;
	const parts = (slug || []).map((s) => decodeURIComponent(s).trim()).filter(Boolean);

	if (parts[0] === 'alignments') {
		return <ProfilesClient initialView="alignments" />;
	}

	const initialProfileSlug =
		parts.length >= 2
			? `${parts[0]}:${parts.slice(1).join('-')}`
			: parts.length === 1
				? parts[0]
				: undefined;

	return <ProfilesClient initialProfileSlug={initialProfileSlug} />;
}
