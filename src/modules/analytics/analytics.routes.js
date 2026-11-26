import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import { verifyAdmin } from "../../middleware/verifyAdmin.js";
import { verifyOwner } from "../../middleware/verifyOwner.js";
import { getAdminAnalytics, getOwnerAnalytics } from "./analytics.controller.js";

const router = Router();

router.get("/admin", verifyToken, verifyAdmin, asyncHandler(getAdminAnalytics));
router.get("/owner", verifyToken, verifyOwner, asyncHandler(getOwnerAnalytics));

export default router;
