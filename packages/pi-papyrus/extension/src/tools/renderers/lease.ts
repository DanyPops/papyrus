import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { buildDetailLines, type DetailField, statelessComponent } from "malevich-tui-components";
import { detailViewTheme, measure } from "../../tool-rendering/artifact-card.ts";

/** tasks.claim/heartbeat_lease/release_lease/lease's own name-first view. Detected the same
 * name-independent, shape-based way as the others in this directory. */
export interface TaskLeaseViewOutput {
	taskName: string;
	taskTitle: string;
	owner: string;
	token: string;
	claimedAt: string;
	leaseExpiresAt: string;
	heartbeatAt?: string;
	note?: string;
}

export function isTaskLeaseView(value: unknown): value is TaskLeaseViewOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.taskName === "string" &&
		typeof row.taskTitle === "string" &&
		typeof row.owner === "string" &&
		typeof row.token === "string" &&
		typeof row.claimedAt === "string" &&
		typeof row.leaseExpiresAt === "string" &&
		(row.heartbeatAt === undefined || typeof row.heartbeatAt === "string") &&
		(row.note === undefined || typeof row.note === "string")
	);
}

/** Renders a lease's own safe fields -- never the raw token, which the model channel (not this persisted, human-facing one) carries for a later heartbeat/release call. */
export function renderLease(
	lease: {
		taskName: string;
		taskTitle: string;
		owner: string;
		claimedAt: string;
		leaseExpiresAt: string;
		heartbeatAt?: string;
		note?: string;
	},
	theme: Theme,
): Component {
	return statelessComponent((width) => {
		const fields: DetailField[] = [
			{ label: "Task", value: `${lease.taskName} \u2014 ${lease.taskTitle}` },
			{ label: "Owner", value: lease.owner },
			{ label: "Expires", value: lease.leaseExpiresAt },
			...(lease.heartbeatAt ? [{ label: "Last heartbeat", value: lease.heartbeatAt }] : []),
			...(lease.note ? [{ label: "Note", value: lease.note }] : []),
		];
		return buildDetailLines(Math.max(1, width), { fields, alignFields: true, theme: detailViewTheme(theme), measure });
	});
}
