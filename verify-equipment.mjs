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
  
  const equipment = db.collection('equipment');
  const count = await equipment.countDocuments({});
  console.log('Total equipment count:', count);
  
  if (count > 0) {
    const statusDist = await equipment.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).toArray();
    console.log('Status distribution:', statusDist);
    
    const approvedCount = await equipment.countDocuments({ status: 'approved' });
    console.log('Approved equipment count:', approvedCount);
  } else {
    console.log('No equipment documents found');
  }
  
  await client.close();
}
check().catch(console.error);