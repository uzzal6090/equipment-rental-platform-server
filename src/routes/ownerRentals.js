import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyOwner } from "../middleware/verifyOwner.js";
import { success, error } from "../utils/response.js";
import { listOwnerRentals } from "../modules/equipment/ownerRentals.service.js";

const router = express.Router();

// All owner rentals routes require authentication and owner role
router.use(verifyToken, verifyOwner);

// GET /api/owner/rentals - List rentals for equipment owned by the authenticated owner
router.get("/", async (req, res) => {
  try {
    const ownerId = req.profile.profileId.toString();
    const result = await listOwnerRentals(ownerId, req.query);
    return success(res, result);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to fetch owner rentals", 500, "FETCH_OWNER_RENTALS_FAILED");
  }
});

export { router as ownerRentalsRouter };