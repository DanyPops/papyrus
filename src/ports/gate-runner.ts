import type { GateResult } from "../domain/gate.ts";

export interface GateRunner {
	run(artifactId: string): GateResult[];
	runAsync(artifactId: string): Promise<GateResult[]>;
}
