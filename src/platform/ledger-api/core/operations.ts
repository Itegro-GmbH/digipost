// Owner: src/platform/ledger-api (decisions/0081-ledger-via-api.md). Which operations are reads.
// The API's catalog names every read `list_*`, `get_*` or `find_*`; everything else changes data
// and needs an `Idempotency-Key`. A read never needs one (the API ignores it there), so treating
// an unknown name as a write is the safe direction.

const READ_OPERATION = /^(list|get|find)_/;
const OPERATION_NAME = /^[a-z][a-z0-9_]*$/;

export function isLedgerApiReadOperation(operation: string): boolean {
  return READ_OPERATION.test(operation);
}

export function isLedgerApiOperationName(operation: string): boolean {
  return OPERATION_NAME.test(operation);
}
