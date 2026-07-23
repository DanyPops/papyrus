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
import type { ArtifactTrashRecord } from "../domain/artifact-trash.ts";

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
	/** See domain/artifact-trash.ts. Moves an artifact to the trash; throws if it does not exist or is the live Task Focus in any scope. */
	trash(id: string, options?: { reason?: string; context?: ArtifactEventContext }): ArtifactTrashRecord;
	/** Idempotent: restoring an artifact that is not currently trashed is a real no-op. */
	restore(id: string, context?: ArtifactEventContext): { restored: boolean };
	trashStatus(id: string): ArtifactTrashRecord | null;
	listTrash(): ArtifactTrashRecord[];
	/** Real, cascading, irreversible deletion of every artifact past its purge deadline; returns how many were purged. */
	purgeDueTrash(): number;
}
