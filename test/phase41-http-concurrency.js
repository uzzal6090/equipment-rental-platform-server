import { config as dotenvConfig } from "dotenv";
import * as dns from "dns";
import { MongoClient, ObjectId } from "mongodb";
import { spawn } from "child_process";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import Stripe from "stripe";
import http from "http";
import { connectDB as connectAppDB, closeDB as closeAppDB, getClient } from "../src/config/db.js";
import { releaseExpiredIntents, checkAvailability } from "../src/modules/equipment/booking.service.js";

dotenvConfig({ path: ".env.test", override: true });
const dnsServers = process.env.DNS_SERVERS;
if (dnsServers) dns.setServers(dnsServers.split(",").map(s=>s.trim()).filter(Boolean));
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "equipment_rental_test_db";
const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL;
const PORT = Number(process.env.PORT || 5012);
const BASE_URL = `http://localhost:${PORT}`;
if (DB_NAME !== "equipment_rental_test_db") { console.error("Unsafe DB"); process.exit(1); }

const results=[]; let passed=0, failed=0;
function test(name, fn){ return async()=>{ try{ await fn(); results.push({name,status:"PASS"}); passed++; console.log(`PASS: ${name}`);}catch(e){ results.push({name,status:"FAIL",error:e.message}); failed++; console.log(`FAIL: ${name} - ${e.message}`);} }; }
function assert(c,m){ if(!c) throw new Error(m); }
async function fetchJson(path, options={}){ const res=await fetch(`${BASE_URL}${path}`,{method:options.method||"GET",headers:{"Content-Type":"application/json",...(options.headers||{})},body:options.body}); const text=await res.text(); let body; try{ body=text?JSON.parse(text):null; }catch{ body=text; } return {status:res.status, body, headers:res.headers}; }
async function fetchRaw(path, options={}){ const res=await fetch(`${BASE_URL}${path}`,{method:options.method||"POST",headers:options.headers||{},body:options.body}); const text=await res.text(); let body; try{ body=text?JSON.parse(text):null; }catch{ body=text; } return {status:res.status, body, text}; }

let db, mongoClient, ownerProfileId, customerProfileId, customer2ProfileId, adminProfileId;
let ownerJwt, customerJwt, customer2Jwt, adminJwt;
let stripeMockServer, stripeMockRequests=[], stripeMockFail=false;

async function startStripeMock(){
  stripeMockRequests=[]; stripeMockFail=false;
  stripeMockServer = http.createServer(async (req,res)=>{
    let raw=""; req.on("data",c=>raw+=c); req.on("end",()=>{
      stripeMockRequests.push({method:req.method,url:req.url,body:raw,headers:req.headers});
      if (stripeMockFail) { res.writeHead(500,{"Content-Type":"application/json"}); res.end(JSON.stringify({error:{message:"mock failure"}})); return; }
      if (req.method==="POST" && req.url.startsWith("/v1/checkout/sessions")){
        const params = new URLSearchParams(raw);
        const id = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const response={id,object:"checkout.session",url:`https://checkout.stripe.test/pay/${id}`,payment_status:"unpaid",amount_total:Number(params.get("line_items[0][price_data][unit_amount]")||10000),currency:params.get("line_items[0][price_data][currency]")||"usd",metadata:{checkout_intent_id:params.get("metadata[checkout_intent_id]"),equipment_id:params.get("metadata[equipment_id]"),user_id:params.get("metadata[user_id]"),owner_id:params.get("metadata[owner_id]")}};
        res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify(response)); return;
      }
      if (req.method==="POST" && /\/v1\/checkout\/sessions\/.*\/expire/.test(req.url)) {
        res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify({id:req.url.split("/").pop(),status:"expired"})); return;
      }
      if (req.method==="GET" && req.url.startsWith("/v1/checkout/sessions/")) {
        const id=req.url.split("/").pop().split("?")[0];
        res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify({id,object:"checkout.session",payment_status:"paid",metadata:{}})); return;
      }
      res.writeHead(404,{"Content-Type":"application/json"}); res.end(JSON.stringify({error:{message:"not found"}}));
    });
  });
  await new Promise(r=>stripeMockServer.listen(12112,"127.0.0.1",r));
}
async function stopStripeMock(){ if(stripeMockServer) await new Promise(r=>stripeMockServer.close(r)); }

