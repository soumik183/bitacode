/**
 * shell-scan.ts — pure, shell-aware scanning of command strings for permission rules.
 *
 * This is a structural scanner, not an executor and not an interpolator. It
 * tokenizes a command string well enough to tell an allow-rule matcher which
 * parts are plain commands and which parts contain shell control structure
 * (chains, pipes, redirections, substitution, background jobs). Nothing here
 * runs a shell, expands `$VAR`, or resolves a path; callers must still gate the
 * command through `command-gate.ts` before execution.
 *
 * The scanner is deliberately defensive: malformed input, unterminated quotes,
 * oversized input and token floods produce a high-risk result with a reason
 * instead of throwing, so a caller that forgets to check `risk` still fails
 * closed when it asks `assertShellAllowable`.
 */
const MAX_INPUT_LENGTH = 100_000;
const MAX_TOKENS = 4096;
const SEPARATORS = new Set([';', '\n', '\r', '&&', '||', '|', '&']);
function isDigit(char) {
    return char !== undefined && char >= '0' && char <= '9';
}
/** Consume a single-quoted span. Single quotes never interpret backslashes. */
function consumeSingleQuoted(source, start) {
    const close = source.indexOf("'", start + 1);
    if (close === -1) {
        return {
            end: source.length,
            raw: source.slice(start),
            value: source.slice(start + 1),
            terminated: false,
            substitution: false,
            unterminatedSubstitution: false,
        };
    }
    return {
        end: close + 1,
        raw: source.slice(start, close + 1),
        value: source.slice(start + 1, close),
        terminated: true,
        substitution: false,
        unterminatedSubstitution: false,
    };
}
/** Consume a double-quoted span, honouring escapes and nested substitution. */
function consumeDoubleQuoted(source, start) {
    let raw = '"';
    let value = '';
    let i = start + 1;
    let terminated = false;
    let substitution = false;
    let unterminatedSubstitution = false;
    while (i < source.length) {
        const char = source[i];
        if (char === '\\') {
            const next = source[i + 1];
            if (next === '\n' || next === '\r') {
                raw += char + next;
                i += 2;
                continue;
            }
            if (next === undefined) {
                raw += char;
                value += char;
                i += 1;
                continue;
            }
            raw += char + next;
            value += next === '$' || next === '`' || next === '"' || next === '\\' ? next : char + next;
            i += 2;
            continue;
        }
        if (char === '"') {
            raw += char;
            i += 1;
            terminated = true;
            break;
        }
        if (char === '$' && source[i + 1] === '(') {
            const end = consumeBalanced(source, i + 1);
            const span = end === -1 ? source.slice(i) : source.slice(i, end);
            raw += span;
            value += span;
            substitution = true;
            if (end === -1) {
                unterminatedSubstitution = true;
                i = source.length;
                break;
            }
            i = end;
            continue;
        }
        if (char === '`') {
            const end = consumeBacktick(source, i);
            const span = end === -1 ? source.slice(i) : source.slice(i, end);
            raw += span;
            value += span;
            substitution = true;
            if (end === -1) {
                unterminatedSubstitution = true;
                i = source.length;
                break;
            }
            i = end;
            continue;
        }
        raw += char;
        value += char;
        i += 1;
    }
    return { end: i, raw, value, terminated, substitution, unterminatedSubstitution };
}
/** Consume from an opening `(` to its matching `)`, ignoring quoted content. */
function consumeBalanced(source, open) {
    let depth = 0;
    let i = open;
    while (i < source.length) {
        const char = source[i];
        if (char === '\\') {
            i += 2;
            continue;
        }
        if (char === "'") {
            const span = consumeSingleQuoted(source, i);
            i = span.end > i ? span.end : i + 1;
            continue;
        }
        if (char === '"') {
            const span = consumeDoubleQuoted(source, i);
            i = span.end > i ? span.end : i + 1;
            continue;
        }
        if (char === '(')
            depth += 1;
        if (char === ')') {
            depth -= 1;
            if (depth === 0)
                return i + 1;
        }
        i += 1;
    }
    return -1;
}
/** Consume a backtick pair, treating `\\` as an escape inside it. */
function consumeBacktick(source, start) {
    let i = start + 1;
    while (i < source.length) {
        if (source[i] === '\\') {
            i += 2;
            continue;
        }
        if (source[i] === '`')
            return i + 1;
        i += 1;
    }
    return -1;
}
/** Recognize `>`, `>>`, `<`, `<<`, `<>`, `2>` and `2>&1` as one operator. */
function matchRedirection(source, i) {
    let j = i;
    let text = '';
    if (isDigit(source[j])) {
        while (isDigit(source[j]))
            j += 1;
        if (source[j] !== '>')
            return null;
        text = source.slice(i, j);
    }
    const char = source[j];
    if (char !== '>' && char !== '<')
        return null;
    text += char;
    j += 1;
    if (source[j] === char) {
        text += char;
        j += 1;
    }
    if (char === '>' && source[j] === '&') {
        text += '&';
        j += 1;
        if (isDigit(source[j])) {
            text += source[j];
            j += 1;
        }
    }
    else if (char === '<' && source[j] === '>') {
        text += '>';
        j += 1;
    }
    return { text, end: j };
}
function emptyScan(reasons) {
    return {
        commands: [],
        hasSubstitution: false,
        hasPipe: false,
        hasChain: false,
        hasBackground: false,
        hasRedirection: false,
        risk: 'low',
        reasons,
    };
}
/**
 * Tokenize a command string and describe its shell control structure.
 * Never throws; malformed input is reported through `risk` and `reasons`.
 */
