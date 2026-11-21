import express from "express";
import cors from "cors";

import { validateEnv } from "./src/config/env.js";
import { connectDB, closeDB, getDB, getClient, verifyTransactionSupport } from "./src/config/db.js";
import { ensureDatabase } from "./src/config/indexes.js";
import { createAuth } from "./src/config/auth.js";
import { errorHandler } from "./src/middleware/errorHandler.js";
import { profileRouter } from "./src/routes/profile.js";
import { profileImageRouter } from "./src/routes/profileImage.js";
import { equipmentRouter } from "./src/routes/equipment.js";
import { equipmentImageRouter } from "./src/routes/equipmentImage.js";
import { favoritesRouter } from "./src/routes/favorites.js";
import { rentalsRouter } from "./src/routes/rentals.js";
import { ownerRentalsRouter } from "./src/routes/ownerRentals.js";
import { adminRouter } from "./src/routes/admin.js";
import { ownerRouter } from "./src/routes/owner.js";

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

    // Mount Better Auth handler BEFORE express.json() per Better Auth Express v5 requirements.
    app.use("/api/auth/{*any}", createdAuthHandler);

    // Mount the profile image router BEFORE the global express.json() parser so its
    // route-specific (larger) body limit applies. Otherwise the global default-limit
    // JSON parser rejects base64 image uploads (~6.6MB for a 5MB image) with 413
    // before the request ever reaches the upload handler.
    app.use("/api/profile/image", profileImageRouter);

    // Mount the equipment image router BEFORE the global express.json() parser for the same reason.
    app.use("/api/equipment/image", equipmentImageRouter);

    app.use(express.json());

app.use("/api/profile", profileRouter);

app.use("/api/equipment", equipmentRouter);

app.use("/api/favorites", favoritesRouter);

app.use("/api/rentals", rentalsRouter);

app.use("/api/owner/rentals", ownerRentalsRouter);

app.use("/api/admin", adminRouter);

app.use("/api/owner", ownerRouter);

    app.get("/", (req, res) => {
      res.status(200).json({
        success: true,
        message: "Equipment Rental Platform API is running!",
      });
    });

    // 404 handler (must be after all routes)
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

    const gracefulShutdown = async (signal) => {
      if (isShuttingDown) {
        return;
      }
      isShuttingDown = true;

      console.log(`Received ${signal}. Shutting down gracefully...`);

      // Force-exit safety net: only created when shutdown actually begins.
      let forceExitTimer;
      forceExitTimer = setTimeout(() => {
        console.error("Graceful shutdown did not complete in time; forcing exit");
        process.exit(1);
      }, 15000);
      if (forceExitTimer.unref) {
        forceExitTimer.unref();
      }

      try {
        // 1. Stop accepting new HTTP connections.
        if (server) {
          try {
            await new Promise((resolve, reject) => {
              server.close((error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            });
            console.log("HTTP server closed");
          } catch (error) {
            console.error("Error closing HTTP server:", error.message);
            throw error;
          }
        }

        // 2. Only then close MongoDB connections.
        try {
          await closeDB();
          console.log("Database connection closed");
        } catch (error) {
          console.error("Error closing database:", error.message);
          throw error;
        }

        clearTimeout(forceExitTimer);
        process.exit(0);
      } catch (error) {
        clearTimeout(forceExitTimer);
        console.error("Graceful shutdown failed:", error.message);
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  } catch (error) {
    console.error("Failed to start server:", error.message);
    // Close the database connection if it was initialized before exiting.
    try {
      await closeDB();
    } catch (closeError) {
      // Do not mask the original startup error.
      console.error("Error closing database after startup failure:", closeError.message);
    }
    process.exit(1);
  }
}

startServer();

export { app };
