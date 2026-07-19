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

export interface ArtifactQuery {
	kind?: string;
	status?: string;
	text?: string;
	labels?: string[];
	limit?: number;
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
}
