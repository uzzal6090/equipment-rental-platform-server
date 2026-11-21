import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyOwner } from "../middleware/verifyOwner.js";
import { success, error } from "../utils/response.js";
import { getOwnerAnalytics } from "../modules/owner/ownerAnalytics.service.js";

const router = express.Router();

// Owner Analytics endpoint
router.get("/analytics", verifyToken, verifyOwner, async (req, res) => {
  try {
    // Get owner ID from the authenticated user's profile
    const ownerId = req.user.profileId;
    const analytics = await getOwnerAnalytics(ownerId);
    return success(res, analytics);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to fetch analytics", 500, "FETCH_FAILED");
  }
});

export { router as ownerRouter };