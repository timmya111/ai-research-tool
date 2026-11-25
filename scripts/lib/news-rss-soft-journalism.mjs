/**
 * Detect soft interview / opinion / low-quantitative / personal-injury / pet-story /
 * quarterly-earnings journalism that should stay out of historic_event timelines.
 */

import {
	classifyPersonalInjuryStory,
	classifyPetStory,
	classifyQuarterlyEarnings,
} from './news-rss-focus-topics.mjs';

const INTERVIEW_RE =
	/\b(?:let[’']s talk about|hahahaha|inaudible|podcast|transcript|speaking with|joined (?:us|me) (?:today|now)|welcome back to|first[, ]+i wanna|kind of scale)\b/i;

const SPEAKER_TURN_RE =
	/(?:^|\n)(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s+(?:Well|Let[’']s|And|But|However|Exactly|So|Why|What|The|It|Federal|Military)\b/;

const OPINION_TITLE_RE =
	/\b(?:sounds straightforward|in my (?:view|opinion)|opinion:|editorial|commentary|what looks like|changing faster than many|settled some questions)\b/i;

/** How-to / standards explainers with little event news value. */
const HOWTO_TITLE_RE =
	/^(?:how\s+(?:to|can|do|should|does)\b)|(?:\bhow\s+can\b.+\bprevent\b)|\b(?:what is required of|how to|a guide to|ways to|tips for|checklist|instruction(?:s|al)?|best practices for|what (?:crane )?operators (?:must|need)|competent,? qualified(?: and|,) certified|how to evaluate|prevent (?:cumulative )?injuries?)\b/i;

const SUBJECTIVE_BODY_RE =
	/\b(?:i think|i believe|in my view|feels like|kind of|sort of|you know, when|hopefully, you know)\b/i;

const QTY_RE = /\$[\d,.]+|\b\d+(?:\.\d+)?%|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b(?:million|billion|trillion)\b|\b(?:18|19|20)\d{2}-\d{2}-\d{2}\b/gi;

/**
 * @param {{ title?: string, summary?: string, description?: string }} input
 * @returns {{ soft: boolean, reasons: string[], qty: number, score: number }}
 */
export function classifySoftJournalism(input = {}) {
	const title = String(input.title || '');
	const body = String(input.summary || input.description || '');
	const head = `${title}\n${body.slice(0, 1_200)}`;
	const qty = (body.match(QTY_RE) || []).length;
	const reasons = [];
	let score = 0;

	if (INTERVIEW_RE.test(head) || INTERVIEW_RE.test(body.slice(0, 4_000))) {
		score += 3;
		reasons.push('interview_voice');
	}
	const speakerHits = body.slice(0, 6_000).match(new RegExp(SPEAKER_TURN_RE.source, 'g')) || [];
	if (speakerHits.length >= 2) {
		score += 3;
		reasons.push(`speaker_turns=${speakerHits.length}`);
	}
	if (OPINION_TITLE_RE.test(title)) {
		score += 2;
		reasons.push('opinion_title');
	}
	if (HOWTO_TITLE_RE.test(title)) {
		score += 3;
		reasons.push('howto_guide');
	}
	const injury = classifyPersonalInjuryStory({ title, summary: body });
	if (injury.soft) {
		score += 4;
		reasons.push(...injury.reasons);
	}
	const pet = classifyPetStory({ title, summary: body });
	if (pet.soft) {
		score += 4;
		reasons.push(...pet.reasons);
	}
	const earnings = classifyQuarterlyEarnings({ title, summary: body });
	if (earnings.soft) {
		score += 4;
		reasons.push(...earnings.reasons);
	}
	const subj = body.slice(0, 3_000).match(new RegExp(SUBJECTIVE_BODY_RE.source, 'gi')) || [];
	if (subj.length >= 3) {
		score += 2;
		reasons.push(`subjective_voice=${subj.length}`);
	}
	if (qty < 3) {
		score += 1;
		reasons.push(`low_qty=${qty}`);
	} else if (qty < 6 && score >= 2) {
		score += 1;
		reasons.push(`modest_qty=${qty}`);
	}

	// Soft if clear interview/opinion/how-to/injury/pet/earnings signal, or opinion+low quantitative density.
	const soft =
		injury.soft ||
		pet.soft ||
		earnings.soft ||
		(score >= 3 &&
			(reasons.some((r) =>
				/interview|speaker_turns|opinion_title|howto_guide|personal_injury|injury_fine|pet_story|quarterly_earnings/.test(
					r,
				),
			) ||
				(qty < 4 && score >= 4)));
	return { soft, reasons, qty, score };
}

export function isSoftJournalism(input) {
	return classifySoftJournalism(input).soft;
}
