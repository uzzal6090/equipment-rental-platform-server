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

  // For analytics that depend on bookings/payments (not implemented yet)
  // Return 0 with a note that booking/payment functionality is not yet implemented
  const completedRentals = 0;
  const totalEarnings = 0;
  const monthlyEarnings = [];

  return {
    totalListedEquipment: totalEquipment,
    equipmentByStatus: statusCounts,
    completedRentals,
    totalEarnings,
    monthlyEarnings,
    notes: {
      completedRentals: "Booking functionality not yet implemented",
      totalEarnings: "Payment functionality not yet implemented",
      monthlyEarnings: "Payment functionality not yet implemented",
    },
  };
}

export { getOwnerAnalytics };