import express from "express";
import cors from "cors";

import { validateEnv } from "./src/config/env.js";
import { connectDB, closeDB, getDB, getClient, verifyTransactionSupport } from "./src/config/db.js";
import { ensureDatabase } from "./src/config/indexes.js";
import { createAuth } from "./src/config/auth.js";
import { errorHandler } from "./src/middleware/errorHandler.js";

// Route modules
import equipmentRoutes from "./src/modules/equipment/equipment.routes.js";
import usersRoutes from "./src/modules/users/users.routes.js";
import favoritesRoutes from "./src/modules/favorites/favorites.routes.js";
import reviewsRoutes from "./src/modules/reviews/reviews.routes.js";
import bookingsRoutes from "./src/modules/bookings/bookings.routes.js";
import paymentsRoutes from "./src/modules/payments/payments.routes.js";
import analyticsRoutes from "./src/modules/analytics/analytics.routes.js";
import { handleStripeWebhook } from "./src/modules/payments/payments.controller.js";

// Cron jobs
import { startBookingStatusUpdater } from "./src/jobs/bookingStatusUpdater.js";
import { startEmailProcessor } from "./src/jobs/emailProcessor.js";

const app = express();

const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";

app.use(
  cors({
    origin: clientUrl,
    credentials: true,
  })
);

const PORT = process.env.PORT || 5000;

let server;
let isShuttingDown = false;

async function startServer() {
  try {
    validateEnv();
    await connectDB();
    const db = getDB();
    const transactionsSupported = await verifyTransactionSupport();
    console.log("MongoDB transactions supported:", transactionsSupported);
    if (!transactionsSupported) {
      throw new Error("MongoDB transaction support is required but unavailable; refusing to start");
    }
    await ensureDatabase(db);
    console.log("Database collections and indexes ensured");

    const { authHandler: createdAuthHandler } = await createAuth(db, getClient());

    // Mount Better Auth BEFORE express.json() per Better Auth Express v5 requirements
    app.use("/api/auth/{*any}", createdAuthHandler);

    // Stripe webhook needs raw body — mount BEFORE express.json()
    if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
      app.post(
        "/api/stripe/webhook",
        express.raw({ type: "application/json" }),
        handleStripeWebhook
      );
    }

    app.use(express.json());

    // Health check
    app.get("/", (req, res) => {
      res.status(200).json({
        success: true,
        message: "Equipment Rental Platform API is running!",
      });
    });

    // API routes
    app.use("/api/equipment", equipmentRoutes);
    app.use("/api", usersRoutes);
    app.use("/api/favorites", favoritesRoutes);
    app.use("/api/reviews", reviewsRoutes);
    app.use("/api/bookings", bookingsRoutes);
    app.use("/api/payments", paymentsRoutes);
    app.use("/api/analytics", analyticsRoutes);

    // 404 handler
    app.use((req, res) => {
      res.status(404).json({
        success: false,
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    });

    // Error handler (must be last)
    app.use(errorHandler);

    server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    // Start cron jobs after server is up
    startBookingStatusUpdater();
    startEmailProcessor();

    const gracefulShutdown = async (signal) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`Received ${signal}. Shutting down gracefully...`);

      let forceExitTimer = setTimeout(() => {
        console.error("Graceful shutdown did not complete in time; forcing exit");
        process.exit(1);
      }, 15000);
      if (forceExitTimer.unref) forceExitTimer.unref();

      try {
        if (server) {
          await new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          });
          console.log("HTTP server closed");
        }
        await closeDB();
        console.log("Database connection closed");
        clearTimeout(forceExitTimer);
        process.exit(0);
      } catch (err) {
        clearTimeout(forceExitTimer);
        console.error("Graceful shutdown failed:", err.message);
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  } catch (err) {
    console.error("Failed to start server:", err.message);
    try {
      await closeDB();
    } catch (closeErr) {
      console.error("Error closing database after startup failure:", closeErr.message);
    }
    process.exit(1);
  }
}

startServer();

export { app };
