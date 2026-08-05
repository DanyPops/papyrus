import type { ArtifactEventPage, ArtifactEventQuery } from "./artifact-event.ts";

/** Read access to the generic mutation event log shared by every kind -- split out of
 * ArtifactStore since only service.ts's graph.history operation reads it. */
export interface ArtifactEventReader {
	/** Bounded query over the generic mutation event log shared by every kind. */
	events(query: ArtifactEventQuery): ArtifactEventPage;
}
