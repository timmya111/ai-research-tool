/**
 * Shared visual tokens matching Entity Profiles (navy panel + blue controls + orange CTA).
 * Used by Research Chat and Profiles so both surfaces stay aligned.
 */

/** Page / panel shell — deep navy, light text (same in light + dark class variants). */
export const PANEL_BG =
	'bg-[#050a1c] text-[#e8eeff] dark:bg-[#040812] dark:text-[#e8eeff]';

/** Card / section outline on navy. */
export const PANEL_OUTLINE = `rounded-lg border border-[#1e3a8a]/50 dark:border-[#3b82f6]/35 ${PANEL_BG}`;

/** Secondary control chip / button. */
export const CONTROL_BTN =
	'rounded-md border border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] text-[#e8eeff] hover:bg-[lab(5_4.06_-17.11_/0.75)]';

/** Text inputs / selects on navy. */
export const CONTROL_INPUT =
	'rounded-md border border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] text-[#e8eeff] placeholder:text-[#e8eeff]/50';

/** Primary orange CTA. */
export const PRIMARY_BTN =
	'rounded-md border-none bg-[#F97316] font-semibold text-white disabled:opacity-50';

/** Suggested-question / filter chip (idle). */
export const CHIP =
	'rounded-full border border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] text-[#e8eeff] hover:bg-[lab(5_4.06_-17.11_/0.75)]';

/** Accent chip (canvas / highlighted). */
export const CHIP_ACCENT =
	'rounded-full border border-[#F97316]/50 bg-[#F97316]/15 text-[#FFEDD5] hover:bg-[#F97316]/25';

/** Inner nested surface on navy (options rows, paste boxes). */
export const INNER_SURFACE =
	'rounded-lg border border-[#1e3a8a]/45 bg-[lab(5_4.06_-17.11_/0.45)] dark:border-[#3b82f6]/30';

/** Soft info / notice strip (replaces sky/amber rainbow panels). */
export const NOTICE_STRIP =
	'rounded-lg border border-[#3b82f6]/35 bg-[lab(5_4.06_-17.11_/0.35)]';

/** Divider inside navy panels. */
export const PANEL_DIVIDER = 'border-[#1e3a8a]/50 dark:border-[#3b82f6]/30';
