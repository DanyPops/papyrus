/**
 * Bounded poll for a condition driven by fire-and-forget async work a test has no direct
 * promise handle for -- e.g. registerVehicleToolsWhenReady's own internal session_start
 * handler, which kicks off resolve+register without awaiting it (so a caller's own
 * session_start invocation returns long before registration actually completes).
 */
export async function waitFor(predicate: () => boolean, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 2_000;
	const intervalMs = options.intervalMs ?? 10;
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`waitFor: condition never became true within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
