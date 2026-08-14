import { randomUUID } from "node:crypto";
import { SCOPE_GROUP_MAX_MEMBERS, SCOPE_GROUP_MAX_NESTING_DEPTH } from "../constants.ts";
import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import {
	assertRegisterScopeGroupInputBounds,
	type RegisterScopeGroupInput,
	type ScopeGroup,
	ScopeGroupInUseError,
	type ScopeMemberRef,
} from "./scope-group.ts";
import type { ScopeGroupStore } from "./scope-group-store.ts";

interface GroupRow {
	id: string;
	name: string;
	aliases_json: string;
	created_at: string;
	updated_at: string;
}

function groupFromRow(row: GroupRow): ScopeGroup {
	return {
		id: row.id,
		name: row.name,
		aliases: JSON.parse(row.aliases_json) as string[],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

interface MemberRow {
	member_type: "project" | "group";
	member_id: string;
}

function memberFromRow(row: MemberRow): ScopeMemberRef {
	return row.member_type === "project" ? { type: "project", id: row.member_id } : { type: "group", id: row.member_id };
}

export class SQLiteScopeGroupStore implements ScopeGroupStore {
	constructor(private readonly db: Db) {}

	groups(query: string | undefined, limit: number): ScopeGroup[] {
		const needle = query?.trim().toLowerCase();
		if (!needle) {
			return (
				this.db
					.prepare("SELECT id, name, aliases_json, created_at, updated_at FROM scope_groups ORDER BY name LIMIT ?")
					.all(limit) as GroupRow[]
			).map(groupFromRow);
		}
		return (
			this.db
				.prepare(`
					SELECT id, name, aliases_json, created_at, updated_at FROM scope_groups
					WHERE instr(lower(name), ?) > 0
						OR EXISTS (SELECT 1 FROM json_each(scope_groups.aliases_json) WHERE instr(lower(CAST(json_each.value AS TEXT)), ?) > 0)
					ORDER BY name LIMIT ?
				`)
				.all(needle, needle, limit) as GroupRow[]
		).map(groupFromRow);
	}

	matchingGroups(reference: string): ScopeGroup[] {
		const needle = reference.trim().toLowerCase();
		return (
			this.db
				.prepare(`
					SELECT id, name, aliases_json, created_at, updated_at FROM scope_groups
					WHERE lower(id) = ? OR lower(name) = ?
						OR EXISTS (SELECT 1 FROM json_each(scope_groups.aliases_json) WHERE lower(CAST(json_each.value AS TEXT)) = ?)
					LIMIT 11
				`)
				.all(needle, needle, needle) as GroupRow[]
		).map(groupFromRow);
	}

	get(id: string): ScopeGroup | undefined {
		const row = this.db
			.prepare("SELECT id, name, aliases_json, created_at, updated_at FROM scope_groups WHERE id = ?")
			.get(id) as GroupRow | null;
		return row ? groupFromRow(row) : undefined;
	}

	registerGroup(input: RegisterScopeGroupInput): ScopeGroup {
		assertRegisterScopeGroupInputBounds(input.name, input.aliases);
		return inTransaction(this.db, () => {
			const existingRow = input.existingId
				? (this.db
						.prepare("SELECT id, name, aliases_json, created_at, updated_at FROM scope_groups WHERE id = ?")
						.get(input.existingId) as GroupRow | null)
				: null;
			const existing = existingRow ? groupFromRow(existingRow) : undefined;
			const now = new Date().toISOString();
			const name = input.name?.trim() || existing?.name || "unnamed-scope-group";
			const seen = new Set([name.toLowerCase()]);
			const aliases = [
				...(existing?.aliases ?? []),
				...(existing && existing.name !== name ? [existing.name] : []),
				...(input.aliases ?? []),
			].flatMap((value) => {
				const trimmed = value.trim();
				const key = trimmed.toLowerCase();
				if (!trimmed || seen.has(key)) return [];
				seen.add(key);
				return [trimmed];
			});
			const group: ScopeGroup = { id: existing?.id ?? randomUUID(), name, aliases, createdAt: existing?.createdAt ?? now, updatedAt: now };
			this.db
				.prepare(`
					INSERT INTO scope_groups (id, name, aliases_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET name = excluded.name, aliases_json = excluded.aliases_json, updated_at = excluded.updated_at
				`)
				.run(group.id, group.name, JSON.stringify(group.aliases), group.createdAt, group.updatedAt);
			return group;
		});
	}

	members(groupId: string): ScopeMemberRef[] {
		return (
			this.db
				.prepare("SELECT member_type, member_id FROM scope_group_members WHERE group_id = ? ORDER BY member_type, member_id")
				.all(groupId) as MemberRow[]
		).map(memberFromRow);
	}

	private childGroupIds(groupId: string): string[] {
		return (
			this.db.prepare("SELECT member_id FROM scope_group_members WHERE group_id = ? AND member_type = 'group'").all(groupId) as Array<{
				member_id: string;
			}>
		).map((row) => row.member_id);
	}

	wouldCreateCycle(groupId: string, candidateMemberGroupId: string): boolean {
		if (groupId === candidateMemberGroupId) return true;
		const visited = new Set<string>();
		const stack = [candidateMemberGroupId];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (current === groupId) return true;
			if (visited.has(current)) continue;
			visited.add(current);
			for (const childId of this.childGroupIds(current)) stack.push(childId);
		}
		return false;
	}

	private depthOf(groupId: string, seen: Set<string> = new Set()): number {
		if (seen.has(groupId)) return 0;
		seen.add(groupId);
		let max = 0;
		for (const childId of this.childGroupIds(groupId)) max = Math.max(max, 1 + this.depthOf(childId, seen));
		return max;
	}

	addMember(groupId: string, member: ScopeMemberRef): ScopeGroup {
		return inTransaction(this.db, () => {
			const group = this.get(groupId);
			if (!group) throw new Error(`scope group "${groupId}" not found`);
			const already = this.db
				.prepare("SELECT 1 FROM scope_group_members WHERE group_id = ? AND member_type = ? AND member_id = ?")
				.get(groupId, member.type, member.id);
			if (already) return group;
			const count = (this.db.prepare("SELECT COUNT(*) AS n FROM scope_group_members WHERE group_id = ?").get(groupId) as { n: number }).n;
			if (count >= SCOPE_GROUP_MAX_MEMBERS) throw new Error(`a scope group cannot have more than ${SCOPE_GROUP_MAX_MEMBERS} members`);
			if (member.type === "group") {
				if (this.wouldCreateCycle(groupId, member.id))
					throw new Error(`adding "${member.id}" to "${groupId}" would create a scope group cycle`);
				if (1 + this.depthOf(member.id) > SCOPE_GROUP_MAX_NESTING_DEPTH) {
					throw new Error(`scope group nesting cannot exceed ${SCOPE_GROUP_MAX_NESTING_DEPTH} levels`);
				}
			}
			this.db
				.prepare("INSERT INTO scope_group_members (group_id, member_type, member_id) VALUES (?, ?, ?)")
				.run(groupId, member.type, member.id);
			this.db.prepare("UPDATE scope_groups SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), groupId);
			return this.get(groupId)!;
		});
	}

	removeMember(groupId: string, member: ScopeMemberRef): ScopeGroup {
		return inTransaction(this.db, () => {
			const group = this.get(groupId);
			if (!group) throw new Error(`scope group "${groupId}" not found`);
			const result = this.db
				.prepare("DELETE FROM scope_group_members WHERE group_id = ? AND member_type = ? AND member_id = ?")
				.run(groupId, member.type, member.id);
			if (result.changes > 0) this.db.prepare("UPDATE scope_groups SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), groupId);
			return this.get(groupId)!;
		});
	}

	expandToProjectIds(groupId: string): Set<string> {
		const result = new Set<string>();
		const visited = new Set<string>();
		const stack = [groupId];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (visited.has(current)) continue;
			visited.add(current);
			for (const member of this.members(current)) {
				if (member.type === "project") result.add(member.id);
				else stack.push(member.id);
			}
		}
		return result;
	}

	/** Only checks self-consistency (another group's own membership) -- whether any Doc/Rule/Playbook's own explicit scope still references this group is a cross-store concern the caller (deleteScopeGroup, which holds both stores) checks first. */
	delete(groupId: string): void {
		inTransaction(this.db, () => {
			const referencingGroup = this.db
				.prepare("SELECT group_id FROM scope_group_members WHERE member_type = 'group' AND member_id = ? LIMIT 1")
				.get(groupId) as { group_id: string } | null;
			if (referencingGroup)
				throw new ScopeGroupInUseError(`scope group "${groupId}" is still a member of scope group "${referencingGroup.group_id}"`);
			this.db.prepare("DELETE FROM scope_group_members WHERE group_id = ?").run(groupId);
			this.db.prepare("DELETE FROM scope_groups WHERE id = ?").run(groupId);
		});
	}
}
