import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import { getReviews, getEquipmentReviews, createReview } from "./reviews.controller.js";

const router = Router();

router.get("/", asyncHandler(getReviews));
router.get("/equipment/:id", asyncHandler(getEquipmentReviews));
router.post("/", verifyToken, asyncHandler(createReview));

export default router;
