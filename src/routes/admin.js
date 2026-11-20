import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";
import { success, error } from "../utils/response.js";
import { listUsers, updateUserRole } from "../modules/admin/adminUsers.service.js";
import {
  listAllEquipment,
  approveEquipment,
  rejectEquipment,
  adminUpdateEquipment,
  adminDeleteEquipment,
} from "../modules/admin/adminEquipment.service.js";

const router = express.Router();

// Admin Users endpoints
router.get("/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await listUsers();
    return success(res, { users });
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to fetch users", 500, "FETCH_FAILED");
  }
});

router.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { role } = req.body;

    if (!role || typeof role !== "string") {
      return error(res, "Role is required", 400, "MISSING_ROLE");
    }

    const user = await updateUserRole(req.params.id, role);
    return success(res, { user });
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to update user role", 500, "UPDATE_FAILED");
  }
});

// Admin Equipment endpoints
router.get("/equipment", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await listAllEquipment(req.query);
    return success(res, result);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code, err.errors);
    }
    return error(res, "Failed to fetch equipment", 500, "FETCH_FAILED");
  }
});

router.patch("/equipment/:id/approve", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const equipment = await approveEquipment(req.params.id);
    return success(res, { equipment });
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to approve equipment", 500, "APPROVE_FAILED");
  }
});

router.patch("/equipment/:id/reject", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const equipment = await rejectEquipment(req.params.id);
    return success(res, { equipment });
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to reject equipment", 500, "REJECT_FAILED");
  }
});

router.put("/equipment/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const equipment = await adminUpdateEquipment(req.params.id, req.body);
    return success(res, { equipment });
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code, err.errors);
    }
    return error(res, "Failed to update equipment", 500, "UPDATE_FAILED");
  }
});

router.delete("/equipment/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await adminDeleteEquipment(req.params.id);
    return success(res, result);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to delete equipment", 500, "DELETE_FAILED");
  }
});

export { router as adminRouter };