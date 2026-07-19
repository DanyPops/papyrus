import type {
	Artifact,
	ArtifactEdge,
	ArtifactGraphOptions,
	ArtifactLink,
	ArtifactQuery,
	CreateArtifactInput,
	RelationshipQuery,
	UpdateArtifactInput,
} from "../domain/artifact.ts";

export interface ArtifactStore {
	create(input: CreateArtifactInput): Artifact;
	get(id: string, options?: ArtifactGraphOptions): Artifact | null;
	query(filter: ArtifactQuery): Artifact[];
	link(link: ArtifactLink): void;
	setStatus(id: string, status: string): Artifact | null;
	setExtra(id: string, extra: Record<string, unknown>): Artifact | null;
	updateContent(id: string, input: UpdateArtifactInput): Artifact | null;
	relationships(filter?: RelationshipQuery): ArtifactEdge[];
}
