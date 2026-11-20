import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";
import { success, error } from "../utils/response.js";
import { listUsers, updateUserRole } from "../modules/admin/adminUsers.service.js";

const router = express.Router();

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

export { router as adminRouter };