export function scanShell(command) {
    if (typeof command !== 'string') {
        return { ...emptyScan(['command is not a string; failing closed']), risk: 'high' };
    }
    if (command.length === 0) {
        return emptyScan(['command is empty']);
    }
    if (command.trim().length === 0) {
        return emptyScan(['command contains only whitespace']);
    }
    if (command.length > MAX_INPUT_LENGTH) {
        return {
            ...emptyScan([
                `command is ${command.length} characters long (limit ${MAX_INPUT_LENGTH}); refusing to scan it`,
            ]),
            risk: 'high',
        };
    }
    const tokens = [];
    const seenReasons = new Set();
    const reason = (text) => seenReasons.add(text);
    let hasSubstitution = false;
    let hasPipe = false;
    let hasChain = false;
    let hasBackground = false;
    let hasRedirection = false;
    let hasNewline = false;
    let unterminatedQuote = false;
    let unterminatedSubstitution = false;
    let ambiguousHash = false;
    let tokenLimitExceeded = false;
    let i = 0;
    let word = null;
    const ensureWord = (start) => {
        if (!word)
            word = { start, raw: '', value: '' };
    };
    const appendWord = (raw, value) => {
        if (!word)
            return;
        word.raw += raw;
        word.value += value;
    };
    const pushToken = (token) => {
        if (tokens.length >= MAX_TOKENS) {
            tokenLimitExceeded = true;
            return;
        }
        tokens.push(token);
    };
    const flushWord = () => {
        if (!word)
            return;
        const current = word;
        word = null;
        pushToken({ kind: 'word', text: current.raw, value: current.value, start: current.start, end: i });
    };
    const pushOp = (text, start, end) => {
        flushWord();
        pushToken({ kind: 'op', text, start, end });
    };
    while (i < command.length && !tokenLimitExceeded) {
        const char = command[i];
        if (char === '\n' || char === '\r') {
            hasNewline = true;
            pushOp(char, i, i + 1);
            i += 1;
            continue;
        }
        if (char === ' ' || char === '\t' || char === '\v' || char === '\f') {
            flushWord();
            i += 1;
            continue;
        }
        if (char === '\\') {
            ensureWord(i);
            const next = command[i + 1];
            if (next === '\n' || next === '\r') {
                appendWord(char + next, ''); // line continuation: no value, but keep the source text
                i += 2;
            }
            else if (next === undefined) {
                appendWord(char, char);
                i += 1;
            }
            else {
                appendWord(char + next, next);
                i += 2;
            }
            continue;
        }
        if (char === "'") {
            ensureWord(i);
            const span = consumeSingleQuoted(command, i);
            appendWord(span.raw, span.value);
            if (!span.terminated) {
                unterminatedQuote = true;
                reason('unterminated single quote: the rest of the command is inside the quote');
            }
            i = span.end;
            continue;
        }
        if (char === '"') {
            ensureWord(i);
            const span = consumeDoubleQuoted(command, i);
            appendWord(span.raw, span.value);
            if (span.substitution)
                hasSubstitution = true;
            if (span.unterminatedSubstitution) {
                unterminatedSubstitution = true;
                reason('unterminated substitution inside double quotes');
            }
            if (!span.terminated) {
                unterminatedQuote = true;
                reason('unterminated double quote: the rest of the command is inside the quote');
            }
            i = span.end;
            continue;
        }
        if (char === '#') {
            // A hash attached to a word is ambiguous; never quietly hide what follows.
            if (word) {
                ambiguousHash = true;
                reason("ambiguous '#' inside a word treated as the start of a comment");
            }
            flushWord();
            while (i < command.length && command[i] !== '\n' && command[i] !== '\r')
                i += 1;
            continue;
        }
        if ((char === '$' || char === '<' || char === '>') && command[i + 1] === '(') {
            ensureWord(i);
            const open = i + 1;
            const end = consumeBalanced(command, open);
            const span = end === -1 ? command.slice(i) : command.slice(i, end);
            appendWord(span, span);
            hasSubstitution = true;
            if (end === -1) {
                unterminatedSubstitution = true;
                reason('unterminated command or process substitution');
                i = command.length;
            }
            else {
                i = end;
            }
            continue;
        }
        if (char === '`') {
            ensureWord(i);
            const end = consumeBacktick(command, i);
            const span = end === -1 ? command.slice(i) : command.slice(i, end);
            appendWord(span, span);
            hasSubstitution = true;
            if (end === -1) {
                unterminatedSubstitution = true;
                reason('unterminated backtick substitution');
                i = command.length;
            }
            else {
                i = end;
            }
            continue;
        }
        const redirection = matchRedirection(command, i);
        if (redirection) {
            hasRedirection = true;
            pushOp(redirection.text, i, redirection.end);
            i = redirection.end;
            continue;
        }
        if ((char === '&' && command[i + 1] === '&') || (char === '|' && command[i + 1] === '|')) {
            const op = command.slice(i, i + 2);
            hasChain = true;
            pushOp(op, i, i + 2);
            i += 2;
            continue;
        }
        if (char === '|' || char === ';' || char === '&') {
            if (char === '|')
                hasPipe = true;
            else if (char === ';')
                hasChain = true;
            else
                hasBackground = true;
            pushOp(char, i, i + 1);
            i += 1;
            continue;
        }
        ensureWord(i);
        appendWord(char, char);
        i += 1;
    }
    flushWord(); // the final word has no following separator to flush it
    if (tokenLimitExceeded) {
        reason(`token limit of ${MAX_TOKENS} exceeded; command was truncated and is treated as high risk`);
    }
    // Group the token stream into subcommands, split on separators only.
    const commands = [];
    let args = [];
    let redirections = [];
    let segmentStart = -1;
    let segmentEnd = -1;
    let leadingOp = null;
    let skipRedirectTarget = false;
    const finalize = () => {
        if (segmentStart === -1)
            return;
        const text = command.slice(segmentStart, segmentEnd).trim();
        if (text) {
            commands.push({ text, op: leadingOp, args: [...args], redirections: [...redirections] });
        }
        args = [];
        redirections = [];
        segmentStart = -1;
        segmentEnd = -1;
        skipRedirectTarget = false;
    };
    for (const token of tokens) {
        if (token.kind === 'word') {
            if (segmentStart === -1)
                segmentStart = token.start;
            segmentEnd = token.end;
            if (skipRedirectTarget)
                skipRedirectTarget = false;
            else
                args.push(token.value);
            continue;
        }
        if (SEPARATORS.has(token.text)) {
            finalize();
            leadingOp = token.text;
            continue;
        }
        if (segmentStart === -1)
            segmentStart = token.start;
        segmentEnd = token.end;
        redirections.push(token.text);
        skipRedirectTarget = true;
    }
    finalize();
    const multiCommandSeparator = commands.length > 1 && (hasChain || hasNewline || hasBackground);
    let risk = 'low';
    if (hasSubstitution || hasBackground || multiCommandSeparator || unterminatedQuote ||
        unterminatedSubstitution || ambiguousHash || tokenLimitExceeded) {
        risk = 'high';
    }
    else if (hasPipe || hasRedirection || hasChain) {
        risk = 'medium';
    }
    if (hasSubstitution)
        reason('command or process substitution detected ($(), backticks, <() or >())');
    if (hasPipe)
        reason('pipe operator detected');
    if (hasChain)
        reason('command chaining operator detected (&&, || or ;)');
    if (hasBackground)
        reason('background execution operator (&) detected');
    if (hasRedirection)
        reason('input or output redirection detected');
    if (hasNewline)
        reason('newline used as a command separator');
    if (commands.length > 1)
        reason(`command contains ${commands.length} subcommands`);
    if (commands.length === 0 && !hasSubstitution && !hasPipe && !hasChain && !hasBackground &&
        !hasRedirection && seenReasons.size === 0) {
        reason('command contains only comments or whitespace');
    }
    if (risk === 'low' && seenReasons.size === 0) {
        reason('no shell control operators detected');
    }
    return {
        commands,
        hasSubstitution,
        hasPipe,
        hasChain,
        hasBackground,
        hasRedirection,
        risk,
        reasons: [...seenReasons],
    };
}
/**
 * Split a command string into its trimmed subcommands, in source order.
 * Operators themselves are not returned; comments and separators are dropped.
 */
