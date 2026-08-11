import type { Db } from "../db.ts";
import type { GateResult, GateRunOptions } from "../domain/gate.ts";
import { runGates, runGatesAsync } from "../domain/gate-execution.ts";
import type { GateRunner } from "./gate-runner.ts";

export class SQLiteGateRunner implements GateRunner {
	constructor(private readonly db: Db) {}

	run(artifactId: string, options?: GateRunOptions): GateResult[] {
		return runGates(this.db, artifactId, options);
	}

	runAsync(artifactId: string, options?: GateRunOptions): Promise<GateResult[]> {
		return runGatesAsync(this.db, artifactId, options);
	}
}
