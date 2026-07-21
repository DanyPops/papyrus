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
import type { ArtifactEventContext, ArtifactEventPage, ArtifactEventQuery } from "../domain/artifact-event.ts";

export interface ArtifactStore {
	create(input: CreateArtifactInput, context?: ArtifactEventContext): Artifact;
	get(id: string, options?: ArtifactGraphOptions): Artifact | null;
	query(filter: ArtifactQuery): Artifact[];
	link(link: ArtifactLink, context?: ArtifactEventContext): void;
	/** Idempotent: removing an already-absent relationship is a no-op that returns false, not an error. */
	unlink(link: ArtifactLink, context?: ArtifactEventContext): boolean;
	setStatus(id: string, status: string, context?: ArtifactEventContext): Artifact | null;
	setExtra(id: string, extra: Record<string, unknown>, context?: ArtifactEventContext): Artifact | null;
	updateContent(id: string, input: UpdateArtifactInput, context?: ArtifactEventContext): Artifact | null;
	relationships(filter?: RelationshipQuery): ArtifactEdge[];
	/** Bounded query over the generic mutation event log shared by every kind. */
	events(query: ArtifactEventQuery): ArtifactEventPage;
}
