const pipeline = [
  {
    $match: {
      createdAt: { $gte: new Date() },
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
];
console.log("Pipeline syntax OK");