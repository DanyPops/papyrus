export type CliArtifact = { id: string; alias: string; title: string; status: string; body?: string };

export function artifactLabel(artifact: CliArtifact): string {
	return `${artifact.alias} ${artifact.title}`;
}
