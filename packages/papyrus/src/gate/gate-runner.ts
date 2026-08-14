import type { GateResult, GateRunOptions } from "../gate/gate.ts";

export interface GateRunner {
	run(artifactId: string, options?: GateRunOptions): GateResult[];
	runAsync(artifactId: string, options?: GateRunOptions): Promise<GateResult[]>;
}
