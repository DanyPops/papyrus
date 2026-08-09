/**
 * A registered project identity, shared across every artifact kind (Tasks, Docs, Rules,
 * Playbooks) rather than owned by Tasks alone -- extracted so a Doc/Rule/Playbook can resolve
 * and register against the exact same id/name/alias/root space a Task already does, instead of
 * each domain inventing its own project catalog.
 */
export interface Project {
	id: string;
	name: string;
	aliases: string[];
	projectRoot: string;
	createdAt: string;
	updatedAt: string;
}

export interface RegisterProjectInput {
	projectRoot: string;
	name?: string;
	aliases?: string[];
	existingId?: string;
}
