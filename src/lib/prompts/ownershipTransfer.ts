/**
 * Client for the OFF-CHAIN ownership transfer endpoints (#708, #1034).
 *
 * The Soroban contract's `Prompt.creator` is immutable; transfers only
 * re-point the indexed `Prompt.owner` after the recipient approves (or
 * rejects) a pending request. Mutations carry a wallet session token
 * (src/lib/auth/walletSession.ts) proving the acting wallet, plus an
 * Idempotency-Key so a retried click is not applied twice.
 * See docs/architecture.md.
 */

export type OwnershipTransferStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired";

export interface OwnershipTransferDto {
  id: string;
  promptId: string;
  promptTitle: string;
  fromWallet: string;
  toWallet: string;
  status: OwnershipTransferStatus;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface OwnershipTransferList {
  inbound: OwnershipTransferDto[];
  outbound: OwnershipTransferDto[];
}

async function throwServerError(res: Response): Promise<never> {
  let message = `Request failed (${res.status}).`;
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    // keep the fallback message when the body is not JSON
  }
  throw new Error(message);
}

async function postTransfer(
  path: string,
  sessionToken: string,
  body: Record<string, unknown>,
): Promise<OwnershipTransferDto> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return throwServerError(res);
  return res.json();
}

export async function listOwnershipTransfers(
  walletAddress: string,
): Promise<OwnershipTransferList> {
  const res = await fetch(
    `/api/prompts/transfers/${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) return throwServerError(res);
  return res.json();
}

export function requestOwnershipTransfer(
  sessionToken: string,
  input: { promptId: string; fromWallet: string; toWallet: string },
): Promise<OwnershipTransferDto> {
  return postTransfer("/api/prompts/transfers/request", sessionToken, input);
}

export function respondOwnershipTransfer(
  transferId: string,
  sessionToken: string,
  input: { walletAddress: string; decision: "approved" | "rejected" },
): Promise<OwnershipTransferDto> {
  return postTransfer(
    `/api/prompts/transfers/${encodeURIComponent(transferId)}/respond`,
    sessionToken,
    input,
  );
}

export function cancelOwnershipTransfer(
  transferId: string,
  sessionToken: string,
  input: { walletAddress: string },
): Promise<OwnershipTransferDto> {
  return postTransfer(
    `/api/prompts/transfers/${encodeURIComponent(transferId)}/cancel`,
    sessionToken,
    input,
  );
}
