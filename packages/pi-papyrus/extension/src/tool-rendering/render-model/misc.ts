import { TOOL_DETAILS_BODY_MAX_CHARACTERS, TOOL_DETAILS_FIELD_MAX_CHARACTERS } from "@danypops/papyrus";
import { boundedText, PAPYRUS_TOOL_DETAILS_SCHEMA, type ResultCompleteness, type ToolDetailsBase } from "./shared.ts";

export interface PreviewToolDetails extends ToolDetailsBase {
	kind: "preview";
	title: string;
	content: string;
	completeness: ResultCompleteness;
}

export function createPreviewDetails(operation: string, title: string, content: string): PreviewToolDetails {
	const bounded = boundedText(content, TOOL_DETAILS_BODY_MAX_CHARACTERS);
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "preview",
		operation,
		title,
		content: bounded.value,
		completeness: bounded.completeness,
	};
}

export interface ErrorToolDetails extends ToolDetailsBase {
	kind: "error";
	code: string;
	message: string;
}

export function createErrorDetails(operation: string, code: string, message: string): ErrorToolDetails {
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "error",
		operation,
		code: code.slice(0, TOOL_DETAILS_FIELD_MAX_CHARACTERS),
		message: message.slice(0, TOOL_DETAILS_BODY_MAX_CHARACTERS),
	};
}

export interface NoFocusToolDetails extends ToolDetailsBase {
	kind: "no-focus";
}

export function createNoFocusDetails(operation: string): NoFocusToolDetails {
	return { schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA, kind: "no-focus", operation };
}
