/**
 * module-registry.ts — Branch-by-Abstraction step 1 of the modules/projections refactor
 * (see docs reducing-papyrus-consumer-change-amplification-with-modules--pvdo and
 * papyrus-full-context-mesh-and-domain-storage-ownership-bound-qhzp).
 *
 * A statically registered operation descriptor replaces one entry of the central
 * operation switch in src/service.ts. This is intentionally minimal for this slice:
 * one registry, one contract, no dynamic loading, no migration/authority/CLI descriptors
 * yet — those are separate follow-up steps. The goal is to prove the shape end-to-end
 * for a real module (Notes) without changing any observable behavior.
 */

export interface OperationDefinition<Input = unknown, Output = unknown> {
	/** Dotted operation name, e.g. "notes.capture". Must be unique across every registered module. */
	readonly name: string;
	/** Owning module id, e.g. "notes". Used for boot diagnostics and future authority/migration scoping. */
	readonly moduleId: string;
	execute(input: Input): Output | Promise<Output>;
}

/**
 * O(1) name -> descriptor lookup. Boot-time registration is O(N) and rejects duplicate
 * names immediately rather than silently letting the last registration win, so a module
 * collision fails fast instead of producing quiet cross-module dispatch bugs.
 */
export class OperationRegistry {
	private readonly operations = new Map<string, OperationDefinition>();

	register(operation: OperationDefinition): void {
		const existing = this.operations.get(operation.name);
		if (existing) {
			throw new Error(`operation "${operation.name}" is already registered by module "${existing.moduleId}"`);
		}
		this.operations.set(operation.name, operation);
	}

	registerAll(operations: readonly OperationDefinition[]): void {
		for (const operation of operations) this.register(operation);
	}

	get(name: string): OperationDefinition | undefined {
		return this.operations.get(name);
	}

	has(name: string): boolean {
		return this.operations.has(name);
	}

	/** Bounded by registration count, not a runtime query — safe to call freely for diagnostics/CLI listing. */
	list(): string[] {
		return [...this.operations.keys()].sort();
	}
}
