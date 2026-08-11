import { TOOL_DETAILS_MAX_ITEMS, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS } from "@danypops/papyrus";
import {
	completeness,
	isBoundedString,
	isRecord,
	PAPYRUS_TOOL_DETAILS_SCHEMA,
	type ResultCompleteness,
	type ToolDetailsBase,
} from "./shared.ts";

export interface ToolGateRow {
	passed: boolean;
	type: string;
	target: string;
	output: string;
}

export interface GateRunToolDetails extends ToolDetailsBase {
	kind: "gate-run";
	artifactId: string;
	artifactTitle: string;
	gates: ToolGateRow[];
	completeness: ResultCompleteness;
}

export function createGateRunDetails(
	operation: string,
	artifactId: string,
	artifactTitle: string,
	gates: readonly ToolGateRow[],
): GateRunToolDetails {
	const boundedGates = gates.slice(0, TOOL_DETAILS_MAX_ITEMS).map((gate) => ({
		...gate,
		output: gate.output.slice(0, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS),
	}));
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "gate-run",
		operation,
		artifactId,
		artifactTitle,
		gates: boundedGates,
		completeness: completeness(gates.length, boundedGates.length),
	};
}

export function isGateRow(value: unknown): value is ToolGateRow {
	return (
		isRecord(value) &&
		typeof value.passed === "boolean" &&
		isBoundedString(value.type) &&
		isBoundedString(value.target) &&
		isBoundedString(value.output, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS)
	);
}
