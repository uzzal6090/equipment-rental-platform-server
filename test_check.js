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

  // Total Bookings
  const totalBookings = await db.collection(COLLECTIONS.BOOKINGS).countDocuments({});

  // Completed Rentals (bookingStatus === "completed")
  const completedRentals = await db.collection(COLLECTIONS.BOOKINGS).countDocuments({
    bookingStatus: "completed",
  });

  // Pending Approvals (equipment with status "pending")
  const pendingApprovals = await db.collection(COLLECTIONS.EQUIPMENT).countDocuments({
    status: "pending",
  });

  // Total Revenue - sum of amounts from payments with status "paid"
  const revenueResult = await db.collection(COLLECTIONS.PAYMENTS).aggregate([
    { $match: { status: "paid" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]).toArray();
  const totalRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;

  // Monthly Booking Statistics (last 12 months)
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  const monthlyBookingStatsAgg = await db.collection(COLLECTIONS.BOOKINGS).aggregate([
    {
      $match: {
        createdAt: { $gte: twelveMonthsAgo },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
        },
        count: { $sum: 1 },
      },
    },
    {
      $sort: { "_id.year": 1, "_id.month": 1 },
    },
    {
      $project: {
        _id: 0,
        month: {
          $concat: [
            { $toString: "$_id.year" },
            "-",
            {
              $toString: {
                $cond: {
                  if: { $lt: ["$_id.month", 10] },
                  then: { $concat: ["0", { $toString: "$_id.month" }] },
                  else: { $toString: "$_id.month" },
                },
              },
            },
          ],
        },
        bookings: 1,
      },
    },
    {
      $sort: { month: 1 },
    },
  ).toArray();

  // Generate all 12 months (including months with 0 bookings)
  const monthlyBookingStats = [];
  for (let i = 11; i >= 0; i--) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
    
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    
    const existing = monthlyBookingStatsAgg.find((item) => item.month === monthKey);
    monthlyBookingStats.push({
      month: monthKey,
      bookings: existing ? existing.bookings : 0,
    });
  }

  return {
    totalUsers,
    totalEquipment,
    totalBookings,
    pendingApprovals,
    completedRentals,
    totalRevenue,
    monthlyBookingStats,
    equipmentByStatus: {
      pending: statusCounts.pending,
      approved: statusCounts.approved,
      rejected: statusCounts.rejected,
    },
    notes: {},
  };
}

export { getAdminAnalytics };