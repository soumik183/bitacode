/**
 * Approval system for destructive operations.
 *
 * Two categories of approval:
 *  1. File operations (write_file, edit_file)
 *  2. Shell commands (non-whitelisted)
 *
 * Approval can be granted:
 *  - Per-operation (one-time)
 *  - Per-operation-type for the session (e.g., "approve all writes")
 *  - Globally via --dangerously-skip-permissions
 *
 * In the Ink UI, approvals are handled by emitting an event and waiting
 * for the UI to resolve it (instead of blocking on stdin with inquirer).
 */
// Global state
let dangerouslySkipPermissions = false;
const sessionApprovals = new Set(); // stores approval keys scoped by session
// Callback that the Ink UI provides to handle interactive approval
let approvalHandler = null;
export function setDangerouslySkipPermissions(value) {
    dangerouslySkipPermissions = value;
}
export function isDangerouslySkipPermissions() {
    return dangerouslySkipPermissions;
}
export function setApprovalHandler(handler) {
    approvalHandler = handler;
}
export function clearApprovalHandler() {
    approvalHandler = null;
}
export function clearSessionApprovals() {
    sessionApprovals.clear();
}
function getApprovalScopeKey(req) {
    const sessionId = req.sessionId ?? '__global__';
    const scope = req.sessionScopeKey ?? req.type;
    return `${sessionId}:${scope}`;
}
/**
 * Request approval for an operation. Returns true if approved.
 *
 * Check order:
 *  1. --dangerously-skip-permissions → auto-approve
 *  2. Session approval for this type → auto-approve
 *  3. Interactive prompt via the UI handler
 *  4. No handler registered → reject (fail closed)
 */
export async function requestApproval(req) {
    if (dangerouslySkipPermissions)
        return true;
    const sessionKey = getApprovalScopeKey(req);
    if (sessionApprovals.has(sessionKey))
        return true;
    if (!approvalHandler) {
        return false;
    }
    const response = await approvalHandler(req);
    switch (response) {
        case 'approve_once':
            return true;
        case 'approve_session':
            sessionApprovals.add(sessionKey);
            return true;
        case 'reject':
            return false;
        default:
            return false;
    }
}
