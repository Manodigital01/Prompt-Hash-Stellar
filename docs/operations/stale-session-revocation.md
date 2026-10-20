# Stale Session and Token Revocation After Security Events (#1031)

Stateless challenge tokens and HMAC bearer sessions protect self-service endpoints (`/api/wallet-session`) and privileged admin tasks (`/api/admin`). However, when security incidents occur—such as compromised wallet private keys, operator token leaks, permission downgrades, or root signing secret rotations—simply waiting for sessions to expire naturally leaves an unacceptable vulnerability window.

The Session Revocation Service (`server/src/services/sessionRevocationService.ts`) provides instantaneous, granular invalidation of stale sessions across both wallet sessions and operator admin tokens.

---

## 1. Revocation Mechanisms

1. **Subject Cutoff (`revokedBefore`)**:
   Sets a millisecond cutoff timestamp for an entity (a Stellar wallet address `G...` or an operator identifier `ops-...`).
   Any session presenting `issuedAt <= revokedBefore` is immediately refused (`401 Unauthorized`).
   New sessions created *after* the security event (with fresh wallet signatures or newly minted credentials) proceed normally.
2. **Specific Token / Nonce Revocation**:
   Revokes an individual token by its unique nonce without invalidating other valid sessions belonging to that actor.
3. **Global Emergency Cutoff (`targetSubject: "*"` )**:
   A global breaker for critical infrastructure events (e.g., suspected server secret leak). All tokens issued prior to the emergency timestamp are severed across the entire marketplace.

---

## 2. Security Event Lifecycle

```mermaid
graph TD
    A["Security Incident (Key Leak, Downgrade, Secret Rotation)"] --> B["Record Security Event via Registry"]
    B --> C["Update In-Memory Cutoff Map & Append to Audit Log"]
    C --> D["Incoming HTTP Request with Bearer Token"]
    D --> E{"IssuedAt <= Cutoff OR Nonce Revoked?"}
    E -- "Yes" --> F["401 Unauthorized (subject_revoked_by_security_event)"]
    E -- "No" --> G["Admit Request"]
```

---

## 3. Integration Points

- **Wallet Sessions (`server/src/middleware/walletSession.ts`)**:
  - `requireWalletSession`: Verifies `globalSessionRevocationRegistry.isRevoked(wallet, payload.issuedAt, payload.nonce)`.
  - `hasFreshWalletSession`: Validates step-up authentication tokens against active revocation cutoffs.
- **Admin Tokens (`server/src/services/adminToken.ts`)**:
  - `verifyAdminToken`: Checks operator subjects against active cutoffs.

---

## 4. Performance & Bounded Storage

- **Time Complexity**: $O(1)$ constant time lookup in hash maps during request authentication.
- **Space Complexity**: $O(M)$ bounded memory. Revocation records are automatically pruned after `MAX_REVOCATION_RETENTION_MS` (2 hours). Because tokens have a maximum TTL (e.g. 30–60 minutes), any token issued before an expired cutoff has already expired naturally, preventing memory leaks.

---

## 5. Operational Recovery & Rollback

- **False Alarm Recovery (`reinstateSubject`)**:
  If a security alert is verified as a false positive, authorized operators (`admin` or `security:revoke`) can call `reinstateSubject(subject, actor, reason)`. The subject's cutoff is removed, immediately restoring valid access and recording an audit trail entry.
- **Audit Logging**:
  All security events and reinstatements are logged in the immutable security audit log (`getAuditTrail()`).
