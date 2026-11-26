import { MongoClient } from 'mongodb';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

async function check() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || 'equipment_rental_test_db';
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const bookings = await db.collection('bookings').find({}).toArray();
  console.log('Total bookings:', bookings.length);
  if (bookings.length > 0) {
    bookings.forEach(b => console.log('  ', b._id, b.createdAt, b.bookingStatus));
  }
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  twelveMonthsAgo.setHours(0, 0, 0, 0);
  console.log('twelveMonthsAgo:', twelveMonthsAgo);
  const recent = await db.collection('bookings').find({ createdAt: { $gte: twelveMonthsAgo } }).toArray();
  console.log('Bookings in last 12 months:', recent.length);
  await client.close();
}
check().catch(console.error);