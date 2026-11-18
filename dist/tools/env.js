/** env tool — safe environment inspection. */
import { cap, errorMessage } from './system-helpers.js';
// Names that conventionally carry credentials. Substring match so API_KEY,
// GITHUB_TOKEN, DB_PASSWORD, AWS_CREDENTIALS, etc. are all covered.
const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
export const envTool = {
    type: 'function',
    function: {
        name: 'env',
        description: 'Read environment information safely. With no name, lists variable names only (never values). ' +
            'With a name, reads one value; sensitive names are shown as <redacted> unless redact is false.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Single environment variable to read. Omit to list variable names.' },
                redact: { type: 'boolean', description: 'Hide values of sensitive variables (default true). Only applies when name is given.' },
            },
            required: [],
        },
    },
};
export async function readEnv(name, redact = true) {
    try {
        if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
            return 'Error: name must be a non-empty string.';
        }
        if (typeof redact !== 'boolean')
            return 'Error: redact must be a boolean.';
        // No explicit name: names only, regardless of redact — never dump all values.
        if (name === undefined) {
            const keys = Object.keys(process.env).sort();
            if (keys.length === 0)
                return 'Environment is empty.';
            return cap(`Environment variables (${keys.length}, names only — pass name to read a value):\n${keys.join('\n')}`);
        }
        const value = process.env[name];
        if (value === undefined)
            return `Environment variable '${name}' is not set.`;
        const display = SENSITIVE_NAME.test(name) && redact ? '<redacted>' : value;
        return cap(`${name}=${display}`);
    }
    catch (err) {
        return `Error: ${errorMessage(err)}`;
    }
}
