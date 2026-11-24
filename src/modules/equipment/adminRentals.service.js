import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { ObjectId } from "mongodb";

async function listAdminRentals(query = {}) {
  const db = getDB();

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 10), 50);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    db
      .collection(COLLECTIONS.BOOKINGS)
      .aggregate([
        { $sort: { bookingDate: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: COLLECTIONS.EQUIPMENT,
            localField: "equipmentId",
            foreignField: "_id",
            as: "equipment",
          },
        },
        { $unwind: { path: "$equipment", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: COLLECTIONS.PROFILES,
            localField: "userId",
            foreignField: "_id",
            as: "customer",
          },
        },
        { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: COLLECTIONS.PROFILES,
            localField: "ownerId",
            foreignField: "_id",
            as: "owner",
          },
        },
        { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            equipmentId: 1,
            ownerId: 1,
            userId: 1,
            startDate: 1,
            endDate: 1,
            quantity: 1,
            contactPhone: 1,
            deliveryAddress: 1,
            notes: 1,
            bookingStatus: 1,
            paymentStatus: 1,
            checkoutIntent: 1,
            stripeSessionId: 1,
            totalPrice: 1,
            bookingDate: 1,
            createdAt: 1,
            updatedAt: 1,
            equipment: {
              id: { $toString: "$equipment._id" },
              name: "$equipment.name",
              category: "$equipment.category",
              rentalPrice: "$equipment.rentalPrice",
              rentalType: "$equipment.rentalType",
              location: "$equipment.location",
              image: "$equipment.image",
              status: "$equipment.status",
            },
            customer: {
              id: { $toString: "$customer._id" },
              name: "$customer.name",
              email: "$customer.email",
              phone: "$customer.phone",
              profileImage: "$customer.profileImage",
            },
            owner: {
              id: { $toString: "$owner._id" },
              name: "$owner.name",
              email: "$owner.email",
              phone: "$owner.phone",
              profileImage: "$owner.profileImage",
            },
          },
        },
      ])
      .toArray(),
    db.collection(COLLECTIONS.BOOKINGS).countDocuments({}),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    rentals: items.map((item) => ({
      id: item._id.toString(),
      equipmentId: item.equipmentId.toString(),
      ownerId: item.ownerId.toString(),
      userId: item.userId.toString(),
      startDate: item.startDate,
      endDate: item.endDate,
      quantity: item.quantity,
      contactPhone: item.contactPhone,
      deliveryAddress: item.deliveryAddress,
      notes: item.notes,
      bookingStatus: item.bookingStatus,
      paymentStatus: item.paymentStatus,
      checkoutIntent: item.checkoutIntent?.toString(),
      stripeSessionId: item.stripeSessionId,
      totalPrice: item.totalPrice,
      bookingDate: item.bookingDate,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      equipment: item.equipment
        ? {
            id: item.equipment.id,
            name: item.equipment.name,
            category: item.equipment.category,
            rentalPrice: item.equipment.rentalPrice,
            rentalType: item.equipment.rentalType,
            location: item.equipment.location,
            image: item.equipment.image,
            status: item.equipment.status,
          }
        : null,
      customer: item.customer
        ? {
            id: item.customer.id,
            name: item.customer.name,
            email: item.customer.email,
            phone: item.customer.phone,
            profileImage: item.customer.profileImage,
          }
        : null,
      owner: item.owner
        ? {
            id: item.owner.id,
            name: item.owner.name,
            email: item.owner.email,
            phone: item.owner.phone,
            profileImage: item.owner.profileImage,
          }
        : null,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

export { listAdminRentals };