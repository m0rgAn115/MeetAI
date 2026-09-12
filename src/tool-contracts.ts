export interface InternalToolContract {
  name: string;
  parameters: string;
  response: string;
  permissions: string;
  sideEffects: string;
  retries: string;
  errors: string[];
  humanConfirmation: boolean;
}

export const INTERNAL_TOOL_CONTRACTS: InternalToolContract[] = [
  {
    name: "retrieve_context",
    parameters: "workspaceId, userId, query, optional projectId/participants/asOf/limit",
    response: "Memories with source, provenance, dates, confidence, relations and supporting quote",
    permissions: "Authenticated workspace member; every source is filtered by its permissions snapshot",
    sideEffects: "None",
    retries: "Safe and deterministic for the same inputs",
    errors: ["UNAUTHENTICATED", "FORBIDDEN", "INVALID_QUERY", "RETRIEVAL_UNAVAILABLE"],
    humanConfirmation: false,
  },
  {
    name: "get_memory_neighborhood",
    parameters: "workspaceId, userId, memoryId, maxDepth (MVP maximum 1)",
    response: "Accessible neighboring memories and the traversed edges",
    permissions: "Access to the root and every returned source",
    sideEffects: "None",
    retries: "Safe",
    errors: ["FORBIDDEN", "NOT_FOUND"],
    humanConfirmation: false,
  },
  {
    name: "get_current_commitments",
    parameters: "workspaceId, userId, optional projectId/participant/asOf",
    response: "Current accessible commitment-like memories with evidence",
    permissions: "Workspace membership plus source ACLs",
    sideEffects: "None",
    retries: "Safe",
    errors: ["FORBIDDEN", "RETRIEVAL_UNAVAILABLE"],
    humanConfirmation: false,
  },
  {
    name: "persist_memory_mutations",
    parameters: "workspaceId, actorId, correlationId, idempotencyKey, validated proposals",
    response: "Created/updated memory and edge identifiers",
    permissions: "Curator service role scoped to one workspace",
    sideEffects: "Transactional inserts and temporal validity updates; never deletes history",
    retries: "Idempotent by workspace and idempotency key",
    errors: ["INVALID_PROPOSAL", "STALE_TARGET", "FORBIDDEN", "TRANSACTION_FAILED"],
    humanConfirmation: false,
  },
  {
    name: "propose_calendar_event",
    parameters: "workspaceId, meetingId, calendar payload, idempotencyKey",
    response: "Stored proposal and user-visible preview",
    permissions: "Workspace member with access to the meeting",
    sideEffects: "Stores a proposal only; does not call Google Calendar",
    retries: "Returns the existing proposal for the idempotency key",
    errors: ["INVALID_TIME", "FORBIDDEN", "DUPLICATE_KEY_MISMATCH"],
    humanConfirmation: false,
  },
  {
    name: "confirm_calendar_event",
    parameters: "proposalId, userId, optional edited payload",
    response: "Execution status and Google Calendar result",
    permissions: "Explicitly authenticated user with access to the proposal and connected Google account",
    sideEffects: "Creates or updates one Calendar event and records execution evidence",
    retries: "Idempotent; completed proposals return the recorded result",
    errors: ["NOT_CONFIRMED", "FORBIDDEN", "GOOGLE_NOT_CONNECTED", "EXECUTION_FAILED"],
    humanConfirmation: true,
  },
  {
    name: "open_drive_document",
    parameters: "workspaceId, userId, documentId or URI",
    response: "Authorized metadata/link or bounded content excerpt",
    permissions: "Google Drive access is checked with the current user's OAuth credentials",
    sideEffects: "None",
    retries: "Safe",
    errors: ["FORBIDDEN", "NOT_FOUND", "GOOGLE_NOT_CONNECTED"],
    humanConfirmation: false,
  },
  {
    name: "record_signal_feedback",
    parameters: "signalId, userId, reaction (accepted/edited/dismissed/postponed), optional note",
    response: "Recorded feedback identifier and timestamp",
    permissions: "Access to the originating meeting signal",
    sideEffects: "Appends feedback; does not rewrite the signal",
    retries: "Idempotent for signal, user and feedback idempotency key",
    errors: ["FORBIDDEN", "SIGNAL_NOT_FOUND"],
    humanConfirmation: false,
  },
];
