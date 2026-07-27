export interface ArtifactEdge {
	from: string;
	relation: string;
	to: string;
}

export interface Artifact {
	id: string;
	kind: string;
	title: string;
	status: string;
	subtype: string;
	body: string;
	labels: string[];
	extra: Record<string, unknown>;
	created_at: string;
	updated_at: string;
	edges?: ArtifactEdge[];
}

export interface CreateArtifactInput {
	kind?: string;
	title?: string;
	status?: string;
	body?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
	id?: string;
	subtype?: string;
	templateId?: string;
}

export interface UpdateArtifactInput {
	title?: string;
	body?: string;
	labels?: string[];
}

export interface ArtifactQuery {
	kind?: string;
	status?: string;
	statuses?: string[];
	subtype?: string;
	excludeSubtype?: string;
	text?: string;
	labels?: string[];
	extraEquals?: Record<string, string | number | boolean>;
	limit?: number;
	/** Trashed artifacts (see artifact-trash.ts) are excluded from every query by default; set true to include them, e.g. for a trash-listing view. */
	includeTrashed?: boolean;
	/**
	 * Restrict to exactly these ids, still subject to every other filter (kind, trash exclusion,
	 * etc.) -- for a caller that already has a bounded candidate id set (e.g. Tasks.list's
	 * project/graph scope) and needs query()'s own trash-exclusion without a full-kind scan.
	 * Empty array is a real "match nothing", not "unset".
	 */
	ids?: string[];
}

export interface ArtifactGraphOptions {
	tree?: boolean;
	depth?: number;
	maxNodes?: number;
}

export interface ArtifactLink {
	from: string;
	relation: string;
	to: string;
}

export interface RelationshipQuery {
	kind?: string;
	artifactIds?: string[];
	limit?: number;
}

/**
 * A label of the form "source:<system>" marks an artifact as ingested/projected from an
 * external, non-Papyrus system (e.g. web-spider's own "source:web-spider" convention on the
 * Docs it creates) -- content Papyrus does not own and cannot safely rewrite without silently
 * diverging from the true source. Editing one directly would look like a correction but really
 * just be a local fork nobody re-syncs.
 */
export const EXTERNAL_SOURCE_LABEL_PREFIX = "source:";

/** The external system name from a "source:<system>" label, or undefined if this artifact has no such label (i.e. it's Papyrus-native content). */
export function externalSourceOf(artifact: Pick<Artifact, "labels">): string | undefined {
	const label = artifact.labels.find((entry) => entry.startsWith(EXTERNAL_SOURCE_LABEL_PREFIX));
	return label === undefined ? undefined : label.slice(EXTERNAL_SOURCE_LABEL_PREFIX.length) || undefined;
}

/** Throws if the artifact is a read-only external projection; a caller must never silently rewrite content it doesn't own the source of. */
export function requireLocallyOwnedContent(artifact: Artifact): Artifact {
	const system = externalSourceOf(artifact);
	if (system !== undefined) {
		throw new Error(`"${artifact.title}" is a read-only projection from ${system}; edit it there, or capture a correction as a new linked Doc, until a write-back capability is integrated`);
	}
	return artifact;
}