async function connectTestDb(){
  process.env.DB_NAME = DB_NAME;
  process.env.MONGODB_URI = MONGODB_URI;
  db = await connectAppDB();
  mongoClient = getClient();
  const name = db.databaseName;
  if (name !== "equipment_rental_test_db") throw new Error(`Unsafe db ${name}`);
}
async function clearDb(){
  for (const c of ["profiles","equipment","checkoutIntents","bookings","payments","webhookEvents","favorites","jwks"]) {
    await db.collection(c).deleteMany({});
  }
}
async function seed(){
  await clearDb();
  const profiles=[
    {betterAuthUserId:"owner1",name:"Owner",email:"o@e.com",role:"owner",roleVersion:0,createdAt:new Date(),updatedAt:new Date()},
    {betterAuthUserId:"cust1",name:"Cust1",email:"c1@e.com",role:"customer",roleVersion:0,createdAt:new Date(),updatedAt:new Date()},
    {betterAuthUserId:"cust2",name:"Cust2",email:"c2@e.com",role:"customer",roleVersion:0,createdAt:new Date(),updatedAt:new Date()},
    {betterAuthUserId:"admin1",name:"Admin",email:"a@e.com",role:"admin",roleVersion:0,createdAt:new Date(),updatedAt:new Date()},
  ];
  await db.collection("profiles").insertMany(profiles);
  const all = await db.collection("profiles").find({}).toArray();
  ownerProfileId=all.find(p=>p.role==="owner")._id;
  customerProfileId=all.find(p=>p.betterAuthUserId==="cust1")._id;
  customer2ProfileId=all.find(p=>p.betterAuthUserId==="cust2")._id;
  adminProfileId=all.find(p=>p.role==="admin")._id;
  const keyPair = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = await exportJWK(keyPair.publicKey);
  const kid = "test-key-"+Date.now();
  await db.collection("jwks").insertOne({_id:kid,publicKey:JSON.stringify(jwk),privateKey:JSON.stringify(await exportJWK(keyPair.privateKey)),createdAt:new Date()});
  async function mk(role, sub, rv=0){ return new SignJWT({sub,role,roleVersion:rv}).setProtectedHeader({alg:"EdDSA",kid}).setIssuer(BETTER_AUTH_URL).setAudience(BETTER_AUTH_URL).setExpirationTime("1h").setIssuedAt().sign(keyPair.privateKey); }
  ownerJwt=await mk("owner","owner1",0); customerJwt=await mk("customer","cust1",0); customer2Jwt=await mk("customer","cust2",0); adminJwt=await mk("admin","admin1",0);
}
async function seedEquipment(overrides={}){
  const eq={ownerId:ownerProfileId,name:"Excavator",description:"d",category:"Construction Equipment",location:"NY",rentalPrice:100,rentalType:"daily",totalQuantity:1,condition:"good",status:"approved",featured:false,inventoryVersion:0,createdAt:new Date(),updatedAt:new Date(),...overrides};
  const r=await db.collection("equipment").insertOne(eq); return {...eq,_id:r.insertedId};
}

let serverProc;
async function startServer(){
  return new Promise((resolve,reject)=>{
    const proc=spawn("node",["server.js"],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),NODE_ENV:"test",DB_NAME,STRIPE_API_HOST:"127.0.0.1",STRIPE_API_PORT:"12112",STRIPE_API_PROTOCOL:"http",STRIPE_SECRET_KEY:process.env.STRIPE_SECRET_KEY||"sk_test_mock",STRIPE_WEBHOOK_SECRET:"whsec_test_phase41"},stdio:["ignore","pipe","pipe"]});
    let out=""; proc.stdout.on("data",d=>{out+=d.toString(); if(out.includes("Server running on port")) resolve(proc);});
    proc.stderr.on("data",d=>{out+=d.toString();});
    proc.on("error",reject);
    proc.on("exit",c=>{ if(c && c!==0) console.error(out.slice(-1000));});
    setTimeout(()=>reject(new Error("server timeout\n"+out.slice(-500))),30000);
  });
}
async function waitServer(){ for(let i=0;i<30;i++){ try{ const r=await fetch(`${BASE_URL}/`); if(r.ok) return; }catch{} await new Promise(r=>setTimeout(r,500)); } throw new Error("no server"); }

