import { Router } from "express";
import { requireAdminScope } from "../middleware/adminAuth";
import { ResolveOwnershipDispute } from "../controllers/ownershipDisputeControllers";

/**
 * Maintainer decisions on ownership transfer disputes (#907).
 * Mounted at /api/admin/ownership-disputes. Requires the `disputes:resolve` scope.
 */
export const ownershipDisputeAdminRouter = Router();
ownershipDisputeAdminRouter.use(requireAdminScope("disputes:resolve"));
ownershipDisputeAdminRouter.post("/:disputeId/resolve", ResolveOwnershipDispute);
