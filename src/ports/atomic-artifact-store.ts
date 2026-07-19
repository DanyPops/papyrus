import type { ArtifactStore } from "./artifact-store.ts";

/** Artifact store boundary for domain operations that must commit as one graph mutation. */
export interface AtomicArtifactStore extends ArtifactStore {
	atomic<T>(operation: () => T): T;
}

export function requireAtomicArtifactStore(store: ArtifactStore): AtomicArtifactStore {
	if (!("atomic" in store) || typeof store.atomic !== "function") {
		throw new Error("artifact store does not support atomic workflow runs");
	}
	return store as AtomicArtifactStore;
}
