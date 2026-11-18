/**
 * MCP (Model Context Protocol) client.
 *
 * Uses the official @modelcontextprotocol/sdk to connect to MCP servers
 * over both stdio (spawned processes) and HTTP transports.
 *
 * Configuration in `bitacode.jsonc` under `mcp.servers`:
 * {
 *   "servers": {
 *     "my-stdio-server": {
 *       "type": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "@my/mcp-server"],
 *       "env": { "API_KEY": "..." }
 *     },
 *     "my-http-server": {
 *       "type": "http",
 *       "url": "http://localhost:3000/mcp"
 *     }
 *   }
 * }
 *
 * Stdio servers are spawned as child processes communicating over stdin/stdout.
 * HTTP servers connect to a running server via HTTP POST/GET with SSE streaming.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadRuntimeConfig, getRuntimeConfig } from './runtime-config.js';
import { logger } from './utils/logger.js';
import { registerDynamicTool, registerDynamicHandler, unregisterDynamicTool, unregisterDynamicHandler, } from './tools/index.js';
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
// ─── Pure helpers ───
/** Tool names only allow [A-Za-z0-9_-]; fold anything else to underscore. */
export function sanitizeMcpToolName(name) {
    return name.replace(/[^A-Za-z0-9_-]/g, '_');
}
/** Reserve a non-colliding tool name, suffixing _2, _3, ... when already used. */
export function uniqueToolName(base, used) {
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
        candidate = `${base}_${suffix++}`;
    }
    used.add(candidate);
    return candidate;
}
/** Reject missing or non-http(s) URLs before the SDK sees them. */
export function isValidMcpUrl(url) {
    if (typeof url !== 'string' || url.trim() === '')
        return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
    catch {
        return false;
    }
}
/** Return a human-readable reason a server config cannot be used, or null. */
export function mcpConfigError(config) {
    if (!config || typeof config !== 'object')
        return 'invalid server config';
    const server = config;
    if (server.type !== 'stdio' && server.type !== 'http') {
        return `unknown server type: ${server.type}`;
    }
    if (server.type === 'stdio' && (typeof server.command !== 'string' || server.command.trim() === '')) {
        return 'stdio config is missing a valid command';
    }
    if (server.type === 'http' && !isValidMcpUrl(server.url)) {
        return 'http config is missing a valid url';
    }
    return null;
}
/** Race a promise against a timer, clearing the timer when it settles. */
function withTimeout(promise, timeoutMs, label) {
    let timer;
    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            const message = `${label} timed out after ${timeoutMs}ms`;
            logger.error(message);
            reject(new Error(message));
        }, timeoutMs);
    });
    return Promise.race([promise, deadline]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
}
const connections = new Map();
// Shared across servers so two servers can never claim the same tool name.
const usedToolNames = new Set();
/** Test-only: inject a fake connection so cleanup can be verified without a live server. */
export function __setMcpConnectionForTests(name, conn) {
    connections.set(name, conn);
}
/** Connect with a bounded wait; best-effort close on failure to avoid orphaned processes. */
async function connectClient(client, transport, serverName) {
    try {
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP [${serverName}] connect`);
    }
    catch (err) {
        try {
            await client.close();
        }
        catch {
            // best effort cleanup of a half-open transport
        }
        throw err;
    }
}
/**
 * Create an MCP client connection for a stdio server.
 */
async function connectStdioServer(serverName, config) {
    const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: {
            ...process.env,
            ...(config.env || {}),
        },
        cwd: config.cwd,
        stderr: 'pipe',
    });
    const client = new Client({
        name: 'bitacode',
        version: '0.0.1',
    }, {
        capabilities: {},
    });
    await connectClient(client, transport, serverName);
    // Pipe stderr from the spawned process to the logger instead of letting it
    // bleed through to the terminal and corrupt the Ink UI.
    transport.stderr?.on('data', (data) => {
        for (const line of data.toString('utf-8').split('\n')) {
            if (line.trim())
                logger.debug(`MCP [${serverName}] ${line}`);
        }
    });
    return {
        client,
        serverName,
        transport,
        registeredToolNames: [],
    };
}
/**
 * Create an MCP client connection for an HTTP server.
 */
async function connectHttpServer(serverName, config) {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
    });
    const client = new Client({
        name: 'bitacode',
        version: '0.0.1',
    }, {
        capabilities: {},
    });
    await connectClient(client, transport, serverName);
    return {
        client,
        serverName,
        transport,
        registeredToolNames: [],
    };
}
/**
 * Register all tools from an MCP server into the dynamic tool registry.
 */
async function registerMcpTools(conn) {
    try {
        const response = await withTimeout(conn.client.listTools(), CALL_TIMEOUT_MS, `MCP [${conn.serverName}] listTools`);
        const tools = response.tools || [];
        logger.info(`MCP [${conn.serverName}] discovered ${tools.length} tools`);
        for (const tool of tools) {
            const base = `mcp_${sanitizeMcpToolName(conn.serverName)}_${sanitizeMcpToolName(tool.name)}`;
            const toolName = uniqueToolName(base, usedToolNames);
            conn.registeredToolNames.push(toolName);
            registerDynamicTool({
                type: 'function',
                function: {
                    name: toolName,
                    description: `[MCP: ${conn.serverName}] ${tool.description || tool.name}`,
                    parameters: tool.inputSchema,
                },
            });
            registerDynamicHandler(toolName, async (args) => {
                // Note: Errors from this handler are caught and formatted by
                // handleToolCall() in tools/index.ts, which wraps all tool calls
                // in a try/catch and returns `Error executing ${toolName}: ${msg}`
                const result = await withTimeout(conn.client.callTool({
                    name: tool.name,
                    arguments: (args && typeof args === 'object' ? args : {}),
                }), CALL_TIMEOUT_MS, `MCP [${conn.serverName}] callTool ${tool.name}`);
                // MCP tool results are arrays of content blocks
                if (Array.isArray(result.content)) {
                    return result.content
                        .map((c) => {
                        if (c.type === 'text')
                            return c.text;
                        return JSON.stringify(c);
                    })
                        .join('\n');
                }
                return JSON.stringify(result);
            });
        }
    }
    catch (err) {
        logger.error(`Failed to register tools for MCP [${conn.serverName}]: ${err}`);
    }
}
/** Remove a connection's tools/handlers from the shared registry. */
function unregisterConnectionTools(conn) {
    for (const toolName of conn.registeredToolNames) {
        unregisterDynamicTool(toolName);
        unregisterDynamicHandler(toolName);
        usedToolNames.delete(toolName);
    }
    conn.registeredToolNames = [];
}
/** Close one connection and forget it, whether called from closeMcp or re-init. */
async function closeConnection(name, conn) {
    try {
        logger.debug(`Closing MCP connection: ${name}`);
        await conn.client.close();
    }
    catch (err) {
        logger.error(`Error closing MCP connection [${name}]: ${err}`);
    }
    unregisterConnectionTools(conn);
    connections.delete(name);
}
/**
 * Load MCP configuration and connect to all configured servers.
 * Registers their tools in the dynamic tool registry.
 */
export async function initializeMcp() {
    await loadRuntimeConfig();
    const servers = getRuntimeConfig().mcp?.servers || {};
    if (Object.keys(servers).length === 0)
        return;
    logger.info('Loading MCP servers from merged runtime config');
    for (const [name, serverConfig] of Object.entries(servers)) {
        // Re-init or config change: drop any prior connection and its tools first.
        const existing = connections.get(name);
        if (existing)
            await closeConnection(name, existing);
        if (serverConfig && typeof serverConfig === 'object' && serverConfig.enabled === false) {
            logger.debug(`Skipping disabled MCP server: ${name}`);
            continue;
        }
        const configError = mcpConfigError(serverConfig);
        if (configError) {
            logger.error(`Skipping MCP server "${name}": ${configError}`);
            continue;
        }
        try {
            let conn;
            if (serverConfig.type === 'stdio') {
                logger.debug(`Connecting to stdio MCP server: ${name}`);
                conn = await connectStdioServer(name, serverConfig);
            }
            else {
                logger.debug(`Connecting to HTTP MCP server: ${name} (${serverConfig.url})`);
                conn = await connectHttpServer(name, serverConfig);
            }
            connections.set(name, conn);
            await registerMcpTools(conn);
        }
        catch (err) {
            logger.error(`Failed to connect to MCP server "${name}": ${err}`);
        }
    }
}
/**
 * Close all MCP connections and unregister their dynamic tools/handlers.
 */
export async function closeMcp() {
    for (const [name, conn] of [...connections]) {
        await closeConnection(name, conn);
    }
}
/**
 * Get the names of all connected MCP servers.
 */
export function getConnectedMcpServers() {
    return Array.from(connections.keys());
}
