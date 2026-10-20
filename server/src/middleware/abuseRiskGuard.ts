/**
 * Express guard that scores a high-impact operation before its handler runs.
 *
 *   allow    → next()
 *   step_up  → proceeds only with a verified, unexpired step-up record or a
 *              freshly signed wallet session for the acting wallet. Otherwise
 *              403 with STEP_UP_REQUIRED, STEP_UP_EXPIRED, STEP_UP_FAILED or
 *              STEP_UP_LOCKED (#901). See services/stepUpVerification.ts
 *   review   → 202 REVIEW_REQUIRED with a review id; the operation is held
 *              until an admin approves it (one-shot approval)
 *   block    → 403 OPERATION_BLOCKED
 *
 * Every non-allow response is self-explaining: it carries `riskScore`, a
 * plain-language `summary`, a `remedy` telling the caller what to do next,
 * and per-signal `reasons` with code/points/observed/threshold/explanation,
 * so a reviewer or support engineer can reconstruct the decision without
 * server-side lookups (#1046).
 *
 * Mode comes from ABUSE_RISK_MODE (`off` | `shadow` | `enforce`, default
 * `shadow`). In `shadow` every decision is logged but nothing is enforced;
 * flipping to `off` is the instant rollback. See docs/abuse-risk-detection.md.
 */

import { NextFunction, Request, Response } from "express";
import {
  abuseActivityLedger,
  EvaluationOutcome,
  evaluateOperation,
  HighImpactOperation,
  OperationContext,
  parseRiskMode,
  RiskAssessment,
  RiskMode,
} from "../services/abuseRiskScoring";
import { hasFreshWalletSession } from "./walletSession";
import { logger } from "../services/structuredLogger";
import { recordAuditEvent } from "../services/auditTrail";
import {
  evaluateStepUp,
  stepUpKey,
  stepUpRemedy,
  stepUpVerificationStore,
} from "../services/stepUpVerification";

export interface AbuseRiskGuardOptions {
  operation: HighImpactOperation;
  /** Extract the context fields from the request; wallet is required. */
  extract: (req: Request) => Omit<OperationContext, "operation" | "now"> | null;
  /** Override mode resolution (tests). Defaults to ABUSE_RISK_MODE. */
  mode?: () => RiskMode;
  /** Override step-up proof (tests). Defaults to a fresh wallet session. */
  stepUpSatisfied?: (req: Request, wallet: string) => boolean;
}

export interface RiskAnnotatedRequest extends Request {
  riskOutcome?: EvaluationOutcome;
}

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || undefined;
}

function recordStepUpEvent(
  ctx: OperationContext,
  action: "step_up_verified" | "step_up_failed" | "step_up_locked",
  result: "success" | "blocked",
  detail: string,
): void {
  void recordAuditEvent({
    action,
    result,
    promptId: ctx.target ?? null,
    walletAddress: ctx.wallet,
    reason: `op=${ctx.operation} ${detail}`,
  });
}

/**
 * Per-signal explanation payload returned to the client. Everything a
 * reviewer needs to re-derive the decision: the raw points before impact
 * weighting, the observed value vs the threshold that fired it, and whether
 * the signal is critical (the only kind that can justify a block).
 */
export function explainReasons(assessment: RiskAssessment) {
  return assessment.signals.map((s) => ({
    code: s.code,
    explanation: s.explanation,
    points: s.points,
    observed: s.observed,
    threshold: s.threshold,
    critical: s.critical,
  }));
}

