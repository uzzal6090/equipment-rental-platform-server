import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { ObjectId } from "mongodb";

async function getOwnerAnalytics(ownerId) {
  const db = getDB();
  const ownerObjectId = new ObjectId(ownerId);

  // Total listed equipment (all statuses)
  const totalEquipment = await db.collection(COLLECTIONS.EQUIPMENT).countDocuments({ ownerId });

  // Equipment by status
  const equipmentByStatus = await db.collection(COLLECTIONS.EQUIPMENT).aggregate([
    { $match: { ownerId } },
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

  // Completed Rentals - count bookings with bookingStatus: "completed" for this owner
  const completedRentals = await db.collection(COLLECTIONS.BOOKINGS).countDocuments({
    ownerId: ownerObjectId,
    bookingStatus: "completed",
  });

  // Total Earnings - sum of paid payments for this owner's bookings
  const earningsResult = await db.collection(COLLECTIONS.PAYMENTS).aggregate([
    { $match: { status: "paid" } },
    {
      $lookup: {
        from: COLLECTIONS.BOOKINGS,
        localField: "bookingId",
        foreignField: "_id",
        as: "booking",
      },
    },
    { $unwind: "$booking" },
    { $match: { "booking.ownerId": ownerObjectId } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]).toArray();
  const totalEarnings = earningsResult.length > 0 ? earningsResult[0].total : 0;

  // Monthly Earnings Statistics (last 12 months)
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  const monthlyEarningsAgg = await db.collection(COLLECTIONS.PAYMENTS).aggregate([
    {
      $match: {
        status: "paid",
        createdAt: { $gte: twelveMonthsAgo },
      },
    },
    {
      $lookup: {
        from: COLLECTIONS.BOOKINGS,
        localField: "bookingId",
        foreignField: "_id",
        as: "booking",
      },
    },
    { $unwind: "$booking" },
    { $match: { "booking.ownerId": ownerObjectId } },
    {
      $group: {
        _id: {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
        },
        earnings: { $sum: "$amount" },
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
              $cond: {
                if: { $lt: ["$_id.month", 10] },
                then: { $concat: ["0", { $toString: "$_id.month" }] },
                else: { $toString: "$_id.month" },
              },
            },
          ],
        },
        earnings: 1,
      },
    },
  ]).toArray();

  // Generate all 12 months (including months with 0 earnings)
  const monthlyEarnings = [];
  for (let i = 11; i >= 0; i--) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    date.setDate(1);
    date.setHours(0, 0, 0, 0);

    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;

    const existing = monthlyEarningsAgg.find((item) => item.month === monthKey);
    monthlyEarnings.push({
      month: monthKey,
      earnings: existing ? existing.earnings : 0,
    });
  }

  return {
    totalListedEquipment: totalEquipment,
    equipmentByStatus: statusCounts,
    completedRentals,
    totalEarnings,
    monthlyEarnings,
    notes: {},
  };
}

export { getOwnerAnalytics };