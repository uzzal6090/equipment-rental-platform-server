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
  
  // Check profiles
  const profiles = db.collection('profiles');
  const profileCount = await profiles.countDocuments({});
  console.log('Total profiles count:', profileCount);
  
  if (profileCount > 0) {
    const roleDist = await profiles.aggregate([
      { $group: { _id: '$role', count: { $sum: 1 } } }
    ]).toArray();
    console.log('Role distribution:', roleDist);
    
    const sample = await profiles.findOne({});
    console.log('Sample profile:', JSON.stringify(sample, null, 2));
  }
  
  // Check users (Better Auth)
  const users = db.collection('user');
  const userCount = await users.countDocuments({});
  console.log('Total Better Auth users count:', userCount);
  
  if (userCount > 0) {
    const sample = await users.findOne({});
    console.log('Sample user:', JSON.stringify(sample, null, 2));
  }
  
  await client.close();
}
check().catch(console.error);