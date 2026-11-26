import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import {
  createCheckoutIntent,
  getBookings,
  getBookingById,
  updateBookingStatus,
} from "./bookings.controller.js";

const router = Router();

router.post("/checkout-intent", verifyToken, asyncHandler(createCheckoutIntent));
router.get("/", verifyToken, asyncHandler(getBookings));
router.get("/:id", verifyToken, asyncHandler(getBookingById));
router.patch("/:id/status", verifyToken, asyncHandler(updateBookingStatus));

export default router;
