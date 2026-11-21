import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { ObjectId } from "mongodb";

async function getAdminAnalytics() {
  const db = getDB();

  // Total Users
  const totalUsers = await db.collection(COLLECTIONS.PROFILES).countDocuments({});

  // Total Equipment
  const totalEquipment = await db.collection(COLLECTIONS.EQUIPMENT).countDocuments({});

  // Equipment by status
  const equipmentByStatus = await db.collection(COLLECTIONS.EQUIPMENT).aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();

  const statusCounts = {
    pending: 0,
    approved: 0,
    rejected: 0,
  };
  equipmentByStatus.forEach((item) => {
    if (item._id && statusCounts.hasOwnProperty(item._id)) {
      statusCounts[item._id] = item.count;
    }
  });

  // For analytics that depend on bookings/payments (not implemented yet)
  const totalBookings = 0;
  const completedRentals = 0;
  const totalRevenue = 0;
  const monthlyBookingStats = [];
  const pendingApprovals = statusCounts.pending;

  return {
    totalUsers,
    totalEquipment,
    totalBookings,
    pendingApprovals,
    completedRentals,
    totalRevenue,
    monthlyBookingStats,
    equipmentByStatus: statusCounts,
    notes: {
      totalBookings: "Booking functionality not yet implemented",
      completedRentals: "Booking functionality not yet implemented",
      totalRevenue: "Payment functionality not yet implemented",
      monthlyBookingStats: "Booking functionality not yet implemented",
    },
  };
}

export { getAdminAnalytics };