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
  const dbName = 'equipment_rental_test_db';
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  
  // Check bookings
  const bookings = db.collection('bookings');
  const bookingCount = await bookings.countDocuments({});
  console.log('Test DB - Total bookings count:', bookingCount);
  
  if (bookingCount > 0) {
    const sample = await bookings.findOne({});
    console.log('Sample booking:', JSON.stringify(sample, null, 2));
  } else {
    console.log('Test DB - No bookings found');
  }
  
  await client.close();
}
check().catch(console.error);