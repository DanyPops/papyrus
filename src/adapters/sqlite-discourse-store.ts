import { DISCOURSE_PARTICIPANT_MAX_COUNT } from "../constants.ts";
import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import {
	appendCommand,
	DISCOURSE_MESSAGE_SUBTYPE,
	DISCOURSE_THREAD_SUBTYPE,
	eventRetention,
	nonNegativeInteger,
	optionalString,
	queryLimit,
	requiredString,
	threadAddress,
	type AppendPostCommand,
	type DiscourseEvent,
	type DiscourseEventType,
	type JsonValue,
	type OpenQuestion,
	type Page,
	type Post,
	type ProjectionRecord,
	type ThreadSummary,
	type TopicSummary,
} from "../domain/discourse-store.ts";
import type { AtomicArtifactStore } from "../ports/atomic-artifact-store.ts";

interface QuestionColumns {
	questionType?: "question" | "answer";
	responseId?: string;
	targetId?: string;
}

type Row = Record<string, unknown>;

function rowString(row: Row, name: string): string {
	const value = row[name];
	if (typeof value !== "string") throw new Error(`invalid persisted ${name}`);
	return value;
}

function rowOptionalString(row: Row, name: string): string | undefined {
	const value = row[name];
	return typeof value === "string" ? value : undefined;
}

