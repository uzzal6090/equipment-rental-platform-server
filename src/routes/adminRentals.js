import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";
import { success, error } from "../utils/response.js";
import { listAdminRentals } from "../modules/equipment/adminRentals.service.js";

const router = express.Router();

// All admin rentals routes require authentication and admin role
router.use(verifyToken, verifyAdmin);

// GET /api/admin/rentals - List all rentals for admin
router.get("/", async (req, res) => {
  try {
    const result = await listAdminRentals(req.query);
    return success(res, result);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to fetch admin rentals", 500, "FETCH_ADMIN_RENTALS_FAILED");
  }
});

export { router as adminRentalsRouter };