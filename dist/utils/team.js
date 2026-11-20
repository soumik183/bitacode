/**
 * team.ts — in-process registry for agent-to-agent messaging.
 *
 * All state lives in module-level maps: no filesystem, timers, model calls, or
 * imports from the tool layer. Channels are keyed by team name; `default` is
 * the shared channel. Reads return copies so callers cannot mutate the store.
 */
export const DEFAULT_TEAM = 'default';
/** Recipient meaning "everyone on this team's channel". */
export const TEAM_CHANNEL = '*';
export const MAX_TEAMS = 50;
export const MAX_MESSAGES_PER_TEAM = 500;
export const MAX_NAME_CHARS = 80;
export const MAX_BODY_CHARS = 2_000;
export const MAX_TASK_CHARS = 4_000;
export const MAX_AGENTS = 50;
export const MAX_DESCRIPTION_CHARS = 300;
export const MAX_SYSTEM_PROMPT_CHARS = 4_000;
export const MAX_ALLOWED_TOOLS = 50;
export const MAX_SPAWN_INTENTS = 100;
const channels = new Map([[DEFAULT_TEAM, { messages: [], seq: 0 }]]);
const agents = new Map();
const spawnIntents = [];
let spawnSeq = 0;
function text(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function teamName(value) {
    return text(value, MAX_NAME_CHARS) || DEFAULT_TEAM;
}
function parseAfter(value) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
/** Post a message. `to` may be a teammate name or `*` for the team channel. */
export function postMessage(team, from, to, body) {
    const name = teamName(team);
    const sender = text(from, MAX_NAME_CHARS);
    const recipient = text(to, MAX_NAME_CHARS);
    const messageBody = text(body, MAX_BODY_CHARS);
    if (!sender || !recipient || !messageBody)
        return null;
    const channel = channels.get(name) ?? { messages: [], seq: 0 };
    channel.seq += 1;
    const message = {
        id: `${name}:${channel.seq}`,
        seq: channel.seq,
        from: sender,
        to: recipient,
        body: messageBody,
        at: Date.now(),
    };
    channel.messages.push(message);
    if (channel.messages.length > MAX_MESSAGES_PER_TEAM)
        channel.messages.shift();
    channels.set(name, channel);
    // Keep the default channel; evict the oldest named team if we run out of slots.
    while (channels.size > MAX_TEAMS) {
        const oldest = channels.keys().next().value;
        if (oldest === undefined || oldest === DEFAULT_TEAM)
            break;
        channels.delete(oldest);
    }
    return { ...message };
}
/**
 * Read messages with `seq > afterSeq`, oldest first. When `to` is supplied,
 * include messages addressed to that name plus team-channel broadcasts (`*`).
 */
export function readMessages(team, afterSeq = 0, to) {
    const channel = channels.get(teamName(team));
    if (!channel)
        return [];
    const after = parseAfter(afterSeq);
    const recipient = text(to, MAX_NAME_CHARS);
    return channel.messages
        .filter((m) => m.seq > after && (!recipient || m.to === recipient || m.to === TEAM_CHANNEL))
        .map((m) => ({ ...m }));
}
export function listTeams() {
    return [...channels.keys()].sort();
}
export function clearTeam(team) {
    const name = teamName(team);
    if (name === DEFAULT_TEAM)
        channels.set(DEFAULT_TEAM, { messages: [], seq: 0 });
    else
        channels.delete(name);
}
/** One entry per channel with its members (senders, named recipients, spawns). */
export function teamRoster() {
    return [...channels.entries()]
        .map(([team, channel]) => {
        const members = new Set();
        for (const m of channel.messages) {
            members.add(m.from);
            if (m.to !== TEAM_CHANNEL)
                members.add(m.to);
        }
        for (const intent of spawnIntents) {
            if (intent.team === team)
                members.add(intent.name);
        }
        return {
            team,
            members: [...members].sort(),
            messageCount: channel.messages.length,
            lastSeq: channel.seq,
        };
    })
        .sort((a, b) => a.team.localeCompare(b.team));
}
/** Register (or replace) a custom agent definition in memory. */
export function defineAgent(name, description, systemPrompt, allowedTools = []) {
    const cleanName = text(name, MAX_NAME_CHARS);
    const cleanDescription = text(description, MAX_DESCRIPTION_CHARS);
    const cleanPrompt = text(systemPrompt, MAX_SYSTEM_PROMPT_CHARS);
    if (!cleanName || !cleanDescription || !cleanPrompt)
        return null;
    const tools = Array.isArray(allowedTools)
        ? allowedTools
            .filter((tool) => typeof tool === 'string' && tool.trim().length > 0)
            .map((tool) => tool.trim().slice(0, MAX_NAME_CHARS))
            .slice(0, MAX_ALLOWED_TOOLS)
        : [];
    if (!agents.has(cleanName) && agents.size >= MAX_AGENTS) {
        const oldest = agents.keys().next().value;
        if (oldest !== undefined)
            agents.delete(oldest);
    }
    const definition = {
        name: cleanName,
        description: cleanDescription,
        systemPrompt: cleanPrompt,
        allowedTools: tools,
    };
    agents.set(cleanName, definition);
    return { ...definition, allowedTools: [...tools] };
}
export function getAgent(name) {
    const entry = agents.get(text(name, MAX_NAME_CHARS));
    return entry ? { ...entry, allowedTools: [...entry.allowedTools] } : undefined;
}
export function listAgents() {
    return [...agents.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => ({ ...entry, allowedTools: [...entry.allowedTools] }));
}
export function clearAgents() {
    agents.clear();
}
/** Record a spawn request without starting any process or calling the model. */
export function recordSpawnIntent(name, task, team = DEFAULT_TEAM) {
    spawnSeq += 1;
    const intent = {
        id: `spawn-${spawnSeq}`,
        name: text(name, MAX_NAME_CHARS) || 'unnamed',
        task: text(task, MAX_TASK_CHARS),
        team: teamName(team),
        at: Date.now(),
    };
    spawnIntents.push(intent);
    if (spawnIntents.length > MAX_SPAWN_INTENTS)
        spawnIntents.shift();
    return { ...intent };
}
export function listSpawnIntents() {
    return spawnIntents.map((intent) => ({ ...intent }));
}
export function clearSpawnIntents() {
    spawnIntents.length = 0;
}
