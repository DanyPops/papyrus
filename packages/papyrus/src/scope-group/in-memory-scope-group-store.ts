import { randomUUID } from "node:crypto";
import { SCOPE_GROUP_MAX_MEMBERS, SCOPE_GROUP_MAX_NESTING_DEPTH } from "../constants.ts";
import {
	assertRegisterScopeGroupInputBounds,
	type RegisterScopeGroupInput,
	type ScopeGroup,
	ScopeGroupInUseError,
	type ScopeMemberRef,
	sameScopeMember,
} from "./scope-group.ts";
import type { ScopeGroupStore } from "./scope-group-store.ts";

interface Row {
	group: ScopeGroup;
	members: ScopeMemberRef[];
}

export class InMemoryScopeGroupStore implements ScopeGroupStore {
	private readonly rows = new Map<string, Row>();

	groups(query: string | undefined, limit: number): ScopeGroup[] {
		const needle = query?.trim().toLowerCase();
		return [...this.rows.values()]
			.map((row) => row.group)
			.filter(
				(group) =>
					!needle || group.name.toLowerCase().includes(needle) || group.aliases.some((alias) => alias.toLowerCase().includes(needle)),
			)
			.sort((left, right) => left.name.localeCompare(right.name))
			.slice(0, limit);
	}

	matchingGroups(reference: string): ScopeGroup[] {
		const needle = reference.trim().toLowerCase();
		return [...this.rows.values()]
			.map((row) => row.group)
			.filter(
				(group) =>
					group.id.toLowerCase() === needle ||
					group.name.toLowerCase() === needle ||
					group.aliases.some((alias) => alias.toLowerCase() === needle),
			)
			.slice(0, 11);
	}

	get(id: string): ScopeGroup | undefined {
		return this.rows.get(id)?.group;
	}

	registerGroup(input: RegisterScopeGroupInput): ScopeGroup {
		assertRegisterScopeGroupInputBounds(input.name, input.aliases);
		const existing = input.existingId ? this.rows.get(input.existingId) : undefined;
		const now = new Date().toISOString();
		const name = input.name?.trim() || existing?.group.name || "unnamed-scope-group";
		const seen = new Set([name.toLowerCase()]);
		const aliases = [
			...(existing?.group.aliases ?? []),
			...(existing && existing.group.name !== name ? [existing.group.name] : []),
			...(input.aliases ?? []),
		].flatMap((value) => {
			const trimmed = value.trim();
			const key = trimmed.toLowerCase();
			if (!trimmed || seen.has(key)) return [];
			seen.add(key);
			return [trimmed];
		});
		const group: ScopeGroup = {
			id: existing?.group.id ?? randomUUID(),
			name,
			aliases,
			createdAt: existing?.group.createdAt ?? now,
			updatedAt: now,
		};
		this.rows.set(group.id, { group, members: existing?.members ?? [] });
		return group;
	}

	members(groupId: string): ScopeMemberRef[] {
		return [...(this.rows.get(groupId)?.members ?? [])];
	}

	private requireRow(groupId: string): Row {
		const row = this.rows.get(groupId);
		if (!row) throw new Error(`scope group "${groupId}" not found`);
		return row;
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
			for (const member of this.rows.get(current)?.members ?? []) {
				if (member.type === "group") stack.push(member.id);
			}
		}
		return false;
	}

	private depthOf(groupId: string, seen: Set<string> = new Set()): number {
		if (seen.has(groupId)) return 0;
		seen.add(groupId);
		const members = this.rows.get(groupId)?.members ?? [];
		let max = 0;
		for (const member of members) {
			if (member.type === "group") max = Math.max(max, 1 + this.depthOf(member.id, seen));
		}
		return max;
	}

	addMember(groupId: string, member: ScopeMemberRef): ScopeGroup {
		const row = this.requireRow(groupId);
		if (row.members.some((existing) => sameScopeMember(existing, member))) return row.group;
		if (row.members.length >= SCOPE_GROUP_MAX_MEMBERS)
			throw new Error(`a scope group cannot have more than ${SCOPE_GROUP_MAX_MEMBERS} members`);
		if (member.type === "group") {
			if (this.wouldCreateCycle(groupId, member.id))
				throw new Error(`adding "${member.id}" to "${groupId}" would create a scope group cycle`);
			if (1 + this.depthOf(member.id) > SCOPE_GROUP_MAX_NESTING_DEPTH) {
				throw new Error(`scope group nesting cannot exceed ${SCOPE_GROUP_MAX_NESTING_DEPTH} levels`);
			}
		}
		row.members.push(member);
		row.group = { ...row.group, updatedAt: new Date().toISOString() };
		return row.group;
	}

	removeMember(groupId: string, member: ScopeMemberRef): ScopeGroup {
		const row = this.requireRow(groupId);
		const next = row.members.filter((existing) => !sameScopeMember(existing, member));
		if (next.length !== row.members.length) {
			row.members = next;
			row.group = { ...row.group, updatedAt: new Date().toISOString() };
		}
		return row.group;
	}

	expandToProjectIds(groupId: string): Set<string> {
		const result = new Set<string>();
		const visited = new Set<string>();
		const stack = [groupId];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (visited.has(current)) continue;
			visited.add(current);
			for (const member of this.rows.get(current)?.members ?? []) {
				if (member.type === "project") result.add(member.id);
				else stack.push(member.id);
			}
		}
		return result;
	}

	/** Exposed for a caller (e.g. an ArtifactScopeStore checking whether a group it references still exists) needing raw existence, without going through a bounded search. */
	exists(groupId: string): boolean {
		return this.rows.has(groupId);
	}

	/** Only checks self-consistency (another group's own membership) -- whether any Doc/Rule/Playbook's own explicit scope still references this group is a cross-store concern the caller (deleteScopeGroup, which holds both stores) checks first. */
	delete(groupId: string): void {
		for (const [otherId, row] of this.rows) {
			if (otherId === groupId) continue;
			if (row.members.some((member) => member.type === "group" && member.id === groupId)) {
				throw new ScopeGroupInUseError(`scope group "${groupId}" is still a member of scope group "${otherId}"`);
			}
		}
		this.rows.delete(groupId);
	}
}
