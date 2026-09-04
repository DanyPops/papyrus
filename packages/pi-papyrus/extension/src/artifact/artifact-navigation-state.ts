export type ArtifactNavigationMode = "normal" | "filter";

/** Owns bounded selection, mode, and viewport-expansion state for artifact UIs. */
export class ArtifactNavigationState {
	selectedIndex = 0;
	mode: ArtifactNavigationMode = "normal";
	query = "";
	expanded = false;

	constructor(private itemCount: number) {
		this.setItemCount(itemCount);
	}

	setItemCount(itemCount: number): void {
		this.itemCount = Math.max(0, itemCount);
		this.selectedIndex = this.itemCount === 0 ? 0 : Math.min(this.selectedIndex, this.itemCount - 1);
	}

	move(delta: number): void {
		if (this.itemCount === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + this.itemCount) % this.itemCount;
	}

	movePage(direction: -1 | 1, pageSize: number): void {
		if (this.itemCount === 0) return;
		const distance = Math.max(1, Math.floor(pageSize));
		this.selectedIndex = Math.max(0, Math.min(this.itemCount - 1, this.selectedIndex + direction * distance));
	}

	first(): void {
		this.selectedIndex = 0;
	}

	last(): void {
		this.selectedIndex = Math.max(0, this.itemCount - 1);
	}

	enterFilter(): void {
		this.mode = "filter";
	}

	setQuery(query: string): void {
		this.query = query;
	}

	leaveFilter(clearQuery = false): void {
		this.mode = "normal";
		if (clearQuery) this.query = "";
	}

	toggleExpanded(): void {
		this.expanded = !this.expanded;
	}
}
