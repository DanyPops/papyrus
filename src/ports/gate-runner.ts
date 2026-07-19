import type { GateResult, GateRunOptions } from "../domain/gate.ts";

export interface GateRunner {
	run(artifactId: string): GateResult[];
	runAsync(artifactId: string, options?: GateRunOptions): Promise<GateResult[]>;
}
