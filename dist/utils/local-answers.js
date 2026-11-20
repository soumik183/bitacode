/**
 * local-answers.ts — questions the CLI can answer without a model call.
 *
 * "What version are you?" and "where am I?" are facts the process already holds.
 * Sending them to a provider costs a round trip, fails offline, and invites the
 * model to invent a version number. This module recognises a small, explicit set
 * of such questions and answers them directly.
 *
 * Deliberately narrow: a false positive here silently swallows a real prompt, so
 * only slash commands and unmistakable phrasings are matched.
 */
const RULES = [
    {
        id: 'version',
        test: /^\/(?:version|about)\b|^(?:what|which)\s+(?:version|build)\b|\bwhat version (?:are you|is this|of \w+)\b|\byour version\b/i,
        answer: (ctx) => `bitacode ${ctx.version}`,
    },
    {
        id: 'cwd',
        test: /^\/(?:pwd|cwd)\s*$|^where am i\??$/i,
        answer: (ctx) => ctx.cwd,
    },
    {
        id: 'model',
        test: /^\/(?:model|route)\?$|^(?:what|which) (?:model|provider)\b|\bwhat model (?:are you|is this)\b/i,
        answer: (ctx) => {
            const model = ctx.model ?? 'not configured';
            const provider = ctx.provider ? ` via ${ctx.provider}` : '';
            const base = ctx.baseUrl ? ` (${ctx.baseUrl})` : '';
            return `${model}${provider}${base}`;
        },
    },
    {
        id: 'mode',
        test: /^\/(?:mode|status)\s*$|^what mode (?:am i in|is this)\??$/i,
        answer: (ctx) => {
            const mode = ctx.planMode ? 'plan (read-only)' : 'build';
            const approval = ctx.approvalMode ? `, approvals: ${ctx.approvalMode}` : '';
            return `${mode}${approval}`;
        },
    },
];
/** Returns the answer text, or null when the input needs the model. */
export function answerLocally(input, context) {
    const text = input.trim();
    if (!text || text.length > 200)
        return null;
    for (const rule of RULES) {
        if (rule.test.test(text))
            return rule.answer(context);
    }
    return null;
}
/** True when the input is one of the locally answered questions. */
export function isLocalAnswer(input, context) {
    return answerLocally(input, context) !== null;
}
/** Stable ids of the rules, for tests and docs. */
export function localAnswerRuleIds() {
    return RULES.map((rule) => rule.id);
}
