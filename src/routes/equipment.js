import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyOwner } from "../middleware/verifyOwner.js";
import { success, error } from "../utils/response.js";
import {
  listEquipment,
  getEquipmentDetails,
  createEquipment,
  getOwnerEquipment,
  updateEquipment,
  deleteEquipment,
} from "../modules/equipment/equipment.service.js";

const router = express.Router();

// GET /api/equipment - Public equipment listing with search, filters, sort, pagination
router.get("/", async (req, res) => {
  try {
    const result = await listEquipment(req.query);
    return success(res, result);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code, err.errors);
    }
    return error(res, "Failed to fetch equipment", 500, "FETCH_FAILED");
  }
});

// POST /api/equipment - Owner creates new equipment
router.post("/", verifyToken, verifyOwner, async (req, res) => {
  try {
    const ownerId = req.profile.profileId.toString();
    const equipment = await createEquipment(ownerId, req.body);
    return success(res, { equipment }, 201);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code, err.errors);
    }
    return error(res, "Failed to create equipment", 500, "CREATE_FAILED");
  }
});

// GET /api/equipment/owner/me - Owner's equipment list (all statuses)
router.get("/owner/me", verifyToken, verifyOwner, async (req, res) => {
  try {
    const ownerId = req.profile.profileId.toString();
    const result = await getOwnerEquipment(ownerId, req.query);
    return success(res, result);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to fetch owner equipment", 500, "FETCH_FAILED");
  }
});

// GET /api/equipment/:id - Private equipment details (auth required)
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const equipment = await getEquipmentDetails(req.params.id, req.profile);
    if (!equipment) {
      return error(res, "Equipment not found", 404, "EQUIPMENT_NOT_FOUND");
    }
    return success(res, { equipment });
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to fetch equipment", 500, "FETCH_FAILED");
  }
});

// PUT /api/equipment/:id - Owner updates their equipment
router.put("/:id", verifyToken, verifyOwner, async (req, res) => {
  try {
    const ownerId = req.profile.profileId.toString();
    const equipment = await updateEquipment(req.params.id, ownerId, req.body);
    return success(res, { equipment });
  } catch (err) {
    console.error("UPDATE EQUIPMENT ERROR:", err);
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to update equipment", 500, "UPDATE_FAILED");
  }
});

// DELETE /api/equipment/:id - Owner deletes their equipment
router.delete("/:id", verifyToken, verifyOwner, async (req, res) => {
  try {
    const ownerId = req.profile.profileId.toString();
    const result = await deleteEquipment(req.params.id, ownerId);
    return success(res, result);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to delete equipment", 500, "DELETE_FAILED");
  }
});

export { router as equipmentRouter };