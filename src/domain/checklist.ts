export const PROOF_TYPES = ["file", "symbol", "code", "test", "command", "artifact", "url"] as const;

export type ProofType = typeof PROOF_TYPES[number];

export interface ProofReference {
	type: ProofType;
	target: string;
	expect?: string;
}

export interface ChecklistCriterion {
	proof: ProofReference[];
}

export type Checklist = Record<string, ChecklistCriterion>;

export interface ChecklistEntry {
	item: string;
	proof: ProofReference[];
	legacy: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function proofReference(value: unknown): ProofReference | undefined {
	if (!isRecord(value) || !PROOF_TYPES.includes(value["type"] as ProofType)) return undefined;
	if (typeof value["target"] !== "string" || value["target"].trim().length === 0) return undefined;
	if (value["expect"] !== undefined && typeof value["expect"] !== "string") return undefined;
	return {
		type: value["type"] as ProofType,
		target: value["target"],
		...(typeof value["expect"] === "string" ? { expect: value["expect"] } : {}),
	};
}

export function validateChecklist(value: unknown): Checklist {
	if (!isRecord(value)) throw new Error("checklist must be an item-to-proof map");
	const checklist: Checklist = {};
	for (const [item, criterion] of Object.entries(value)) {
		if (item.trim().length === 0) throw new Error("checklist item must not be empty");
		if (!isRecord(criterion) || !Array.isArray(criterion["proof"]) || criterion["proof"].length === 0) {
			throw new Error(`checklist item "${item}" requires at least one proof reference`);
		}
		const proof = criterion["proof"].map(proofReference);
		if (proof.some((reference) => reference === undefined)) {
			throw new Error(`checklist item "${item}" requires a typed, non-empty proof target`);
		}
		checklist[item] = { proof: proof as ProofReference[] };
	}
	return checklist;
}

export function checklistEntries(value: unknown): ChecklistEntry[] {
	if (Array.isArray(value)) {
		return value.flatMap((item) => typeof item === "string"
			? [{ item, proof: [], legacy: true }]
			: isRecord(item) && typeof item["title"] === "string"
				? [{ item: item["title"], proof: [], legacy: true }]
				: []);
	}
	if (!isRecord(value)) return [];
	return Object.entries(value).map(([item, criterion]) => {
		const references = isRecord(criterion) && Array.isArray(criterion["proof"])
			? criterion["proof"].map(proofReference).filter((proof): proof is ProofReference => proof !== undefined)
			: [];
		return { item, proof: references, legacy: false };
	});
}
