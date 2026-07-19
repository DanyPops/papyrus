import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import type { AtomicArtifactStore } from "../ports/atomic-artifact-store.ts";
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
import { createArtifact, getArtifact, linkArtifacts, queryArtifacts, updateArtifactContent, updateExtra, updateStatus } from "../ops.ts";

export class SQLiteArtifactStore implements AtomicArtifactStore {
	constructor(private readonly db: Db) {}

	atomic<T>(operation: () => T): T {
		return inTransaction(this.db, operation);
	}

	create(input: CreateArtifactInput): Artifact {
		return createArtifact(this.db, input);
	}

	get(id: string, options?: ArtifactGraphOptions): Artifact | null {
		return getArtifact(this.db, id, options);
	}

	query(filter: ArtifactQuery): Artifact[] {
		return queryArtifacts(this.db, filter);
	}

	link(link: ArtifactLink): void {
		linkArtifacts(this.db, link.from, link.relation, link.to);
	}

	setStatus(id: string, status: string): Artifact | null {
		return updateStatus(this.db, id, status);
	}

	setExtra(id: string, extra: Record<string, unknown>): Artifact | null {
		return updateExtra(this.db, id, extra);
	}

	updateContent(id: string, input: UpdateArtifactInput): Artifact | null {
		return updateArtifactContent(this.db, id, input);
	}

	relationships(filter: RelationshipQuery = {}): ArtifactEdge[] {
		if (filter.artifactIds?.length === 0) return [];
		const conditions: string[] = [];
		const parameters: unknown[] = [];
		if (filter.kind) {
			conditions.push("source.kind = ? AND target.kind = ?");
			parameters.push(filter.kind, filter.kind);
		}
		if (filter.artifactIds) {
			const placeholders = filter.artifactIds.map(() => "?").join(", ");
			conditions.push(`(edges.from_id IN (${placeholders}) OR edges.to_id IN (${placeholders}))`);
			parameters.push(...filter.artifactIds, ...filter.artifactIds);
		}
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		let limit = "";
		if (filter.limit !== undefined) {
			if (!Number.isInteger(filter.limit) || filter.limit < 1) throw new Error("relationship limit must be a positive integer");
			limit = "LIMIT ?";
			parameters.push(filter.limit);
		}
		return this.db.prepare(`
			SELECT edges.from_id AS "from", edges.relation, edges.to_id AS "to"
			FROM edges
			JOIN artifacts AS source ON source.id = edges.from_id
			JOIN artifacts AS target ON target.id = edges.to_id
			${where}
			ORDER BY edges.rowid
			${limit}
		`).all(...parameters) as ArtifactEdge[];
	}
}
