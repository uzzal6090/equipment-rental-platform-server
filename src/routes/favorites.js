import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyRenter } from "../middleware/verifyRenter.js";
import { success, error } from "../utils/response.js";
import { addFavorite, listFavorites, removeFavorite } from "../modules/equipment/favorites.service.js";

const router = express.Router();

// All favorites routes require authentication and customer role
router.use(verifyToken, verifyRenter);

// POST /api/favorites - Add a favorite
router.post("/", async (req, res) => {
  console.error("[favoritesRouter] POST /api/favorites called");
  try {
    const userId = req.profile.profileId.toString();
    const { equipmentId } = req.body;
    console.error("[favoritesRouter] userId:", userId, "equipmentId:", equipmentId);

    if (!equipmentId) {
      return error(res, "equipmentId is required", 400, "VALIDATION_ERROR");
    }

    const favorite = await addFavorite(userId, equipmentId);
    return success(res, { favorite }, 201);
  } catch (err) {
    console.error("[favoritesRouter] error:", err);
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to add favorite", 500, "ADD_FAVORITE_FAILED");
  }
});

// GET /api/favorites - List customer's favorites
router.get("/", async (req, res) => {
  try {
    const userId = req.profile.profileId.toString();
    const result = await listFavorites(userId, req.query);
    return success(res, result);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to fetch favorites", 500, "FETCH_FAVORITES_FAILED");
  }
});

// DELETE /api/favorites/:id - Remove a favorite
router.delete("/:id", async (req, res) => {
  try {
    const userId = req.profile.profileId.toString();
    const result = await removeFavorite(userId, req.params.id);
    return success(res, result);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to remove favorite", 500, "REMOVE_FAVORITE_FAILED");
  }
});

export { router as favoritesRouter };