import type { Application, CommandContext } from "@stricli/core";
import { run } from "@stricli/core";

/**
 * Every run*Cli export keeps the pre-Stricli (args, client) => Promise<string> contract so
 * test/cli-parity.test.ts and cli.ts's main() dispatch don't need to change per migrated command.
 * Stricli itself never throws for a user-facing failure (invalid flag, unknown route) -- it
 * writes to context.process.stderr and sets context.process.exitCode instead -- so this captures
 * both in memory and converts a nonzero exit code back into a thrown Error to match every other
 * run*Cli function's own contract.
 */
export async function runStricliToString<CONTEXT extends CommandContext>(
	app: Application<CONTEXT>,
	args: string[],
	contextWithoutProcess: Omit<CONTEXT, "process">,
): Promise<string> {
	const chunks: string[] = [];
	const errors: string[] = [];
	const process: {
		stdout: { write: (text: string) => void };
		stderr: { write: (text: string) => void };
		exitCode?: number | string | null;
	} = {
		stdout: { write: (text: string) => chunks.push(text) },
		stderr: { write: (text: string) => errors.push(text) },
	};
	await run(app, args, { ...contextWithoutProcess, process } as CONTEXT);
	if (process.exitCode) throw new Error(errors.join("").trim() || `command failed with exit code ${process.exitCode}`);
	return chunks.join("");
}
