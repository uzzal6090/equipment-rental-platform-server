import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import { verifyOwner } from "../../middleware/verifyOwner.js";
import { verifyAdmin } from "../../middleware/verifyAdmin.js";
import {
  getAllEquipment,
  getFeaturedEquipment,
  getEquipmentById,
  createEquipment,
  updateEquipment,
  deleteEquipment,
  updateEquipmentStatus,
} from "./equipment.controller.js";

const router = Router();

// Public routes
router.get("/featured", asyncHandler(getFeaturedEquipment));
router.get("/:id", asyncHandler(getEquipmentById));
router.get("/", asyncHandler(getAllEquipment));

// Owner routes
router.post("/", verifyToken, verifyOwner, asyncHandler(createEquipment));
router.put("/:id", verifyToken, verifyOwner, asyncHandler(updateEquipment));

// Owner or Admin delete
router.delete("/:id", verifyToken, asyncHandler(deleteEquipment));

// Admin only - approve/reject
router.patch("/:id/status", verifyToken, verifyAdmin, asyncHandler(updateEquipmentStatus));

export default router;
