/**
 * A short, globally-unique, human/agent-typeable name for an artifact -- alongside its
 * opaque UUID identity (ops.ts's createArtifact), not instead of it. Derived from title by
 * default so the alias stays recognizable, but title itself is free-form prose and not
 * unique -- this module owns turning that into something safe to type, remember, and index.
 */

const MAX_ALIAS_LENGTH = 50;
const FALLBACK_BASE = "artifact";
const ALIAS_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Lowercased, hyphen-separated, ASCII-alphanumeric-only; never empty (falls back to a generic base). */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/'/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_ALIAS_LENGTH)
		.replace(/-+$/g, "");
	return slug.length > 0 ? slug : FALLBACK_BASE;
}

/** Appends the lowest available "-N" suffix (starting at 2) until `isTaken` reports free. */
export function generateUniqueAlias(base: string, isTaken: (candidate: string) => boolean): string {
	if (!isTaken(base)) return base;
	for (let suffix = 2; ; suffix++) {
		const candidate = `${base}-${suffix}`;
		if (!isTaken(candidate)) return candidate;
	}
}

/** Format an explicit caller-supplied alias must satisfy -- the same shape generateUniqueAlias always produces. */
export function isValidAlias(alias: string): boolean {
	return alias.length > 0 && alias.length <= MAX_ALIAS_LENGTH && ALIAS_PATTERN.test(alias);
}