export function splitShellCommands(command) {
    return scanShell(command).commands.map((entry) => entry.text).filter(Boolean);
}
/**
 * Fail-closed check for allow-rule matching. A command is only allowed when
 * every scanned subcommand starts with one of `allowedPrefixes`; high-risk
 * structure (substitution, backgrounding, multi-command chains, malformed or
 * oversized input) is never allowed, except for a bare command that is itself
 * an allowlisted prefix. This does not execute or replace `command-gate.ts`.
 */
export function assertShellAllowable(command, allowedPrefixes) {
    if (typeof command !== 'string' || command.trim().length === 0) {
        return { allowed: false, reason: 'empty command is not allowed' };
    }
    const prefixes = (Array.isArray(allowedPrefixes) ? allowedPrefixes : [])
        .filter((prefix) => typeof prefix === 'string' && prefix.trim().length > 0)
        .map((prefix) => prefix.trim());
    if (prefixes.length === 0) {
        return { allowed: false, reason: 'no allowed command prefixes are configured; failing closed' };
    }
    const scan = scanShell(command);
    const trimmed = command.trim();
    const isBareAllowedPrefix = prefixes.includes(trimmed);
    const onlyLowRiskStructure = !scan.hasSubstitution && !scan.hasPipe && !scan.hasChain &&
        !scan.hasBackground && !scan.hasRedirection && scan.commands.length <= 1 &&
        !scan.reasons.some((text) => /unterminated|ambiguous|limit|exceeds|not a string|only whitespace/i.test(text));
    if (scan.risk === 'high') {
        if (isBareAllowedPrefix && onlyLowRiskStructure)
            return { allowed: true };
        return {
            allowed: false,
            reason: `high-risk shell structure is never covered by allow rules (${scan.reasons.join('; ')})`,
        };
    }
    if (scan.commands.length === 0) {
        return { allowed: false, reason: 'no commands could be scanned; failing closed' };
    }
    for (const segment of scan.commands) {
        if (scanShell(segment.text).hasSubstitution) {
            return {
                allowed: false,
                reason: `command segment "${segment.text}" contains shell substitution and is never allowed`,
            };
        }
        const firstToken = segment.args[0] ?? '';
        const normalized = segment.text.replace(/\s+/g, ' ').trim();
        const covered = prefixes.some((prefix) => {
            if (prefix === firstToken)
                return true;
            const prefixHead = prefix.split(/\s+/)[0];
            return prefixHead === firstToken && (normalized === prefix || normalized.startsWith(`${prefix} `));
        });
        if (!covered) {
            return {
                allowed: false,
                reason: `command segment "${segment.text}" is not covered by any allowed prefix`,
            };
        }
    }
    return { allowed: true };
}