export function abuseRiskGuard(options: AbuseRiskGuardOptions) {
  return function abuseRiskMiddleware(
    req: RiskAnnotatedRequest,
    res: Response,
    next: NextFunction,
  ): void {
    const mode = options.mode ? options.mode() : parseRiskMode(process.env.ABUSE_RISK_MODE);
    if (mode === "off") {
      next();
      return;
    }

    const fields = options.extract(req);
    // Without an identifiable wallet there is nothing to score; the route's
    // own validation will reject malformed requests.
    if (!fields || !fields.wallet) {
      next();
      return;
    }

    const ctx: OperationContext = {
      ...fields,
      operation: options.operation,
      ip: fields.ip ?? clientIp(req),
      now: Date.now(),
    };

    const outcome = evaluateOperation(ctx, mode);
    req.riskOutcome = outcome;
    const { assessment } = outcome;

    if (assessment.decision !== "allow") {
      // Wallet is deliberately omitted; the redactor also masks it.
      logger.info("abuse risk decision", {
        action: "abuseRisk",
        operation: ctx.operation,
        mode,
        decision: assessment.decision,
        enforced: outcome.action,
        score: assessment.score,
        signals: assessment.signals.map((s) => s.code),
        summary: assessment.summary,
        reviewId: outcome.reviewId,
      });
      void recordAuditEvent({
        action: "abuse_risk_decision",
        result: outcome.action === "allow" ? "success" : "blocked",
        promptId: ctx.target ?? null,
        walletAddress: ctx.wallet,
        requestId: (req as { requestId?: string }).requestId ?? null,
        reason: `op=${ctx.operation} mode=${mode} decision=${assessment.decision} enforced=${outcome.action} score=${assessment.score} signals=${assessment.signals.map((s) => s.code).join("|")}`,
      });
    }

    const finish = (ok: boolean) => abuseActivityLedger.record(ctx, ok);
    res.once("finish", () => finish(res.statusCode < 400));

    const stepUpOk = options.stepUpSatisfied
      ? options.stepUpSatisfied(req, ctx.wallet)
      : hasFreshWalletSession(req, ctx.wallet);

    switch (outcome.action) {
      case "allow":
        next();
        return;
      case "step_up": {
        const key = stepUpKey(ctx.wallet, ctx.operation, ctx.target);
        const now = ctx.now ?? Date.now();
        let evaluation = evaluateStepUp(stepUpVerificationStore.get(key), now);
        if (evaluation.allowed) {
          next();
          return;
        }

        // A locked subject is refused even with a valid proof (#901).
        // Otherwise a fresh session verifies, and a presented but rejected
        // proof spends one attempt.
        const proofPresented = Boolean(req.headers.authorization);
        if (evaluation.code !== "STEP_UP_LOCKED" && (stepUpOk || proofPresented)) {
          const record = stepUpVerificationStore.applyProof(key, stepUpOk, now);
          evaluation = evaluateStepUp(record, now);
          if (evaluation.allowed) {
            recordStepUpEvent(ctx, "step_up_verified", "success", "proof accepted");
            next();
            return;
          }
          recordStepUpEvent(
            ctx,
            evaluation.code === "STEP_UP_LOCKED" ? "step_up_locked" : "step_up_failed",
            "blocked",
            `code=${evaluation.code} attemptsRemaining=${evaluation.attemptsRemaining}`,
          );
        }

        res.status(403).json({
          error: "Additional verification required for this operation.",
          code: evaluation.code,
          riskScore: assessment.score,
          summary: assessment.summary,
          reasons: explainReasons(assessment),
          attemptsRemaining: evaluation.attemptsRemaining,
          ...(evaluation.allowed || evaluation.lockedUntil === undefined
            ? {}
            : { lockedUntil: new Date(evaluation.lockedUntil).toISOString() }),
          remedy: stepUpRemedy(evaluation.code),
        });
        return;
      }
      case "review":
        res.status(202).json({
          error: "This operation is held for review.",
          code: "REVIEW_REQUIRED",
          reviewId: outcome.reviewId,
          riskScore: assessment.score,
          summary: assessment.summary,
          reasons: explainReasons(assessment),
          remedy:
            "An admin must resolve the review (GET /api/admin/abuse-risk/reviews); retry with the same Idempotency-Key after approval.",
        });
        return;
      case "block":
        res.status(403).json({
          error: "This operation was blocked by abuse protection.",
          code: "OPERATION_BLOCKED",
          reviewId: outcome.reviewId,
          riskScore: assessment.score,
          summary: assessment.summary,
          reasons: explainReasons(assessment),
          remedy:
            "This operation was rejected on corroborated risk evidence. An admin can reset the subject's counters (POST /api/admin/abuse-risk/subjects/reset) if this is a false positive.",
        });
        return;
    }
  };
}
