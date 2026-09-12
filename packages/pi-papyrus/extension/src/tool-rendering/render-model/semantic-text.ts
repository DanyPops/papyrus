import { stripVTControlCharacters } from "node:util";
import { TOOL_DETAILS_BODY_MAX_CHARACTERS } from "@danypops/papyrus";
import { boundedText, PAPYRUS_TOOL_DETAILS_SCHEMA, type ResultCompleteness, type ToolDetailsBase } from "./shared.ts";

/** Carries an operation's bounded semantic text channel for human presentation. */
export interface SemanticTextToolDetails extends ToolDetailsBase {
	kind: "semantic-text";
	text: string;
	completeness: ResultCompleteness;
}

/** Preserves diagnostic text while removing terminal commands and normalizing line breaks and tabs. */
export function plainTerminalText(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/\r\n?/g, "\n")
		.replace(/\p{Cc}/gu, (character) => (character === "\n" ? "\n" : character === "\t" ? "    " : ""));
}

export function createSemanticTextDetails(operation: string, text: string): SemanticTextToolDetails {
	const bounded = boundedText(plainTerminalText(text), TOOL_DETAILS_BODY_MAX_CHARACTERS);
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "semantic-text",
		operation,
		text: bounded.value,
		completeness: bounded.completeness,
	};
}
