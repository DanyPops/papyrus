import {
	DISCOURSE_CONTENT_MAX_BYTES,
	DISCOURSE_EVENT_RETENTION_DEFAULT,
	DISCOURSE_EVENT_RETENTION_MAX,
	DISCOURSE_QUERY_MAX_LIMIT,
} from "../constants.ts";

/** Papyrus-owned Doc subtypes reserved for the Discourse persistence adapter. */
export const DISCOURSE_THREAD_SUBTYPE = "context-thread";
export const DISCOURSE_MESSAGE_SUBTYPE = "context-message";
export const DISCOURSE_RELATIONS = new Set(["reply_to", "discusses"]);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export interface ArtifactReference { kind: string; id: string }
export interface ThreadAddress { forumId: string; topicId: string; threadId: string }
export interface AppendPostCommand extends ThreadAddress {
	schemaVersion: "discourse.command.v1";
	operationId: string;
	authorId: string;
	content: JsonValue;
	correlationId?: string;
	causationId?: string;
	replyToPostId?: string;
	references?: ArtifactReference[];
}
export interface Post extends ThreadAddress {
	id: string;
	authorId: string;
	content: JsonValue;
	timestamp: number;
	sequence: number;
	operationId: string;
	correlationId?: string;
	causationId?: string;
	replyToPostId?: string;
	references: ArtifactReference[];
}
export type DiscourseEventType = "post-added" | "thread-changed" | "question-opened" | "question-answered" | "subscription-resync-required";
export interface DiscourseEvent extends ThreadAddress {
	schemaVersion: "discourse.event.v1";
	type: DiscourseEventType;
	sequence: number;
	timestamp: number;
	postId?: string;
	operationId?: string;
	correlationId?: string;
	causationId?: string;
	responseId?: string;
	retainedFromSequence?: number;
}
export interface Page<T> {
	items: T[];
	truncated: boolean;
	nextSequence?: number;
	completeness: "complete" | "truncated";
}
export interface TopicSummary { forumId: string; topicId: string; threadCount: number; postCount: number; lastActivity: number }
export interface ThreadSummary extends ThreadAddress { postCount: number; participantIds: string[]; lastActivity: number }
export interface OpenQuestion { responseId: string; post: Post }
export interface ProjectionRecord { sequence: number; post: Post }

export function isDiscourseSubtype(subtype: string | undefined): boolean {
	return subtype === DISCOURSE_THREAD_SUBTYPE || subtype === DISCOURSE_MESSAGE_SUBTYPE;
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

export function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
	return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
	return value;
}

export function nonNegativeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative safe integer`);
	return value as number;
}

export function queryLimit(value: unknown): number {
	const limit = nonNegativeInteger(value, "limit");
	if (limit < 1 || limit > DISCOURSE_QUERY_MAX_LIMIT) throw new Error(`limit must be between 1 and ${DISCOURSE_QUERY_MAX_LIMIT}`);
	return limit;
}

export function eventRetention(value: unknown): number {
	if (value === undefined) return DISCOURSE_EVENT_RETENTION_DEFAULT;
	const retention = nonNegativeInteger(value, "event_retention");
	if (retention < 1 || retention > DISCOURSE_EVENT_RETENTION_MAX) {
		throw new Error(`event_retention must be between 1 and ${DISCOURSE_EVENT_RETENTION_MAX}`);
	}
	return retention;
}

function jsonValue(value: unknown, name: string): JsonValue {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error(`${name} must be JSON-serializable`);
	if (new TextEncoder().encode(encoded).byteLength > DISCOURSE_CONTENT_MAX_BYTES) {
		throw new Error(`${name} cannot exceed ${DISCOURSE_CONTENT_MAX_BYTES} bytes`);
	}
	return JSON.parse(encoded) as JsonValue;
}

export function appendCommand(value: unknown): AppendPostCommand {
	const input = record(value, "command");
	if (input["schemaVersion"] !== "discourse.command.v1") throw new Error("unsupported Discourse command schema");
	const referencesValue = input["references"] ?? [];
	if (!Array.isArray(referencesValue)) throw new Error("references must be an array");
	const references = referencesValue.map((entry, index) => {
		const reference = record(entry, `references[${index}]`);
		return { kind: requiredString(reference["kind"], `references[${index}].kind`), id: requiredString(reference["id"], `references[${index}].id`) };
	});
	return {
		schemaVersion: "discourse.command.v1",
		operationId: requiredString(input["operationId"], "operationId"),
		forumId: requiredString(input["forumId"], "forumId"),
		topicId: requiredString(input["topicId"], "topicId"),
		threadId: requiredString(input["threadId"], "threadId"),
		authorId: requiredString(input["authorId"], "authorId"),
		content: jsonValue(input["content"], "content"),
		...(optionalString(input["correlationId"], "correlationId") ? { correlationId: input["correlationId"] as string } : {}),
		...(optionalString(input["causationId"], "causationId") ? { causationId: input["causationId"] as string } : {}),
		...(optionalString(input["replyToPostId"], "replyToPostId") ? { replyToPostId: input["replyToPostId"] as string } : {}),
		references,
	};
}

export function threadAddress(value: Record<string, unknown>): ThreadAddress {
	return {
		forumId: requiredString(value["forumId"], "forumId"),
		topicId: requiredString(value["topicId"], "topicId"),
		threadId: requiredString(value["threadId"], "threadId"),
	};
}
