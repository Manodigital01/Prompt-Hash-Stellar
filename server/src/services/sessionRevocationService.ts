/**
 * Stale Session and Token Revocation After Security Events (#1031).
 *
 * Provides granular and global session invalidation triggered by security
 * incidents (e.g. wallet key compromise, admin secret rotation, permission
 * downgrade, brute-force step-up detection, or explicit global cutoffs).
 *
 * Invalidation Mechanisms:
 *   1. Subject Cutoff (Wallet or Admin):
 *      Invalidates all tokens for `subject` issued on or before `revokedBefore`.
 *      Any token presented with `issuedAt <= revokedBefore` is immediately rejected.
 *   2. Token/Nonce Revocation:
 *      Revokes specific token nonces or session IDs.
 *   3. Global Emergency Cutoff:
 *      Invalidates all sessions across the platform issued before a critical timestamp
 *      (e.g., during emergency secret rotations).
 *
 * Space & Time Complexity:
 *   - Lookup: O(1) constant-time hash map lookups.
 *   - Storage: O(M) where M is the number of active revocation records within
 *     the retention window (MAX_REVOCATION_RETENTION_MS). Expired revocation records
 *     are pruned automatically since tokens beyond max TTL expire naturally.
 */

import { createHash, randomUUID } from "crypto";

const sessionLogger = {
  warn(msg: string, meta?: Record<string, unknown>) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(JSON.stringify({ level: "warn", msg, ...meta, timestamp: new Date().toISOString() }));
    }
  },
  info(msg: string, meta?: Record<string, unknown>) {
    if (process.env.NODE_ENV !== "test") {
      console.info(JSON.stringify({ level: "info", msg, ...meta, timestamp: new Date().toISOString() }));
    }
  },
};

export const MAX_REVOCATION_RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours
export const MAX_RECORDS_BEFORE_PRUNE = 5_000;

export type SecurityEventType =
  | "wallet_compromise"
  | "admin_key_rotation"
  | "permission_revocation"
  | "suspicious_activity"
  | "explicit_logout_all"
  | "global_emergency_cutoff";

export interface SecurityRevocationEvent {
  eventId: string;
  type: SecurityEventType;
  targetSubject: string; // Stellar address "G...", admin "ops-...", or "*"
  targetNonce?: string;
  reason: string;
  revokedBefore: number; // millisecond timestamp: tokens issued <= this are revoked
  createdAt: number;
  actorId: string;
  metadata?: Record<string, unknown>;
}

export interface RevocationStatus {
  revoked: boolean;
  code?:
    | "global_security_event"
    | "subject_revoked_by_security_event"
    | "token_nonce_revoked";
  reason?: string;
  revocationEventId?: string;
}

export interface RevocationActor {
  id: string;
  role?: string;
  permissions: ReadonlySet<string>;
}

export type RevocationErrorCode =
  | "unauthorized"
  | "invalid_subject"
  | "invalid_timestamp"
  | "not_found";

export class SessionRevocationError extends Error {
  readonly code: RevocationErrorCode;
  constructor(
    code: RevocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionRevocationError";
    this.code = code;
  }
}

/**
 * Normalizes subjects (Stellar wallets to uppercase, admin handles trimmed).
 */
export function normalizeSubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed === "*") return "*";
  if (/^G[A-Z2-7]{55}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return trimmed.toLowerCase();
}

/**
 * In-memory revocation registry with bounded TTL pruning.
 */
export class SessionRevocationRegistry {
  private subjectCutoffs = new Map<
    string,
    { revokedBefore: number; eventId: string; reason: string; createdAt: number }
  >();
  private revokedNonces = new Map<string, { expiresAt: number; eventId: string }>();
  private globalCutoff: {
    revokedBefore: number;
    eventId: string;
    reason: string;
  } | null = null;
  private auditLog: SecurityRevocationEvent[] = [];
  readonly retentionMs: number;

  constructor(retentionMs = MAX_REVOCATION_RETENTION_MS) {
    this.retentionMs = retentionMs;
  }

