/**
 * Discuss's live:true ask UI: a thin wrapper over @danypops/vehicle-client-pi's shared
 * requestPiAskPrompt (searchable single-select, checkbox multi-select, freeform replies,
 * optional comments, typing courtesy, hosted integrated or overlay -- the rich UI itself, and its
 * own test suite, now live there). This module owns exactly what's Papyrus-specific: resolving
 * PAPYRUS_DISCUSS_* environment preferences into explicit options, and the "discuss" box label.
 */
import {
	type PiAskPromptOptions,
	requestPiAskPrompt,
	ensureTypingCourtesyTracking as sharedEnsureTypingCourtesyTracking,
	isLiveAskPending as sharedIsLiveAskPending,
} from "@danypops/vehicle-client-pi/hitl-ask-prompt";
import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AskPresentation = "integrated" | "overlay";

export interface AskOption {
	title: string;
	description?: string;
}

export interface AskQuestionParams {
	question: string;
	/**
	 * `integrated` replaces Pi's input editor while preserving the transcript and footer;
	 * `overlay` presents the identical component as a blocking popup over the transcript.
	 * Defaults to integrated, preserving the established Discuss interaction.
	 */
	presentation?: AskPresentation;
	context?: string;
	/** Plain orientation line ("which discussion is this"), shown dim above the question -- not a
	 * labeled section like context. Typically the Discussion's own title. */
	subtitle?: string;
	options?: AskOption[];
	allowMultiple?: boolean;
	allowFreeform?: boolean;
	allowComment?: boolean;
	timeout?: number;
	onUpdate?: AgentToolUpdateCallback;
	signal?: AbortSignal;
}

export interface AskAnswer {
	content: string;
	selected?: string[];
}

function parseBooleanPreference(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}

/** Re-exported for pi-papyrus's own typing-courtesy tracking call sites (extension/src/index.ts). */
export const ensureTypingCourtesyTracking = sharedEnsureTypingCourtesyTracking;
/** Re-exported for extension/src/index.ts's active-task-continuation guard -- see the shared
 * module's own isLiveAskPending doc comment for why that guard exists. */
export const isLiveAskPending = sharedIsLiveAskPending;

/** Test-only: forwarded so existing tests can still reset the shared module's ambient keystroke
 * clock between cases without importing it directly. */
export { resetTypingCourtesyTrackingForTests, setTypingCourtesyTimingForTests } from "@danypops/vehicle-client-pi/hitl-ask-prompt";

/**
 * Discuss's live:true synchronous ask -- resolves PAPYRUS_DISCUSS_* environment preferences into
 * requestPiAskPrompt's explicit options, brands the box "discuss", and forwards everything else
 * unchanged.
 */
export async function askQuestion(ctx: ExtensionContext, params: AskQuestionParams): Promise<AskAnswer | undefined> {
	const options: PiAskPromptOptions = {
		question: params.question,
		presentation: params.presentation,
		context: params.context,
		subtitle: params.subtitle,
		boxTitle: "discuss",
		options: params.options,
		allowMultiple: params.allowMultiple,
		allowFreeform: params.allowFreeform,
		allowComment: params.allowComment ?? parseBooleanPreference(process.env.PAPYRUS_DISCUSS_ALLOW_COMMENT),
		commentToggleKey: process.env.PAPYRUS_DISCUSS_COMMENT_TOGGLE_KEY,
		typingCourtesy: parseBooleanPreference(process.env.PAPYRUS_DISCUSS_TYPING_COURTESY) ?? true,
		timeout: params.timeout,
		onUpdate: params.onUpdate,
		signal: params.signal,
	};
	return requestPiAskPrompt(ctx, options);
}
