const { MongoClient } = require('mongodb');
require('dotenv').config();

async function check() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || 'equipment_rental_db';
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  
  console.log('Database:', dbName);
  console.log('Collections:', await db.listCollections().toArray());
  
  const equipment = db.collection('equipment');
  const count = await equipment.countDocuments({});
  console.log('Total equipment count:', count);
  
  if (count > 0) {
    const statusDist = await equipment.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).toArray();
    console.log('Status distribution:', statusDist);
    
    const sample = await equipment.findOne({});
    console.log('Sample document:', JSON.stringify(sample, null, 2));
    
    const ownerIdTypes = await equipment.aggregate([
      { $project: { ownerIdType: { $type: '$ownerId' } } },
      { $group: { _id: '$ownerIdType', count: { $sum: 1 } } }
    ]).toArray();
    console.log('ownerId types:', ownerIdTypes);
  } else {
    console.log('No equipment documents found');
  }
  
  await client.close();
}
check().catch(console.error);