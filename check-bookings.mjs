import { MongoClient } from 'mongodb';
import * as dns from 'dns';
import 'dotenv/config';

const dnsServers = process.env.DNS_SERVERS;
if (dnsServers) {
  const servers = dnsServers
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (servers.length > 0) {
    dns.setServers(servers);
  }
}

async function check() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || 'equipment_rental_db';
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  
  // Check bookings
  const bookings = db.collection('bookings');
  const bookingCount = await bookings.countDocuments({});
  console.log('Total bookings count:', bookingCount);
  
  if (bookingCount > 0) {
    const sample = await bookings.findOne({});
    console.log('Sample booking:', JSON.stringify(sample, null, 2));
  } else {
    console.log('No bookings found');
  }
  
  // Check payments
  const payments = db.collection('payments');
  const paymentCount = await payments.countDocuments({});
  console.log('Total payments count:', paymentCount);
  
  if (paymentCount > 0) {
    const sample = await payments.findOne({});
    console.log('Sample payment:', JSON.stringify(sample, null, 2));
  } else {
    console.log('No payments found');
  }
  
  // Check checkoutIntents
  const checkoutIntents = db.collection('checkoutIntents');
  const intentCount = await checkoutIntents.countDocuments({});
  console.log('Total checkoutIntents count:', intentCount);
  
  await client.close();
}
check().catch(console.error);