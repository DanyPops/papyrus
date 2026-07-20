import type { Artifact } from "../../src/domain/artifact.ts";
import { formatMetadata } from "./artifact-format.ts";

export function artifactDetailsText(artifact: Artifact): string {
	let output = `${artifact.title}\n${artifact.id} [${artifact.kind}|${artifact.status}]`;
	if (artifact.subtype) output += ` · ${artifact.subtype}`;
	output += `\n\n${artifact.body || "(no body)"}`;
	if (artifact.labels.length > 0) output += `\n\nLabels: ${artifact.labels.join(", ")}`;
	if (Object.keys(artifact.extra).length > 0) {
		output += `\n\nMetadata:\n${formatMetadata(artifact.extra).map((line) => `  ${line}`).join("\n")}`;
	}
	if (artifact.edges?.length) {
		output += `\n\nRelationships:\n${artifact.edges.map((edge) => `  ${edge.from} --${edge.relation}--> ${edge.to}`).join("\n")}`;
	}
	return output;
}
