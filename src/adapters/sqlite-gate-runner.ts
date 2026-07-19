import type { Db } from "../db.ts";
import type { GateResult, GateRunOptions } from "../domain/gate.ts";
import type { GateRunner } from "../ports/gate-runner.ts";
import { runGates, runGatesAsync } from "../ops.ts";

export class SQLiteGateRunner implements GateRunner {
	constructor(private readonly db: Db) {}

	run(artifactId: string): GateResult[] {
		return runGates(this.db, artifactId);
	}

	runAsync(artifactId: string, options?: GateRunOptions): Promise<GateResult[]> {
		return runGatesAsync(this.db, artifactId, options);
	}
}
