import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import { verifyAdmin } from "../../middleware/verifyAdmin.js";
import {
  getProfile,
  updateProfile,
  getAllUsers,
  changeUserRole,
} from "./users.controller.js";

const router = Router();

router.get("/profile", verifyToken, asyncHandler(getProfile));
router.put("/profile", verifyToken, asyncHandler(updateProfile));
router.get("/users", verifyToken, verifyAdmin, asyncHandler(getAllUsers));
router.patch("/users/:id/role", verifyToken, verifyAdmin, asyncHandler(changeUserRole));

export default router;
