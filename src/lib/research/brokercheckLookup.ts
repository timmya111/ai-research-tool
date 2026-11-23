/**
 * BrokerCheck / AdviserInfo individual detail by CRD.
 * The prod search sidecars only expose current employments (often empty for
 * Inactive CRDs). Full registration history lives on these detail endpoints.
 */

export type BrokercheckEmployment = {
	firmId?: string;
	firmName?: string;
	city?: string;
	state?: string;
	country?: string;
	begin?: string;
	end?: string;
	bdSECNumber?: string;
	iaSECNumber?: string;
	firmBCScope?: string;
	firmIAScope?: string;
	iaOnly?: string;
	source: 'current' | 'previous' | 'currentIA' | 'previousIA';
};

export type BrokercheckExam = {
	category?: string;
	name?: string;
	takenDate?: string;
	scope?: string;
	kind: 'state' | 'principal' | 'product';
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function pickString(...vals: unknown[]): string {
	for (const v of vals) {
		const s = String(v ?? '').trim();
		if (s) return s;
	}
	return '';
}

function normalizeCrd(raw: unknown): string {
	const s = String(raw ?? '')
		.trim()
		.replace(/^CRD[#:\s]*/i, '')
		.replace(/[^\d]/g, '');
	return s;
}

function mapEmployment(row: unknown, source: BrokercheckEmployment['source']): BrokercheckEmployment | null {
	const er = asRecord(row);
	if (!er) return null;
	const firmId = pickString(er.firmId, er.firm_id);
	const firmName = pickString(er.firmName, er.firm_name);
	if (!firmId && !firmName) return null;
	return {
		firmId: firmId || undefined,
		firmName: firmName || undefined,
		city: pickString(er.city) || undefined,
		state: pickString(er.state) || undefined,
		country: pickString(er.country) || undefined,
		begin: pickString(er.registrationBeginDate, er.beginDate, er.startDate) || undefined,
		end: pickString(er.registrationEndDate, er.endDate) || undefined,
		bdSECNumber: pickString(er.bdSECNumber) || undefined,
		iaSECNumber: pickString(er.iaSECNumber) || undefined,
		firmBCScope: pickString(er.firmBCScope) || undefined,
		firmIAScope: pickString(er.firmIAScope) || undefined,
		iaOnly: pickString(er.iaOnly) || undefined,
		source,
	};
}

function mapExam(row: unknown, kind: BrokercheckExam['kind']): BrokercheckExam | null {
	const er = asRecord(row);
	if (!er) return null;
	const category = pickString(er.examCategory, er.category);
	const name = pickString(er.examName, er.name);
	if (!category && !name) return null;
	return {
		category: category || undefined,
		name: name || undefined,
		takenDate: pickString(er.examTakenDate, er.takenDate) || undefined,
		scope: pickString(er.examScope, er.scope) || undefined,
		kind,
	};
}

function unwrapContent(source: Record<string, unknown>): Record<string, unknown> | null {
	const content = source.content ?? source.iacontent;
	if (typeof content === 'string' && content.trim()) {
		try {
			const parsed = JSON.parse(content);
			return asRecord(parsed);
		} catch {
			return null;
		}
	}
	return asRecord(content) || source;
}

function extractHitSource(payload: unknown): Record<string, unknown> | null {
	const root = asRecord(payload);
	if (!root) return null;
	const hitsWrap = asRecord(root.hits);
	const hitList = Array.isArray(hitsWrap?.hits) ? hitsWrap!.hits : Array.isArray(root.hits) ? root.hits : [];
	if (!hitList.length) return null;
	const first = asRecord(hitList[0]);
	if (!first) return null;
	const src = asRecord(first._source) || first;
	return unwrapContent(src);
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; payload: unknown; error?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 45_000);
	try {
		const res = await fetch(url, {
			method: 'GET',
			cache: 'no-store',
			signal: controller.signal,
			headers: {
				Accept: 'application/json',
				'User-Agent': 'ai-research-tool/brokercheck-lookup',
				Origin: 'https://brokercheck.finra.org',
				Referer: 'https://brokercheck.finra.org/',
			},
		});
		const text = await res.text();
		let payload: unknown = null;
		try {
			payload = text ? JSON.parse(text) : null;
		} catch {
			return { ok: false, status: res.status, payload: null, error: `non-JSON body (${text.slice(0, 120)})` };
		}
		if (!res.ok) {
			return { ok: false, status: res.status, payload, error: `HTTP ${res.status}` };
		}
		return { ok: true, status: res.status, payload };
	} catch (error: unknown) {
		return {
			ok: false,
			status: 0,
			payload: null,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

function compactDetail(
	detail: Record<string, unknown>,
	opts: { registry: 'brokercheck' | 'adviserinfo'; crd: string; url: string },
) {
	const basic = asRecord(detail.basicInformation) || {};
	const first = pickString(basic.firstName);
	const middle = pickString(basic.middleName);
	const last = pickString(basic.lastName);
	const name =
		[first, middle, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() ||
		pickString(basic.name) ||
		`Individual ${opts.crd}`;
	const other = basic.otherNames;
	const otherNames = Array.isArray(other)
		? other.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
		: undefined;

	const employments: BrokercheckEmployment[] = [];
	const pushAll = (arr: unknown, source: BrokercheckEmployment['source']) => {
		if (!Array.isArray(arr)) return;
		for (const row of arr) {
			const mapped = mapEmployment(row, source);
			if (mapped) employments.push(mapped);
		}
	};
	pushAll(detail.currentEmployments, 'current');
	pushAll(detail.currentIAEmployments, 'currentIA');
	pushAll(detail.previousEmployments, 'previous');
	pushAll(detail.previousIAEmployments, 'previousIA');

	const exams: BrokercheckExam[] = [];
	const pushExams = (arr: unknown, kind: BrokercheckExam['kind']) => {
		if (!Array.isArray(arr)) return;
		for (const row of arr) {
			const mapped = mapExam(row, kind);
			if (mapped) exams.push(mapped);
		}
	};
	pushExams(detail.stateExamCategory, 'state');
	pushExams(detail.principalExamCategory, 'principal');
	pushExams(detail.productExamCategory, 'product');

	const disclosures = Array.isArray(detail.disclosures) ? detail.disclosures : [];

	return {
		registry: opts.registry,
		crd: opts.crd,
		name,
		display: `${name} :: Individual CRD# ${opts.crd}`,
		otherNames,
		bcScope: pickString(basic.bcScope) || undefined,
		iaScope: pickString(basic.iaScope) || undefined,
		daysInIndustry: basic.daysInIndustry != null ? Number(basic.daysInIndustry) : undefined,
		disclosureFlag: pickString(detail.disclosureFlag, basic.disclosureFlag) || undefined,
		iaDisclosureFlag: pickString(detail.iaDisclosureFlag, basic.iaDisclosureFlag) || undefined,
		disclosureCount: disclosures.length,
		employmentCount: employments.length,
		employments,
		exams,
		registeredStates: Array.isArray(detail.registeredStates) ? detail.registeredStates.slice(0, 40) : undefined,
		registeredSROs: Array.isArray(detail.registeredSROs) ? detail.registeredSROs.slice(0, 40) : undefined,
		registrationCount: asRecord(detail.registrationCount) || undefined,
		sourceUrl: opts.url,
		brokercheckUrl: `https://brokercheck.finra.org/individual/summary/${opts.crd}`,
	};
}

/**
 * Look up full BrokerCheck (and optionally AdviserInfo) detail for a CRD,
 * including previous employment history the flat-file sidecars omit.
 */
export async function lookupBrokercheckIndividual(args: {
	crd?: string;
	includeAdviserInfo?: boolean;
}): Promise<{ ok: boolean; result: Record<string, unknown> }> {
	const crd = normalizeCrd(args.crd);
	if (!/^\d{4,10}$/.test(crd)) {
		return {
			ok: false,
			result: {
				ok: false,
				error: 'crd must be a numeric CRD (4–10 digits)',
			},
		};
	}

	const bcUrl = `https://api.brokercheck.finra.org/search/individual/${crd}`;
	const bc = await fetchJson(bcUrl);
	if (!bc.ok) {
		return {
			ok: false,
			result: {
				ok: false,
				crd,
				crdKind: 'individual',
				error: bc.error || `BrokerCheck fetch failed`,
				status: bc.status,
				url: bcUrl,
				hint: 'Try again, or open brokercheck.finra.org for this CRD in a browser. If this is a Firm CRD, use search_finra_sidecar (entity=firm) or lookup_firm_connections instead.',
			},
		};
	}

	const detail = extractHitSource(bc.payload);
	if (!detail) {
		// Same digits may be a Firm CRD (BrokerCheck firm summary), not a person.
		const firmUrl = `https://api.brokercheck.finra.org/search/firm/${crd}`;
		const firm = await fetchJson(firmUrl);
		const firmDetail = firm.ok ? extractHitSource(firm.payload) : null;
		if (firmDetail) {
			const firmBasic = asRecord(firmDetail.basicInformation) || firmDetail;
			const firmName =
				pickString(firmBasic.firmName, firmBasic.iaFirmName, firmBasic.name) || `Firm ${crd}`;
			return {
				ok: false,
				result: {
					ok: false,
					crd,
					crdKind: 'firm',
					error: `CRD# ${crd} is a Firm CRD (${firmName}), not an Individual CRD. lookup_brokercheck is individual-only.`,
					firmName,
					firmBcScope: pickString(firmBasic.bcScope) || undefined,
					firmIaScope: pickString(firmBasic.iaScope) || undefined,
					url: firmUrl,
					brokercheckFirmUrl: `https://brokercheck.finra.org/firm/summary/${crd}`,
					dashboardPath: `/dashboard/firm/${crd}`,
					hint: 'Use search_finra_sidecar with entity=firm, or lookup_firm_connections with firmCrd.',
				},
			};
		}
		return {
			ok: false,
			result: {
				ok: false,
				crd,
				crdKind: 'individual',
				error: 'No BrokerCheck individual hit for this CRD',
				url: bcUrl,
			},
		};
	}

	const profile = compactDetail(detail, { registry: 'brokercheck', crd, url: bcUrl });
	const result: Record<string, unknown> = {
		ok: true,
		crd,
		crdKind: 'individual',
		note: 'Full employment history from BrokerCheck individual detail API (person CRD only — not firm CRDs). search_finra_sidecar only has current employers (often empty when Inactive). Node-graph checkbox is not required.',
		profile,
	};

	const wantIa = args.includeAdviserInfo !== false;
	if (wantIa) {
		const iaUrl = `https://api.adviserinfo.sec.gov/search/individual/${crd}`;
		const ia = await fetchJson(iaUrl);
		if (ia.ok) {
			const iaDetail = extractHitSource(ia.payload);
			if (iaDetail) {
				result.adviserInfo = compactDetail(iaDetail, {
					registry: 'adviserinfo',
					crd,
					url: iaUrl,
				});
			}
		} else {
			result.adviserInfoError = ia.error || `HTTP ${ia.status}`;
		}
	}

	return { ok: true, result };
}
