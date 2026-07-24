import type { Db } from "../db.ts";
import type { GateResult, GateRunOptions } from "../domain/gate.ts";
import type { GateRunner } from "../ports/gate-runner.ts";
import { runGates, runGatesAsync } from "../ops.ts";

export class SQLiteGateRunner implements GateRunner {
	constructor(private readonly db: Db) {}

	run(artifactId: string, options?: GateRunOptions): GateResult[] {
		return runGates(this.db, artifactId, options);
	}

	runAsync(artifactId: string, options?: GateRunOptions): Promise<GateResult[]> {
		return runGatesAsync(this.db, artifactId, options);
	}
}
