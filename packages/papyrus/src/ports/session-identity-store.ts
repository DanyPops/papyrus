import type { SessionIdentityRecord, SessionIdentityStore as DaemonKitSessionIdentityStore } from "@danypops/daemon-kit/session-identity";

/**
 * Papyrus's persistence port for @danypops/daemon-kit's storage-agnostic session-identity
 * primitive -- re-exported under this project's own port naming convention (src/ports/*)
 * rather than importing the daemon-kit interface name directly at every call site.
 */
export type SessionIdentityStore = DaemonKitSessionIdentityStore;
export type { SessionIdentityRecord };
