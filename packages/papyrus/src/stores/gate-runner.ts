import type { GateResult, GateRunOptions } from "../domain/gate.ts";

export interface GateRunner {
	run(artifactId: string, options?: GateRunOptions): GateResult[];
	runAsync(artifactId: string, options?: GateRunOptions): Promise<GateResult[]>;
}
