import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import {
  getFavorites,
  addFavorite,
  removeFavorite,
  checkFavorite,
} from "./favorites.controller.js";

const router = Router();

router.get("/", verifyToken, asyncHandler(getFavorites));
router.get("/check/:equipmentId", verifyToken, asyncHandler(checkFavorite));
router.post("/", verifyToken, asyncHandler(addFavorite));
router.delete("/:equipmentId", verifyToken, asyncHandler(removeFavorite));

export default router;
