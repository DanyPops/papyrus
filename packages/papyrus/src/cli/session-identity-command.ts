import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import { runStricliToString } from "./stricli-run.ts";

type SessionIdentityClient = Pick<PapyrusClient, "call">;

interface SessionIdentityContext extends CommandContext {
	readonly client: SessionIdentityClient;
	readonly json: boolean;
}

function render(this: SessionIdentityContext, result: unknown): void {
	this.process.stdout.write(this.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
}

const registerCommand = buildCommand({
	func: async function (this: SessionIdentityContext, flags: { sessionId: string }) {
		const result = await this.client.call<Record<string, unknown>, { sessionId: string; secret: string }>("session.register", {
			session_id: flags.sessionId,
		});
		render.call(this, result);
	},
	parameters: {
		flags: {
			sessionId: { brief: "Session id to register", kind: "parsed", parse: String, placeholder: "id" },
		},
	},
	docs: { brief: "Register a session identity, receiving back a secret for later mutations" },
});

const releaseCommand = buildCommand({
	func: async function (this: SessionIdentityContext, flags: { sessionId: string; sessionSecret?: string }) {
		const result = await this.client.call<Record<string, unknown>, { released: boolean }>("session.release", {
			session_id: flags.sessionId,
			...(flags.sessionSecret ? { session_secret: flags.sessionSecret } : {}),
		});
		render.call(this, result);
	},
	parameters: {
		flags: {
			sessionId: { brief: "Session id to release", kind: "parsed", parse: String, placeholder: "id" },
			sessionSecret: { brief: "Secret returned at registration", kind: "parsed", parse: String, placeholder: "secret", optional: true },
		},
	},
	docs: { brief: "Release a registered session identity" },
});

const app = buildApplication(
	buildRouteMap({ routes: { register: registerCommand, release: releaseCommand }, docs: { brief: "Session identity operations" } }),
	{ name: "session", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runSessionIdentityCli(args: string[], client: SessionIdentityClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json });
}
