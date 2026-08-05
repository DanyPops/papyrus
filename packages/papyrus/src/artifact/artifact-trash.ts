/**
 * Artifact trash: Option B from the design discussion (Doc-worthy decision, recorded here
 * since there is no other durable home for it yet) -- `artifact.remove` is a real, narrow,
 * time-gated exception to Papyrus's otherwise-absolute append-only invariant, not a mere
 * status flip.
 *
 * The constraint that shaped this design: every artifact gets a mandatory "created" row in
 * artifact_events at creation time (see ops.ts's createArtifact), and artifact_events is
 * DB-trigger-enforced immutable (no UPDATE, no DELETE, ever). That means a literal
 * `DELETE FROM artifacts` can never succeed for ANY artifact while that FK and that trigger
 * both hold unconditionally -- there is no such thing as an artifact with "no history to
 * protect". A real purge therefore requires the DB's own append-only triggers to carry an
 * explicit, narrow carve-out (see db.ts's artifact_events_no_delete / task_events_no_delete),
 * gated on the exact same elapsed-time deadline recorded here -- enforced by the database
 * itself, not merely by application-code discipline, so a bug in the purge sweep cannot
 * delete history before its own stated deadline.
 *
 * Removing an artifact does not touch it immediately: it inserts one row here recording when
 * it becomes eligible, and from that moment the artifact is excluded from ordinary listings
 * (see ops.ts's queryArtifacts) but still directly reachable by id (get/show) and fully
 * restorable via artifact.restore, until purgeAfter passes and the daemon's periodic sweep
 * (see daemon.ts) performs the real, cascading, irreversible deletion.
 */
export interface ArtifactTrashRecord {
	artifactId: string;
	trashedAt: string;
	purgeAfter: string;
	reason?: string;
}