function rowNumber(row: Row, name: string): number {
	const value = Number(row[name]);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid persisted ${name}`);
	return value;
}

function parseJson<T>(row: Row, name: string): T {
	return JSON.parse(rowString(row, name)) as T;
}

function postFromRow(row: Row): Post {
	return {
		id: rowString(row, "id"),
		sequence: rowNumber(row, "sequence"),
		operationId: rowString(row, "operation_id"),
		forumId: rowString(row, "forum_id"),
		topicId: rowString(row, "topic_id"),
		threadId: rowString(row, "thread_id"),
		authorId: rowString(row, "author_id"),
		content: parseJson<JsonValue>(row, "content_json"),
		timestamp: rowNumber(row, "timestamp"),
		references: parseJson(row, "references_json"),
		...(rowOptionalString(row, "correlation_id") ? { correlationId: rowString(row, "correlation_id") } : {}),
		...(rowOptionalString(row, "causation_id") ? { causationId: rowString(row, "causation_id") } : {}),
		...(rowOptionalString(row, "reply_to_post_id") ? { replyToPostId: rowString(row, "reply_to_post_id") } : {}),
	};
}

function page<T>(items: T[], limit: number, sequenceOf?: (item: T) => number): Page<T> {
	const truncated = items.length > limit;
	const selected = items.slice(0, limit);
	const last = selected.at(-1);
	return {
		items: selected,
		truncated,
		completeness: truncated ? "truncated" : "complete",
		...(truncated && last !== undefined && sequenceOf ? { nextSequence: sequenceOf(last) } : {}),
	};
}

function questionColumns(content: JsonValue): QuestionColumns {
	if (typeof content !== "object" || content === null || Array.isArray(content)) return {};
	const type = content["type"];
	const responseId = content["responseId"];
	const targetId = content["targetId"];
	if ((type !== "question" && type !== "answer") || typeof responseId !== "string" || responseId.length === 0) return {};
	return { questionType: type, responseId, ...(typeof targetId === "string" && targetId.length > 0 ? { targetId } : {}) };
}

function eventsFor(command: AppendPostCommand, postId: string, timestamp: number, firstSequence: number): DiscourseEvent[] {
	const question = questionColumns(command.content);
	const metadata: Array<{ type: DiscourseEventType; responseId?: string }> = [
		{ type: "post-added" },
		{ type: "thread-changed" },
	];
	if (question.questionType) {
		metadata.push({
			type: question.questionType === "question" ? "question-opened" : "question-answered",
			responseId: question.responseId,
		});
	}
	return metadata.map((event, index) => ({
		schemaVersion: "discourse.event.v1",
		type: event.type,
		sequence: firstSequence + index,
		timestamp,
		forumId: command.forumId,
		topicId: command.topicId,
		threadId: command.threadId,
		postId,
		operationId: command.operationId,
		...(command.correlationId ? { correlationId: command.correlationId } : {}),
		...(command.causationId ? { causationId: command.causationId } : {}),
		...(event.responseId ? { responseId: event.responseId } : {}),
	}));
}

function bodyFor(content: JsonValue): string {
	return typeof content === "string" ? content : JSON.stringify(content, null, 2);
}

/** Durable graph adapter used only behind the Discourse application mutation boundary. */
export class SQLiteDiscourseStore {
	constructor(private readonly db: Db, private readonly artifacts: AtomicArtifactStore) {}

	execute(input: Record<string, unknown>): unknown {
		const action = requiredString(input["action"], "action");
		const storeId = requiredString(input["store_id"], "store_id");
		switch (action) {
			case "append":
				return this.append(
					storeId,
					appendCommand(input["command"]),
					requiredString(input["post_id"], "post_id"),
					nonNegativeInteger(input["timestamp"], "timestamp"),
					eventRetention(input["event_retention"]),
				);
			case "read_thread":
				return this.readThread(storeId, input);
			case "list_topics":
				return this.listTopics(storeId, requiredString(input["forumId"], "forumId"), queryLimit(input["limit"]));
			case "list_threads":
				return this.listThreads(storeId, requiredString(input["forumId"], "forumId"), requiredString(input["topicId"], "topicId"), queryLimit(input["limit"]));
			case "open_questions":
				return this.openQuestions(storeId, optionalString(input["forumId"], "forumId"), optionalString(input["targetId"], "targetId"), queryLimit(input["limit"]));
			case "replay":
				return this.replay(storeId, nonNegativeInteger(input["after_sequence"], "after_sequence"), queryLimit(input["limit"]));
			case "snapshot":
				return this.snapshot(storeId, input);
			case "acknowledge":
				return this.acknowledge(storeId, requiredString(input["consumer_id"], "consumer_id"), nonNegativeInteger(input["sequence"], "sequence"));
			case "consumer_cursor":
				return this.cursor("discourse_cursors", "consumer_id", storeId, requiredString(input["consumer_id"], "consumer_id"));
			case "read_projection_outbox":
				return this.projectionOutbox(storeId, requiredString(input["projection_id"], "projection_id"), queryLimit(input["limit"]));
			case "acknowledge_projection":
				this.acknowledgeProjection(storeId, requiredString(input["projection_id"], "projection_id"), nonNegativeInteger(input["sequence"], "sequence"));
				return { ok: true };
			case "projection_checkpoint":
				return this.cursor("discourse_projection_cursors", "projection_id", storeId, requiredString(input["projection_id"], "projection_id"));
			case "projection_pending":
				return this.projectionPending(storeId, requiredString(input["projection_id"], "projection_id"));
			case "latest_post_sequence":
				return this.maximum(storeId, "discourse_posts");
			default:
				throw new Error(`unknown discourse store action "${action}"`);
		}
	}

	private append(storeId: string, command: AppendPostCommand, postId: string, timestamp: number, retention: number): { post: Post; replayed: boolean; events: DiscourseEvent[] } {
		return inTransaction(this.db, () => {
			const prior = this.db.prepare("SELECT * FROM discourse_posts WHERE store_id = ? AND operation_id = ?").get(storeId, command.operationId) as Row | null;
			const commandJson = JSON.stringify(command);
			if (prior) {
				if (rowString(prior, "command_json") !== commandJson) throw new Error(`operation conflict: ${command.operationId}`);
				return { post: postFromRow(prior), replayed: true, events: [] };
			}
			for (const reference of command.references ?? []) {
				const artifact = this.artifacts.get(reference.id);
				if (!artifact || artifact.kind !== reference.kind) throw new Error(`artifact reference not verified: ${reference.kind}:${reference.id}`);
			}
			let replyArtifactId: string | undefined;
			if (command.replyToPostId) {
				const parent = this.db.prepare("SELECT forum_id, topic_id, thread_id, artifact_id FROM discourse_posts WHERE store_id = ? AND id = ?").get(storeId, command.replyToPostId) as Row | null;
				if (!parent) throw new Error(`reply target not found: ${command.replyToPostId}`);
				if (rowString(parent, "forum_id") !== command.forumId || rowString(parent, "topic_id") !== command.topicId || rowString(parent, "thread_id") !== command.threadId) {
					throw new Error("reply target must belong to the same thread");
				}
				replyArtifactId = rowString(parent, "artifact_id");
			}
			const firstSequence = this.maximum(storeId, "discourse_events") + 1;
			const events = eventsFor(command, postId, timestamp, firstSequence);
			const threadArtifactId = this.ensureThread(storeId, command);
			const message = this.artifacts.create({
				kind: "doc",
				title: `${command.authorId} · ${command.threadId} · ${firstSequence}`,
				status: "active",
				subtype: DISCOURSE_MESSAGE_SUBTYPE,
				body: bodyFor(command.content),
				extra: {
					storeId, postId, sequence: firstSequence, operationId: command.operationId,
					forumId: command.forumId, topicId: command.topicId, threadId: command.threadId,
					authorId: command.authorId, timestamp,
				},
			});
			const question = questionColumns(command.content);
			this.db.prepare(`INSERT INTO discourse_posts (
				store_id, sequence, id, artifact_id, operation_id, command_json, forum_id, topic_id, thread_id,
				author_id, content_json, timestamp, correlation_id, causation_id, reply_to_post_id, references_json,
				question_type, response_id, target_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				storeId, firstSequence, postId, message.id, command.operationId, commandJson,
				command.forumId, command.topicId, command.threadId, command.authorId, JSON.stringify(command.content), timestamp,
				command.correlationId ?? null, command.causationId ?? null, command.replyToPostId ?? null,
				JSON.stringify(command.references ?? []), question.questionType ?? null, question.responseId ?? null, question.targetId ?? null,
			);
			this.artifacts.link({ from: threadArtifactId, relation: "contains", to: message.id });
			this.artifacts.link({ from: message.id, relation: "part_of", to: threadArtifactId });
			if (replyArtifactId) this.artifacts.link({ from: message.id, relation: "reply_to", to: replyArtifactId });
			for (const reference of command.references ?? []) this.artifacts.link({ from: message.id, relation: "discusses", to: reference.id });
			for (const event of events) {
				this.db.prepare("INSERT INTO discourse_events (store_id, sequence, event_json) VALUES (?, ?, ?)").run(storeId, event.sequence, JSON.stringify(event));
			}
			const latest = events.at(-1);
			if (!latest) throw new Error("append produced no events");
			this.db.prepare("DELETE FROM discourse_events WHERE store_id = ? AND sequence <= ?").run(storeId, latest.sequence - retention);
			return { post: postFromRow(this.db.prepare("SELECT * FROM discourse_posts WHERE store_id = ? AND id = ?").get(storeId, postId) as Row), replayed: false, events };
		});
	}

	private ensureThread(storeId: string, address: AppendPostCommand): string {
		const existing = this.db.prepare("SELECT artifact_id FROM discourse_threads WHERE store_id = ? AND forum_id = ? AND topic_id = ? AND thread_id = ?").get(storeId, address.forumId, address.topicId, address.threadId) as Row | null;
		if (existing) return rowString(existing, "artifact_id");
		const thread = this.artifacts.create({
			kind: "doc", title: address.threadId, status: "active", subtype: DISCOURSE_THREAD_SUBTYPE,
			extra: { storeId, forumId: address.forumId, topicId: address.topicId, threadId: address.threadId },
		});
		this.db.prepare("INSERT INTO discourse_threads (store_id, forum_id, topic_id, thread_id, artifact_id) VALUES (?, ?, ?, ?, ?)").run(storeId, address.forumId, address.topicId, address.threadId, thread.id);
		return thread.id;
	}

	private readThread(storeId: string, input: Record<string, unknown>): Page<Post> {
		const address = threadAddress(input);
		const limit = queryLimit(input["limit"]);
		const after = input["afterSequence"] === undefined ? 0 : nonNegativeInteger(input["afterSequence"], "afterSequence");
		const rows = this.db.prepare("SELECT * FROM discourse_posts WHERE store_id = ? AND forum_id = ? AND topic_id = ? AND thread_id = ? AND sequence > ? ORDER BY sequence LIMIT ?").all(storeId, address.forumId, address.topicId, address.threadId, after, limit + 1) as Row[];
		return page(rows.map(postFromRow), limit, (post) => post.sequence);
	}

	private listTopics(storeId: string, forumId: string, limit: number): Page<TopicSummary> {
		const rows = this.db.prepare("SELECT forum_id, topic_id, COUNT(DISTINCT thread_id) AS thread_count, COUNT(*) AS post_count, MAX(timestamp) AS last_activity FROM discourse_posts WHERE store_id = ? AND forum_id = ? GROUP BY forum_id, topic_id ORDER BY topic_id LIMIT ?").all(storeId, forumId, limit + 1) as Row[];
		return page(rows.map((row) => ({ forumId: rowString(row, "forum_id"), topicId: rowString(row, "topic_id"), threadCount: rowNumber(row, "thread_count"), postCount: rowNumber(row, "post_count"), lastActivity: rowNumber(row, "last_activity") })), limit);
	}

	private listThreads(storeId: string, forumId: string, topicId: string, limit: number): Page<ThreadSummary> {
		const rows = this.db.prepare("SELECT forum_id, topic_id, thread_id, COUNT(*) AS post_count, MAX(timestamp) AS last_activity FROM discourse_posts WHERE store_id = ? AND forum_id = ? AND topic_id = ? GROUP BY forum_id, topic_id, thread_id ORDER BY thread_id LIMIT ?").all(storeId, forumId, topicId, limit + 1) as Row[];
		return page(rows.map((row) => {
			const threadId = rowString(row, "thread_id");
			const participants = this.db.prepare("SELECT DISTINCT author_id FROM discourse_posts WHERE store_id = ? AND forum_id = ? AND topic_id = ? AND thread_id = ? ORDER BY author_id LIMIT ?").all(storeId, forumId, topicId, threadId, DISCOURSE_PARTICIPANT_MAX_COUNT) as Row[];
			return { forumId, topicId, threadId, postCount: rowNumber(row, "post_count"), participantIds: participants.map((entry) => rowString(entry, "author_id")), lastActivity: rowNumber(row, "last_activity") };
		}), limit);
	}

	private openQuestions(storeId: string, forumId: string | undefined, targetId: string | undefined, limit: number): Page<OpenQuestion> {
		const rows = this.db.prepare("SELECT p.* FROM discourse_posts p WHERE p.store_id = ? AND p.question_type = 'question' AND (? IS NULL OR p.forum_id = ?) AND (? IS NULL OR p.target_id IS NULL OR p.target_id = ?) AND NOT EXISTS (SELECT 1 FROM discourse_posts a WHERE a.store_id = p.store_id AND a.question_type = 'answer' AND a.response_id = p.response_id) ORDER BY p.sequence LIMIT ?").all(storeId, forumId ?? null, forumId ?? null, targetId ?? null, targetId ?? null, limit + 1) as Row[];
		return page(rows.map((row) => ({ responseId: rowString(row, "response_id"), post: postFromRow(row) })), limit, (question) => question.post.sequence);
	}

	private replay(storeId: string, afterSequence: number, limit: number): { events: DiscourseEvent[]; retainedFromSequence: number; latestSequence: number; expired: boolean; truncated: boolean } {
		const bounds = this.db.prepare("SELECT COALESCE(MIN(sequence), 0) AS minimum, COALESCE(MAX(sequence), 0) AS maximum FROM discourse_events WHERE store_id = ?").get(storeId) as Row;
		const retainedFromSequence = rowNumber(bounds, "minimum");
		const latestSequence = rowNumber(bounds, "maximum");
		const expired = retainedFromSequence > 0 && afterSequence > 0 && afterSequence < retainedFromSequence - 1;
		const rows = expired ? [] : this.db.prepare("SELECT event_json FROM discourse_events WHERE store_id = ? AND sequence > ? ORDER BY sequence LIMIT ?").all(storeId, afterSequence, limit + 1) as Row[];
		const events = rows.map((row) => parseJson<DiscourseEvent>(row, "event_json"));
		return { events: events.slice(0, limit), retainedFromSequence, latestSequence, expired, truncated: events.length > limit };
	}

	private snapshot(storeId: string, input: Record<string, unknown>): { posts: Page<Post>; throughSequence: number } {
		const limit = queryLimit(input["limit"]);
		const after = input["afterSequence"] === undefined ? 0 : nonNegativeInteger(input["afterSequence"], "afterSequence");
		const forumId = optionalString(input["forumId"], "forumId");
		const rows = this.db.prepare("SELECT * FROM discourse_posts WHERE store_id = ? AND sequence > ? AND (? IS NULL OR forum_id = ?) ORDER BY sequence LIMIT ?").all(storeId, after, forumId ?? null, forumId ?? null, limit + 1) as Row[];
		return { posts: page(rows.map(postFromRow), limit, (post) => post.sequence), throughSequence: this.maximum(storeId, "discourse_events") };
	}

	private acknowledge(storeId: string, consumerId: string, sequence: number): number {
		const latest = this.maximum(storeId, "discourse_events");
		if (sequence > latest) throw new Error(`cannot acknowledge future sequence ${sequence}`);
		this.db.prepare("INSERT INTO discourse_cursors (store_id, consumer_id, sequence) VALUES (?, ?, ?) ON CONFLICT(store_id, consumer_id) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)").run(storeId, consumerId, sequence);
		return this.cursor("discourse_cursors", "consumer_id", storeId, consumerId);
	}

	private projectionOutbox(storeId: string, projectionId: string, limit: number): ProjectionRecord[] {
		const checkpoint = this.cursor("discourse_projection_cursors", "projection_id", storeId, projectionId);
		return (this.db.prepare("SELECT * FROM discourse_posts WHERE store_id = ? AND sequence > ? ORDER BY sequence LIMIT ?").all(storeId, checkpoint, limit) as Row[]).map((row) => {
			const post = postFromRow(row);
			return { sequence: post.sequence, post };
		});
	}

	private acknowledgeProjection(storeId: string, projectionId: string, sequence: number): void {
		if (sequence > this.maximum(storeId, "discourse_posts")) throw new Error(`cannot acknowledge future projection sequence ${sequence}`);
		this.db.prepare("INSERT INTO discourse_projection_cursors (store_id, projection_id, sequence) VALUES (?, ?, ?) ON CONFLICT(store_id, projection_id) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)").run(storeId, projectionId, sequence);
	}

	private projectionPending(storeId: string, projectionId: string): number {
		const checkpoint = this.cursor("discourse_projection_cursors", "projection_id", storeId, projectionId);
		return rowNumber(this.db.prepare("SELECT COUNT(*) AS value FROM discourse_posts WHERE store_id = ? AND sequence > ?").get(storeId, checkpoint) as Row, "value");
	}

	private cursor(table: "discourse_cursors" | "discourse_projection_cursors", column: "consumer_id" | "projection_id", storeId: string, id: string): number {
		const row = this.db.prepare(`SELECT sequence FROM ${table} WHERE store_id = ? AND ${column} = ?`).get(storeId, id) as Row | null;
		return row ? rowNumber(row, "sequence") : 0;
	}

	private maximum(storeId: string, table: "discourse_events" | "discourse_posts"): number {
		return rowNumber(this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) AS value FROM ${table} WHERE store_id = ?`).get(storeId) as Row, "value");
	}
}
