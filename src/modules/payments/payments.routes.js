import { Router } from "express";
import express from "express";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import { verifyAdmin } from "../../middleware/verifyAdmin.js";
import { handleStripeWebhook, getPayments } from "./payments.controller.js";

const router = Router();

// Stripe webhook needs raw body - mounted separately in server.js
router.get("/", verifyToken, verifyAdmin, asyncHandler(getPayments));

export default router;
