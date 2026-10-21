import { beforeEach, describe, expect, it } from "vitest";
import {
  SECURITY_EVENT_POLICY,
  SessionRevocationError,
  SessionRevocationRegistry,
  invalidateSessionsForSecurityEvent,
  type RevocationActor,
  type SecurityEventType,
} from "../services/sessionRevocationService";

/**
 * Security-event session invalidation policy (#908).
 *
 * Builds on the revocation registry (#1031): each security event type has a
 * scope and a user-safe message, and the policy entry point applies that scope.
 */

const ADMIN: RevocationActor = {
  id: "ops-sec-lead",
  role: "admin",
  permissions: new Set(["admin", "security:revoke"]),
};

const UNAUTHORIZED: RevocationActor = {
  id: "guest-user",
  role: "viewer",
  permissions: new Set(["prompts:read"]),
};

const WALLET = "GBZXN7PIRZGNMHGA728R374OXZW6W5Y45PNM26QCOHOHOGIPLDTZQK7U";
const OTHER_WALLET = "GCZXN7PIRZGNMHGA728R374OXZW6W5Y45PNM26QCOHOHOGIPLDTZQK7U";
const T0 = 1_000_000;
const EVENT_AT = T0 + 10_000;

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

const SUBJECT_EVENTS: SecurityEventType[] = [
  "wallet_compromise",
  "admin_key_rotation",
  "permission_revocation",
  "suspicious_activity",
  "explicit_logout_all",
  "credential_change",
  "role_change",
  "account_recovery",
];

describe("security event policy (#908)", () => {
  it("defines a scope and a user-safe message for every event type", () => {
    for (const [type, policy] of Object.entries(SECURITY_EVENT_POLICY)) {
      expect(["subject", "global"]).toContain(policy.scope);
      expect(policy.userMessage.length, type).toBeGreaterThan(0);
      expect(policy.userMessage, type).not.toMatch(/reason|secret|key leak/i);
    }
  });

  it("scopes only the emergency cutoff platform-wide", () => {
    const globalEvents = Object.entries(SECURITY_EVENT_POLICY)
      .filter(([, policy]) => policy.scope === "global")
      .map(([type]) => type);
    expect(globalEvents).toEqual(["global_emergency_cutoff"]);
  });
});

describe("invalidateSessionsForSecurityEvent (#908)", () => {
  let registry: SessionRevocationRegistry;

  beforeEach(() => {
    registry = new SessionRevocationRegistry();
  });

  it.each(SUBJECT_EVENTS)(
    "%s ends the account's earlier sessions with its user message",
    (type) => {
      invalidateSessionsForSecurityEvent(
        registry,
        { type, subject: WALLET, reason: "internal ticket SEC-4412", actor: ADMIN },
        EVENT_AT,
      );

      const stale = registry.isRevoked(WALLET, T0);
      expect(stale).toMatchObject({
        revoked: true,
        code: "subject_revoked_by_security_event",
        message: SECURITY_EVENT_POLICY[type].userMessage,
      });
    },
  );

  it("never shows the internal reason to the user", () => {
    invalidateSessionsForSecurityEvent(
      registry,
      { type: "credential_change", subject: WALLET, reason: "phishing report from ops-7 (SEC-4412)", actor: ADMIN },
      EVENT_AT,
    );

    const stale = registry.isRevoked(WALLET, T0);
    expect(stale.message).not.toContain("phishing");
    expect(stale.message).not.toContain("SEC-4412");
    // Operators still see the detail through the registry's status and audit trail.
    expect(stale.reason).toContain("SEC-4412");
  });

  it("admits sessions issued after the event, so the user can sign in again", () => {
    invalidateSessionsForSecurityEvent(
      registry,
      { type: "account_recovery", subject: WALLET, reason: "recovery completed", actor: ADMIN },
      EVENT_AT,
    );

    expect(registry.isRevoked(WALLET, EVENT_AT + 5_000).revoked).toBe(false);
  });

  it("leaves other accounts' sessions usable", () => {
    invalidateSessionsForSecurityEvent(
      registry,
      { type: "role_change", subject: WALLET, reason: "role downgraded", actor: ADMIN },
      EVENT_AT,
    );

    expect(registry.isRevoked(OTHER_WALLET, T0).revoked).toBe(false);
  });

  it("rejects an emergency cutoff that does not target all sessions, and a subject event that does", () => {
    const emergencyOnOneAccount = captureError(() =>
      invalidateSessionsForSecurityEvent(
        registry,
        { type: "global_emergency_cutoff", subject: WALLET, reason: "secret leak", actor: ADMIN },
        EVENT_AT,
      ),
    );
    expect(emergencyOnOneAccount).toBeInstanceOf(SessionRevocationError);
    expect(emergencyOnOneAccount).toMatchObject({ code: "invalid_subject" });

    const subjectEventOnAll = captureError(() =>
      invalidateSessionsForSecurityEvent(
        registry,
        { type: "credential_change", subject: "*", reason: "password change", actor: ADMIN },
        EVENT_AT,
      ),
    );
    expect(subjectEventOnAll).toMatchObject({ code: "invalid_subject" });
  });

  it("ends every session for a global emergency cutoff", () => {
    invalidateSessionsForSecurityEvent(
      registry,
      { type: "global_emergency_cutoff", subject: "*", reason: "root signing secret rotated", actor: ADMIN },
      EVENT_AT,
    );

    expect(registry.isRevoked(WALLET, T0)).toMatchObject({
      revoked: true,
      code: "global_security_event",
      message: SECURITY_EVENT_POLICY.global_emergency_cutoff.userMessage,
    });
    expect(registry.isRevoked(OTHER_WALLET, T0).revoked).toBe(true);
  });

  it("rejects a leaked token by its nonce, while other tokens issued after the event stay valid", () => {
    registry.recordSecurityEvent(
      {
        type: "suspicious_activity",
        targetSubject: WALLET,
        targetNonce: "nonce-leaked",
        reason: "token leaked in a screenshot",
        actor: ADMIN,
      },
      EVENT_AT,
    );

    // Issued after the subject cutoff, so only the nonce can reject it.
    const issuedAfterEvent = EVENT_AT + 500;
    const leaked = registry.isRevoked(WALLET, issuedAfterEvent, "nonce-leaked", EVENT_AT + 1_000);
    expect(leaked).toMatchObject({ revoked: true, code: "token_nonce_revoked" });
    expect(leaked.message).toContain("Sign in again");

    expect(registry.isRevoked(WALLET, issuedAfterEvent, "nonce-fresh", EVENT_AT + 1_000).revoked).toBe(false);
  });

  it("refuses to record a security event for an actor without authority", () => {
    const error = captureError(() =>
      invalidateSessionsForSecurityEvent(
        registry,
        { type: "explicit_logout_all", subject: WALLET, reason: "user request", actor: UNAUTHORIZED },
        EVENT_AT,
      ),
    );
    expect(error).toMatchObject({ code: "unauthorized" });
  });
});
