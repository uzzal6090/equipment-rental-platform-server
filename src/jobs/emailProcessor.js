import nodemailer from "nodemailer";
import cron from "node-cron";
import { getDB } from "../config/db.js";
import { COLLECTIONS } from "../config/indexes.js";

function createTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function bookingConfirmationTemplate({ recipientName, equipmentName, startDate, endDate, quantity, totalPrice, role }) {
  const roleText = role === "owner" ? "A customer has booked your equipment." : "Your booking has been confirmed.";
  return {
    subject: `Booking Confirmed: ${equipmentName}`,
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; background: #0A0A0A; color: #F0EDE8; padding: 32px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #E8B84B; font-size: 24px; margin: 0;">RentGear</h1>
          <p style="color: #9A9A9A; margin: 8px 0 0;">Equipment Rental Platform</p>
        </div>
        <div style="background: #141414; border-radius: 8px; padding: 24px; border: 1px solid #252525;">
          <h2 style="color: #E8B84B; margin-top: 0;">Booking Confirmed ✓</h2>
          <p>Hi ${recipientName},</p>
          <p>${roleText}</p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr><td style="padding: 8px; color: #9A9A9A; border-bottom: 1px solid #252525;">Equipment</td><td style="padding: 8px; border-bottom: 1px solid #252525;">${equipmentName}</td></tr>
            <tr><td style="padding: 8px; color: #9A9A9A; border-bottom: 1px solid #252525;">Start Date</td><td style="padding: 8px; border-bottom: 1px solid #252525;">${new Date(startDate).toDateString()}</td></tr>
            <tr><td style="padding: 8px; color: #9A9A9A; border-bottom: 1px solid #252525;">End Date</td><td style="padding: 8px; border-bottom: 1px solid #252525;">${new Date(endDate).toDateString()}</td></tr>
            <tr><td style="padding: 8px; color: #9A9A9A; border-bottom: 1px solid #252525;">Quantity</td><td style="padding: 8px; border-bottom: 1px solid #252525;">${quantity}</td></tr>
            <tr><td style="padding: 8px; color: #9A9A9A; font-weight: bold;">Total</td><td style="padding: 8px; color: #E8B84B; font-weight: bold;">$${totalPrice.toFixed(2)}</td></tr>
          </table>
        </div>
        <p style="color: #6B6B6B; font-size: 12px; text-align: center; margin-top: 24px;">© ${new Date().getFullYear()} RentGear — Equipment Rental Platform</p>
      </div>
    `,
  };
}

// Queue email notifications for a booking
export async function queueBookingEmails(db, bookingId, intent) {
  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: intent.equipmentId });
  const renterProfile = await db.collection(COLLECTIONS.PROFILES).findOne({ betterAuthUserId: intent.userId });
  const ownerProfile = await db.collection(COLLECTIONS.PROFILES).findOne({ betterAuthUserId: intent.ownerId });

  const emailsToQueue = [];

  if (renterProfile?.email) {
    emailsToQueue.push({
      bookingId,
      recipientType: "renter",
      recipientEmail: renterProfile.email,
      recipientName: renterProfile.name,
      template: "booking_confirmation",
      status: "pending",
      attempts: 0,
      metadata: {
        recipientName: renterProfile.name,
        equipmentName: equipment?.name || "Equipment",
        startDate: intent.startDate,
        endDate: intent.endDate,
        quantity: intent.quantity,
        totalPrice: intent.totalPrice,
        role: "renter",
      },
      createdAt: new Date(),
    });
  }

  if (ownerProfile?.email) {
    emailsToQueue.push({
      bookingId,
      recipientType: "owner",
      recipientEmail: ownerProfile.email,
      recipientName: ownerProfile.name,
      template: "booking_confirmation",
      status: "pending",
      attempts: 0,
      metadata: {
        recipientName: ownerProfile.name,
        equipmentName: equipment?.name || "Equipment",
        startDate: intent.startDate,
        endDate: intent.endDate,
        quantity: intent.quantity,
        totalPrice: intent.totalPrice,
        role: "owner",
      },
      createdAt: new Date(),
    });
  }

  if (emailsToQueue.length > 0) {
    await db.collection(COLLECTIONS.EMAIL_OUTBOX).insertMany(emailsToQueue);
  }
}

// Process pending emails — runs every 5 minutes
export function startEmailProcessor() {
  const transporter = createTransporter();

  if (!transporter) {
    console.log("[EMAIL] SMTP not configured. Email notifications disabled.");
    return;
  }

  cron.schedule("*/5 * * * *", async () => {
    try {
      const db = getDB();
      const pending = await db.collection(COLLECTIONS.EMAIL_OUTBOX)
        .find({ status: "pending", attempts: { $lt: 3 } })
        .limit(10)
        .toArray();

      for (const email of pending) {
        try {
          const { subject, html } = bookingConfirmationTemplate(email.metadata);
          await transporter.sendMail({
            from: `"RentGear" <${process.env.SMTP_USER}>`,
            to: email.recipientEmail,
            subject,
            html,
          });

          await db.collection(COLLECTIONS.EMAIL_OUTBOX).updateOne(
            { _id: email._id },
            { $set: { status: "sent", sentAt: new Date(), updatedAt: new Date() } }
          );
        } catch (sendErr) {
          await db.collection(COLLECTIONS.EMAIL_OUTBOX).updateOne(
            { _id: email._id },
            {
              $set: { lastError: sendErr.message, lastAttemptAt: new Date() },
              $inc: { attempts: 1 },
            }
          );
          if (email.attempts + 1 >= 3) {
            await db.collection(COLLECTIONS.EMAIL_OUTBOX).updateOne(
              { _id: email._id },
              { $set: { status: "failed" } }
            );
          }
        }
      }
    } catch (err) {
      console.error("[EMAIL] Processor error:", err.message);
    }
  });

  console.log("[EMAIL] Email processor scheduled (every 5 minutes).");
}
