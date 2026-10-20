import express, { Request, Response } from "express";
import connectDb from "../db/connectDb";
import { requireAdminScope } from "../middleware/adminAuth";
import {
  EscalationPolicyError,
  auditingNotifier,
  buildEscalationReport,
  loadEscalationPolicy,
  loadUnresolvedFailures,
  runEscalationSweep,
} from "../services/failureEscalation";

/**
 * Failure escalation (#904). Mounted at /api/admin/escalations.
 *
 *   GET  /policy   the active policy                 escalations:read
 *   GET  /report   escalations that have started     escalations:read
 *   POST /sweep    notify every due failure once     escalations:write
 *
 * The policy comes from ESCALATION_POLICY_JSON. An invalid value is reported,
 * not silently replaced by the default.
 */
export const failureEscalationRouter = express.Router();

function activePolicyOrError(res: Response) {
  try {
    return loadEscalationPolicy(process.env.ESCALATION_POLICY_JSON);
  } catch (err) {
    if (err instanceof EscalationPolicyError) {
      res.status(500).json({ error: err.message, code: "invalid_policy", issues: err.issues });
      return null;
    }
    throw err;
  }
}

failureEscalationRouter.get(
  "/policy",
  requireAdminScope("escalations:read"),
  async (_req: Request, res: Response) => {
    const policy = activePolicyOrError(res);
    if (!policy) return;
    return res.json({ success: true, policy });
  },
);

failureEscalationRouter.get(
  "/report",
  requireAdminScope("escalations:read"),
  async (req: Request, res: Response) => {
    try {
      const policy = activePolicyOrError(res);
      if (!policy) return;
      await connectDb();
      const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const failures = await loadUnresolvedFailures(limit);
      return res.json({ success: true, report: buildEscalationReport(failures, policy) });
    } catch (err) {
      console.error("Escalation report error:", err);
      return res.status(500).json({ error: "Failed to build escalation report." });
    }
  },
);

failureEscalationRouter.post(
  "/sweep",
  requireAdminScope("escalations:write"),
  async (_req: Request, res: Response) => {
    try {
      const policy = activePolicyOrError(res);
      if (!policy) return;
      await connectDb();
      const result = await runEscalationSweep({ policy, notify: auditingNotifier });
      return res.json({ success: true, policyVersion: policy.version, result });
    } catch (err) {
      console.error("Escalation sweep error:", err);
      return res.status(500).json({ error: "Failed to run escalation sweep." });
    }
  },
);
