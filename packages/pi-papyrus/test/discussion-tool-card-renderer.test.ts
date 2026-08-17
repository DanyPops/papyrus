import { describe, expect, it } from "bun:test";
import { type DiscussionRoundOutput, roundsSection } from "../extension/src/tools/renderers/discussion.ts";

describe("roundsSection (discuss.* tool-call card)", () => {
	it("renders a plain, non-quiz round's body unchanged (backward compatible)", () => {
		const rounds: DiscussionRoundOutput[] = [{ roundNumber: 1, actor: "alice", content: "Should we rename this?" }];
		const section = roundsSection(rounds);
		expect(section.items?.[0]?.body).toBe("Should we rename this?");
	});

	it("letters a quiz's posed options in the round's own body", () => {
		const rounds: DiscussionRoundOutput[] = [
			{ roundNumber: 1, actor: "agent", content: "Capital of France?", options: ["Paris", "London"], quiz: true },
		];
		const section = roundsSection(rounds);
		expect(section.items?.[0]?.body).toContain("A. Paris");
		expect(section.items?.[0]?.body).toContain("B. London");
	});

	it("never leaks the correct answer on the posing round -- only the answering round's own quizResult reveals it", () => {
		const rounds: DiscussionRoundOutput[] = [
			{ roundNumber: 1, actor: "agent", content: "Capital of France?", options: ["Paris", "London"], quiz: true },
			{
				roundNumber: 2,
				actor: "human",
				content: "Paris",
				quizResult: { correct: true, correctOptions: ["Paris"], explanation: "Paris has been the capital since 987 AD." },
			},
		];
		const section = roundsSection(rounds);
		expect(section.items?.[0]?.body).not.toContain("987 AD");
		expect(section.items?.[1]?.body).toContain("Correct!");
		expect(section.items?.[1]?.body).toContain("987 AD");
	});

	it("shows an incorrect verdict with the correct answer(s) and explanation", () => {
		const rounds: DiscussionRoundOutput[] = [
			{
				roundNumber: 2,
				actor: "human",
				content: "London",
				quizResult: { correct: false, correctOptions: ["Paris"], explanation: "Paris has been the capital since 987 AD." },
			},
		];
		const section = roundsSection(rounds);
		expect(section.items?.[0]?.body).toContain("Incorrect");
		expect(section.items?.[0]?.body).toContain("Paris");
		expect(section.items?.[0]?.body).toContain("987 AD");
	});
});