  /**
   * Records a security revocation event with authorization verification.
   */
  public recordSecurityEvent(
    event: {
      type: SecurityEventType;
      targetSubject: string;
      targetNonce?: string;
      reason: string;
      revokedBefore?: number;
      actor: RevocationActor;
      metadata?: Record<string, unknown>;
    },
    now = Date.now(),
  ): SecurityRevocationEvent {
    // 1. Authorization check
    const isAuthorized =
      event.actor.permissions.has("admin") ||
      event.actor.permissions.has("security:revoke");
    if (!isAuthorized) {
      throw new SessionRevocationError(
        "unauthorized",
        `Actor ${event.actor.id} lacks authorization to trigger security revocations.`,
      );
    }

    if (!event.targetSubject || event.targetSubject.trim().length === 0) {
      throw new SessionRevocationError("invalid_subject", "Target subject is required.");
    }

    const normSubject = normalizeSubject(event.targetSubject);
    const cutoff = event.revokedBefore ?? now;

    if (cutoff > now + 60_000) {
      throw new SessionRevocationError(
        "invalid_timestamp",
        "revokedBefore cannot be substantially in the future.",
      );
    }

    const eventRecord: SecurityRevocationEvent = {
      eventId: `sec_evt_${randomUUID()}`,
      type: event.type,
      targetSubject: normSubject,
      targetNonce: event.targetNonce,
      reason: event.reason,
      revokedBefore: cutoff,
      createdAt: now,
      actorId: event.actor.id,
      metadata: event.metadata,
    };

    // 2. Apply revocation idempotently
    if (normSubject === "*") {
      const prevCutoff = this.globalCutoff?.revokedBefore ?? 0;
      this.globalCutoff = {
        revokedBefore: Math.max(prevCutoff, cutoff),
        eventId: eventRecord.eventId,
        reason: eventRecord.reason,
      };
    } else {
      const existing = this.subjectCutoffs.get(normSubject);
      const newCutoff = existing ? Math.max(existing.revokedBefore, cutoff) : cutoff;
      this.subjectCutoffs.set(normSubject, {
        revokedBefore: newCutoff,
        eventId: eventRecord.eventId,
        reason: eventRecord.reason,
        createdAt: now,
      });
    }

    if (event.targetNonce) {
      this.revokedNonces.set(event.targetNonce, {
        expiresAt: now + this.retentionMs,
        eventId: eventRecord.eventId,
      });
    }

    this.auditLog.push(eventRecord);

    sessionLogger.warn("Security revocation event recorded", {
      eventId: eventRecord.eventId,
      type: eventRecord.type,
      targetSubject: normSubject,
      revokedBefore: cutoff,
      actorId: event.actor.id,
    });

    this.pruneExpiredEntries(now);
    return eventRecord;
  }

  /**
   * Fast O(1) check to determine if a session or token is revoked.
   */
  public isRevoked(
    subject: string,
    issuedAt: number,
    nonce?: string,
    now = Date.now(),
  ): RevocationStatus {
    // 1. Check global emergency cutoff
    if (this.globalCutoff && issuedAt <= this.globalCutoff.revokedBefore) {
      return {
        revoked: true,
        code: "global_security_event",
        reason: this.globalCutoff.reason,
        revocationEventId: this.globalCutoff.eventId,
      };
    }

    // 2. Check subject cutoff
    const normSubject = normalizeSubject(subject);
    const subjectEntry = this.subjectCutoffs.get(normSubject);
    if (subjectEntry && issuedAt <= subjectEntry.revokedBefore) {
      return {
        revoked: true,
        code: "subject_revoked_by_security_event",
        reason: subjectEntry.reason,
        revocationEventId: subjectEntry.eventId,
      };
    }

    // 3. Check individual nonce
    if (nonce) {
      const nonceEntry = this.revokedNonces.get(nonce);
      if (nonceEntry && now <= nonceEntry.expiresAt) {
        return {
          revoked: true,
          code: "token_nonce_revoked",
          reason: "Token nonce explicitly revoked.",
          revocationEventId: nonceEntry.eventId,
        };
      }
    }

    return { revoked: false };
  }

  /**
   * Reinstates a subject if an event was triggered in error (operational recovery).
   */
  public reinstateSubject(
    subject: string,
    actor: RevocationActor,
    reason: string,
  ): boolean {
    const isAuthorized =
      actor.permissions.has("admin") || actor.permissions.has("security:revoke");
    if (!isAuthorized) {
      throw new SessionRevocationError("unauthorized", "Actor unauthorized to reinstate subjects.");
    }

    const normSubject = normalizeSubject(subject);
    if (normSubject === "*") {
      this.globalCutoff = null;
      sessionLogger.info("Global emergency session cutoff cleared", { actorId: actor.id, reason });
      return true;
    }

    const existed = this.subjectCutoffs.delete(normSubject);
    if (existed) {
      sessionLogger.info("Subject session revocation cleared", {
        subject: normSubject,
        actorId: actor.id,
        reason,
      });
    }
    return existed;
  }

  /**
   * Prunes entries older than the retention window.
   */
  public pruneExpiredEntries(now = Date.now()): void {
    const threshold = now - this.retentionMs;

    for (const [subject, entry] of this.subjectCutoffs.entries()) {
      if (entry.createdAt < threshold) {
        this.subjectCutoffs.delete(subject);
      }
    }

    for (const [nonce, entry] of this.revokedNonces.entries()) {
      if (entry.expiresAt < now) {
        this.revokedNonces.delete(nonce);
      }
    }
  }

  /**
   * Returns copy of the in-memory audit log for forensic inspection.
   */
  public getAuditTrail(): readonly SecurityRevocationEvent[] {
    return [...this.auditLog];
  }

  /** Test helper to reset internal state. */
  public __resetForTests(): void {
    this.subjectCutoffs.clear();
    this.revokedNonces.clear();
    this.globalCutoff = null;
    this.auditLog = [];
  }
}

/** Global shared instance */
export const globalSessionRevocationRegistry = new SessionRevocationRegistry();
