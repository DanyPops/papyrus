import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { VEHICLE_SCHEMA_PRESENTATION_EXTENSION } from "@danypops/vehicle-core";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

function operationProperties(name: string): Record<string, Record<string, unknown>> {
	const directory = tempDir("papyrus-task-stream-schema-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	try {
		const operation = service.vehicle.manifest().operations.find((candidate) => candidate.name === name);
		if (!operation) throw new Error(`missing operation ${name}`);
		return (operation.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
	} finally {
		service.close();
	}
}

describe("Papyrus Task Vehicle streaming presentation", () => {
	for (const operationName of ["tasks.create", "tasks.update"]) {
		it(`${operationName} opts its body into Vehicle's generic rolling stream renderer`, () => {
			const properties = operationProperties(operationName);

			expect(properties.body?.[VEHICLE_SCHEMA_PRESENTATION_EXTENSION]).toBe("stream");
			expect(properties.title?.[VEHICLE_SCHEMA_PRESENTATION_EXTENSION]).toBeUndefined();
		});
	}
});
