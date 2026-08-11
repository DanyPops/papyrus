import { TOOL_DETAILS_FIELD_MAX_CHARACTERS } from "@danypops/papyrus";
import { PAPYRUS_TOOL_DETAILS_SCHEMA, type ToolDetailsBase } from "./shared.ts";

/** tasks.claim/heartbeat_lease/release_lease/lease's own name-first view -- deliberately never carries the raw lease token; the model channel (which needs the real token for a later heartbeat/release call) is a separate, independent channel from this persisted, human-facing one. */
export interface LeaseToolDetails extends ToolDetailsBase {
	kind: "lease";
	taskName: string;
	taskTitle: string;
	owner: string;
	claimedAt: string;
	leaseExpiresAt: string;
	heartbeatAt?: string;
	note?: string;
}

export function createLeaseDetails(
	operation: string,
	lease: {
		taskName: string;
		taskTitle: string;
		owner: string;
		claimedAt: string;
		leaseExpiresAt: string;
		heartbeatAt?: string;
		note?: string;
	},
): LeaseToolDetails {
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "lease",
		operation,
		taskName: lease.taskName,
		taskTitle: lease.taskTitle,
		owner: lease.owner,
		claimedAt: lease.claimedAt,
		leaseExpiresAt: lease.leaseExpiresAt,
		...(lease.heartbeatAt ? { heartbeatAt: lease.heartbeatAt } : {}),
		...(lease.note ? { note: lease.note.slice(0, TOOL_DETAILS_FIELD_MAX_CHARACTERS) } : {}),
	};
}
