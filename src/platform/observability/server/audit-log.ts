// Owner: src/platform/observability. A structured audit line for actions taken on a user's
// behalf by something other than the user's own browser - first consumer: the MCP server
// (decisions/0078-mcp-server.md), one line per tool call.
//
// One JSON object per line on stdout, so the hosting platform's log search can filter by
// `event` and any field. Only small identifiers and stable codes belong in `fields`: never
// document content, OCR text, names, e-mail addresses, amounts or any other personal data,
// and never a token (AGENTS.md "Security"). The type below allows only primitives, which
// keeps a whole object (a document, a contact) from being passed in by accident.
import "server-only";

export type AuditFieldValue = string | number | boolean | null;

export function logAuditEvent(event: string, fields: Record<string, AuditFieldValue>): void {
  try {
    console.info(JSON.stringify({ audit: event, at: new Date().toISOString(), ...fields }));
  } catch {
    // Logging must never break the request it describes.
  }
}
