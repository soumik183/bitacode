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
 *  - Automatically via the configured approval mode (auto / yolo)
 *
 * In the Ink UI, approvals are handled by emitting an event and waiting
 * for the UI to resolve it (instead of blocking on stdin with inquirer).
 */
// Global state
let approvalMode = 'manual';
let cliSkipPermissions = false; // remembers the --dangerously-skip-permissions override
let dangerouslySkipPermissions = false;
const sessionApprovals = new Set(); // stores approval keys scoped by session
// Callback that the Ink UI provides to handle interactive approval
let approvalHandler = null;
function syncSkipPermissions() {
    dangerouslySkipPermissions = cliSkipPermissions || approvalMode === 'yolo';
}
export function setApprovalMode(mode) {
    approvalMode = mode;
    syncSkipPermissions();
}
export function getApprovalMode() {
    return approvalMode;
}
export function setDangerouslySkipPermissions(value) {
    cliSkipPermissions = value;
    syncSkipPermissions();
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
 *  1. auto / yolo mode (or --dangerously-skip-permissions) → auto-approve
 *  2. Session approval for this type → auto-approve
 *  3. Interactive prompt via the UI handler (manual mode only)
 *  4. No handler registered → reject (fail closed)
 */
export async function requestApproval(req) {
    if (approvalMode === 'auto' || approvalMode === 'yolo')
        return true;
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
/** Reset all global approval state. Intended for isolated tests only. */
export function resetApprovalStateForTests() {
    approvalMode = 'manual';
    cliSkipPermissions = false;
    dangerouslySkipPermissions = false;
    sessionApprovals.clear();
    approvalHandler = null;
}
