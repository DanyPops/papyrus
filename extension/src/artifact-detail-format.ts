import type { Artifact } from "../../src/domain/artifact.ts";
import { formatMetadata } from "./artifact-format.ts";

export interface ArtifactDetailContent {
	title: string;
	identity: string;
	body: string;
	labels: string[];
	metadata: string[];
	relationships: string[];
}

export function artifactDetailContent(artifact: Artifact): ArtifactDetailContent {
	return {
		title: artifact.title,
		identity: `${artifact.id} [${artifact.kind}|${artifact.status}]${artifact.subtype ? ` · ${artifact.subtype}` : ""}`,
		body: artifact.body || "(no body)",
		labels: [...artifact.labels],
		metadata: Object.keys(artifact.extra).length > 0 ? formatMetadata(artifact.extra) : [],
		relationships: (artifact.edges ?? []).map((edge) => `${edge.from} --${edge.relation}--> ${edge.to}`),
	};
}

export function artifactDetailsText(artifact: Artifact): string {
	const content = artifactDetailContent(artifact);
	let output = `${content.title}\n${content.identity}\n\n${content.body}`;
	if (content.labels.length > 0) output += `\n\nLabels: ${content.labels.join(", ")}`;
	if (content.metadata.length > 0) output += `\n\nMetadata:\n${content.metadata.map((line) => `  ${line}`).join("\n")}`;
	if (content.relationships.length > 0) output += `\n\nRelationships:\n${content.relationships.map((line) => `  ${line}`).join("\n")}`;
	return output;
}
