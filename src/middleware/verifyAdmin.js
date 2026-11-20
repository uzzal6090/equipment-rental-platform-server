import { error } from "../utils/response.js";

export async function verifyAdmin(req, res, next) {
  if (!req.profile || req.profile.role !== "admin") {
    return error(res, "Forbidden: admin role required", 403, "ROLE_REQUIRED");
  }
  next();
}
