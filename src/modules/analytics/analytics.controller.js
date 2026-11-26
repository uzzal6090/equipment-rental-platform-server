import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { success } from "../../utils/response.js";

function getLast6MonthsPipeline(dateField = "createdAt") {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  return [
    { $match: { [dateField]: { $gte: sixMonthsAgo } } },
    {
      $group: {
        _id: {
          year: { $year: `$${dateField}` },
          month: { $month: `$${dateField}` },
        },
        count: { $sum: 1 },
        revenue: { $sum: "$totalPrice" },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ];
}

// GET /api/analytics/admin
export async function getAdminAnalytics(req, res) {
  const db = getDB();

  const [
    totalUsers,
    totalEquipment,
    totalBookings,
    pendingApprovals,
    completedRentals,
    revenueResult,
    monthlyBookings,
  ] = await Promise.all([
    db.collection(COLLECTIONS.PROFILES).countDocuments({}),
    db.collection(COLLECTIONS.EQUIPMENT).countDocuments({}),
    db.collection(COLLECTIONS.BOOKINGS).countDocuments({}),
    db.collection(COLLECTIONS.EQUIPMENT).countDocuments({ status: "pending" }),
    db.collection(COLLECTIONS.BOOKINGS).countDocuments({ bookingStatus: "completed" }),
    db.collection(COLLECTIONS.PAYMENTS).aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]).toArray(),
    db.collection(COLLECTIONS.BOOKINGS).aggregate(getLast6MonthsPipeline()).toArray(),
  ]);

  const totalRevenue = revenueResult[0]?.total || 0;

  return success(res, {
    totalUsers,
    totalEquipment,
    totalBookings,
    pendingApprovals,
    completedRentals,
    totalRevenue,
    monthlyBookings,
  });
}

// GET /api/analytics/owner
export async function getOwnerAnalytics(req, res) {
  const db = getDB();
  const ownerId = req.user.id;

  const [
    totalEquipment,
    totalRentals,
    completedRentals,
    earningsResult,
    monthlyEarnings,
  ] = await Promise.all([
    db.collection(COLLECTIONS.EQUIPMENT).countDocuments({ ownerId }),
    db.collection(COLLECTIONS.BOOKINGS).countDocuments({ ownerId }),
    db.collection(COLLECTIONS.BOOKINGS).countDocuments({ ownerId, bookingStatus: "completed" }),
    db.collection(COLLECTIONS.BOOKINGS).aggregate([
      { $match: { ownerId, paymentStatus: "paid" } },
      { $group: { _id: null, total: { $sum: "$totalPrice" } } },
    ]).toArray(),
    db.collection(COLLECTIONS.BOOKINGS).aggregate([
      { $match: { ownerId, paymentStatus: "paid" } },
      ...getLast6MonthsPipeline().slice(1), // skip the $match, already filtered
    ]).toArray(),
  ]);

  const totalEarnings = earningsResult[0]?.total || 0;

  return success(res, {
    totalEquipment,
    totalRentals,
    completedRentals,
    totalEarnings,
    monthlyEarnings,
  });
}
