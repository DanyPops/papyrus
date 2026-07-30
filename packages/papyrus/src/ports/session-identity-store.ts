import type { SessionIdentityRecord, SessionIdentityStore as VehicleSessionIdentityStore } from "@danypops/vehicle-server/session-identity";

/**
 * Papyrus's persistence port for @danypops/vehicle-server's storage-agnostic session-identity
 * primitive -- re-exported under this project's own port naming convention (src/ports/*)
 * rather than importing the vehicle-server interface name directly at every call site.
 */
export type SessionIdentityStore = VehicleSessionIdentityStore;
export type { SessionIdentityRecord };