function future(daysFromNow, daysLen=2){ const s=new Date(); s.setDate(s.getDate()+daysFromNow); s.setHours(0,0,0,0); const e=new Date(s); e.setDate(e.getDate()+daysLen); return {startDate:s.toISOString(), endDate:e.toISOString()}; }
const tests=[
test("CONC-A: two customers compete for last unit over HTTP", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(30,2);
  const body={equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1};
  const [r1,r2]=await Promise.all([
    fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify(body)}),
    fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customer2Jwt}`},body:JSON.stringify(body)}),
  ]);
  const statuses=[r1.status,r2.status].sort();
  assert(statuses[0]===200 && (statuses[1]===400||statuses[1]===409), `Expected one 200 and one 400/409, got ${statuses}`);
  const activeIntents=await db.collection("checkoutIntents").find({equipmentId:eq._id,status:{$in:["pending","processing","completed"]}}).toArray();
  assert(activeIntents.length===1, `Exactly one active reservation expected, got ${activeIntents.length}`);
  const allIntents=await db.collection("checkoutIntents").find({equipmentId:eq._id}).toArray();
  const releasedOrFailed=allIntents.filter(i=>["expired","failed","cancelled"].includes(i.status) || i.released===true);
  assert(allIntents.length===1 || releasedOrFailed.length===allIntents.length-1, `Losing request must not leave extra active reservation; intents=${JSON.stringify(allIntents.map(i=>({s:i.status,r:i.released})))}`);
  const bookings=await db.collection("bookings").find({equipmentId:eq._id}).toArray();
  assert(bookings.length===0, `No paid booking expected before webhook, got ${bookings.length}`);
}),
test("CONC-B: non-overlapping dates both succeed over HTTP", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d1=future(40,2); const d2=future(43,2);
  const r1=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d1.startDate,endDate:d1.endDate,quantity:1})});
  const r2=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customer2Jwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d2.startDate,endDate:d2.endDate,quantity:1})});
  assert(r1.status===200 && r2.status===200, `Expected 200/200 got ${r1.status}/${r2.status}`);
  const intents=await db.collection("checkoutIntents").find({equipmentId:eq._id,status:"pending"}).toArray();
  assert(intents.length===2, `Expected 2 pending intents, got ${intents.length}`);
}),
test("CONC-C: quantity>1 and partial availability enforced over HTTP", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:2});
  const d=future(50,2);
  const r1=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  const r2=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customer2Jwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:2})});
  assert(r1.status===200, `first should succeed ${r1.status}`);
  assert(r2.status===400||r2.status===409, `second should fail ${r2.status}`);
  const intents=await db.collection("checkoutIntents").find({equipmentId:eq._id,status:"pending"}).toArray();
  assert(intents.length===1, `only one pending intent ${intents.length}`);
}),
test("CONC-D: payment completion racing cancellation is consistent", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(60,2);
  const create=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(create.status===200, `create ${create.status}`);
  const intent=await db.collection("checkoutIntents").findOne({equipmentId:eq._id});
  const stripe=new Stripe(process.env.STRIPE_SECRET_KEY||"sk_test_mock",{apiVersion:"2024-04-10"});
  const payload=JSON.stringify({id:`evt_race_${Date.now()}`,object:"event",type:"checkout.session.completed",data:{object:{id:`cs_race_${Date.now()}`,object:"checkout.session",payment_status:"paid",amount_total:Math.round(intent.totalPrice*100),currency:"usd",payment_intent:`pi_race_${Date.now()}`,metadata:{checkout_intent_id:intent._id.toString(),user_id:customerProfileId.toString(),equipment_id:eq._id.toString(),owner_id:ownerProfileId.toString()}}}});
  const sig=stripe.webhooks.generateTestHeaderString({payload,secret:"whsec_test_phase41"});
  const [cancelRes, webhookRes]=await Promise.all([
    fetchJson(`/api/bookings/cancel/${intent._id}`,{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`}}),
    fetchRaw("/api/webhooks/stripe",{headers:{"Content-Type":"application/json","stripe-signature":sig},body:payload}),
  ]);
  const bookings=await db.collection("bookings").find({checkoutIntent:intent._id}).toArray();
  const payments=await db.collection("payments").find({checkoutIntent:intent._id}).toArray();
  const finalIntent=await db.collection("checkoutIntents").findOne({_id:intent._id});
  const webhookEvents=await db.collection("webhookEvents").find({eventId:JSON.parse(payload).id}).toArray();
  assert(bookings.length<=1, `max 1 booking ${bookings.length}`);
  assert(payments.length<=1, `max 1 payment ${payments.length}`);
  assert(webhookEvents.length<=1, `max 1 webhook event record ${webhookEvents.length}`);
  if (bookings.length===1) {
    assert(payments.length===1, `paid booking should have one payment, got ${payments.length}`);
    assert(finalIntent.status==="completed", `paid booking means completed intent, got ${finalIntent.status}`);
    assert(finalIntent.released !== true || finalIntent.status==="completed", "completed paid intent must not be released as cancelled");
    assert(cancelRes.status===400||cancelRes.status===409, `cancel must fail after paid completion ${cancelRes.status}`);
    assert(bookings[0].paymentStatus==="paid", `booking paymentStatus ${bookings[0].paymentStatus}`);
    assert(payments[0].status==="paid" || payments[0].status==="completed", `payment status ${payments[0].status}`);
  } else {
    assert(["cancelled","expired","failed"].includes(finalIntent.status), `no booking => cancelled/expired/failed, got ${finalIntent.status}`);
    assert(cancelRes.status===200, `if no booking created, cancellation should win with 200, got ${cancelRes.status} webhook=${webhookRes.status}`);
    assert(webhookRes.status>=400 || ["cancelled","expired","failed"].includes(finalIntent.status), `webhook should not create paid booking after cancellation won`);
  }
  assert([200,400,409,500].includes(webhookRes.status), `webhook responded ${webhookRes.status}`);
}),
test("CONC-E: Stripe session creation failure releases inventory over HTTP", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(70,2);
  stripeMockFail=true;
  const r1=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  stripeMockFail=false;
  assert(r1.status>=400, `expected failure ${r1.status}`);
  const active=await db.collection("checkoutIntents").find({equipmentId:eq._id,status:"pending",released:{$ne:true}}).toArray();
  assert(active.length===0, "no active pending intent after failure");
  const intents=await db.collection("checkoutIntents").find({equipmentId:eq._id}).toArray();
  assert(intents.length>=1, "intent should be recorded");
  assert(intents.every(i=>i.released===true || i.status!=="pending"), `all intents released/terminal ${JSON.stringify(intents.map(i=>({s:i.status,r:i.released})))}`);
  const r2=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(r2.status===200, `re-reserve should succeed ${r2.status}`);
  const after=await db.collection("checkoutIntents").find({equipmentId:eq._id,status:"pending",released:{$ne:true}}).toArray();
  assert(after.length===1, "one active reservation after recovery");
}),
test("CONC-F: processing intent remains counted and blocks overlapping HTTP reserve", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(80,2);
  const create=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(create.status===200);
  const intent=await db.collection("checkoutIntents").findOne({equipmentId:eq._id});
  await db.collection("checkoutIntents").updateOne({_id:intent._id},{$set:{status:"processing",updatedAt:new Date()}});
  const r2=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customer2Jwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(r2.status===400||r2.status===409, `overlap during processing must fail ${r2.status}`);
  const intents=await db.collection("checkoutIntents").find({equipmentId:eq._id,status:{$in:["pending","processing","completed"]}}).toArray();
  assert(intents.length===1, `only original intent active ${intents.length}`);
  const processingIntent=await db.collection("checkoutIntents").findOne({_id:intent._id});
  assert(processingIntent.status==="processing", `intent should remain processing ${processingIntent.status}`);
}),
test("CONC-G: actual expiry flow releases inventory exactly once through supported service flow", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(90,2);
  const create=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(create.status===200, `create ${create.status}`);
  const intent=await db.collection("checkoutIntents").findOne({equipmentId:eq._id,status:"pending"});
  assert(intent, "pending intent exists");
  await db.collection("checkoutIntents").updateOne({_id:intent._id},{$set:{expiresAt:new Date(Date.now()-60_000),updatedAt:new Date()}});
  const releasedCount1 = await releaseExpiredIntents(db);
  assert(releasedCount1>=1, `first expiry release should release >=1, got ${releasedCount1}`);
  const after1=await db.collection("checkoutIntents").findOne({_id:intent._id});
  assert(after1.status==="expired", `intent expired ${after1.status}`);
  assert(after1.released===true, "intent marked released");
  const releasedCount2 = await releaseExpiredIntents(db);
  assert(releasedCount2===0, `second expiry release should be 0, got ${releasedCount2}`);
  const after2=await db.collection("checkoutIntents").findOne({_id:intent._id});
  assert(after2.status==="expired" && after2.released===true, "state unchanged after second expiry");
  const r2=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customer2Jwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(r2.status===200, `released quantity should be reservable ${r2.status} ${JSON.stringify(r2.body)}`);
  const active=await db.collection("checkoutIntents").find({equipmentId:eq._id,status:"pending",released:{$ne:true}}).toArray();
  assert(active.length===1, `one new active intent ${active.length}`);
  assert(active[0].userId.toString()===customer2ProfileId.toString(), "new reservation belongs to customer2");
}),
test("CONC-H: failed/expired checkout intent release is distinct and inventory restored", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(100,2);
  stripeMockFail=true;
  const failed=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  stripeMockFail=false;
  assert(failed.status>=400, `Stripe failure expected ${failed.status}`);
  const intentsAfterFail=await db.collection("checkoutIntents").find({equipmentId:eq._id}).sort({createdAt:1}).toArray();
  assert(intentsAfterFail.length===1, "one intent created");
  assert(intentsAfterFail[0].released===true, "failed intent released");
  assert(["expired","failed","cancelled"].includes(intentsAfterFail[0].status), `failed intent terminal status ${intentsAfterFail[0].status}`);
  const create2=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(create2.status===200, "second reservation after failure");
  const pending=await db.collection("checkoutIntents").findOne({equipmentId:eq._id,status:"pending",released:{$ne:true}});
  await db.collection("checkoutIntents").updateOne({_id:pending._id},{$set:{expiresAt:new Date(Date.now()-60_000),updatedAt:new Date()}});
  const released = await releaseExpiredIntents(db);
  assert(released===1, `expired flow released 1, got ${released}`);
  const expiredIntent=await db.collection("checkoutIntents").findOne({_id:pending._id});
  assert(expiredIntent.status==="expired" && expiredIntent.released===true, "expired intent marked expired+released");
  const create3=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customer2Jwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(create3.status===200, "reservation after actual expiry flow succeeds");
}),
test("CONC-I: calculated availability reflects overlapping vs non-overlapping reservations", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d1=future(110,2); const d2=future(113,2); const overlap=future(111,2);
  const r1=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d1.startDate,endDate:d1.endDate,quantity:1})});
  assert(r1.status===200, `r1 ${r1.status}`);
  const availOverlap=await checkAvailability(db, eq._id, overlap.startDate, overlap.endDate, 1);
  assert(availOverlap.available===false, `overlapping should be unavailable ${JSON.stringify(availOverlap)}`);
  assert(availOverlap.availableQuantity===0, `availableQuantity 0 got ${availOverlap.availableQuantity}`);
  const availNonOverlap=await checkAvailability(db, eq._id, d2.startDate, d2.endDate, 1);
  assert(availNonOverlap.available===true, `non-overlapping should be available ${JSON.stringify(availNonOverlap)}`);
  assert(availNonOverlap.availableQuantity===1, `availableQuantity 1 got ${availNonOverlap.availableQuantity}`);
  const r2=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customer2Jwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d2.startDate,endDate:d2.endDate,quantity:1})});
  assert(r2.status===200, `non-overlapping reserve ${r2.status}`);
  const availAfter=await checkAvailability(db, eq._id, d2.startDate, d2.endDate, 1);
  assert(availAfter.available===false, "after reserving non-overlapping slot unavailable");
}),
];

async function main(){
  await startStripeMock();
  await connectTestDb();
  await clearDb();
  serverProc=await startServer();
  await waitServer();
  try {
    for (const t of tests) await t();
  } finally {
    if (serverProc) serverProc.kill();
    await closeAppDB().catch(()=>{});
    await stopStripeMock();
  }
  console.log(`\nTOTAL:${results.length} PASS:${passed} FAIL:${failed}`);
  for (const r of results.filter(r=>r.status==="FAIL")) console.log(`- ${r.name}: ${r.error}`);
  process.exit(failed?1:0);
}
main().catch(e=>{ console.error(e); process.exit(1); });
