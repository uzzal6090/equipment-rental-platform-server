import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyRenter } from "../middleware/verifyRenter.js";
import { success, error } from "../utils/response.js";
import { listCustomerRentals } from "../modules/equipment/rentals.service.js";

const router = express.Router();

// All rentals routes require authentication and customer role
router.use(verifyToken, verifyRenter);

// GET /api/rentals - List customer's own rentals
router.get("/", async (req, res) => {
  try {
    const userId = req.profile.profileId.toString();
    const result = await listCustomerRentals(userId, req.query);
    return success(res, result);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to fetch rentals", 500, "FETCH_RENTALS_FAILED");
  }
});

export { router as rentalsRouter };